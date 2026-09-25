#!/usr/bin/env node
/**
 * Bundle cli/{index,daemon}.ts into packages/pypi/src/srift_cli/_vendor/.
 *
 * Unlike packages/cli/build.mjs (which keeps express/cors/ws/dotenv/uuid
 * external so npm resolves them from that package's own dependency list),
 * this bundle inlines them: the PyPI wrapper ships no node_modules, so
 * everything the CLI needs at runtime must be in the JS file itself.
 *
 * `webtorrent` stays external and absent — cli/daemon.ts already loads it
 * via a lazy `await import('webtorrent')` wrapped in try/catch (see the
 * "WebTorrent: lazy load" comment there) and degrades to WebSocket-chunked
 * transfer if it's missing, which is exactly the case here.
 *
 * `bufferutil` / `utf-8-validate` are `ws`'s optional native-addon
 * accelerators, also `require()`d from inside a try/catch in `ws/lib/*.js`.
 * They're native binaries and can't be bundled into portable JS, so they
 * too stay external+absent; `ws` falls back to its pure-JS mask/validate
 * implementations.
 *
 * Format is ESM (cli/index.ts uses `import.meta.url` for __dirname, which
 * only works natively in ESM output — CJS output silently empties it).
 * Inlining express's dependency tree also inlines nested CJS modules (e.g.
 * `debug`) that call plain `require('tty')` for Node builtins; in ESM
 * output esbuild wraps those in a runtime `__require` shim that only
 * delegates to a *real* `require` if one is in module scope — which plain
 * ESM doesn't have — otherwise throwing `Dynamic require of "tty" is not
 * supported`. The `banner` below shims a real `require` via
 * `module.createRequire`, which is the standard esbuild workaround for
 * exactly this combination (ESM output + bundled CJS deps needing Node
 * builtins).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pypiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pypiRoot, '..', '..');
const outdir = path.join(pypiRoot, 'src', 'srift_cli', '_vendor');

const external = ['webtorrent', 'bufferutil', 'utf-8-validate'];

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
    banner: {
      js:
        "import { createRequire as __srift_createRequire } from 'node:module';\n" +
        'const require = __srift_createRequire(import.meta.url);',
    },
  });
}

// Strip any shebang esbuild/source may have carried over — this bundle is
// never executed directly (Python always invokes `node <path>/index.js`),
// so a shebang is unnecessary and a stray duplicate would be invalid JS.
for (const entry of entries) {
  const f = path.join(outdir, `${entry.out}.js`);
  const src = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, src.replace(/^\s*#!.*\n/, ''));
}

// Without a package.json declaring `"type": "module"`, Node has to sniff
// each file's syntax to realize it's ESM (since the extension is plain
// `.js`), which prints a MODULE_TYPELESS_PACKAGE_JSON warning to stderr and
// adds parse overhead on every invocation.
fs.writeFileSync(path.join(outdir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');

console.log('[srift-pypi] bundle complete ->', outdir);
