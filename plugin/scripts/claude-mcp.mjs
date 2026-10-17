/**
 * Launches one SRIFT MCP server for the Claude Code plugin.
 *
 * npm (`srift-transfer`) and PyPI (`srift`) are two installs of the
 * same CLI. Starting both would open two daemons on port 3822, so this picks
 * one, in order: an already-installed `srift` (npm -g, pip, or the standalone
 * binary), then npx, then uvx.
 *
 * Args are the srift subcommand, e.g. `mcp` or `peerknock mcp`. The npx and
 * uvx packages are pinned to SRIFT_VERSION (kept in step with package.json by
 * scripts/sync-version.mjs) so a plugin version always runs the same CLI.
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path, { delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SRIFT_VERSION = '4.4.1';

const EXTRA_EXTS = process.platform === 'win32'
  ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  : [''];

export function findOnPath(name, envPath = process.env.PATH || '', exts = EXTRA_EXTS) {
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, ext && name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext);
      try {
        if (existsSync(full) && statSync(full).isFile()) return full;
      } catch {
        // a PATH entry that cannot be stat'd is skipped
      }
    }
  }
  return null;
}

/** @param {string[]} extra srift args, such as ['mcp'] or ['peerknock', 'mcp'] */
export function resolveLaunch(extra, find = findOnPath) {
  const srift = find('srift');
  if (srift) return { command: srift, args: [...extra] };
  const npx = find('npx');
  if (npx) return { command: npx, args: ['-y', `srift-transfer@${SRIFT_VERSION}`, ...extra] };
  const uvx = find('uvx');
  if (uvx) return { command: uvx, args: [`srift==${SRIFT_VERSION}`, ...extra] };
  return null;
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  const extra = process.argv.slice(2);
  const launch = resolveLaunch(extra);
  if (!launch) {
    console.error('Install SRIFT with `npm i -g srift-transfer` or `pip install srift`, then restart Claude.');
    process.exit(1);
  }
  const child = spawn(launch.command, launch.args, { stdio: 'inherit', windowsHide: true });
  child.on('error', (err) => {
    console.error(err.message);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}
