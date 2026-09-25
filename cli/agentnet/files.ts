/**
 * SRIFT AgentNet — native agent-to-agent file transfer.
 *
 * Protocol (every step is its own E2EE, sender-signed envelope, routed only
 * to an ONLINE recipient; relays store nothing):
 *   A → B  file_offer  {fileId, name, size, sha256, chunkSize, chunks, groupId?}
 *   B → A  file_accept {fileId, accepted, reason?}          (B's policy decides)
 *   A → B  file_chunk  {fileId, index, data(base64)} × N   (windowed, acked per chunk)
 *   B → A  file_ack    {fileId, ok, sha256}                 (after hash verification)
 *
 * Receiving: chunks are written straight to a .part file at their offset
 * (any order), never held in memory and never in the inbox. On completion the
 * SHA-256 is verified; then the file moves to ~/.srift/agentnet/files/<peer or
 * group>/ with a sanitized, non-clobbering name, and an inbox record of type
 * "file" is added. Idle partial transfers are deleted after 10 minutes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as C from '../../lib/agentnet/crypto.mjs';
import { isGroupId } from '../../lib/agentnet/group.mjs';
import { filesDir, filesRoot } from './local.ts';

export const CHUNK_SIZE = 32 * 1024; // keeps each sealed envelope under the 64 KB relay limit
export const FILE_WINDOW = 8; // chunks in flight
const IDLE_MS = 10 * 60_000;
const MAX_PER_SENDER = 3;
const MAX_TOTAL = 16;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function safeFileName(name: string): string {
  // basename on both separators, whatever OS we run on
  const raw = String(name || 'file').split(/[\\/]/).pop() || 'file';
  let base = raw.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '_').replace(/[. ]+$/, '').trim();
  if (WIN_RESERVED.test(base)) base = '_' + base; // CON, NUL.txt, COM1 … are devices on Windows
  return (base || 'file').slice(0, 180);
}
function uniquePath(dir: string, name: string): string {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    p = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
}
export function sha256File(p: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

export type FileOffer = { fileId: string; name: string; size: number; sha256: string; chunkSize: number; chunks: number; groupId?: string; mime?: string };
export function makeOffer(filePath: string, groupId?: string): FileOffer {
  const st = fs.statSync(filePath);
  if (!st.isFile()) throw new Error(`Not a file: ${filePath}`);
  return {
    fileId: C.newId(),
    name: safeFileName(path.basename(filePath)),
    size: st.size,
    sha256: sha256File(filePath),
    chunkSize: CHUNK_SIZE,
    chunks: Math.max(1, Math.ceil(st.size / CHUNK_SIZE)),
    groupId,
  };
}
export function readChunk(fd: number, offer: FileOffer, index: number): string {
  const len = Math.min(offer.chunkSize, offer.size - index * offer.chunkSize);
  const buf = Buffer.alloc(Math.max(0, len));
  if (len > 0) fs.readSync(fd, buf, 0, len, index * offer.chunkSize);
  return buf.toString('base64');
}

type Incoming = FileOffer & { from: string; fromName?: string; part: string; fd: number; received: Set<number>; bytes: number; lastAt: number };
export type ChunkResult = { complete?: boolean; error?: string; progress?: number; duplicate?: boolean };
export type ReceivedFile = { fileId: string; from: string; fromName?: string; name: string; size: number; sha256: string; path: string; groupId?: string };

export class FileReceiver {
  private incoming = new Map<string, Incoming>();
  /** Recently finished transfers (fileId → sender), so late duplicate chunks still get acked. */
  private finished = new Map<string, string>();
  private sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  /** Validate an offer; returns null if acceptable, or a rejection reason. */
  check(offer: any, maxBytes: number, from?: string): string | null {
    if (!offer || typeof offer.fileId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(offer.fileId)) return 'invalid offer';
    if (offer.groupId !== undefined && !isGroupId(offer.groupId)) return 'invalid group';
    if (typeof offer.name !== 'string' || offer.name.length > 1024) return 'invalid name';
    if (from && [...this.incoming.values()].filter((t) => t.from === from).length >= MAX_PER_SENDER) return 'too many transfers from you at once';
    if (this.incoming.size >= MAX_TOTAL) return 'receiver busy, try again later';
    const reserved = [...this.incoming.values()].reduce((a, t) => a + t.size, 0);
    if (reserved + Number(offer.size || 0) > MAX_TOTAL_BYTES) return 'receiver busy, try again later';
    if (!Number.isInteger(offer.size) || offer.size < 0) return 'invalid size';
    if (offer.size > maxBytes) return `file too large (limit ${Math.round(maxBytes / 1048576)} MB)`;
    if (offer.chunkSize !== CHUNK_SIZE || offer.chunks !== Math.max(1, Math.ceil(offer.size / CHUNK_SIZE))) return 'invalid chunking';
    if (typeof offer.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(offer.sha256)) return 'invalid hash';
    if (this.incoming.has(offer.fileId)) return 'duplicate transfer';
    return null;
  }

  begin(offer: FileOffer, from: string, fromName?: string): void {
    const dir = filesDir('.incoming');
    const part = path.join(dir, `${offer.fileId}.part`);
    const fd = fs.openSync(part, 'w', 0o600);
    this.incoming.set(offer.fileId, { ...offer, name: safeFileName(offer.name), from, fromName, part, fd, received: new Set(), bytes: 0, lastAt: Date.now() });
  }

  /** Write one chunk. `complete` = every chunk is on disk (call finalize() after acking). */
  chunk(from: string, body: any): ChunkResult {
    const fileId = String(body?.fileId);
    const t = this.incoming.get(fileId);
    if (!t) return this.finished.get(fileId) === from ? { duplicate: true } : { error: 'unknown transfer' };
    if (t.from !== from) return { error: 'unknown transfer' };
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0 || index >= t.chunks || typeof body.data !== 'string') return { error: 'invalid chunk' };
    if (t.received.has(index)) return { duplicate: true, progress: t.received.size / t.chunks };
    const data = Buffer.from(body.data, 'base64');
    const expected = Math.min(t.chunkSize, t.size - index * t.chunkSize);
    if (data.length !== Math.max(0, expected)) return { error: 'chunk size mismatch' };
    if (data.length) fs.writeSync(t.fd, data, 0, data.length, index * t.chunkSize);
    t.received.add(index);
    t.bytes += data.length;
    t.lastAt = Date.now();
    return t.received.size < t.chunks ? { progress: t.received.size / t.chunks } : { complete: true, progress: 1 };
  }

  /** Verify the hash and move the file into place (async-friendly: called after the last chunk was acked). */
  finalize(fileId: string): { done?: ReceivedFile; error?: string } {
    const t = this.incoming.get(fileId);
    if (!t) return { error: 'unknown transfer' };
    try { fs.closeSync(t.fd); } catch { /* closed */ }
    this.incoming.delete(t.fileId);
    this.finished.set(t.fileId, t.from);
    if (this.finished.size > 1000) this.finished.delete(this.finished.keys().next().value!);
    try {
      const actual = sha256File(t.part);
      if (actual !== t.sha256) {
        try { fs.unlinkSync(t.part); } catch { /* gone */ }
        return { error: 'hash mismatch' };
      }
      const dir = t.groupId ? filesDir('groups', t.groupId) : filesDir(C.compactAddress(t.from));
      const dest = uniquePath(dir, t.name);
      // Defense in depth: the final path must stay inside the files folder.
      const root = path.resolve(filesRoot()) + path.sep;
      if (!path.resolve(dest).startsWith(root)) {
        try { fs.unlinkSync(t.part); } catch { /* gone */ }
        return { error: 'invalid destination' };
      }
      fs.renameSync(t.part, dest);
      return { done: { fileId: t.fileId, from: t.from, fromName: t.fromName, name: path.basename(dest), size: t.size, sha256: actual, path: dest, groupId: t.groupId } };
    } catch (e: any) {
      try { fs.unlinkSync(t.part); } catch { /* gone */ }
      return { error: `could not save file: ${e?.code || e?.message}` };
    }
  }

  cancel(fileId: string): void {
    const t = this.incoming.get(fileId);
    if (!t) return;
    try { fs.closeSync(t.fd); } catch { /* closed */ }
    try { fs.unlinkSync(t.part); } catch { /* gone */ }
    this.incoming.delete(fileId);
  }

  private sweep(): void {
    const now = Date.now();
    for (const t of [...this.incoming.values()]) if (now - t.lastAt > IDLE_MS) this.cancel(t.fileId);
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const id of [...this.incoming.keys()]) this.cancel(id);
  }
}
