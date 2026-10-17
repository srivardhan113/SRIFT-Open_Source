/**
 * Local send history (~/.srift/history.jsonl, mode 0600).
 *
 * Stores the links you created — including #k= keys — so `srift history`
 * can show them again. Nothing here is sent anywhere.
 * Disable with SRIFT_NO_HISTORY=1; wipe with `srift history --clear`.
 * Retention: SRIFT_HISTORY_DAYS days (default 30) and at most 500 entries; a link
 * whose TTL has passed is dropped at once (its key is useless but still secret).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const HISTORY_FILE = path.join(os.homedir(), '.srift', 'history.jsonl');
const MAX_ENTRIES = 500;
const DAY_MS = 86_400_000;

/** SRIFT_HISTORY_DAYS (default 30; 0 = keep until the entry cap). */
function historyDays(): number {
  const v = Number(process.env.SRIFT_HISTORY_DAYS);
  return process.env.SRIFT_HISTORY_DAYS !== undefined && Number.isFinite(v) && v >= 0 ? v : 30;
}

export type HistoryEntry = {
  at: string;
  mode: 'relay';
  fileName: string;
  fileSize: number;
  downloadUrl: string;
  token: string;
  encrypted: boolean;
  expiresAt: number | null;
  maxDownloads: number;
};

export function recordHistory(e: HistoryEntry): void {
  if (process.env.SRIFT_NO_HISTORY === '1') return;
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true, mode: 0o700 });
    fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    try { fs.chmodSync(HISTORY_FILE, 0o600); } catch { /* windows */ }
    pruneHistory();
  } catch { /* history is best-effort */ }
}

/** Entries still worth keeping: not past their link TTL, and younger than the retention window. */
export function keepEntry(e: HistoryEntry, now = Date.now(), days = historyDays()): boolean {
  if (e.expiresAt && e.expiresAt <= now) return false;
  if (days > 0) {
    const at = Date.parse(e.at);
    if (Number.isFinite(at) && now - at > days * DAY_MS) return false;
  }
  return true;
}

/** Apply retention to the file (age, expired links, entry cap). Returns what is kept. */
export function pruneHistory(now = Date.now()): HistoryEntry[] {
  let lines: string[];
  try { lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const kept: string[] = [];
  const entries: HistoryEntry[] = [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as HistoryEntry;
      if (keepEntry(e, now)) { kept.push(l); entries.push(e); }
    } catch { /* drop corrupt lines */ }
  }
  const out = kept.slice(-MAX_ENTRIES);
  if (out.length !== lines.length) {
    try {
      if (out.length) fs.writeFileSync(HISTORY_FILE, `${out.join('\n')}\n`, { mode: 0o600 });
      else fs.rmSync(HISTORY_FILE, { force: true });
    } catch { /* best-effort */ }
  }
  return entries.slice(-MAX_ENTRIES);
}

export function readHistory(): HistoryEntry[] {
  return pruneHistory();
}

export function clearHistory(): void {
  try { fs.rmSync(HISTORY_FILE, { force: true }); } catch { /* ignore */ }
}

export function findInHistory(token: string): HistoryEntry | undefined {
  return readHistory().reverse().find((e) => e.token === token);
}
