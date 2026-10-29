// Packs the source of the Firefox build for the add-on review (doc/14 §10.5). Mozilla asks for it whenever the
// submitted code is machine-generated, and ours is bundled by esbuild. It holds only what the build reads, and a
// README that says how to rebuild the very same package.
//
// Usage: npm run firefox && npm run firefox:source
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'release', 'build', 'source-firefox');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = pkg.firefoxVersion ?? pkg.version;

// Everything the build reads, and nothing else: no server, website, tests, docs or store material.
const tracked = execFileSync('git', ['ls-files', 'src', 'public', 'scripts/build.mjs', 'scripts/manifest.mjs', 'scripts/zip.mjs', 'package.json', 'package-lock.json', 'tsconfig.json'], {
  cwd: root,
  encoding: 'utf8',
}).split('\n').filter(Boolean);

await rm(out, { recursive: true, force: true });
for (const file of tracked) {
  await mkdir(dirname(join(out, file)), { recursive: true });
  await copyFile(join(root, file), join(out, file));
}

let stamp = '';
try {
  stamp = (await readFile(join(root, 'release', 'build', 'stamp-firefox.txt'), 'utf8')).trim();
} catch {
  throw new Error('Run npm run firefox first: the source package carries the stamp of that build.');
}
const readme = (await readFile(join(root, 'release', 'firefox', 'BUILD.md'), 'utf8')).replaceAll('{{VERSION}}', version).replaceAll('{{STAMP}}', stamp);
await writeFile(join(out, 'README.md'), readme);

const zipPath = join(root, 'release', 'build', `yuedu-translate-${version}-source.zip`);
await writeFile(zipPath, await zipDirectory(out));
console.log(`Source package: ${zipPath.replace(root + '\\', '')} (${tracked.length} files, build stamp "${stamp}")`);
