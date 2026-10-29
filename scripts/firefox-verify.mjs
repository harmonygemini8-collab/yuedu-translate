// Proves the Firefox source package rebuilds the submitted package byte for byte (doc/14 §10.5): copies the source
// package's folder somewhere clean, installs the dependencies, builds with the recorded stamp, and compares every
// file with the submitted build by SHA-256.
//
// Usage: npm run firefox && npm run firefox:source && npm run firefox:verify
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const submitted = join(root, 'release', 'build', 'extension-firefox');
const sourceDir = join(root, 'release', 'build', 'source-firefox');
const stamp = (await readFile(join(root, 'release', 'build', 'stamp-firefox.txt'), 'utf8')).trim();

async function hashes(dir) {
  const out = new Map();
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.set(relative(dir, path).replaceAll('\\', '/'), createHash('sha256').update(await readFile(path)).digest('hex'));
    }
  };
  await walk(dir);
  return out;
}

const work = await mkdtemp(join(tmpdir(), 'yuedu-firefox-verify-'));
try {
  await cp(sourceDir, work, { recursive: true });
  const run = (command) => execSync(command, { cwd: work, stdio: 'ignore', env: { ...process.env, YILIN_BUILD_STAMP: stamp } });
  console.log(`Installing dependencies in ${work} ...`);
  run('npm ci --no-audit --no-fund');
  console.log(`Building with stamp "${stamp}" ...`);
  run('npm run firefox');

  const [a, b] = [await hashes(submitted), await hashes(join(work, 'release', 'build', 'extension-firefox'))];
  const different = [...a.keys()].filter((k) => a.get(k) !== b.get(k));
  const missing = [...b.keys()].filter((k) => !a.has(k));
  if (a.size === b.size && different.length === 0 && missing.length === 0) {
    console.log(`OK: all ${a.size} files are identical (SHA-256).`);
  } else {
    console.error(`DIFFERENT: submitted ${a.size} files, rebuilt ${b.size}.`);
    for (const k of different) console.error(`  differs: ${k}`);
    for (const k of missing) console.error(`  only in the rebuild: ${k}`);
    process.exitCode = 1;
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
