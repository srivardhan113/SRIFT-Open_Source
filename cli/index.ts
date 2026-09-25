#!/usr/bin/env node --experimental-strip-types
import { spawn, execSync } from 'child_process';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import net from 'net';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';

import {
  handleSessionStart,
  handleSessionJoin,
  handleSessionStatus,
  handleSessionClose,
  handleSendFile,
  handleReceiveFile,
  handleListTransfers,
  handleApproveJoin,
  handleRejectJoin,
  handleKickUser,
  handleChatSend,
  handleChatHistory,
  handleDaemonStop,
  handleMonitorTransfer,
  handleQuickShare,
  handleQuickShareMany,
  waitForDownloads,
  handlePubshareList,
  handlePubshareRevoke,
  handlePubshareAdd,
  handleAutoInstallMcp,
  handleBootstrap,
  reportShare,
  callDaemon as callDaemonApi,
  type QuickShareOpts,
} from './client.ts';

import { startMcpServer } from './mcp.ts';
import { startEmbeddedDaemon, isEmbeddedDaemon, realConsole } from './embedded.ts';
import { agentFor, formatNetError, proxyEnvPresent } from './net.ts';
import { runDiagnostics, formatDiagnostics, diagExitCode } from './probe.ts';
import { relaySelfTest } from './selftest.ts';
import { getLink } from './get.ts';
import { packDirectory, DEFAULT_EXCLUDES, mapLimit } from './pack.ts';
import { readHistory, clearHistory, HISTORY_FILE } from './history.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DAEMON_PORT = parseInt(process.env.SRIFT_DAEMON_PORT || '3822', 10);
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const CLI_VERSION = '4.1.0';

// Parse "30s", "15m", "2h", "1d" → milliseconds. Returns 0 on invalid input.
function parseDuration(s: string | undefined): number {
  if (!s) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(s.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.floor(n * (mult[unit] || 0));
}
const VERSION_CHECK_URL = 'https://srift.app/cli/version.json';

function nodeAtLeast(major: number, minor: number): boolean {
  const [a, b] = process.versions.node.split('.').map((n) => parseInt(n, 10));
  return a > major || (a === major && b >= minor);
}

function flagValue(args: string[], ...names: string[]): string | undefined {
  for (const n of names) {
    const i = args.indexOf(n);
    if (i !== -1 && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) return args[i + 1];
    const eq = args.find((a) => a.startsWith(`${n}=`));
    if (eq) return eq.slice(n.length + 1);
  }
  return undefined;
}

/** Positional arguments after the subcommand (skips --flags and their values). */
const VALUE_FLAGS = new Set(['--password', '--ttl', '--max-downloads', '--filename', '--name', '--session-name', '--exclude',
  '--wait-timeout', '--bundle-name', '--mode', '-o', '--out', '--output', '--concurrency', '--limit']);
function positionals(args: string[], from = 1): string[] {
  const out: string[] = [];
  for (let i = from; i < args.length; i++) {
    const a = args[i];
    if (a === '-') { out.push(a); continue; }
    if (a.startsWith('-')) { if (VALUE_FLAGS.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === name && args[i + 1] !== undefined) out.push(args[i + 1]);
    else if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
  });
  return out;
}

const OUTBOX_DIR = path.join(os.homedir(), '.srift', 'outbox');

/** Files shared by path must outlive this process (relay links read them later). */
function outboxPath(name: string): string {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true, mode: 0o700 });
  // Staged copies of folders/stdin must outlive relay links (which may have no
  // TTL). Sweep after 30 days.
  try {
    const cutoff = Date.now() - 30 * 86_400_000;
    for (const f of fs.readdirSync(OUTBOX_DIR)) {
      const p = path.join(OUTBOX_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  const dir = path.join(OUTBOX_DIR, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, name);
}

async function stdinToFile(dest: string): Promise<number> {
  if (process.stdin.isTTY) throw new Error('Nothing on stdin. Pipe data in, e.g.:  tar cz dir | srift quick-share - --filename dir.tgz');
  // pipeline(): backpressure + propagates write errors (e.g. ENOSPC) as a rejection.
  await pipeline(process.stdin, fs.createWriteStream(dest, { mode: 0o600 }));
  return fs.statSync(dest).size;
}
const SRIFT_BASE_DL_URL = 'https://srift.app/dl';

// ─────────────────────────────────────────────────────────────────
// Config management (~/.srift/config.json)
// ─────────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), '.srift');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface SriftConfig {
  updateCheck?: boolean;
  updateCheckIntervalHours?: number;
  lastUpdateCheck?: string;
}

function readConfig(): SriftConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

function writeConfig(config: SriftConfig): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────
// Version check (background, non-blocking)
// ─────────────────────────────────────────────────────────────────
function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': `srift-cli/${CLI_VERSION}` }, agent: agentFor(url) }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

async function checkForUpdate(silent = true): Promise<{ update: boolean; latest: string; current: string } | null> {
  if (process.env.SRIFT_NO_UPDATE_CHECK === '1') return null;
  const cfg = readConfig();
  if (cfg.updateCheck === false) return null;

  // Throttle: only check once per 24h (configurable)
  const intervalHours = cfg.updateCheckIntervalHours ?? 24;
  if (cfg.lastUpdateCheck) {
    const since = Date.now() - new Date(cfg.lastUpdateCheck).getTime();
    if (since < intervalHours * 3600_000) return null;
  }

  try {
    const data = await fetchJson(VERSION_CHECK_URL);
    writeConfig({ ...cfg, lastUpdateCheck: new Date().toISOString() });
    const latest: string = data.latest;
    const update = compareVersions(latest, CLI_VERSION) > 0;
    if (!silent && update) {
      console.error(`\n⚡  srift ${latest} is available (you have ${CLI_VERSION})`);
      console.error(`   Run: srift self-update   or   curl -fsSL https://srift.app/install.sh | sh\n`);
    }
    return { update, latest, current: CLI_VERSION };
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────
// srift version
// ─────────────────────────────────────────────────────────────────
async function handleVersion(isJson: boolean): Promise<void> {
  let daemonVersion: string | null = null;
  let daemonOk = false;
  try {
    const result = await new Promise<any>((resolve, reject) => {
      const req = http.get(`${DAEMON_URL}/health`, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { reject(new Error('Invalid')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(1000, () => req.destroy());
    });
    daemonVersion = result.version ?? result.daemonVersion ?? null;
    daemonOk = result.ok ?? true;
  } catch { /* daemon not running */ }

  let remoteLatest: string | null = null;
  try {
    const data = await fetchJson(VERSION_CHECK_URL);
    remoteLatest = data.latest;
  } catch { /* offline */ }

  if (isJson) {
    console.log(JSON.stringify({
      cli: CLI_VERSION,
      daemon: daemonVersion,
      daemonRunning: daemonOk,
      latest: remoteLatest,
      updateAvailable: remoteLatest ? compareVersions(remoteLatest, CLI_VERSION) > 0 : null,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    }, null, 2));
    return;
  }

  console.log(`srift ${CLI_VERSION}`);
  if (daemonVersion) {
    console.log(`daemon ${daemonVersion} (${daemonOk ? 'running' : 'not ok'} on :${DAEMON_PORT})`);
  } else {
    console.log(`daemon — not running`);
  }
  console.log(`node   ${process.version}`);
  console.log(`os     ${process.platform} ${process.arch}`);
  if (remoteLatest && compareVersions(remoteLatest, CLI_VERSION) > 0) {
    console.log(`\n⚡ Update available: ${CLI_VERSION} → ${remoteLatest}`);
    console.log(`   srift self-update`);
  }
}

// ─────────────────────────────────────────────────────────────────
// srift self-update
// ─────────────────────────────────────────────────────────────────
async function handleSelfUpdate(isJson: boolean): Promise<void> {
  // Detect if we're running as a compiled binary or as node script
  const isBinary = !__filename.endsWith('.ts') && !__filename.endsWith('.js');
  const installDir = path.join(os.homedir(), '.srift', 'bin');
  const binName = process.platform === 'win32' ? 'srift.exe' : 'srift';
  const binPath = path.join(installDir, binName);

  console.log(`[srift] Checking for updates...`);
  let data: any;
  try {
    data = await fetchJson(VERSION_CHECK_URL);
  } catch (e) {
    console.error(`[srift] Cannot reach update server: ${e}`);
    if (isJson) console.log(JSON.stringify({ ok: false, error: String(e) }));
    process.exit(1);
  }

  const latest = data.latest as string;
  if (compareVersions(latest, CLI_VERSION) <= 0) {
    console.log(`[srift] Already up to date (${CLI_VERSION}).`);
    if (isJson) console.log(JSON.stringify({ ok: true, alreadyLatest: true, version: CLI_VERSION }));
    return;
  }

  console.log(`[srift] Updating ${CLI_VERSION} → ${latest} ...`);

  // If not installed as binary, use the universal install.sh / install.ps1.
  if (!isBinary) {
    // An npm install must be updated through npm. Pointing these users at
    // install.sh would drop a SECOND, standalone binary on the machine that
    // shadows (or is shadowed by) the npm shim — two installs, two versions,
    // and `srift --version` reporting whichever wins the PATH race.
    const entry = (typeof __filename === 'string' ? __filename : '').replace(/\\/g, '/');
    const isNpmInstall = /\/node_modules\//.test(entry);
    if (isNpmInstall) {
      const cmd = `npm install -g srift-transfer@latest`;
      console.log(`[srift] Installed via npm — update with:`);
      console.log(`[srift]   ${cmd}`);
      if (isJson) console.log(JSON.stringify({ ok: false, error: 'npm-install', updateCmd: cmd, latest }));
      return;
    }
    console.log(`[srift] Running as Node script — delegating to install script.`);
    if (process.platform === 'win32') {
      console.log(`[srift] Run: irm https://srift.app/install.ps1 | iex`);
    } else {
      console.log(`[srift] Run: curl -fsSL https://srift.app/install.sh | sh`);
    }
    if (isJson) console.log(JSON.stringify({ ok: false, error: 'not-a-binary', installScript: `https://srift.app/install.${process.platform === 'win32' ? 'ps1' : 'sh'}` }));
    return;
  }

  // Binary install path
  const archMap: Record<string, string> = {
    x64: 'x64', arm64: 'arm64', ia32: 'x86'
  };
  const osMap: Record<string, string> = {
    linux: 'linux', darwin: 'darwin', win32: 'win'
  };
  const osKey = osMap[process.platform];
  const archKey = archMap[process.arch];
  if (!osKey || !archKey) {
    console.error(`[srift] Unsupported platform: ${process.platform}/${process.arch}`);
    process.exit(1);
  }
  const target = `${osKey}-${archKey}`;
  const binaryUrl = `${SRIFT_BASE_DL_URL}/${latest}/${target}/${binName}`;
  const sumsUrl   = `${SRIFT_BASE_DL_URL}/${latest}/SHA256SUMS`;

  const tmpPath = binPath + '.new';

  // If a previous self-update aborted mid-download, the .new file is partial.
  // We resume by default, but only when the URL is the same as last time —
  // otherwise (e.g. user pinned a new version) restart from byte 0 to avoid
  // a corrupted binary. We persist the in-flight URL alongside the .new file.
  const stampPath = binPath + '.new.stamp';
  try {
    if (fs.existsSync(stampPath)) {
      const prevUrl = fs.readFileSync(stampPath, 'utf8').trim();
      if (prevUrl !== binaryUrl && fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } else if (fs.existsSync(tmpPath)) {
      // No stamp → can't trust the partial, start fresh
      fs.unlinkSync(tmpPath);
    }
    fs.writeFileSync(stampPath, binaryUrl);
  } catch { /* ignore */ }

  console.log(`[srift] Downloading ${binaryUrl} ...`);
  try {
    await downloadFile(binaryUrl, tmpPath);
  } catch (err: any) {
    if (isJson) console.log(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    console.error(`[srift] ${err?.message || err}`);
    process.exit(1);
  } finally {
    try { if (fs.existsSync(stampPath)) fs.unlinkSync(stampPath); } catch { /* ignore */ }
  }

  // Verify checksum
  try {
    const sumsContent = await fetchRaw(sumsUrl);
    const lines = sumsContent.split('\n');
    const line = lines.find((l: string) => l.trim().endsWith(binName));
    if (line) {
      const expected = line.trim().split(/\s+/)[0].toLowerCase();
      const actual = crypto.createHash('sha256').update(fs.readFileSync(tmpPath)).digest('hex');
      if (actual !== expected) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        console.error(`[srift] Checksum mismatch! Aborting update.`);
        console.error(`  Expected: ${expected}`);
        console.error(`  Got:      ${actual}`);
        if (isJson) console.log(JSON.stringify({ ok: false, error: 'checksum mismatch' }));
        process.exit(1);
      }
      console.log(`[srift] Checksum verified.`);
    } else {
      console.log(`[srift] No checksum entry for ${binName} in SHA256SUMS (continuing without verification).`);
    }
  } catch (err: any) {
    console.log(`[srift] Could not download checksum (${err?.message || err}). Continuing without verification.`);
  }

  // Atomic replace.
  // On Windows you cannot rename a file over a running .exe — so if rename
  // fails because the target is busy, write a self-cleaning .bat that swaps
  // the binaries ~2s after we exit, mirroring the uninstall pattern.
  try { fs.chmodSync(tmpPath, 0o755); } catch { /* not on win32 */ }
  const bakPath = binPath + '.bak';
  try {
    if (fs.existsSync(binPath)) {
      if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
      fs.renameSync(binPath, bakPath);
    }
    fs.renameSync(tmpPath, binPath);
    if (fs.existsSync(bakPath)) {
      try { fs.unlinkSync(bakPath); } catch { /* ignore — best-effort */ }
    }

    // Clean up any OTHER srift binaries we find on the system (stale test
    // installs, legacy paths, duplicate copies in other PATH dirs). After an
    // update there should be exactly one srift on the system — the canonical
    // ~/.srift/bin/srift[.exe].
    const others = findAllSriftBinaries().filter((p) => path.resolve(p) !== path.resolve(binPath));
    if (others.length) {
      console.log(`[srift] Cleaning ${others.length} stale srift binar${others.length === 1 ? 'y' : 'ies'} elsewhere on the system...`);
      for (const o of others) {
        const r = removeBinary(o);
        if (r.ok && !r.deferred) console.log(`           ✅ removed: ${o}`);
        else if (r.deferred)     console.log(`           ⏱  scheduled (locked): ${o}`);
        else                     console.log(`           ⚠️  could not remove: ${o}`);
      }
      // Also remove the corresponding stale PATH entries
      purgeSriftFromPath();
      // Re-add the canonical install dir to PATH (purge removed it too)
      if (process.platform === 'win32') {
        try {
          const installDir = path.dirname(binPath);
          const psCmd = [
            "$p=[System.Environment]::GetEnvironmentVariable('Path','User')",
            "if(-not $p){$p=''}",
            `$d='${installDir.replace(/'/g, "''")}'`,
            "if($p -notlike \"*$d*\"){[System.Environment]::SetEnvironmentVariable('Path',\"$d;$p\",'User')}",
          ].join(';');
          execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'ignore' });
        } catch { /* non-fatal */ }
      }
    }

    console.log(`[srift] ✅ Updated to ${latest}. Restart your terminal.`);
    if (isJson) console.log(JSON.stringify({ ok: true, from: CLI_VERSION, to: latest, cleanedStale: others.length }));
  } catch (e: any) {
    if (process.platform === 'win32' && (e?.code === 'EPERM' || e?.code === 'EBUSY' || e?.code === 'EACCES')) {
      try {
        const winBin    = binPath.replace(/\//g, '\\');
        const winTmp    = tmpPath.replace(/\//g, '\\');
        const batPath   = path.join(os.tmpdir(), `srift-update-${process.pid}-${Date.now()}.bat`);
        // Wait for parent to exit, swap in the new binary, clean up.
        const batBody =
          '@echo off\r\n' +
          'timeout /t 2 /nobreak >nul 2>&1\r\n' +
          ':swap\r\n' +
          'del /f /q "' + winBin + '" >nul 2>&1\r\n' +
          'if exist "' + winBin + '" (\r\n' +
          '  timeout /t 1 /nobreak >nul 2>&1\r\n' +
          '  goto :swap\r\n' +
          ')\r\n' +
          'move /y "' + winTmp + '" "' + winBin + '" >nul 2>&1\r\n' +
          'del /f /q "%~f0" >nul 2>&1\r\n';
        fs.writeFileSync(batPath, batBody, 'utf8');
        spawn('cmd.exe', ['/C', batPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
        }).unref();
        console.log(`[srift] ✅ Update staged. The new binary will be activated within ~2-3 seconds`);
        console.log(`         after you exit this command. Then restart your terminal.`);
        if (isJson) console.log(JSON.stringify({ ok: true, from: CLI_VERSION, to: latest, deferred: true }));
      } catch (delErr: any) {
        console.error(`[srift] Could not stage update: ${delErr?.message || delErr}`);
        if (isJson) console.log(JSON.stringify({ ok: false, error: String(delErr?.message || delErr) }));
        process.exit(1);
      }
    } else {
      console.error(`[srift] Could not replace binary: ${e?.message || e}`);
      if (isJson) console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }));
      process.exit(1);
    }
  }
}

// Robust download with:
//   • Connect + socket-idle timeouts (kills connection if no bytes flow for 30 s)
//   • Live progress on the same line ("Downloaded X.X MB (NN.N%)")
//   • Auto-resume via HTTP Range when retrying after a stall
//   • Exponential backoff retry up to 5 attempts (covers Cloudflare 5xx cache-misses,
//     Cloud Run cold-start timeouts, flaky links, and the previous "stucking forever" bug)
//   • Honours redirects (single hop)
function _downloadAttempt(
  url: string,
  dest: string,
  resumeFrom: number,
  showProgress: boolean,
  socketIdleMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': `srift-cli/${CLI_VERSION}`,
      'Accept-Encoding': 'identity', // don't gzip a binary
    };
    if (resumeFrom > 0) headers['Range'] = `bytes=${resumeFrom}-`;

    const req = https.get(url, { headers, agent: agentFor(url) }, (res) => {
      // Redirect (single hop — recurse via outer retry loop if needed)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return _downloadAttempt(res.headers.location as string, dest, resumeFrom, showProgress, socketIdleMs)
          .then(resolve).catch(reject);
      }
      const ok = res.statusCode === 200 || (res.statusCode === 206 && resumeFrom > 0);
      if (!ok) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const cl = res.headers['content-length'];
      const total = cl ? parseInt(cl as string, 10) + resumeFrom : 0;
      let received = resumeFrom;
      let lastPrint = 0;
      let lastDataAt = Date.now();

      const file = fs.createWriteStream(dest, { flags: resumeFrom > 0 ? 'a' : 'w' });

      // Stall watchdog: if no bytes for `socketIdleMs`, kill the request so the
      // outer retry loop can resume from `received`.
      const stallTimer = setInterval(() => {
        if (Date.now() - lastDataAt > socketIdleMs) {
          clearInterval(stallTimer);
          req.destroy(new Error(`Stalled — no data for ${Math.round(socketIdleMs / 1000)}s`));
        }
      }, 2000);

      res.on('data', (chunk: Buffer) => {
        lastDataAt = Date.now();
        received += chunk.length;
        if (showProgress && Date.now() - lastPrint > 500) {
          const mb = (received / 1024 / 1024).toFixed(1);
          const pct = total > 0 ? ` (${((received / total) * 100).toFixed(1)}%)` : '';
          process.stdout.write(`\r[srift] Downloaded ${mb} MB${pct}    `);
          lastPrint = Date.now();
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        clearInterval(stallTimer);
        if (showProgress) process.stdout.write('\n');
        file.close(() => resolve());
      });
      const onErr = (err: any) => {
        clearInterval(stallTimer);
        try { file.close(); } catch { /* ignore */ }
        reject(err);
      };
      file.on('error', onErr);
      res.on('error', onErr);
    });

    req.setTimeout(socketIdleMs, () => {
      req.destroy(new Error(`Connect timeout (${Math.round(socketIdleMs / 1000)}s)`));
    });
    req.on('error', reject);
  });
}

// Locate a usable curl binary on disk. On Windows we explicitly look in
// System32 because some PowerShell-flavoured shells alias `curl` to IWR.
function _findCurl(): string | null {
  if (process.platform === 'win32') {
    const win = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'curl.exe');
    if (fs.existsSync(win)) return win;
  }
  try {
    const out = execSync(process.platform === 'win32' ? 'where curl.exe' : 'which curl', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n').map((s) => s.trim()).filter(Boolean);
    for (const p of out) {
      // Skip if this is a PowerShell shim (resolves to powershell.exe)
      if (/powershell/i.test(p)) continue;
      if (fs.existsSync(p)) return p;
    }
  } catch { /* not found */ }
  return null;
}

// Download via curl.exe (preferred on every platform). Uses rustup-style
// security flags + a meaningful User-Agent so CDN logs are useful and we
// don't trip generic bot heuristics. Supports HTTP Range resume via `-C -`.
async function _runCurl(curlPath: string, url: string, dest: string, showProgress: boolean): Promise<boolean> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const ua = `srift-cli/${CLI_VERSION} (${process.platform}; ${process.arch})`;
  const args = [
    '-fL',
    '--proto', '=https',
    '--tlsv1.2',
    '-A', ua,
    '--compressed',
    '-C', '-',
    '--retry', '15',
    '--retry-delay', '4',
    '--retry-all-errors',
    '--connect-timeout', '15',
    '--max-time', '900',
    showProgress ? '--progress-bar' : '-s',
    '-o', dest,
    url,
  ];
  return new Promise<boolean>((resolve) => {
    try {
      const r = spawn(curlPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
      r.on('exit', (code) => resolve(code === 0));
      r.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Primary path: curl.exe. Empirically, on some Cloudflare POPs (notably
  // Mumbai/Singapore for the SRIFT binaries) PowerShell IWR and Node's
  // https.get get HTTP 500 while curl gets clean 200s. curl uses HTTP/1.1
  // + plain UA which Cloudflare serves cleanly from cache.
  const curlPath = _findCurl();
  if (curlPath) {
    console.log(`[srift] Downloading via curl (${curlPath}) — handles 5xx + connection drops natively.`);
    const ok = await _runCurl(curlPath, url, dest, /*showProgress*/ true);
    if (ok && fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
      console.log(''); // newline after curl's progress bar
      return;
    }
    console.log(`\n[srift] curl download failed (or file too small) — falling back to Node https.get with retry/resume.`);
  }

  // Fallback: Node https.get with retry + resume + stall detection + progress.
  // Used when curl is unavailable (very old / stripped-down systems) or
  // when curl itself failed for some reason.
  const maxAttempts = 5;
  const socketIdleMs = 30_000;
  let lastErr: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resumeFrom = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    try {
      await _downloadAttempt(url, dest, resumeFrom, /*showProgress*/ true, socketIdleMs);
      return;
    } catch (err: any) {
      lastErr = err;
      const partial = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      const partialMb = (partial / 1024 / 1024).toFixed(1);
      if (attempt >= maxAttempts) break;
      const wait = Math.min(2000 * attempt, 8000);
      console.log(
        `\n[srift] Download attempt ${attempt}/${maxAttempts} failed: ${err?.message || err}`
      );
      console.log(
        `[srift] Retrying in ${wait / 1000}s (resuming from ${partialMb} MB)...`
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  // If even resume failed (e.g. the server doesn't accept Range and keeps 5xx-ing
  // on cold start), throw the last error so the caller can surface a helpful tip.
  throw new Error(
    `Download failed after ${maxAttempts} attempts: ${lastErr?.message || lastErr}\n` +
    `  Workaround:\n` +
    `    Windows:  irm https://srift.app/install.ps1 | iex\n` +
    `    macOS/Linux:  curl -fsSL https://srift.app/install.sh | sh`
  );
}

function fetchRaw(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': `srift-cli/${CLI_VERSION}` }, agent: agentFor(url) }, (res) => {
      // Single-hop redirect support so SHA256SUMS works through any future CDN
      // redirect without hanging.
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchRaw(res.headers.location as string).then(resolve).catch(reject);
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
      res.on('error', reject);
    });
    req.setTimeout(15_000, () => req.destroy(new Error('Request timeout (15s)')));
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────
// srift doctor
// ─────────────────────────────────────────────────────────────────
async function handleDoctor(isJson: boolean, fresh: boolean, deep = false): Promise<void> {
  // stdout directly: an embedded daemon (started by --deep) redirects console.* to its log.
  const out = (s: string) => process.stdout.write(`${s}\n`);
  // Connectivity, local runtime and environment checks, each with the reason
  // and the fix, plus a concrete plan. --deep adds a real end-to-end self-test.
  let where: 'daemon' | 'embedded' | null = null;
  const report = await runDiagnostics({
    fresh, daemonPort: DAEMON_PORT, clientVersion: CLI_VERSION,
    ...(deep ? {
      selfTest: async () => {
        where = await ensureDaemonOrEmbedded({ quiet: true });
        return relaySelfTest(callDaemonApi, { via: where === 'embedded' ? 'embedded daemon' : 'background daemon', userAgent: `srift-cli/${CLI_VERSION}` });
      },
    } : {}),
  });
  let update: { latest: string; hasUpdate: boolean } | null = null;
  try {
    const data = await fetchJson(VERSION_CHECK_URL);
    update = { latest: data.latest, hasUpdate: compareVersions(data.latest, CLI_VERSION) > 0 };
  } catch { /* offline: covered by the HTTPS rung */ }
  if (isJson) {
    out(JSON.stringify({
      ...report,
      cli: { version: CLI_VERSION, latest: update?.latest ?? null, updateAvailable: update?.hasUpdate ?? null },
      config: CONFIG_FILE,
    }, null, 2));
  } else {
    out(formatDiagnostics(report));
    if (update?.hasUpdate) out(`  Update available: ${CLI_VERSION} → ${update.latest}  (srift self-update)\n`);
    if (report.verdict !== 'ok') out('  Docs: https://srift.app/ai-agents#troubleshooting\n');
  }
  process.exitCode = diagExitCode(report);
  // An embedded daemon started for the self-test would keep this process alive.
  if (where === 'embedded') process.exit(process.exitCode);
}

// ─────────────────────────────────────────────────────────────────
// srift config
// ─────────────────────────────────────────────────────────────────
async function handleConfig(args: string[], isJson: boolean): Promise<void> {
  const subCmd = args[0];
  const key    = args[1];
  const value  = args[2];

  if (subCmd === 'get') {
    const cfg = readConfig();
    if (key) {
      const val = (cfg as any)[key];
      if (isJson) console.log(JSON.stringify({ [key]: val }));
      else console.log(`${key} = ${val ?? '(not set)'}`);
    } else {
      if (isJson) console.log(JSON.stringify(cfg, null, 2));
      else {
        for (const [k, v] of Object.entries(cfg)) {
          console.log(`${k} = ${v}`);
        }
        if (Object.keys(cfg).length === 0) console.log('(no config values set)');
      }
    }
  } else if (subCmd === 'set') {
    if (!key || value === undefined) {
      console.error('Usage: srift config set <key> <value>');
      process.exit(1);
    }
    const cfg = readConfig();
    let parsed: any = value;
    if (value === 'true') parsed = true;
    else if (value === 'false') parsed = false;
    else if (!isNaN(Number(value))) parsed = Number(value);
    (cfg as any)[key] = parsed;
    writeConfig(cfg);
    if (isJson) console.log(JSON.stringify({ ok: true, [key]: parsed }));
    else console.log(`✓ ${key} = ${parsed}`);
  } else if (subCmd === 'delete' || subCmd === 'unset') {
    if (!key) { console.error('Usage: srift config delete <key>'); process.exit(1); }
    const cfg = readConfig();
    delete (cfg as any)[key];
    writeConfig(cfg);
    if (isJson) console.log(JSON.stringify({ ok: true, deleted: key }));
    else console.log(`✓ Deleted ${key}`);
  } else if (!subCmd) {
    // Print all config + path
    const cfg = readConfig();
    console.log(`Config file: ${CONFIG_FILE}`);
    if (isJson) { console.log(JSON.stringify(cfg, null, 2)); return; }
    for (const [k, v] of Object.entries(cfg)) console.log(`  ${k} = ${v}`);
    if (Object.keys(cfg).length === 0) console.log('  (no config values set)');
    console.log('\nKeys: updateCheck (bool), updateCheckIntervalHours (number)');
  } else {
    console.error('Usage: srift config [get|set|delete] [key] [value]');
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────
// Shared daemon HTTP request helper
// ─────────────────────────────────────────────────────────────────
function daemonRequest(method: string, urlPath: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: DAEMON_PORT,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve({ raw: d, statusCode: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Helper to check if daemon is running
function isDaemonRunning(timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    // Bounded: something else on the port (or a black-holing firewall) may
    // accept the connection and never answer.
    const req = http.get(`${DAEMON_URL}/status`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Background daemon if possible; otherwise host it in this process (no port).
 * Returns 'embedded' when this process now serves links itself.
 */
async function ensureDaemonOrEmbedded(opts: { force?: boolean; quiet?: boolean } = {}): Promise<'daemon' | 'embedded'> {
  if (!opts.force) {
    try { await ensureDaemon(); return 'daemon'; } catch (e: any) {
      if (process.env.SRIFT_NO_EMBEDDED === '1') throw e;
      if (!opts.quiet) console.error(`[srift] Background daemon unavailable (${String(e?.message || e).split('\n')[0]}) — serving from this process instead.`);
    }
  }
  await startEmbeddedDaemon();
  return 'embedded';
}

// Helper to start daemon in background
async function ensureDaemon(): Promise<void> {
  const running = await isDaemonRunning();
  if (running) return;

  // Sandboxes that forbid local servers fail the bind immediately: skip the
  // spawn + 5 s wait and let callers fall back to the embedded daemon.
  const preBind = await new Promise<string | null>((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e: any) => resolve(e?.code || 'EUNKNOWN'));
    srv.listen(DAEMON_PORT, '127.0.0.1', () => srv.close(() => resolve(null)));
  });
  if (preBind === 'EPERM' || preBind === 'EACCES') {
    throw Object.assign(new Error(`This environment does not allow local servers (${preBind} binding 127.0.0.1:${DAEMON_PORT}).`), { code: preBind });
  }

  const isMcp = process.argv.includes('mcp');
  // Status chatter goes to stderr: stdout carries command output (--json, MCP stdio).
  const logFn = console.error;
  void isMcp;

  logFn('[SRIFT] Starting background transfer daemon...');

  // Determine how to spawn the daemon depending on runtime mode.
  //  1. Bun-compiled standalone binary (Windows / Linux / macOS prod install)
  //     → self-spawn:  <srift.exe>  daemon  start
  //     (the binary already knows how to run the embedded daemon.ts)
  //  2. Pre-bundled JS  (npm-installed)            →  node  daemon.js
  //  3. TypeScript source  (dev / npm run srift)   →  node --experimental-strip-types daemon.ts
  const isBunBinary =
    !!(process.versions && (process.versions as any).bun) ||
    (typeof (process as any).isBun === 'boolean' && (process as any).isBun);
  const execBase = path.basename(process.execPath || '').toLowerCase();
  const isCompiledBinary =
    isBunBinary ||
    execBase === 'srift' ||
    execBase === 'srift.exe';

  let execCmd: string;
  let spawnArgs: string[];
  if (isCompiledBinary) {
    execCmd = process.execPath;
    spawnArgs = ['daemon', 'start'];
  } else {
    const isJs = __filename.endsWith('.js');
    const daemonFile = isJs ? 'daemon.js' : 'daemon.ts';
    const daemonPath = path.join(__dirname, daemonFile);
    execCmd = process.execPath;
    spawnArgs = isJs ? [daemonPath] : ['--experimental-strip-types', daemonPath];
  }

  // Spawn daemon background process completely detached with no inherited stdio handles
  const child = spawn(
    execCmd,
    spawnArgs,
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        SRIFT_DAEMON_PORT: DAEMON_PORT.toString(),
        // Node >= 24.5 can route its built-in HTTP clients through HTTP(S)_PROXY.
        // SRIFT's own requests already use explicit tunnelling agents.
        ...(proxyEnvPresent() && nodeAtLeast(24, 5) ? { NODE_USE_ENV_PROXY: '1' } : {}),
      },
    }
  );

  // A refused spawn (EPERM/EACCES/ENOENT in locked-down containers) emits
  // 'error' asynchronously; unhandled, it would crash the CLI before the
  // embedded fallback can run.
  let spawnError: string | null = null;
  child.on('error', (e: any) => { spawnError = e?.code || e?.message || 'spawn failed'; });
  child.unref();

  // Wait for daemon to respond: a hard 6 s deadline (each probe is bounded too,
  // so a port that accepts but never answers cannot stretch this).
  const readyBy = Date.now() + 6000;
  while (Date.now() < readyBy) {
    if (spawnError) throw Object.assign(new Error(`Could not start the background daemon process (${spawnError}).`), { code: 'ESPAWN' });
    await new Promise((r) => setTimeout(r, 100));
    if (await isDaemonRunning(Math.max(200, Math.min(1500, readyBy - Date.now())))) {
      logFn('[SRIFT] Daemon started successfully.');
      return;
    }
  }

  // Why did it not come up? Try the bind ourselves: EADDRINUSE is a real port
  // conflict, EPERM/EACCES means a sandbox forbids local servers.
  const bindCode = await new Promise<string | null>((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e: any) => resolve(e?.code || 'EUNKNOWN'));
    srv.listen(DAEMON_PORT, '127.0.0.1', () => srv.close(() => resolve(null)));
  });

  if (bindCode === 'EADDRINUSE') {
    throw Object.assign(new Error(
      `Port ${DAEMON_PORT} is already in use by another process.\n` +
      `  Try: SRIFT_DAEMON_PORT=3823 srift daemon start\n` +
      `  Or stop whatever is using port ${DAEMON_PORT}.`
    ), { code: 'EADDRINUSE' });
  }
  if (bindCode === 'EPERM' || bindCode === 'EACCES') {
    throw Object.assign(new Error(
      `This environment does not allow local servers (${bindCode} binding 127.0.0.1:${DAEMON_PORT}) — likely a sandbox.\n` +
      `  quick-share and mcp serve from their own process instead (no port needed).\n` +
      `  Details:  srift doctor`
    ), { code: bindCode });
  }

  throw new Error(
    'Failed to start daemon background process.\n' +
    `  Try manually: srift daemon start\n` +
    `  Check logs:   srift logs\n` +
    `  Diagnose:     srift doctor`
  );
}

// ─────────────────────────────────────────────────────────────────
// srift status  (unified daemon + session + transfers view)
// ─────────────────────────────────────────────────────────────────
async function handleStatus(isJson: boolean): Promise<void> {
  let daemonInfo: any = null;
  let sessionInfo: any = null;
  let transfersInfo: any[] = [];
  let daemonRunning = false;

  try {
    daemonInfo = await new Promise<any>((resolve, reject) => {
      const req = http.get(`${DAEMON_URL}/health`, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json')); } });
      });
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('timeout')));
    });
    daemonRunning = daemonInfo.ok ?? true;
  } catch { /* not running */ }

  if (daemonRunning) {
    try { sessionInfo = await daemonRequest('GET', '/status'); } catch { /* ignore */ }
    try {
      const t = await daemonRequest('GET', '/transfers');
      if (Array.isArray(t)) transfersInfo = t;
      else if (t && Array.isArray(t.transfers)) transfersInfo = t.transfers;
    } catch { /* ignore */ }
  }

  if (isJson) {
    console.log(JSON.stringify({
      daemon: daemonRunning
        ? { running: true, version: daemonInfo?.version, uptime_ms: daemonInfo?.uptime_ms, port: DAEMON_PORT, mcp: daemonInfo?.mcp, webtorrent: daemonInfo?.webtorrent }
        : { running: false },
      session: sessionInfo ?? null,
      transfers: { count: transfersInfo.length, items: transfersInfo },
    }, null, 2));
    return;
  }

  console.log(`\nsrift status\n`);
  if (daemonRunning) {
    const uptimeSec = Math.round((daemonInfo?.uptime_ms ?? 0) / 1000);
    console.log(`  Daemon:     running  v${daemonInfo?.version ?? '?'}  uptime=${uptimeSec}s  port=${DAEMON_PORT}`);
    console.log(`              mcp=${daemonInfo?.mcp ?? '?'}  webtorrent=${daemonInfo?.webtorrent ?? '?'}`);
  } else {
    console.log(`  Daemon:     not running`);
    console.log(`              Start with: srift daemon start`);
  }

  if (daemonRunning) {
    const s = sessionInfo?.session ?? sessionInfo;
    if (s?.id) {
      const peers = s.peerCount ?? s.peers ?? 0;
      console.log(`\n  Session:    ${s.id}  role=${s.role ?? '?'}  peers=${peers}  connected=${s.isConnected ?? s.connected ?? '?'}`);
    } else {
      console.log(`\n  Session:    none  (start one: srift session start)`);
    }

    if (transfersInfo.length > 0) {
      console.log(`\n  Transfers:  ${transfersInfo.length} active`);
      for (const t of transfersInfo.slice(0, 5)) {
        const pct = typeof t.progress === 'number' ? `${t.progress.toFixed(1)}%` : '?%';
        console.log(`    ${(t.fileId ?? t.id ?? '?').padEnd(32)}  ${(t.name ?? '?').padEnd(24)}  ${pct.padStart(6)}  ${t.status ?? ''}`);
      }
      if (transfersInfo.length > 5) console.log(`    … and ${transfersInfo.length - 5} more`);
    } else {
      console.log(`\n  Transfers:  none`);
    }
  }
  console.log('');
}

// ─────────────────────────────────────────────────────────────────
// srift daemon status  (daemon health only)
// ─────────────────────────────────────────────────────────────────
async function handleDaemonStatus(isJson: boolean): Promise<void> {
  let info: any = null;
  let running = false;

  try {
    info = await new Promise<any>((resolve, reject) => {
      const req = http.get(`${DAEMON_URL}/health`, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json')); } });
      });
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('timeout')));
    });
    running = info.ok ?? true;
  } catch { /* not running */ }

  if (isJson) {
    console.log(JSON.stringify(running ? { running: true, ...info } : { running: false }, null, 2));
    return;
  }

  if (running) {
    const uptimeSec = Math.round((info?.uptime_ms ?? 0) / 1000);
    console.log(`\nDaemon status: running`);
    console.log(`  version      ${info?.version ?? '?'}`);
    console.log(`  port         ${DAEMON_PORT}`);
    console.log(`  uptime       ${uptimeSec}s`);
    console.log(`  mcp          ${info?.mcp ?? '?'}`);
    console.log(`  webtorrent   ${info?.webtorrent ?? '?'}`);
  } else {
    console.log(`\nDaemon status: not running`);
    console.log(`  Start with: srift daemon start`);
  }
  console.log('');
}

// ─────────────────────────────────────────────────────────────────
// srift daemon restart
// ─────────────────────────────────────────────────────────────────
async function handleDaemonRestart(): Promise<void> {
  console.log('[srift] Restarting daemon...');
  // Attempt graceful reset first, then stop
  try { await daemonRequest('POST', '/reset'); } catch { /* daemon may not be up */ }
  try { await handleDaemonStop(false); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 500));
  await ensureDaemon();
  console.log('[srift] Daemon restarted successfully.');
}

// ─────────────────────────────────────────────────────────────────
// srift reset  (POST /reset on daemon)
// ─────────────────────────────────────────────────────────────────
async function handleReset(isJson: boolean): Promise<void> {
  let result: any;
  try {
    result = await daemonRequest('POST', '/reset');
  } catch (e) {
    if (isJson) {
      console.log(JSON.stringify({ ok: false, error: String(e) }));
    } else {
      console.error(`[srift] Reset failed: ${e}`);
      console.error(`  Is the daemon running? Start it: srift daemon start`);
    }
    process.exit(1);
  }
  if (isJson) {
    console.log(JSON.stringify({ ok: true, ...(result ?? {}) }));
  } else {
    console.log(`[srift] Reset complete. Session state wiped, encryption keys flushed.`);
  }
}

// ─────────────────────────────────────────────────────────────────
// srift logs
// ─────────────────────────────────────────────────────────────────
async function handleLogs(tail: number, jsonStream: boolean): Promise<void> {
  let result: any;
  try {
    result = await daemonRequest('GET', `/logs?lines=${tail}&n=${tail}`);
  } catch (e) {
    console.error(`[srift] Cannot retrieve logs: ${e}`);
    console.error(`  Is the daemon running? Start it: srift daemon start`);
    process.exit(1);
  }

  // Normalize response: may be array, { logs: [] }, or { raw: 'ndjson' }
  let lines: string[] = [];
  if (Array.isArray(result)) {
    lines = result.map((l: any) => (typeof l === 'string' ? l : JSON.stringify(l)));
  } else if (result?.logs && Array.isArray(result.logs)) {
    lines = result.logs.map((l: any) => (typeof l === 'string' ? l : JSON.stringify(l)));
  } else if (result?.raw && typeof result.raw === 'string') {
    lines = result.raw.split('\n').filter(Boolean);
  } else {
    lines = [JSON.stringify(result)];
  }

  for (const line of lines) {
    if (jsonStream) {
      console.log(line);
    } else {
      try {
        const obj = JSON.parse(line);
        const ts = obj.ts ?? obj.time ?? obj.timestamp ?? '';
        const level = (obj.level ?? obj.severity ?? 'info').toUpperCase();
        const msg = obj.msg ?? obj.message ?? obj.text ?? line;
        console.log(`${ts ? ts + '  ' : ''}[${level}]  ${msg}`);
      } catch {
        console.log(line);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Helper: find EVERY srift binary on the system.
// Looks at: `where srift` (Win) / `which -a srift` (Unix), every PATH entry
// (both User PATH on Windows and the current $PATH), plus the canonical
// `~/.srift/bin/srift[.exe]` and the running `process.execPath` if it points
// to a srift binary. De-dups by absolute path.
// ─────────────────────────────────────────────────────────────────
function findAllSriftBinaries(): string[] {
  const binName = process.platform === 'win32' ? 'srift.exe' : 'srift';
  const found = new Set<string>();

  const add = (p: string | undefined | null) => {
    if (!p) return;
    try {
      const abs = path.resolve(p);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) found.add(abs);
    } catch { /* ignore */ }
  };

  // 1. The running binary (if compiled)
  const execBase = path.basename(process.execPath || '').toLowerCase();
  if (execBase === 'srift' || execBase === 'srift.exe') add(process.execPath);

  // 2. Canonical install path
  add(path.join(os.homedir(), '.srift', 'bin', binName));

  // 3. `where` / `which -a` — finds every match on PATH, not just the first
  try {
    const cmd = process.platform === 'win32' ? 'where srift' : 'which -a srift';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n').map((s) => s.trim()).filter(Boolean)) add(line);
  } catch { /* not on PATH */ }

  // 4. Walk every PATH directory looking for a srift binary (catches stale
  //    test installs that `where srift` may have missed on shadowing rules)
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    // Also walk User PATH from the registry (in case our parent shell predated install)
    try {
      const userPath = execSync(
        `powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('Path','User')"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (userPath) for (const d of userPath.split(';')) if (d) pathDirs.push(d);
    } catch { /* ignore */ }
  }
  for (const dir of pathDirs) add(path.join(dir, binName));

  return Array.from(found);
}

// Helper: clean ALL srift-referencing entries from User PATH (Windows) or
// shell rc files (Unix), broadcast WM_SETTINGCHANGE on Windows so newly
// opened shells lose the references immediately.
function purgeSriftFromPath(): void {
  if (process.platform === 'win32') {
    try {
      const psCmd = [
        "$p=[System.Environment]::GetEnvironmentVariable('Path','User')",
        "if(-not $p){$p=''}",
        // Drop any entry containing 'srift' (case-insensitive). The CLI lives
        // at ~/.srift/bin so the substring is a reliable marker.
        "$new=($p -split ';' | Where-Object { $_ -and ($_ -notmatch '[Ss]rift') }) -join ';'",
        "[System.Environment]::SetEnvironmentVariable('Path',$new,'User')",
        // Broadcast so newly-opened cmd/PowerShell windows see the change
        "try{$s='[DllImport(\\\"user32.dll\\\")] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r);';if(-not('W.M' -as [type])){Add-Type -MemberDefinition $s -Namespace W -Name M | Out-Null};$r=[UIntPtr]::Zero;[W.M]::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'Environment',0x0002,5000,[ref]$r) | Out-Null}catch{}",
      ].join(';');
      execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'ignore' });
      console.log('[srift] Cleaned all srift entries from Windows user PATH (+ broadcast to open windows).');
    } catch { /* non-fatal */ }
    return;
  }

  // Unix shell rc files
  const rcFiles = [
    path.join(os.homedir(), '.bashrc'),
    path.join(os.homedir(), '.zshrc'),
    path.join(os.homedir(), '.profile'),
    path.join(os.homedir(), '.bash_profile'),
    path.join(os.homedir(), '.config', 'fish', 'config.fish'),
  ];
  for (const rc of rcFiles) {
    if (!fs.existsSync(rc)) continue;
    try {
      const original = fs.readFileSync(rc, 'utf8');
      const filtered = original
        .split('\n')
        .filter((l) => !/\.srift[\/\\]bin/.test(l) && l.trim() !== '# SRIFT' && !l.includes('fish_add_path ~/.srift'))
        .join('\n');
      if (filtered !== original) {
        fs.writeFileSync(rc, filtered);
        console.log(`[srift] Cleaned srift PATH entry from: ${rc}`);
      }
    } catch { /* ignore */ }
  }
}

// Helper: schedule a single binary deletion via a self-cleaning .bat on
// Windows when the running .exe is locked. Returns true if scheduled.
function scheduleWindowsDelete(binaryPath: string): boolean {
  try {
    const winBin = binaryPath.replace(/\//g, '\\');
    const batPath = path.join(os.tmpdir(), `srift-uninstall-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bat`);
    const batBody =
      '@echo off\r\n' +
      'timeout /t 2 /nobreak >nul 2>&1\r\n' +
      'if not exist "' + winBin + '" goto :selfDelete\r\n' +
      ':retry\r\n' +
      'del /f /q "' + winBin + '" >nul 2>&1\r\n' +
      'if exist "' + winBin + '" (\r\n' +
      '  timeout /t 1 /nobreak >nul 2>&1\r\n' +
      '  goto :retry\r\n' +
      ')\r\n' +
      ':selfDelete\r\n' +
      'del /f /q "%~f0" >nul 2>&1\r\n';
    fs.writeFileSync(batPath, batBody, 'utf8');
    spawn('cmd.exe', ['/C', batPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    }).unref();
    return true;
  } catch {
    return false;
  }
}

// Helper: try to remove a binary; falls back to delayed delete on Windows.
function removeBinary(binaryPath: string): { ok: boolean; deferred: boolean } {
  try {
    fs.unlinkSync(binaryPath);
    return { ok: true, deferred: false };
  } catch (e: any) {
    if (process.platform === 'win32' && (e?.code === 'EPERM' || e?.code === 'EBUSY' || e?.code === 'EACCES' || e?.code === 'ENOTEMPTY')) {
      // The running .exe is file-locked: Windows won't let us DELETE a binary
      // that's currently executing (this very process). It WILL let us RENAME
      // it, though — the open handle follows the moved file. So move it out of
      // the way immediately: this frees the canonical `srift.exe` path and the
      // PATH lookup right now (so `srift` stops resolving the instant we exit),
      // then schedule the renamed leftover for deletion a couple seconds later.
      try {
        const renamed = `${binaryPath}.old-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        fs.renameSync(binaryPath, renamed);
        scheduleWindowsDelete(renamed);
        return { ok: true, deferred: true };
      } catch {
        // Rename failed (rare — e.g. cross-volume or AV lock): fall back to
        // scheduling deletion of the original path after we exit.
        const scheduled = scheduleWindowsDelete(binaryPath);
        return { ok: scheduled, deferred: scheduled };
      }
    }
    return { ok: false, deferred: false };
  }
}

// ─────────────────────────────────────────────────────────────────
// srift uninstall [--purge]
//
// Removes EVERY srift binary on the system (not just the one in
// ~/.srift/bin/), cleans EVERY srift-referencing entry from PATH,
// removes scheduled-delete .bat residue, and — with --purge — also
// deletes ~/.srift/ entirely (config + state + logs).
// ─────────────────────────────────────────────────────────────────
async function handleUninstall(purge: boolean): Promise<void> {
  console.log('[srift] Starting uninstall...');

  // 1. Stop daemon if running
  const running = await isDaemonRunning();
  if (running) {
    console.log('[srift] Stopping daemon...');
    try { await handleDaemonStop(false); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  // 2. Locate EVERY srift binary on the system
  const binaries = findAllSriftBinaries();
  if (binaries.length === 0) {
    console.log('[srift] No srift binaries found on disk.');
  } else {
    console.log(`[srift] Found ${binaries.length} srift binar${binaries.length === 1 ? 'y' : 'ies'} on disk:`);
    for (const b of binaries) console.log(`           ${b}`);
  }

  // 3. Remove every one (deferred on Windows for any that are file-locked)
  let removedNow = 0;
  let deferred = 0;
  const failed: string[] = [];
  for (const b of binaries) {
    const r = removeBinary(b);
    if (r.ok && !r.deferred) {
      removedNow++;
    } else if (r.deferred) {
      deferred++;
    } else {
      failed.push(b);
    }
  }
  if (removedNow > 0) console.log(`[srift] Removed ${removedNow} binar${removedNow === 1 ? 'y' : 'ies'} immediately.`);
  if (deferred > 0)   console.log(`[srift] Scheduled ${deferred} locked binar${deferred === 1 ? 'y' : 'ies'} for deletion ~2-3s after this command exits.`);
  if (failed.length) {
    console.error(`[srift] Could not remove ${failed.length}:`);
    failed.forEach((f) => console.error(`           ${f}`));
  }

  // 4. Also empty stale install dirs (e.g. ~/.srift/bin/ may contain .new/.bak residue)
  const standardInstallDir = path.join(os.homedir(), '.srift', 'bin');
  if (fs.existsSync(standardInstallDir)) {
    try {
      for (const f of fs.readdirSync(standardInstallDir)) {
        const fp = path.join(standardInstallDir, f);
        try { fs.unlinkSync(fp); } catch { /* may be the locked .exe — handled above */ }
      }
    } catch { /* ignore */ }
  }

  // 5. --purge: remove ~/.srift/ entirely
  if (purge) {
    const sriftDir = path.join(os.homedir(), '.srift');
    if (fs.existsSync(sriftDir)) {
      try {
        fs.rmSync(sriftDir, { recursive: true, force: true });
        console.log(`[srift] Purged directory: ${sriftDir}`);
      } catch (e: any) {
        // Likely a locked .exe inside .srift/bin/ — schedule its parent for cleanup too
        if (process.platform === 'win32') {
          const batPath = path.join(os.tmpdir(), `srift-purge-${process.pid}-${Date.now()}.bat`);
          const winDir = sriftDir.replace(/\//g, '\\');
          const batBody =
            '@echo off\r\n' +
            'timeout /t 3 /nobreak >nul 2>&1\r\n' +
            ':retry\r\n' +
            'rmdir /s /q "' + winDir + '" >nul 2>&1\r\n' +
            'if exist "' + winDir + '" (\r\n' +
            '  timeout /t 1 /nobreak >nul 2>&1\r\n' +
            '  goto :retry\r\n' +
            ')\r\n' +
            'del /f /q "%~f0" >nul 2>&1\r\n';
          try {
            fs.writeFileSync(batPath, batBody, 'utf8');
            spawn('cmd.exe', ['/C', batPath], { detached: true, stdio: 'ignore', windowsHide: true, shell: false }).unref();
            console.log(`[srift] Scheduled purge of ${sriftDir} (~3s after exit).`);
          } catch (ee: any) {
            console.error(`[srift] Could not schedule purge: ${ee?.message || ee}`);
          }
        } else {
          console.error(`[srift] Could not purge ${sriftDir}: ${e?.message || e}`);
        }
      }
    }
  }

  // 6. Clean ALL srift entries from PATH (User PATH on Windows, shell rc files on Unix)
  purgeSriftFromPath();

  // 7. Clean stale scheduled-delete .bat files from previous incomplete uninstalls
  if (process.platform === 'win32') {
    try {
      const tmp = os.tmpdir();
      for (const f of fs.readdirSync(tmp)) {
        if (/^srift-(uninstall|update|purge)-.*\.bat$/.test(f)) {
          try { fs.unlinkSync(path.join(tmp, f)); } catch { /* may be the one we just spawned */ }
        }
      }
    } catch { /* ignore */ }
  }

  console.log(`\n[srift] Uninstall complete.`);
  if (!purge) {
    console.log(`  Config + data at ~/.srift/ preserved. Re-run with --purge to also delete them.`);
  }
  console.log(`  Reinstall:`);
  console.log(`    macOS/Linux/WSL:  curl -fsSL https://srift.app/install.sh | sh`);
  console.log(`    Windows PS:       irm https://srift.app/install.ps1 | iex`);
  console.log(`    Windows cmd:      powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://srift.app/install.ps1 | iex"`);
}

// ─────────────────────────────────────────────────────────────────
// "Did you mean?" helper
// ─────────────────────────────────────────────────────────────────
const ALL_COMMANDS = [
  'daemon', 'session', 'send', 'receive', 'list', 'monitor',
  'approve', 'reject', 'kick', 'chat', 'mcp', 'quick-share', 'share',
  'pubshare', 'links', 'get', 'download', 'history', 'completion',
  'install-mcp', 'install', 'info', 'version', 'self-update', 'update',
  'doctor', 'config', 'status', 'reset', 'logs', 'uninstall',
  'agentnet', 'an', 'bootstrap',
];

function suggestCommand(input: string): string | null {
  // Exact prefix match first
  const prefixMatch = ALL_COMMANDS.find((c) => c.startsWith(input) || input.startsWith(c.slice(0, 3)));
  if (prefixMatch) return prefixMatch;
  // Simple edit-distance of 1–2
  for (const cmd of ALL_COMMANDS) {
    let diffs = 0;
    const shorter = input.length < cmd.length ? input : cmd;
    const longer = input.length < cmd.length ? cmd : input;
    for (let i = 0; i < shorter.length; i++) {
      if (shorter[i] !== longer[i]) diffs++;
    }
    diffs += Math.abs(input.length - cmd.length);
    if (diffs <= 2) return cmd;
  }
  return null;
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const isJson = args.includes('--json');
  const noDaemon = args.includes('--no-daemon');

  switch (command) {
    case 'status': {
      // Unified view — never auto-start daemon (status-only)
      await handleStatus(isJson);
      break;
    }

    case 'reset': {
      await handleReset(isJson);
      break;
    }

    case 'logs': {
      const tailIdx = args.indexOf('--tail');
      const tail = tailIdx !== -1 ? parseInt(args[tailIdx + 1] ?? '50', 10) : 50;
      const jsonStream = args.includes('--json-stream');
      await handleLogs(tail, jsonStream);
      break;
    }

    case 'uninstall': {
      const purge = args.includes('--purge');
      await handleUninstall(purge);
      break;
    }

    case 'daemon': {
      const subCommand = args[1];
      if (subCommand === 'start') {
        // Start daemon in foreground (usually called by spawn or manually for debugging)
        await import('./daemon.ts');
      } else if (subCommand === 'stop') {
        await handleDaemonStop(isJson);
      } else if (subCommand === 'restart') {
        await handleDaemonRestart();
      } else if (subCommand === 'status') {
        await handleDaemonStatus(isJson);
      } else {
        console.error('Usage: srift daemon [start|stop|restart|status]');
        process.exit(1);
      }
      break;
    }

    case 'session': {
      const subCommand = args[1];
      await ensureDaemon();

      if (subCommand === 'start') {
        const nameIdx = args.indexOf('--name');
        const name = nameIdx !== -1 ? args[nameIdx + 1] : undefined;
        const secretIdx = args.indexOf('--room-secret');
        const secret = secretIdx !== -1 ? args[secretIdx + 1] : undefined;
        await handleSessionStart(name, secret, isJson);
      } else if (subCommand === 'join') {
        const sessionId = args[2];
        if (!sessionId) {
          console.error('Usage: srift session join <session-id> [--username <username>] [--room-secret <secret>]');
          process.exit(1);
        }
        const userIdx = args.indexOf('--username');
        const username = userIdx !== -1 ? args[userIdx + 1] : undefined;
        const secretIdx = args.indexOf('--room-secret');
        const secret = secretIdx !== -1 ? args[secretIdx + 1] : undefined;
        await handleSessionJoin(sessionId, username, secret, isJson);
      } else if (subCommand === 'status') {
        await handleSessionStatus(isJson);
      } else if (subCommand === 'close') {
        await handleSessionClose(isJson);
      } else {
        console.error('Unknown session command. Try: start, join, status, close');
        process.exit(1);
      }
      break;
    }

    case 'send': {
      const filePath = args[1];
      if (!filePath) {
        console.error('Usage: srift send <filepath> [--json]');
        process.exit(1);
      }
      // --protocol kept as an internal/debug flag (no longer documented).
      const protocolIdx = args.indexOf('--protocol');
      const protocol = protocolIdx !== -1 ? args[protocolIdx + 1] : undefined;
      await ensureDaemon();
      await handleSendFile(filePath, protocol, isJson);
      break;
    }

    case 'receive': {
      const fileId = args[1];
      if (!fileId) {
        console.error('Usage: srift receive <file-id> [--save-dir <dir>] [--json]');
        process.exit(1);
      }
      const dirIdx = args.indexOf('--save-dir');
      const saveDir = dirIdx !== -1 ? args[dirIdx + 1] : undefined;
      await ensureDaemon();
      await handleReceiveFile(fileId, saveDir, isJson);
      break;
    }

    case 'list': {
      await ensureDaemon();
      await handleListTransfers(isJson);
      break;
    }

    case 'monitor': {
      const fileId = args[1];
      if (!fileId) {
        console.error('Usage: srift monitor <file-id> [--json-stream]');
        process.exit(1);
      }
      const jsonStream = args.includes('--json-stream');
      await ensureDaemon();
      await handleMonitorTransfer(fileId, jsonStream);
      break;
    }

    case 'approve': {
      const tempUserId = args[1];
      if (!tempUserId) {
        console.error('Usage: srift approve <temp-user-id> [--json]');
        process.exit(1);
      }
      await ensureDaemon();
      await handleApproveJoin(tempUserId, isJson);
      break;
    }

    case 'reject': {
      const tempUserId = args[1];
      if (!tempUserId) {
        console.error('Usage: srift reject <temp-user-id> [--reason <reason>] [--json]');
        process.exit(1);
      }
      const reasonIdx = args.indexOf('--reason');
      const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : undefined;
      await ensureDaemon();
      await handleRejectJoin(tempUserId, reason, isJson);
      break;
    }

    case 'kick': {
      const userId = args[1];
      if (!userId) {
        console.error('Usage: srift kick <user-id> [--json]');
        process.exit(1);
      }
      await ensureDaemon();
      await handleKickUser(userId, isJson);
      break;
    }

    case 'chat': {
      const subCommand = args[1];
      await ensureDaemon();

      if (subCommand === 'send') {
        const msg = args[2];
        if (!msg) {
          console.error('Usage: srift chat send "<message>" [--json]');
          process.exit(1);
        }
        await handleChatSend(msg, isJson);
      } else if (subCommand === 'history') {
        await handleChatHistory(isJson);
      } else {
        console.error('Unknown chat command. Try: send, history');
        process.exit(1);
      }
      break;
    }

    case 'mcp': {
      try {
        // Sandboxes may forbid local servers: the MCP process then hosts the
        // daemon itself (no port), so every tool keeps working while it runs.
        await ensureDaemonOrEmbedded({ force: args.includes('--foreground') });
      } catch (e: any) {
        console.error(`[SRIFT] Daemon unavailable: ${String(e?.message || e).split('\n')[0]} — tools will retry on first use.`);
      }
      startMcpServer();
      break;
    }

    case 'quick-share':
    case 'share': {
      const targets = positionals(args, 1);
      const target = targets[0];
      if (!target) {
        console.error('Usage: srift quick-share <file|folder|-> [more files/folders…] [--encrypt]');
        console.error('         several paths → one .tar.gz link (default) or one link each with --separate [--bundle-name <n>]');
        console.error('         [--password <pw>] [--ttl 30s|15m|2h|1d] [--once|--max-downloads N]');
        console.error('         [--filename <name>] [--exclude <glob>]... [--qr] [--json]');
        process.exit(1);
      }
      const maxRaw = flagValue(args, '--max-downloads');
      let maxDownloads = maxRaw !== undefined ? parseInt(maxRaw, 10) : 0;
      if (maxRaw !== undefined && (!Number.isFinite(maxDownloads) || maxDownloads < 0)) {
        console.error(`Invalid --max-downloads: "${maxRaw}"`); process.exit(1);
      }
      if (args.includes('--once')) maxDownloads = 1;
      const ttlRaw = flagValue(args, '--ttl');
      const ttlMs = ttlRaw !== undefined ? parseDuration(ttlRaw) : 0;
      if (ttlRaw !== undefined && ttlMs <= 0) {
        console.error(`Invalid --ttl: "${ttlRaw}". Use 30s, 15m, 2h, 1d.`);
        process.exit(1);
      }
      const modeRaw = flagValue(args, '--mode');
      if (modeRaw !== undefined && !['auto', 'relay'].includes(modeRaw.toLowerCase())) {
        console.error(`Unsupported --mode "${modeRaw}": SRIFT does not store files on a server; links are served by your local daemon.`); process.exit(1);
      }
      const password = flagValue(args, '--password') ?? process.env.SRIFT_LINK_PASSWORD;
      if (password && args.includes('--no-encrypt')) {
        console.error('--password needs encryption; drop --no-encrypt.'); process.exit(1);
      }
      const encrypt = !!password || args.includes('--encrypt');
      const qr = args.includes('--qr');
      // --filename sets the recipient-visible name; --name keeps its original
      // meaning (session name) so existing scripts don't silently rename files.
      let displayName = flagValue(args, '--filename');
      const sessionName = flagValue(args, '--name') ?? flagValue(args, '--session-name');

      // Resolve what to share: file, folder (packed to .tar.gz) or stdin.
      let filePath: string;
      try {
        if (target === '-') {
          displayName = displayName || 'stdin.bin';
          filePath = outboxPath(displayName.replace(/[\\/]/g, '_'));
          const n = await stdinToFile(filePath);
          if (!isJson) console.error(`[srift] Read ${n} bytes from stdin.`);
        } else {
          const abs = path.resolve(target);
          if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
          if (fs.statSync(abs).isDirectory()) {
            const base = path.basename(abs) || 'folder';
            displayName = displayName || `${base}.tar.gz`;
            filePath = outboxPath(displayName.replace(/[\\/]/g, '_'));
            const excludes = [...DEFAULT_EXCLUDES, ...flagValues(args, '--exclude')];
            const r = await packDirectory(abs, filePath, excludes);
            if (!isJson) console.error(`[srift] Packed ${r.files} file(s), ${r.bytes} bytes → ${path.basename(filePath)} (excluded: ${excludes.join(', ')})`);
          } else {
            filePath = abs;
          }
        }
      } catch (e: any) {
        if (isJson) console.log(JSON.stringify({ success: false, error: e.message }));
        else console.error(`Error: ${e.message}`);
        process.exit(1);
      }

      const opts: QuickShareOpts = { maxDownloads, ttlMs, encrypt, password, name: displayName, qr };
      const waitRaw = flagValue(args, '--wait-timeout');
      const waitTimeoutMs = waitRaw !== undefined ? parseDuration(waitRaw) : 0;
      if (waitRaw !== undefined && waitTimeoutMs <= 0) { console.error(`Invalid --wait-timeout: "${waitRaw}". Use 30s, 15m, 2h, 1d.`); process.exit(1); }

      // Embedded: this process IS the server, so it must stay up until every
      // recipient has the file(s). --wait does the same with a background daemon.
      const waitIfNeeded = async (where: 'daemon' | 'embedded', tokens: string[]) => {
        if (!tokens.length || !(where === 'embedded' || args.includes('--wait') || args.includes('--keep-alive'))) return;
        const err = realConsole().error;
        const keepAlive = args.includes('--keep-alive');
        const what = tokens.length > 1 ? `all ${tokens.length} links are downloaded` : 'the download';
        if (!isJson) err(where === 'embedded'
          ? `[srift] Serving from this process (no background daemon here). Keep it running until ${what} — ${keepAlive ? 'Ctrl-C stops the links' : 'it exits by itself afterwards'}.`
          : `[srift] Waiting until ${what}…`);
        const whys = await Promise.all(tokens.map((t) => waitForDownloads(t, { keepAlive, timeoutMs: waitTimeoutMs || undefined })));
        if (!isJson) err(`[srift] Done: ${tokens.length > 1 ? whys.map((w, i) => `#${i + 1} ${w}`).join(', ') : whys[0]}.`);
        process.exit(whys.includes('wait timed out') ? 3 : 0);
      };

      // Several paths: one bundle link (default) or one link each (--separate).
      if (targets.length > 1) {
        if (targets.includes('-')) { console.error('stdin (-) cannot be combined with other paths.'); process.exit(1); }
        // Missing paths don't sink the rest: the daemon skips and reports them
        // (bundle) or returns them in errors[] (--separate).
        const missing = targets.filter((t) => !fs.existsSync(path.resolve(t)));
        if (missing.length === targets.length) {
          const msg = `File not found: ${missing.map((m) => path.resolve(m)).join(', ')}`;
          if (isJson) console.log(JSON.stringify({ success: false, error: msg })); else console.error(`Error: ${msg}`);
          process.exit(1);
        }
        if (missing.length && !isJson) console.error(`[srift] Warning: not found, will be skipped: ${missing.map((m) => path.resolve(m)).join(', ')}`);
        try {
          const where = await ensureDaemonOrEmbedded({ force: args.includes('--foreground') });
          const res = await handleQuickShareMany(targets.map((t) => path.resolve(t)), isJson, {
            maxDownloads, ttlMs, encrypt, password, qr, sessionName,
            bundle: !args.includes('--separate'),
            bundleName: flagValue(args, '--bundle-name') ?? flagValue(args, '--filename'),
            exclude: flagValues(args, '--exclude'),
          });
          await waitIfNeeded(where, res?.bundle === false ? (res.links || []).map((l: any) => l.token).filter(Boolean) : [res?.token].filter(Boolean));
        } catch (e: any) {
          if (isJson) console.log(JSON.stringify({ success: false, error: e.message }));
          else { console.error(`Error: ${e.message}`); console.error('  Diagnose with: srift doctor'); }
          process.exit(1);
        }
        break;
      }

      try {
        const where = await ensureDaemonOrEmbedded({ force: args.includes('--foreground') });
        const res = await handleQuickShare(filePath, sessionName, isJson, opts);
        // Embedded: this process IS the server, so it must stay up until the
        // recipient has the file. --wait does the same with a background daemon.
        await waitIfNeeded(where, [res?.token].filter(Boolean));
      } catch (e: any) {
        if (isJson) console.log(JSON.stringify({ success: false, error: e.message }));
        else {
          console.error(`Error: ${e.message}`);
          console.error('  Diagnose with: srift doctor');
        }
        process.exit(1);
      }
      break;
    }

    case 'get':
    case 'download': {
      const links = positionals(args, 1);
      const link = links[0];
      if (links.length > 1) {
        // Several links: download in parallel into a directory (default: cwd).
        const outDir = flagValue(args, '-o', '--out', '--output') || process.cwd();
        if (outDir === '-') { console.error('Several links cannot all go to stdout; use -o <dir>.'); process.exit(64); }
        fs.mkdirSync(outDir, { recursive: true });
        const conc = Math.min(16, Math.max(1, parseInt(flagValue(args, '--concurrency') || '4', 10) || 4));
        const results = await mapLimit(links, conc, async (l) => {
          try {
            const r = await getLink(l, {
              out: outDir,
              password: flagValue(args, '--password') ?? process.env.SRIFT_LINK_PASSWORD,
              force: args.includes('--force'), json: true, quiet: true, userAgent: `srift-cli/${CLI_VERSION}`,
            });
            if (!isJson) console.error(`[srift] Saved ${r.fileName} (${r.bytes} bytes${r.encrypted ? ', decrypted' : ''}) → ${r.path}`);
            return { link: l.split('#')[0], ...r, ok: true };
          } catch (e: any) {
            if (!isJson) console.error(`[srift] FAILED ${l.split('#')[0]}: ${e.message}`);
            return { ok: false, link: l.split('#')[0], error: e.message, code: e.code || null };
          }
        });
        const failed = results.filter((r) => !r.ok).length;
        if (isJson) console.log(JSON.stringify({ ok: failed === 0, downloaded: results.length - failed, failed, results }));
        else console.error(`[srift] ${results.length - failed}/${results.length} downloaded.`);
        process.exit(failed ? 1 : 0);
      }
      if (!link) {
        console.error('Usage: srift get <link|token> [more links…] [-o <file|dir|->] [--password <pw>] [--force] [--concurrency N] [--json]');
        console.error('  Downloads a srift.app/d/<token> link (decrypts #k= links locally). Works where curl is blocked.');
        process.exit(1);
      }
      try {
        const r = await getLink(link, {
          out: flagValue(args, '-o', '--out', '--output'),
          password: flagValue(args, '--password') ?? process.env.SRIFT_LINK_PASSWORD,
          force: args.includes('--force'),
          json: isJson,
          quiet: args.includes('--quiet') || args.includes('-q'),
          userAgent: `srift-cli/${CLI_VERSION}`,
        });
        if (isJson) console.log(JSON.stringify(r));
        else if (r.path) console.error(`[srift] Saved ${r.fileName} (${r.bytes} bytes${r.encrypted ? ', decrypted' : ''}) → ${r.path}`);
      } catch (e: any) {
        if (isJson) console.log(JSON.stringify({ ok: false, error: e.message, code: e.code || null }));
        else console.error(`Error: ${e.message}`);
        process.exit(e.code === 'EUSAGE' ? 64 : 1);
      }
      break;
    }

    case 'history': {
      if (args.includes('--clear')) {
        clearHistory();
        console.log(isJson ? JSON.stringify({ ok: true }) : `[srift] Cleared ${HISTORY_FILE}`);
        break;
      }
      const items = readHistory().reverse();
      const limitArg = parseInt(flagValue(args, '--limit') || '', 10);
      const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : null;
      // --json returns everything unless --limit is given; the text view shows 20 by default.
      if (isJson) { console.log(JSON.stringify({ items: limit ? items.slice(0, limit) : items })); break; }
      if (!items.length) { console.log('[srift] No links created yet.'); break; }
      const now = Date.now();
      for (const it of items.slice(0, limit || 20)) {
        const state = it.expiresAt && it.expiresAt <= now ? 'expired' : it.expiresAt ? `expires ${new Date(it.expiresAt).toLocaleString()}` : 'no expiry';
        console.log(`${it.at.slice(0, 19).replace('T', ' ')}  ${it.mode.padEnd(5)} ${it.encrypted ? 'e2ee ' : 'plain'}  ${it.fileName}  (${state})`);
        console.log(`    ${it.downloadUrl}`);
      }
      console.log(`\n(${HISTORY_FILE} — links include their keys; clear with: srift history --clear)`);
      break;
    }

    case 'completion': {
      const shell = (args[1] || '').toLowerCase();
      const script = completionScript(shell);
      if (!script) {
        console.error('Usage: srift completion <bash|zsh|fish|powershell>');
        console.error('  bash:        srift completion bash >> ~/.bashrc');
        console.error('  zsh:         srift completion zsh > "${fpath[1]}/_srift"');
        console.error('  fish:        srift completion fish > ~/.config/fish/completions/srift.fish');
        console.error('  PowerShell:  srift completion powershell >> $PROFILE');
        process.exit(1);
      }
      process.stdout.write(script);
      break;
    }

    case 'pubshare':
    case 'links': {
      const sub = args[1];
      await ensureDaemon();
      if (sub === 'list' || !sub) {
        await handlePubshareList(isJson);
      } else if (sub === 'revoke') {
        const token = args[2];
        if (!token) { console.error('Usage: srift links revoke <token> [--json]'); process.exit(1); }
        await handlePubshareRevoke(token, isJson);
      } else if (sub === 'add') {
        const fp = args[2];
        if (!fp) { console.error('Usage: srift pubshare add <filepath> [--max-downloads N] [--ttl dur] [--once] [--json]'); process.exit(1); }
        const maxIdx = args.indexOf('--max-downloads');
        let maxDownloads = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) : 0;
        if (args.includes('--once')) maxDownloads = 1;
        const ttlIdx = args.indexOf('--ttl');
        const ttlMs = ttlIdx !== -1 ? parseDuration(args[ttlIdx + 1]) : 0;
        const password = flagValue(args, '--password');
        const encrypt = !!password || args.includes('--encrypt');
        await handlePubshareAdd(fp, isJson, { maxDownloads, ttlMs, encrypt, password, qr: args.includes('--qr') });
      } else {
        console.error('Usage: srift pubshare [list|add <file>|revoke <token>]');
        process.exit(1);
      }
      break;
    }

    case 'install-mcp':
    case 'install': {
      if (args.includes('--auto')) {
        await handleAutoInstallMcp(isJson);
      } else {
        printInstallMcpInstructions();
      }
      break;
    }

    case 'bootstrap': {
      // Parse path if given, and filter flags out of position 1
      const pathArg = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
      const cursorrules = args.includes('--cursorrules');
      const agents = args.includes('--agents');
      await handleBootstrap(pathArg, { cursorrules, agents });
      break;
    }

    case 'info': {
      await ensureDaemon();
      printAgentInfo();
      break;
    }

    case 'version':
    case '--version':
    case '-v': {
      await handleVersion(isJson);
      // Fire-and-forget background update nudge (not on --json)
      if (!isJson) {
        checkForUpdate(false).catch(() => {});
      }
      break;
    }

    case 'self-update':
    case 'update': {
      await handleSelfUpdate(isJson);
      break;
    }

    case 'doctor': {
      await handleDoctor(isJson, args.includes('--fresh') || args.includes('--deep'), args.includes('--deep'));
      break;
    }

    case 'config': {
      await handleConfig(args.slice(1), isJson);
      break;
    }

    case 'agentnet':
    case 'an': {
      // AgentNet: agent-to-agent addresses, presence, messaging, calls (isolated module — see "A2A Plan.md").
      const { run } = await import('./agentnet/cli.ts');
      await run(args, { ensureDaemon: () => ensureDaemonOrEmbedded({ quiet: true }), callDaemon: callDaemonApi });
      break;
    }

    default: {
      const suggestion = suggestCommand(command);
      if (suggestion) {
        console.error(`Unknown command: "${command}". Did you mean: srift ${suggestion}`);
      } else {
        console.error(`Unknown command: "${command}"`);
      }
      console.error(`Run "srift --help" for usage.`);
      process.exit(1);
    }
  }

  // Background nudge (silent, after command completes)
  checkForUpdate(false).catch(() => {});
}

function printHelp() {
  console.log(`
SRIFT v${CLI_VERSION} — Headless P2P file transfer + MCP server

Install:  npm i -g srift-transfer    (or)    curl -fsSL https://srift.app/install.sh | sh
Update:   srift self-update            (npm installs: npm i -g srift-transfer@latest)
Docs:     https://srift.app/ai-agents

─── Daemon ────────────────────────────────────────────────────────
  srift daemon start                              Start in foreground (port ${DAEMON_PORT})
  srift daemon stop                               Stop background daemon
  srift daemon restart                            Stop then re-start daemon
  srift daemon status [--json]                    Show daemon health (version, uptime, mcp)

─── Status & Diagnostics ──────────────────────────────────────────
  srift status [--json]                           Unified: daemon + session + transfers
  srift doctor [--deep] [--json] [--fresh]        Connectivity, local runtime + environment
                                                checks with exact fixes and a plan for this
                                                machine; --deep adds an end-to-end self-test
                                                  (exit 0 ok, 1 degraded, 2 blocked)
  srift logs [--tail <n>] [--json-stream]         View daemon logs (default: last 50 lines)

─── Sessions ──────────────────────────────────────────────────────
  srift session start [--name <name>] [--room-secret <secret>] [--json]
  srift session join <session-id> [--username <u>] [--room-secret <s>] [--json]
  srift session status [--json]
  srift session close [--json]

─── Transfers ─────────────────────────────────────────────────────
  srift quick-share <file|folder|->            Download link for a file, a folder
                                                (sent as .tar.gz) or stdin (-)
                                                Streamed from this machine on demand;
                                                nothing is stored on a server.
        [--encrypt]                             End-to-end encrypt. Key stays in the
                                                link's #part (never sent to a server).
        [--password <pw>]                       Also require a password (implies --encrypt)
        [--max-downloads <N>] [--once]          Cap downloads
        [--ttl <30s|15m|2h|1d>]                 Auto-expire link after duration
        [--filename <name>]                     Recipient-visible name (stdin/folder)
        [--name <session>]                      Session name
        [--exclude <glob>]                      Folder only; repeatable (.git and
                                                node_modules are always excluded)
  srift quick-share <path> <path> …             Several files/folders: one .tar.gz link
        [--separate] [--bundle-name <name>]     …or one link per path (created in parallel)
        [--wait] [--wait-timeout <dur>]         Block until downloaded (exit 3 on timeout)
        [--keep-alive]                          Serve until expiry/Ctrl-C (implies --wait)
        [--foreground]                          Serve from this process, no background
                                                daemon (automatic in sandboxes that
                                                forbid local servers)
        [--qr] [--json]
  srift get <link|token>… [-o <path|dir|->]     Download link(s), several in parallel (works where curl is
        [--password <pw>] [--force] [--json]    blocked; decrypts #k= links; resumes)
  srift links list [--json]                     Active links from this daemon
  srift links add <filepath> [...quick-share flags]
  srift links revoke <token> [--json]           Invalidate a link immediately
  srift history [--limit N] [--clear] [--json]  Links you created (stored locally, 0600)
  srift send <filepath> [--json]                In-session offer for joined peers
  srift receive <file-id> [--save-dir <dir>] [--json]
  srift list [--json]
  srift monitor <file-id> [--json-stream]

─── Host Controls ─────────────────────────────────────────────────
  srift approve <temp-user-id> [--json]
  srift reject <temp-user-id> [--reason <reason>] [--json]
  srift kick <user-id> [--json]

─── Chat ──────────────────────────────────────────────────────────
  srift chat send "<message>" [--json]
  srift chat history [--json]

─── AI / Agent Helpers ────────────────────────────────────────────
  srift install-mcp                               Print config snippets for IDEs
  srift install-mcp --auto                        Automatically install to Claude Desktop
  srift bootstrap [dir]                           Bootstrap .cursorrules & AGENTS.md in [dir]
        [--cursorrules]                           Only bootstrap .cursorrules
        [--agents]                                Only bootstrap AGENTS.md
  srift info                                      Zero-config quick reference

─── MCP Server ────────────────────────────────────────────────────
  srift mcp                                       stdio transport (all 15 tools)
  HTTP: POST http://127.0.0.1:${DAEMON_PORT}/mcp  streamable HTTP (MCP 2026-07-28; older clients OK)
  SSE:  GET  http://127.0.0.1:${DAEMON_PORT}/mcp/sse   (deprecated transport, kept for old clients)
  Hosted (no install): POST https://srift.app/mcp
        9 session/control tools only — file/chat tools need this local daemon.

─── Maintenance ───────────────────────────────────────────────────
  srift version [--json]
  srift self-update [--json]                      Atomic in-place binary update
  srift reset [--json]                            Wipe daemon session state + flush keys
  srift config [get|set|delete] [key] [value]     Manage ~/.srift/config.json
  srift uninstall [--purge]                       Remove srift binary (--purge also deletes ~/.srift/)
  srift completion <bash|zsh|fish|powershell>     Print a shell completion script

Flags (global):
  --json                        Machine-readable JSON output
  --no-daemon                   Skip auto-starting daemon (status-only commands)

Env vars:
  SRIFT_DAEMON_PORT=3822        Change daemon port
  SRIFT_NO_UPDATE_CHECK=1       Disable background update checks
  HTTPS_PROXY / NO_PROXY        Proxy (http://, https://, socks5://) — honoured everywhere
  NODE_EXTRA_CA_CERTS=<pem>     Trust a TLS-inspecting proxy's root CA (never disable TLS checks)
  SRIFT_LINK_PASSWORD           Password for quick-share/get without putting it in shell history
  SRIFT_NO_HISTORY=1            Don't record created links in ~/.srift/history.jsonl
`);
}

function printInstallMcpInstructions() {
  const claudeWin = `${process.env.APPDATA || '%APPDATA%'}\\Claude\\claude_desktop_config.json`;

  // Detect if we are running inside the Bun-compiled standalone binary.
  // In that case `__dirname` is the Bun virtual FS path (B:/~BUN/root) which is
  // useless to MCP clients. Emit the actual `srift` binary path instead.
  const execPath = process.execPath || '';
  const execBase = path.basename(execPath).toLowerCase();
  const isCompiledBinary =
    execBase === 'srift' || execBase === 'srift.exe' ||
    (typeof (process as any).isBun === 'boolean' && (process as any).isBun) ||
    (process.versions && (process.versions as any).bun !== undefined);

  let cmd: string;
  let argList: string;
  // Human-readable single-line invocation used in IDE-style configs (Cursor etc.)
  let cursorCmd: string;
  // npm install puts a `srift` shim on PATH, so the config is portable and
  // should NOT bake in an absolute path. Detect it by the bundled .js entry
  // living under node_modules. Without this branch an npm user was handed the
  // DEV path (node --experimental-strip-types <repo>/cli/index.ts mcp), which
  // only ever resolved on the machine that built it.
  const entry = (typeof __filename === 'string' ? __filename : '').replace(/\\/g, '/');
  const isNpmInstall = /\/node_modules\//.test(entry) && entry.endsWith('.js');

  if (isCompiledBinary) {
    // Single-binary install — call the actual srift binary with `mcp`.
    // Use the absolute path so it works regardless of whether ~/.srift/bin is on PATH.
    const sriftPath = execPath.replace(/\\/g, '/');
    cmd = sriftPath;
    argList = `["mcp"]`;
    cursorCmd = `${sriftPath} mcp`;
  } else if (isNpmInstall) {
    // Global npm install — the `srift` bin is on PATH.
    cmd = `srift`;
    argList = `["mcp"]`;
    cursorCmd = `srift mcp`;
  } else {
    // Dev / source install — node with the ts entry point.
    const scriptPath = path.resolve(__dirname, 'index.ts').replace(/\\/g, '/');
    cmd = `node`;
    argList = `["--experimental-strip-types","${scriptPath}","mcp"]`;
    cursorCmd = `node --experimental-strip-types ${scriptPath} mcp`;
  }

  console.log(`
SRIFT MCP — Universal Install Snippets
======================================

# Claude Desktop  (Windows: ${claudeWin})
# macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
# Linux:   ~/.config/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "srift": {
      "command": "${cmd}",
      "args": ${argList}
    }
  }
}

# Cursor IDE  (Settings → Features → MCP → Add)
Name:    srift
Type:    stdio
Command: ${cursorCmd}

# Continue.dev  (~/.continue/config.json → "mcpServers")
{ "command": "${cmd}", "args": ${argList} }

# Codex CLI / Zed / Aider / any MCP-aware client
Same command/args as above.

# Cloud / browser agents (ChatGPT, Claude.ai, n8n, Zapier, etc.)
# These run off your machine and CANNOT reach 127.0.0.1 — use the hosted endpoint:
Hosted MCP:         POST https://srift.app/mcp        (no install, 9 session/control tools)
{ "mcpServers": { "srift": { "type": "streamable-http", "url": "https://srift.app/mcp" } } }

# Local daemon surfaces (this machine only — all 15 tools):
HTTP MCP endpoint:  POST http://127.0.0.1:${DAEMON_PORT}/mcp
OpenAPI spec:       GET  http://127.0.0.1:${DAEMON_PORT}/openapi.json
AI Plugin:          GET  http://127.0.0.1:${DAEMON_PORT}/.well-known/ai-plugin.json
A2A discovery:      GET  http://127.0.0.1:${DAEMON_PORT}/.well-known/agent.json
MCP server card:    GET  http://127.0.0.1:${DAEMON_PORT}/.well-known/mcp/server-card.json

No tokens. No auth. File and chat tools require the local daemon.
`);
}

function printAgentInfo() {
  console.log(`
SRIFT for AI Agents — Zero-Config Quick Reference
=================================================

You are running inside the SRIFT workspace. A local daemon is up at:
  http://127.0.0.1:${DAEMON_PORT}

Everything below works without tokens, OAuth, or API keys.

──── Fastest path to deliver a file to the user ────
  srift quick-share /abs/path/to/file
    → prints a direct download URL: https://srift.app/d/<token>
    → the user opens it in any browser, or downloads via:
        curl -OJ https://srift.app/d/<token>
        wget --content-disposition https://srift.app/d/<token>
    → the daemon keeps serving in the background after this command exits,
      and nothing is stored server-side. If the daemon stops (srift daemon
      stop, reboot, laptop sleep) the link returns 503.
    → add --encrypt for end-to-end encryption (key stays in the #k= part).

──── Open a long-lived collaboration room ────
  srift session start --name "AI-Collab"
  (give the user the share URL; approve their join with 'srift approve')

──── Watch progress without polling ────
  Read .srift-state.json (auto-updated on every event)
  Or subscribe to SSE: GET http://127.0.0.1:${DAEMON_PORT}/api/v1/monitor/events

──── Connect any AI / MCP client ────
  Stdio:           srift mcp
  HTTP MCP:        POST http://127.0.0.1:${DAEMON_PORT}/mcp
  REST/OpenAPI:    http://127.0.0.1:${DAEMON_PORT}/openapi.json

──── Discovery files this project ships ────
  ./AGENTS.md                 — universal instructions for any AI
  ./.cursorrules              — Cursor-specific
  ./.agents/AGENTS.md         — fallback path some clients check
  ./ai-instructions.md        — full spec
  ./public/llms.txt           — for LLM crawlers
  ./public/.well-known/       — MCP card, AI plugin manifest, A2A, etc.

Crypto: AES-256-GCM + PBKDF2-SHA256 (100k iter). Keys never leave the device.
`);
}

main();

function completionScript(shell: string): string | null {
  const cmds = ALL_COMMANDS.join(' ');
  const qsFlags = '--separate --bundle-name --wait --wait-timeout --keep-alive --foreground --encrypt --password --ttl --once --max-downloads --name --exclude --qr --json';
  if (shell === 'bash') {
    return `# srift bash completion
_srift() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"; prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=( $(compgen -W "${cmds}" -- "$cur") ); return; fi
  case "$prev" in
    --ttl) COMPREPLY=( $(compgen -W "15m 1h 24h 7d" -- "$cur") ); return;;
  esac
  case "\${COMP_WORDS[1]}" in
    quick-share|share) COMPREPLY=( $(compgen -W "${qsFlags}" -- "$cur") $(compgen -f -- "$cur") );;
    get|download) COMPREPLY=( $(compgen -W "-o --password --force --json" -- "$cur") );;
    links|pubshare) COMPREPLY=( $(compgen -W "list add revoke" -- "$cur") );;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish powershell" -- "$cur") );;
    *) COMPREPLY=( $(compgen -f -- "$cur") );;
  esac
}
complete -o default -F _srift srift
`;
  }
  if (shell === 'zsh') {
    return `#compdef srift
_srift() {
  local -a cmds; cmds=(${cmds})
  if (( CURRENT == 2 )); then _describe 'command' cmds; return; fi
  case $words[2] in
    quick-share|share) _arguments '--encrypt' '--password:password:' '--ttl:duration:' '--once' '--max-downloads:count:' '--name:name:' '--exclude:glob:' '--qr' '--json' '*:file:_files';;
    get|download) _arguments '-o:output:_files' '--password:password:' '--force' '--json' '1:link:';;
    links|pubshare) _values 'subcommand' list add revoke;;
    completion) _values 'shell' bash zsh fish powershell;;
    *) _files;;
  esac
}
compdef _srift srift
`;
  }
  if (shell === 'fish') {
    return [
      '# srift fish completion',
      `complete -c srift -f -n '__fish_use_subcommand' -a '${cmds}'`,
      ...qsFlags.split(' ').map((f) => `complete -c srift -n '__fish_seen_subcommand_from quick-share share' -l ${f.slice(2)}`),
      `complete -c srift -n '__fish_seen_subcommand_from get download' -s o -r`,
      `complete -c srift -n '__fish_seen_subcommand_from links pubshare' -f -a 'list add revoke'`,
      `complete -c srift -n '__fish_seen_subcommand_from completion' -f -a 'bash zsh fish powershell'`,
      '',
    ].join('\n');
  }
  if (shell === 'powershell' || shell === 'pwsh') {
    return `# srift PowerShell completion
Register-ArgumentCompleter -Native -CommandName srift -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
  $cands = if ($words.Count -le 2) { '${cmds}'.Split(' ') }
    elseif ($words[1] -in @('quick-share','share')) { '${qsFlags}'.Split(' ') }
    elseif ($words[1] -in @('links','pubshare')) { @('list','add','revoke') }
    elseif ($words[1] -eq 'completion') { @('bash','zsh','fish','powershell') }
    else { @() }
  $cands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
  }
  return null;
}
