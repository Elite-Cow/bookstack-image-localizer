// Build BookStack Companion as a single self-contained executable using
// Node's Single Executable Application (SEA) support.
//
//   npm run build:app
//
// Steps: bundle server.js to CJS (esbuild) → collect public/ + extension
// folders as SEA assets → generate the SEA blob → copy the Node runtime and
// inject the blob (postject). Output lands in dist/.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
// The packaged app runs as the localizer-only edition by default — name it
// for what it does. (BSC_EDITION=full at runtime still unlocks the full app.)
const EXE_NAME =
  process.platform === 'win32' ? 'BookStack-Image-Localizer.exe' : 'bookstack-image-localizer';

async function collectFiles(dir, baseKey) {
  const out = {};
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      Object.assign(out, await collectFiles(full, `${baseKey}/${e.name}`));
    } else if (e.isFile()) {
      out[`${baseKey}/${e.name}`] = full;
    }
  }
  return out;
}

console.log('› Cleaning dist/');
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

console.log('› Bundling server (esbuild)');
await build({
  entryPoints: [join(ROOT, 'start.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: join(DIST, 'server.cjs'),
  logLevel: 'warning',
  legalComments: 'none',
});

console.log('› Collecting assets');
const assets = {
  ...(await collectFiles(join(ROOT, 'public'), 'public')),
  ...(await collectFiles(join(ROOT, 'extension'), 'extension')),
  ...(await collectFiles(join(ROOT, 'extension-firefox'), 'extension-firefox')),
};
const manifestPath = join(DIST, 'asset-manifest.json');
await writeFile(manifestPath, JSON.stringify(Object.keys(assets)));
assets['asset-manifest.json'] = manifestPath;
console.log(`  ${Object.keys(assets).length} files embedded`);

console.log('› Generating SEA blob');
const seaConfig = {
  main: join(DIST, 'server.cjs'),
  output: join(DIST, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  assets,
};
await writeFile(join(DIST, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', join(DIST, 'sea-config.json')], {
  stdio: 'inherit',
});

console.log('› Copying Node runtime and injecting blob (postject)');
const exePath = join(DIST, EXE_NAME);
await cp(process.execPath, exePath);
execFileSync(
  process.execPath,
  [
    join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
    exePath,
    'NODE_SEA_BLOB',
    join(DIST, 'sea-prep.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ],
  { stdio: 'inherit' }
);

const size = (await stat(exePath)).size;
console.log(`\n✔ Built ${relative(ROOT, exePath)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log('  Double-click it — the app starts and opens in the default browser.');
