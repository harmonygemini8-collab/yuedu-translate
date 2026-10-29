import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { zipDirectory } from './zip.mjs';
import { firefoxManifest } from './manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
/**
 * --public builds the version for end users (Chrome Web Store / Edge Add-ons) into
 * release/build/extension and packs it as a zip; development builds go to dist/.
 */
const isPublic = process.argv.includes('--public');
/**
 * --firefox builds the same code for Firefox (desktop and Android): only the manifest differs. It goes to its
 * own folders, so building it never touches the Chrome build.
 */
const isFirefox = process.argv.includes('--firefox');
const dist = isFirefox
  ? (isPublic ? join(root, 'release', 'build', 'extension-firefox') : join(root, 'dist-firefox'))
  : (isPublic ? join(root, 'release', 'build', 'extension') : join(root, 'dist'));

/** Backend origin, e.g. YILIN_API_BASE=http://127.0.0.1:8787. Without it only the free Google engine works. */
function resolveApiBase(raw) {
  if (!raw) return '';
  const url = new URL(raw);
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('YILIN_API_BASE must use https (plain http is only allowed for localhost)');
  }
  return url.origin;
}
const apiArg = process.argv.find((a) => a.startsWith('--api='))?.slice('--api='.length);
const apiBase = resolveApiBase(apiArg ?? process.env.YILIN_API_BASE);

/** Commit and time of this build, so a package on a phone can be told apart from the one before it (the version number is the same). */
function buildStamp() {
  // Set to the stamp of a package already built, to rebuild that package byte for byte (doc/14 §10.5).
  if (process.env.YILIN_BUILD_STAMP) return process.env.YILIN_BUILD_STAMP;
  let commit = 'nogit';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    // Not a git checkout: the time alone has to do.
  }
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${commit} ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

const staticFiles = [
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
  ['src/options/options.html', 'options.html'],
  ['src/options/options.css', 'options.css'],
  ['src/shared/lang-picker.css', 'lang-picker.css'],
];

async function copyStatic() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'public/manifest.json'), 'utf8'));
  // The Firefox package may carry its own number (AMO wants one it has not seen), so the two stores need not move together.
  const written = isFirefox ? (pkg.firefoxVersion ?? pkg.version) : pkg.version;
  // A leading zero ("0.4.01") is what the product calls the release, but a manifest version is plain integers and
  // browsers read it as 0.4.1; write that, and let Chrome show the name as written.
  manifest.version = written.split('.').map((part) => String(Number(part))).join('.');
  if (!isFirefox && manifest.version !== written) manifest.version_name = written;
  const output = isFirefox ? firefoxManifest(manifest) : manifest;
  // No host_permissions at all: both translation endpoints answer cross-origin requests with
  // permissive CORS (Google's with `*`, ours by echoing a chrome-extension:// origin), so the
  // service worker can reach them without one. That keeps the extension's details page from
  // listing any site it may contact, and webpage access stays on activeTab. See doc/07 §2.
  await writeFile(join(dist, 'manifest.json'), JSON.stringify(output, null, 2));
  await Promise.all([
    ...staticFiles.map(([from, to]) => cp(join(root, from), join(dist, to))),
    cp(join(root, 'public/icons'), join(dist, 'icons'), { recursive: true }),
    cp(join(root, 'public/_locales'), join(dist, '_locales'), { recursive: true }),
  ]);
}

const stamp = buildStamp();

const options = {
  absWorkingDir: root,
  entryPoints: {
    background: 'src/background/index.ts',
    content: 'src/content/index.ts',
    'caption-hook': 'src/content/caption-hook.ts',
    popup: 'src/popup/popup.ts',
    options: 'src/options/options.ts',
  },
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: isFirefox ? 'firefox128' : 'chrome111',
  charset: 'utf8',
  legalComments: 'none',
  define: {
    __YILIN_API_BASE__: JSON.stringify(apiBase),
    __YILIN_PUBLIC__: JSON.stringify(isPublic),
    __YILIN_BUILD__: JSON.stringify(stamp),
  },
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  plugins: [{ name: 'static', setup: (build) => build.onEnd(copyStatic) }],
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// The backend is baked in here, and without it the extension has no account section at all,
// so say which one this build got (doc/18 §1).
console.log(`${isFirefox ? 'Firefox ' : ''}${isPublic ? 'Public' : 'Development'} build · ${apiBase
  ? `backend ${apiBase}`
  : 'NO BACKEND: free Google engine only, the extension will have no account or VIP section'}`);
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
  if (isPublic) {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const version = isFirefox ? (pkg.firefoxVersion ?? pkg.version) : pkg.version;
    const zipPath = join(root, 'release', 'build', `yuedu-translate-${version}${isFirefox ? '-firefox' : ''}.zip`);
    await writeFile(zipPath, await zipDirectory(dist));
    // Kept beside the packages: the source package for the Firefox review carries it, so the build can be repeated exactly.
    await writeFile(join(root, 'release', 'build', isFirefox ? 'stamp-firefox.txt' : 'stamp.txt'), `${stamp}\n`);
    console.log(`Package: ${relative(root, zipPath)}`);
  }
}
