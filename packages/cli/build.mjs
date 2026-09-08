#!/usr/bin/env node
/**
 * Build the publishable `srift` CLI package.
 *
 * Bundles cli/{index,daemon}.ts from the repo root into packages/cli/dist/.
 * Runtime deps stay external so npm resolves them from this package's own
 * (6-dep) dependency list rather than the website's 78-dep tree.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const outdir = path.join(__dirname, 'dist');

// Externals must match this package.json's dependencies + optionalDependencies.
const external = ['express', 'cors', 'ws', 'webtorrent', 'dotenv', 'uuid'];

// Guard: the CLI hardcodes its own version string for `srift --version`.
// If it drifts from package.json, users get a wrong version in bug reports
// and `srift self-update` compares against the wrong baseline.
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const cliSrc = fs.readFileSync(path.join(repoRoot, 'cli', 'index.ts'), 'utf8');
const declared = cliSrc.match(/const CLI_VERSION = '([^']+)'/)?.[1];
if (declared !== pkg.version) {
  console.error(
    `[srift-cli] version drift: cli/index.ts CLI_VERSION='${declared}' but ` +
      `packages/cli/package.json version='${pkg.version}'. Sync them before publishing.`
  );
  process.exit(1);
}

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

const entries = [
  { in: path.join(repoRoot, 'cli', 'index.ts'), out: 'index' },
  { in: path.join(repoRoot, 'cli', 'daemon.ts'), out: 'daemon' },
];

for (const entry of entries) {
  await build({
    entryPoints: [entry.in],
    outfile: path.join(outdir, `${entry.out}.js`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external,
    logLevel: 'info',
  });
}

// Ensure exactly one shebang, on line 1. cli/index.ts already ships one; an
// esbuild `banner` would emit a second (invalid) one, so normalise here instead.
const SHEBANG = '#!/usr/bin/env node';
for (const entry of entries) {
  const f = path.join(outdir, `${entry.out}.js`);
  let src = fs.readFileSync(f, 'utf8');
  src = src.replace(/^\s*#!.*\n/gm, '');
  fs.writeFileSync(f, `${SHEBANG}\n${src}`);
}

// npm does not preserve the executable bit from the bin field on POSIX installs
// unless the file itself is marked executable in the tarball.
for (const entry of entries) {
  const f = path.join(outdir, `${entry.out}.js`);
  fs.chmodSync(f, 0o755);
}

console.log('[srift-cli] build complete →', outdir);
