/**
 * `srift get <url|token>` — download a SRIFT link with Node's own HTTP stack.
 *
 * Exists because the documented `curl -OJ` fails in some agent sandboxes
 * (e.g. `curl: (43)`), and because encrypted links (#k=<key>) need local
 * decryption. Honours HTTPS_PROXY/NO_PROXY, resumes with Range, retries with
 * backoff, respects Content-Disposition without letting it escape the target
 * directory, and can stream to stdout for piping.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { openRequest, formatNetError } from './net.ts';
import { Decryptor, parseFragmentKey } from './e2ee.ts';
import { apiBase } from './probe.ts';

export type GetOpts = {
  out?: string;          // file path, existing directory, or '-' for stdout
  password?: string;
  quiet?: boolean;
  json?: boolean;
  force?: boolean;       // overwrite an existing file
  userAgent?: string;
};

export type GetResult = {
  ok: true;
  path: string | null;   // null when written to stdout
  fileName: string;
  bytes: number;
  encrypted: boolean;
  mode: string | null;   // 'relay' | 'push' | null (older servers)
};

class GetError extends Error {
  code: string;
  status?: number;
  constructor(message: string, code = 'EGET', status?: number) { super(message); this.code = code; this.status = status; }
}

/** Accepts a full link, a bare token, or `srift.app/d/<token>` without scheme. */
export function resolveLink(input: string): { url: string; key: Buffer | null; hasFragment: boolean } {
  let s = input.trim();
  if (!s) throw new GetError('Missing link or token', 'EUSAGE');
  if (/^[A-Za-z0-9-]{8,80}(#.*)?$/.test(s) && !s.includes('.')) s = `${apiBase()}/d/${s}`;
  else if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { throw new GetError(`Not a valid link: ${input}`, 'EUSAGE'); }
  if (!/^\/d\/[^/]+\/?$/.test(u.pathname)) {
    throw new GetError(`Not a SRIFT download link (expected …/d/<token>): ${input}`, 'EUSAGE');
  }
  const frag = u.hash;
  u.hash = '';
  return { url: u.toString(), key: parseFragmentKey(frag), hasFragment: frag.length > 1 };
}

/** Extract a safe basename from Content-Disposition (RFC 6266 / 5987). Decodes exactly once. */
export function filenameFromDisposition(cd: string | undefined): string | null {
  if (!cd) return null;
  let name: string | null = null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (star) {
    try { name = decodeURIComponent(star[2].trim().replace(/^"|"$/g, '')); } catch { name = null; }
  }
  if (!name) {
    const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"|filename\s*=\s*([^;]+)/i.exec(cd);
    if (plain) name = (plain[1] ?? plain[2] ?? '').trim();
  }
  return name ? safeBasename(name) : null;
}

const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩؜]/g;
const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\s*\..*)?$/i;

/** A filename that cannot escape the target directory or spoof its extension. */
export function safeBasename(name: string): string | null {
  const b = name.replace(/\\/g, '/').split('/').pop() || '';
  let cleaned = b
    .replace(BIDI_CONTROLS, '')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 200);
  if (!cleaned) return null;
  if (WIN_RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
}

function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const c = `${stem} (${i})${ext}`;
    if (!fs.existsSync(c)) return c;
  }
  throw new GetError(`Too many files named ${path.basename(p)}`);
}

function fmtBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
}

function withQuery(url: string, q: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${q}`;
}

function explainStatus(status: number, body: string): GetError {
  let msg = body.replace(/^SRIFT:\s*/, '').trim();
  // A CDN/proxy error page (e.g. Cloudflare's HTML for 502/504): never echo the markup.
  if (/^\s*<(!doctype|html)/i.test(msg)) msg = status >= 500 ? 'The SRIFT server or a proxy in front of it is temporarily unavailable — retry shortly' : '';
  // The sender's file is gone, changed or unreadable: permanent, never retried.
  // 424 from current servers; 502 + body from older ones.
  if (status === 424 || (status === 502 && /sender error: (the shared file|cannot read the shared file)/i.test(msg))) return new GetError(msg || 'The sender can no longer serve this file.', 'ESENDERFILE', status);
  if (status === 404) return new GetError(msg || 'Link not found — it expired, was revoked, or the sender went offline.', 'ENOTFOUND_LINK', 404);
  if (status === 410) return new GetError(msg || 'Link expired or reached its download limit.', 'EGONE', 410);
  if (status === 503) return new GetError(msg || 'Sender is offline — their daemon must be running for relay links.', 'EOFFLINE', 503);
  if (status === 409) return new GetError(msg || 'The sender is still uploading — retry shortly.', 'ENOTREADY', 409);
  return new GetError(`${msg || 'Download failed'} (HTTP ${status})`, 'EHTTP', status);
}

async function readSmallBody(res: NodeJS.ReadableStream, max = 4096): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of res as any) {
    parts.push(c as Buffer);
    n += (c as Buffer).length;
    if (n >= max) { (res as any).destroy?.(); break; }
  }
  return Buffer.concat(parts, n).subarray(0, max);
}

/** Refuse to write through a pre-planted symlink at a predictable temp path. */
function assertNotSymlink(p: string): void {
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(p); } catch { return; } // ENOENT is fine
  if (st.isSymbolicLink()) throw new GetError(`Refusing to write through a symlink: ${p}`, 'ESYMLINK');
}

type Sink = {
  write(c: Buffer): boolean;
  once(ev: 'drain', cb: () => void): unknown;
  on?(ev: 'error', cb: (e: any) => void): unknown;
};

/**
 * One download attempt. `resumeFrom` > 0 sends Range (and the resume token for
 * limited links). Resolves 'complete' if the server says the range is already
 * satisfied (the part file holds the whole file).
 */
async function attempt(
  url: string, sink: Sink, resumeFrom: number, ua: string,
  onData: (n: number) => void, opts: { resumeToken?: string | null; onHeaders?: (h: any) => void } = {},
): Promise<'done' | 'complete'> {
  const headers: Record<string, string> = { 'User-Agent': ua, Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' };
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;
  if (resumeFrom > 0 && opts.resumeToken) headers['X-SRIFT-Resume'] = opts.resumeToken;
  const { res } = await openRequest(withQuery(url, 'raw=1'), { headers, timeoutMs: 30_000 });
  const status = res.statusCode || 0;
  if (status === 416 && resumeFrom > 0) {
    const cr = /bytes \*\/(\d+)/.exec(String(res.headers['content-range'] || ''));
    res.resume();
    if (cr && Number(cr[1]) === resumeFrom) return 'complete';
    throw new GetError('Server refused to resume this download', 'ERESUME');
  }
  if (resumeFrom > 0 && status === 200) { res.resume(); throw new GetError('Server ignored the resume request', 'ERESUME'); }
  if (!(status === 200 || (status === 206 && resumeFrom > 0))) {
    throw explainStatus(status, (await readSmallBody(res)).toString('utf8'));
  }
  opts.onHeaders?.(res.headers);
  await new Promise<void>((resolve, reject) => {
    let last = Date.now();
    let settled = false;
    const idle = setInterval(() => {
      if (Date.now() - last > 60_000) res.destroy(new GetError('Stalled — no data for 60 s', 'ESTALL'));
    }, 5000);
    const finish = (err?: any) => {
      if (settled) return;
      settled = true;
      clearInterval(idle);
      if (err) reject(err); else resolve();
    };
    sink.on?.('error', (e: any) => { res.destroy(); finish(e); });
    res.on('data', (c: Buffer) => {
      last = Date.now();
      onData(c.length);
      let ok: boolean;
      try { ok = sink.write(c); } catch (e) { res.destroy(); finish(e); return; }
      if (!ok) { res.pause(); sink.once('drain', () => res.resume()); }
    });
    res.on('end', () => finish());
    res.on('error', (e) => finish(e));
    res.on('aborted', () => finish(new GetError('Connection closed early', 'ECONNRESET')));
  });
  return 'done';
}

function fileSink(p: string, append: boolean, mode: number): fs.WriteStream {
  assertNotSymlink(p);
  if (!append) fs.rmSync(p, { force: true });
  // 'wx' for fresh files: never follow or clobber something planted meanwhile.
  return fs.createWriteStream(p, { flags: append ? 'a' : 'wx', mode });
}

async function closeSink(ws: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve) => { if (ws.closed || ws.destroyed) resolve(); else ws.end(() => resolve()); });
}

export async function getLink(input: string, opts: GetOpts = {}): Promise<GetResult> {
  const { url, key, hasFragment } = resolveLink(input);
  if (hasFragment && !key) throw new GetError('The #fragment of this link is not a valid SRIFT key — copy the whole link.', 'EKEY');
  const ua = opts.userAgent || 'srift-cli';
  const toStdout = opts.out === '-';
  const log = (m: string) => { if (!opts.quiet && !opts.json) process.stderr.write(m); };

  // Destination (plain files use the server name; encrypted ones learn theirs after decryption).
  let destDir = process.cwd();
  let explicitFile: string | null = null;
  if (opts.out && !toStdout) {
    const o = path.resolve(opts.out);
    if (fs.existsSync(o) && fs.statSync(o).isDirectory()) destDir = o;
    else if (/[\\/]$/.test(opts.out)) { fs.mkdirSync(o, { recursive: true }); destDir = o; }
    else { explicitFile = o; fs.mkdirSync(path.dirname(o), { recursive: true }); }
  }
  // Partial files (and their resume token) are tied to this exact link.
  const linkTag = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
  const tmpDir = explicitFile ? path.dirname(explicitFile) : destDir;
  const tokenFile = path.join(tmpDir, `.srift-${linkTag}.resume`);
  const readToken = (): string | null => { try { return fs.readFileSync(tokenFile, 'utf8').trim() || null; } catch { return null; } };
  const saveToken = (t: string) => { try { assertNotSymlink(tokenFile); fs.writeFileSync(tokenFile, t, { mode: 0o600 }); } catch { /* best-effort */ } };
  const dropToken = () => { try { fs.rmSync(tokenFile, { force: true }); } catch { /* ignore */ } };
  let resumeToken = readToken();
  const captureToken = (h: any) => {
    const t = h['x-srift-resume'];
    if (t) { resumeToken = String(t); saveToken(resumeToken); }
  };
  const probeHeaders = (): Record<string, string> => ({ 'User-Agent': ua, ...(resumeToken ? { 'X-SRIFT-Resume': resumeToken } : {}) });

  // HEAD first: name/size/encryption without consuming a download.
  let head: any = {};
  try {
    const { res } = await openRequest(url, { method: 'HEAD', headers: probeHeaders(), timeoutMs: 20_000 });
    res.resume();
    // Never probe with a GET here: on a --once link that would use up the download.
    if ((res.statusCode || 0) >= 400) throw explainStatus(res.statusCode || 0, '');
    head = res.headers;
  } catch (e: any) {
    if (e instanceof GetError) throw e;
    throw new GetError(formatNetError(e, url), e?.code || 'ENET');
  }
  const encrypted = String(head['x-srift-encrypted'] || '').toUpperCase() === 'SRE1';
  if (encrypted && !key) {
    throw new GetError('This link is end-to-end encrypted but has no key. Use the full link including the part after #.', 'EKEY');
  }
  if (encrypted) {
    // Check key + password against the encrypted header/metadata via ?peek=1,
    // which never consumes a download. Otherwise a missing or wrong password
    // would only surface after a --once link had already been used up.
    let peek: Buffer | null = null;
    try {
      const { res } = await openRequest(withQuery(url, 'peek=1'), { headers: { ...probeHeaders(), Accept: 'application/octet-stream' }, timeoutMs: 20_000 });
      const body = await readSmallBody(res, 70 * 1024);
      const st = res.statusCode || 0;
      if (st === 200 || st === 206) peek = body;
      else if (st >= 400 && st !== 400) throw explainStatus(st, body.toString('utf8'));
    } catch (e: any) {
      if (e instanceof GetError) throw e;
      throw new GetError(formatNetError(e, url), e?.code || 'ENET');
    }
    if (peek && peek.length) {
      try {
        new Decryptor(key!, opts.password, () => { /* discard */ }).push(peek);
      } catch (e: any) {
        if (e?.code === 'EPASSWORD') throw new GetError('This link is password-protected — re-run with --password <password>.', 'EPASSWORD');
        if (e?.code === 'EDECRYPT') throw new GetError('Wrong password or incomplete link — nothing was downloaded, so a limited link is still usable.', 'EDECRYPT');
        throw new GetError(`Not a valid SRIFT encrypted file: ${e?.message || e}`, 'EFORMAT');
      }
    }
  }
  const serverName = filenameFromDisposition(head['content-disposition']) || 'download.bin';
  const mode = head['x-srift-mode'] ? String(head['x-srift-mode']) : null;
  const total = parseInt(String(head['x-srift-size'] || head['content-length'] || ''), 10) || 0;

  let received = 0;
  let lastPrint = 0;
  const progress = (n: number) => {
    received += n;
    if (!opts.quiet && !opts.json && process.stderr.isTTY && Date.now() - lastPrint > 250) {
      const pct = total ? ` ${((received / total) * 100).toFixed(1)}%` : '';
      process.stderr.write(`\r[srift] ${fmtBytes(received)}${total ? ` / ${fmtBytes(total)}` : ''}${pct}   `);
      lastPrint = Date.now();
    }
  };

  /** Fill `part` with the whole response body: resumes, retries, and skips work already done. */
  const downloadTo = async (part: string, fileMode: number) => {
    const size = () => { try { return fs.statSync(part).size; } catch { return 0; } };
    if (total > 0 && size() === total) return; // finished earlier; nothing to fetch
    let lastErr: any = null;
    for (let i = 1; i <= 6; i++) {
      const from = size();
      received = from;
      const ws = fileSink(part, from > 0, fileMode);
      try {
        const r = await attempt(url, ws, from, ua, progress, { resumeToken, onHeaders: from === 0 ? captureToken : undefined });
        await closeSink(ws);
        if (r === 'complete' || total === 0 || size() >= total) return;
        throw new GetError('Connection closed early', 'ECONNRESET');
      } catch (e: any) {
        await closeSink(ws);
        lastErr = e;
        if (e?.code === 'ERESUME') { fs.rmSync(part, { force: true }); dropToken(); resumeToken = null; continue; }
        const dropEmpty = () => { try { if (size() === 0) fs.rmSync(part, { force: true }); } catch { /* ignore */ } };
        if (e instanceof GetError && (e.code === 'ESENDERFILE' || (!['ESTALL', 'ECONNRESET'].includes(e.code) && !(e.status && e.status >= 500)))) { dropEmpty(); throw e; }
        if (!(e instanceof GetError) && !['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EAI_AGAIN'].includes(e?.code)) {
          try { if (size() === 0) fs.rmSync(part, { force: true }); } catch { /* ignore */ }
          throw new GetError(formatNetError(e, url), e?.code || 'ENET');
        }
        const wait = Math.min(1000 * 2 ** (i - 1), 15_000);
        log(`\n[srift] ${e.message || e} — retrying in ${Math.round(wait / 1000)}s…\n`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    try { if (size() === 0) fs.rmSync(part, { force: true }); } catch { /* ignore */ }
    throw lastErr instanceof GetError ? lastErr : new GetError(formatNetError(lastErr, url), lastErr?.code || 'ENET');
  };

  // stdout: single attempt (bytes written to a pipe cannot be taken back), with backpressure.
  let stdoutBlocked = false;
  const toOut = (b: Buffer) => { if (!process.stdout.write(b)) stdoutBlocked = true; };
  const stdoutSink = (transform?: (c: Buffer) => void): Sink => ({
    write(c: Buffer) {
      if (transform) transform(c); else toOut(c);
      const ok = !stdoutBlocked;
      stdoutBlocked = false;
      return ok;
    },
    once(_ev: 'drain', cb: () => void) { process.stdout.once('drain', cb); return this; },
    on(_ev: 'error', cb: (e: any) => void) { process.stdout.once('error', cb); return this; },
  });

  if (!encrypted) {
    if (toStdout) {
      try { await attempt(url, stdoutSink(), 0, ua, progress); } catch (e: any) {
        throw e instanceof GetError ? e : new GetError(formatNetError(e, url), e?.code || 'ENET');
      }
      return { ok: true, path: null, fileName: serverName, bytes: received, encrypted: false, mode };
    }
    const finalPath = explicitFile || path.join(destDir, serverName);
    if (fs.existsSync(finalPath) && !opts.force && explicitFile) {
      throw new GetError(`${finalPath} already exists (use --force to overwrite)`, 'EEXIST');
    }
    const part = `${finalPath}.${linkTag}.srift-part`;
    await downloadTo(part, 0o644);
    const dest = explicitFile ? finalPath : (opts.force ? finalPath : uniquePath(finalPath));
    if (opts.force && fs.existsSync(dest)) fs.rmSync(dest);
    fs.renameSync(part, dest);
    dropToken();
    if (!opts.quiet && !opts.json && process.stderr.isTTY) process.stderr.write('\n');
    return { ok: true, path: dest, fileName: path.basename(dest), bytes: fs.statSync(dest).size, encrypted: false, mode };
  }

  if (toStdout) {
    const dec = new Decryptor(key!, opts.password, (pt) => toOut(pt));
    // Decryption errors thrown inside the data handler abort the request via attempt().
    try { await attempt(url, stdoutSink((c) => dec.push(c)), 0, ua, progress); dec.end(); } catch (e: any) {
      if (e instanceof GetError) throw e;
      if (e?.code === 'EDECRYPT' || e?.code === 'EPASSWORD' || e?.code === 'ETRUNCATED') throw new GetError(e.message, e.code);
      throw new GetError(formatNetError(e, url), e?.code || 'ENET');
    }
    return { ok: true, path: null, fileName: dec.meta?.name || 'download', bytes: dec.bytesOut, encrypted: true, mode };
  }

  // Encrypted to disk: fetch ciphertext (resumable) to a private temp file, then decrypt.
  const ctPart = path.join(tmpDir, `.srift-${linkTag}.sre1-part`);
  await downloadTo(ctPart, 0o600);
  if (!opts.quiet && !opts.json && process.stderr.isTTY) process.stderr.write('\n');

  const tmpOut = `${ctPart}.dec`;
  let name = 'download.bin';
  try {
    assertNotSymlink(tmpOut);
    fs.rmSync(tmpOut, { force: true });
    const out = fs.openSync(tmpOut, 'wx', 0o600);
    try {
      const dec = new Decryptor(key!, opts.password, (pt) => { fs.writeSync(out, pt); }, (m) => { name = safeBasename(m.name) || name; });
      for await (const c of fs.createReadStream(ctPart, { highWaterMark: 1024 * 1024 })) dec.push(c as Buffer);
      dec.end();
    } finally { fs.closeSync(out); }
  } catch (e: any) {
    try { fs.rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
    if (e?.code === 'EPASSWORD' || e?.code === 'EDECRYPT') {
      // Keep the ciphertext: a retry with the right password needs no re-download
      // (downloadTo sees the complete part file and skips the network).
      throw new GetError(e.code === 'EPASSWORD'
        ? 'This link is password-protected — re-run with --password <password>.'
        : 'Decryption failed — wrong password, incomplete link, or the file was modified.', e.code);
    }
    try { fs.rmSync(ctPart, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  const finalPath = explicitFile || path.join(destDir, name);
  if (explicitFile && fs.existsSync(finalPath) && !opts.force) {
    fs.rmSync(tmpOut, { force: true });
    throw new GetError(`${finalPath} already exists (use --force to overwrite)`, 'EEXIST');
  }
  const dest = explicitFile || opts.force ? finalPath : uniquePath(finalPath);
  if (opts.force && fs.existsSync(dest)) fs.rmSync(dest);
  fs.renameSync(tmpOut, dest);
  try { fs.chmodSync(dest, 0o644); } catch { /* windows */ }
  fs.rmSync(ctPart, { force: true });
  dropToken();
  return { ok: true, path: dest, fileName: path.basename(dest), bytes: fs.statSync(dest).size, encrypted: true, mode };
}

export { GetError };
