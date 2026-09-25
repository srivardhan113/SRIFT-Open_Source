/**
 * Local send history (~/.srift/history.jsonl, mode 0600).
 *
 * Stores the links you created — including #k= keys — so `srift history`
 * can show them again. Nothing here is sent anywhere.
 * Disable with SRIFT_NO_HISTORY=1; wipe with `srift history --clear`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const HISTORY_FILE = path.join(os.homedir(), '.srift', 'history.jsonl');
const MAX_ENTRIES = 500;

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
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_ENTRIES) fs.writeFileSync(HISTORY_FILE, `${lines.slice(-MAX_ENTRIES).join('\n')}\n`, { mode: 0o600 });
  } catch { /* history is best-effort */ }
}

export function readHistory(): HistoryEntry[] {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as HistoryEntry]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

export function clearHistory(): void {
  try { fs.rmSync(HISTORY_FILE, { force: true }); } catch { /* ignore */ }
}

export function findInHistory(token: string): HistoryEntry | undefined {
  return readHistory().reverse().find((e) => e.token === token);
}
