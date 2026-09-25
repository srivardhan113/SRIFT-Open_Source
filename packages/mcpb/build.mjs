#!/usr/bin/env node
/**
 * Build the .mcpb (MCP Bundle) for SRIFT.
 *
 * Spec verified against github.com/anthropics/mcpb MANIFEST.md (manifest_version
 * "0.3"): required top-level fields are manifest_version, name, version,
 * description, author.name, server{type, entry_point, mcp_config}. The
 * `tools` array only needs {name, description} — apps that support it show
 * this list to the user before install; it is NOT enforced at runtime (the
 * server still answers its own `tools/list`), so a slightly stale entry here
 * is a UX nit, not a functional bug. We still keep it exact by generating it
 * from the single source of truth (lib/mcp/core.mjs MCP_TOOLS) every build,
 * so it self-heals the moment a tool is added/removed/renamed there — e.g.
 * `srift_net_diagnose`, which another workstream is landing in MCP_TOOLS;
 * once it exists there, the very next `node build.mjs` picks it up with zero
 * changes needed in this file or manifest.json.
 *
 * Usage:
 *   node packages/mcpb/build.mjs            # regenerate manifest.json + build staging/
 *   node packages/mcpb/build.mjs --pack     # also zip to srift.mcpb (needs @anthropic-ai/mcpb)
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const stagingDir = path.join(__dirname, 'staging');
const manifestPath = path.join(__dirname, 'manifest.json');

const cliPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8'));

// ─── Derive the tools list from the single source of truth ─────────────────
const coreModUrl = new URL('file://' + path.join(repoRoot, 'lib', 'mcp', 'core.mjs').replace(/\\/g, '/'));
const { MCP_TOOLS } = await import(coreModUrl.href);
const tools = MCP_TOOLS.map((t) => ({ name: t.name, description: t.description }));

// ─── Static manifest fields (everything that isn't derived) ────────────────
const manifest = {
  manifest_version: '0.3',
  name: 'srift',
  display_name: 'SRIFT',
  version: cliPkg.version,
  description: 'Zero-config, zero-token P2P E2EE file transfer, encrypted chat, and session orchestration for AI agents.',
  long_description:
    `SRIFT gives any MCP-capable agent ${tools.length} tools to start/join encrypted P2P sessions, ` +
    'send and receive files, exchange encrypted chat, and share a file with a single ' +
    'public download link — all via a local zero-auth daemon on 127.0.0.1:3822 that this ' +
    'bundle launches on demand. AES-256-GCM + PBKDF2-SHA256 (100,000 iterations), keys ' +
    'derived client-side, zero central retention.',
  author: {
    name: 'SRIFT',
    url: 'https://srift.app',
  },
  homepage: 'https://srift.app',
  documentation: 'https://srift.app/ai-agents',
  support: 'https://github.com/srivardhan113/SRIFT-Open_Source/issues',
  icon: 'icon.png',
  license: 'MIT',
  keywords: ['file-transfer', 'p2p', 'e2ee', 'encrypted-chat', 'mcp'],
  server: {
    type: 'node',
    entry_point: 'dist/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/dist/index.js', 'mcp'],
    },
  },
  tools,
  tools_generated: false,
  compatibility: {
    // Best-effort per MANIFEST.md's "platform and runtime requirements"
    // description — not byte-verified against a schema example at time of
    // writing. Re-check against the live spec before relying on this block
    // to gate installs.
    platforms: ['darwin', 'win32', 'linux'],
    runtimes: {
      node: '>=20.0.0',
    },
  },
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`[mcpb] wrote ${path.relative(repoRoot, manifestPath)} (${tools.length} tools, v${manifest.version})`);

// ─── Stage the bundle contents ──────────────────────────────────────────────
const cliDist = path.join(repoRoot, 'packages', 'cli', 'dist');
if (!fs.existsSync(cliDist)) {
  console.error(`[mcpb] ${path.relative(repoRoot, cliDist)} does not exist — run \`node packages/cli/build.mjs\` first.`);
  process.exit(1);
}

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });
fs.cpSync(cliDist, path.join(stagingDir, 'dist'), { recursive: true });
fs.copyFileSync(manifestPath, path.join(stagingDir, 'manifest.json'));

const iconSrc = path.join(repoRoot, 'public', 'Favicon', 'apple-touch-icon.png');
if (fs.existsSync(iconSrc)) {
  fs.copyFileSync(iconSrc, path.join(stagingDir, 'icon.png'));
} else {
  console.warn('[mcpb] icon source missing, bundling without icon.png:', iconSrc);
  delete manifest.icon;
  fs.writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

console.log(`[mcpb] staged bundle at ${path.relative(repoRoot, stagingDir)}`);

// ─── Optionally pack ─────────────────────────────────────────────────────────
if (process.argv.includes('--pack')) {
  const outFile = path.join(__dirname, 'srift.mcpb');
  try {
    // Verified tool: `npx @anthropic-ai/mcpb pack <dir> <out>` (see
    // github.com/anthropics/mcpb README "Packing a bundle"). Falls back to a
    // plain zip if the package can't be resolved (e.g. offline dev machine),
    // which is not spec-guaranteed to produce an identical artifact but is
    // good enough for local smoke-testing the contents.
    execFileSync('npx', ['-y', '@anthropic-ai/mcpb', 'pack', stagingDir, outFile], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    console.log(`[mcpb] packed ${path.relative(repoRoot, outFile)}`);
  } catch (err) {
    console.error('[mcpb] `npx @anthropic-ai/mcpb pack` failed or is unavailable:', err.message);
    console.error('[mcpb] fallback: zip the staging/ directory contents (not the folder itself) into srift.mcpb by hand, e.g.:');
    console.error(`         cd ${path.relative(repoRoot, stagingDir)} && zip -r ../srift.mcpb . -x '.*'`);
    process.exitCode = 1;
  }
}
