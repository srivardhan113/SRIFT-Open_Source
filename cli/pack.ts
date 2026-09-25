/**
 * Folder → .tar.gz for `srift quick-share <dir>`, with no dependencies.
 *
 * POSIX ustar with PAX extended headers for long paths / large files, so the
 * result opens with `tar -xzf`, 7-Zip, macOS Archive Utility and Windows'
 * built-in tar. Symlinks are skipped (never followed) so sharing a folder
 * cannot leak files outside it. `--exclude` takes simple globs.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const BLOCK = 512;

/** Glob → RegExp: `*` (no slash), `**` (any depth), `?`. Matched against the relative path and the basename. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const DEFAULT_EXCLUDES = ['.git', 'node_modules', '.DS_Store', 'Thumbs.db'];

// Normalised modes: directories 0755, files 0644 or 0755 (executable kept on
// POSIX). Windows reports 0666 for directories, which would extract as
// non-traversable directories on Linux/macOS.
function normFileMode(m: number): number {
  return process.platform !== 'win32' && (m & 0o111) ? 0o755 : 0o644;
}

export type PackEntry = { abs: string; rel: string; size: number; mode: number; mtime: number; dir: boolean };

export function listFiles(root: string, excludes: string[] = DEFAULT_EXCLUDES): PackEntry[] {
  const pats = excludes.map(globToRegExp);
  const excluded = (rel: string) => pats.some((p) => p.test(rel) || p.test(path.posix.basename(rel)));
  const out: PackEntry[] = [];
  const walk = (dirAbs: string, dirRel: string) => {
    const ents = fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (excluded(rel)) continue;
      const abs = path.join(dirAbs, e.name);
      if (e.isSymbolicLink()) continue; // never follow links out of the shared folder
      const st = fs.lstatSync(abs);
      if (e.isDirectory()) {
        out.push({ abs, rel, size: 0, mode: 0o755, mtime: Math.floor(st.mtimeMs / 1000), dir: true });
        walk(abs, rel);
      } else if (e.isFile()) {
        out.push({ abs, rel, size: st.size, mode: normFileMode(st.mode), mtime: Math.floor(st.mtimeMs / 1000), dir: false });
      }
    }
  };
  walk(root, '');
  return out;
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, mode: number, mtime: number, type: string): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(mtime, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

function pad(size: number): Buffer {
  const r = size % BLOCK;
  return r ? Buffer.alloc(BLOCK - r) : Buffer.alloc(0);
}

function* entryHeaders(e: PackEntry, prefix: string): Generator<Buffer> {
  const name = `${prefix}/${e.rel}${e.dir ? '/' : ''}`;
  const needsPax = Buffer.byteLength(name) > 99 || /[^\x20-\x7e]/.test(name) || e.size > 0o77777777777;
  if (needsPax) {
    let pax = paxRecord('path', name);
    if (e.size > 0o77777777777) pax += paxRecord('size', String(e.size));
    const pb = Buffer.from(pax, 'utf8');
    yield header('PaxHeader', pb.length, 0o644, e.mtime, 'x');
    yield pb;
    yield pad(pb.length);
  }
  const shortName = needsPax ? name.replace(/[^\x20-\x7e]/g, '_').slice(-99) : name;
  yield header(shortName, e.dir ? 0 : Math.min(e.size, 0o77777777777), e.mode || (e.dir ? 0o755 : 0o644), e.mtime, e.dir ? '5' : '0');
}

async function* tarStream(entries: PackEntry[], prefix: string): AsyncGenerator<Buffer> {
  for (const e of entries) {
    yield* entryHeaders(e, prefix);
    if (e.dir) continue;
    let written = 0;
    const stream = fs.createReadStream(e.abs);
    stream.on('error', () => { /* surfaced by the iterator below */ });
    try {
      for await (const c of stream) {
        const b = c as Buffer;
        const room = e.size - written;
        if (room <= 0) break;
        const piece = b.length > room ? b.subarray(0, room) : b;
        written += piece.length;
        yield piece;
      }
    } catch (err: any) {
      throw Object.assign(new Error(`${e.rel}: ${err?.code || err?.message || 'read failed'}`), { packEntry: e.abs });
    }
    if (written < e.size) throw Object.assign(new Error(`${e.rel} shrank while packing`), { packEntry: e.abs });
    yield pad(e.size);
  }
  yield Buffer.alloc(BLOCK * 2);
}

/** Pack `dir` into `outFile` (.tar.gz). Returns file/byte counts. */
export async function packDirectory(dir: string, outFile: string, excludes: string[] = DEFAULT_EXCLUDES): Promise<{ files: number; bytes: number }> {
  const root = path.resolve(dir);
  const entries = listFiles(root, excludes);
  const files = entries.filter((e) => !e.dir);
  if (!files.length) throw new Error(`Nothing to share in ${root} (empty, or everything was excluded)`);
  const prefix = path.basename(root) || 'folder';
  await pipeline(Readable.from(tarStream(entries, prefix)), zlib.createGzip({ level: 6 }), fs.createWriteStream(outFile, { mode: 0o600 }));
  return { files: files.length, bytes: files.reduce((a, e) => a + e.size, 0) };
}

/**
 * Entries for several files and/or folders under one archive root. File names
 * that collide get " (2)", " (3)"… suffixes; folders keep their inner layout.
 */
export type Skipped = { path: string; reason: string };

function readable(p: string): string | null {
  try { fs.accessSync(p, fs.constants.R_OK); return null; } catch (e: any) { return e?.code || 'unreadable'; }
}

/**
 * Entries for several files and/or folders under one archive root. File names
 * that collide get " (2)", " (3)"… suffixes; folders keep their inner layout.
 * Missing or unreadable paths/files are skipped and reported, never fatal.
 */
export function listPaths(paths: string[], excludes: string[] = DEFAULT_EXCLUDES, skipped: Skipped[] = []): PackEntry[] {
  const out: PackEntry[] = [];
  const used = new Set<string>();
  const unique = (name: string) => {
    if (!used.has(name.toLowerCase())) { used.add(name.toLowerCase()); return name; }
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let i = 2; ; i++) {
      const c = `${stem} (${i})${ext}`;
      if (!used.has(c.toLowerCase())) { used.add(c.toLowerCase()); return c; }
    }
  };
  for (const p of paths) {
    const abs = path.resolve(p);
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch (e: any) { skipped.push({ path: abs, reason: e?.code === 'ENOENT' ? 'not found' : (e?.code || 'stat failed') }); continue; }
    if (st.isDirectory()) {
      let inner: PackEntry[];
      try { inner = listFiles(abs, excludes); } catch (e: any) { skipped.push({ path: abs, reason: e?.code || 'unreadable folder' }); continue; }
      const name = unique(path.basename(abs) || 'item');
      out.push({ abs, rel: name, size: 0, mode: 0o755, mtime: Math.floor(st.mtimeMs / 1000), dir: true });
      for (const e of inner) {
        const why = e.dir ? null : readable(e.abs);
        if (why) { skipped.push({ path: e.abs, reason: why }); continue; }
        out.push({ ...e, rel: `${name}/${e.rel}` });
      }
    } else if (st.isFile()) {
      const why = readable(abs);
      if (why) { skipped.push({ path: abs, reason: why }); continue; }
      out.push({ abs, rel: unique(path.basename(abs) || 'item'), size: st.size, mode: normFileMode(st.mode), mtime: Math.floor(st.mtimeMs / 1000), dir: false });
    } else {
      skipped.push({ path: abs, reason: 'not a regular file or folder' });
    }
  }
  return out;
}

/**
 * Pack several files/folders into one .tar.gz whose top folder is `prefix`.
 * One bad file never sinks the bundle: unreadable/missing items are skipped,
 * and a file that fails mid-pack is dropped and the archive rebuilt (≤ 5 times).
 */
export async function packPaths(paths: string[], outFile: string, prefix: string, excludes: string[] = DEFAULT_EXCLUDES): Promise<{ files: number; bytes: number; skipped: Skipped[] }> {
  if (!paths.length) throw new Error('No files to share');
  const skipped: Skipped[] = [];
  let entries = listPaths(paths, excludes, skipped);
  for (let attempt = 0; ; attempt++) {
    const files = entries.filter((e) => !e.dir);
    if (!files.length) {
      throw new Error(`Nothing to share${skipped.length ? ` — skipped: ${skipped.map((x) => `${x.path} (${x.reason})`).join(', ')}` : ' (empty folders, or everything was excluded)'}`);
    }
    try {
      await pipeline(Readable.from(tarStream(entries, prefix)), zlib.createGzip({ level: 6 }), fs.createWriteStream(outFile, { mode: 0o600 }));
      return { files: files.length, bytes: files.reduce((a, e) => a + e.size, 0), skipped };
    } catch (err: any) {
      const bad = err?.packEntry as string | undefined;
      if (!bad || attempt >= 4) throw err;
      skipped.push({ path: bad, reason: String(err.message || 'read failed').split(': ').pop() || 'read failed' });
      entries = entries.filter((e) => e.abs !== bad);
    }
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
