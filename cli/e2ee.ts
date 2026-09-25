/**
 * SRIFT link encryption — format "SRE1".
 *
 * The key lives in the URL fragment (`https://srift.app/d/<token>#k=<key>`).
 * Browsers and HTTP clients never send the fragment, so the relay only ever
 * handles ciphertext. The browser page at /d/<token> and `srift get` decrypt
 * locally. Spec: docs/quick-share-e2ee.md (keep in sync with public/d-decrypt.js).
 *
 * Layout
 *   header  (36 B)  "SRE1" | ver u8=1 | flags u8 (bit0 = password) | 0x0000
 *                   | chunkSize u32be | noncePrefix 7 B | 0x00 | salt 16 B
 *   meta            u32be L | AES-256-GCM(counter 0, last 0) of JSON {name,size,mime}
 *   chunks          AES-256-GCM(counter i, last = i==n) for i = 1..n
 *                   n = max(1, ceil(size / chunkSize)); every chunk but the
 *                   last carries exactly chunkSize plaintext bytes.
 *   IV              noncePrefix(7) | counter u32be | lastFlag u8
 *   AAD             the 36-byte header, for every block.
 *   tag             16 B appended to each block.
 *
 * Counter + last flag (the STREAM construction) prevents reordering,
 * truncation and extension. Key: 32 random bytes. With a password the
 * content key is HKDF-SHA256(fragKey || PBKDF2-SHA256(password, salt, 100k),
 * salt, "srift-e2ee-v1") so the link alone is not enough.
 */
import crypto from 'crypto';
import fs from 'fs';

export const E2EE_MAGIC = 'SRE1';
export const E2EE_HEADER_LEN = 36;
export const E2EE_TAG_LEN = 16;
export const E2EE_DEFAULT_CHUNK = 1024 * 1024;
export const E2EE_KDF_ITERATIONS = 100_000;
const HKDF_INFO = 'srift-e2ee-v1';

export type E2eeMeta = { name: string; size: number; mime: string };

export function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function newLinkKey(): Buffer {
  return crypto.randomBytes(32);
}

/** Parse the `#k=...` fragment (also accepts a bare key). */
export function parseFragmentKey(fragment: string | null | undefined): Buffer | null {
  if (!fragment) return null;
  const f = fragment.replace(/^#/, '');
  const params = new URLSearchParams(f);
  const k = params.get('k') || (/^[A-Za-z0-9_-]{43}$/.test(f) ? f : null);
  if (!k) return null;
  const key = fromB64url(k);
  return key.length === 32 ? key : null;
}

export function buildHeader(opts: { chunkSize?: number; password?: boolean } = {}): Buffer {
  const h = Buffer.alloc(E2EE_HEADER_LEN);
  h.write(E2EE_MAGIC, 0, 'ascii');
  h[4] = 1;
  h[5] = opts.password ? 1 : 0;
  h.writeUInt32BE(opts.chunkSize || E2EE_DEFAULT_CHUNK, 8);
  crypto.randomBytes(7).copy(h, 12);
  if (opts.password) crypto.randomBytes(16).copy(h, 20);
  return h;
}

export type ParsedHeader = { version: number; password: boolean; chunkSize: number; noncePrefix: Buffer; salt: Buffer; raw: Buffer };

export function parseHeader(h: Buffer): ParsedHeader {
  if (h.length < E2EE_HEADER_LEN || h.toString('ascii', 0, 4) !== E2EE_MAGIC) {
    throw new Error('Not a SRIFT encrypted stream (bad magic)');
  }
  if (h[4] !== 1) throw new Error(`Unsupported SRIFT encryption version ${h[4]} — run \`srift self-update\``);
  const chunkSize = h.readUInt32BE(8);
  if (chunkSize < 1024 || chunkSize > 64 * 1024 * 1024) throw new Error('Corrupt header (chunk size)');
  return {
    version: 1,
    password: (h[5] & 1) === 1,
    chunkSize,
    noncePrefix: Buffer.from(h.subarray(12, 19)),
    salt: Buffer.from(h.subarray(20, 36)),
    raw: Buffer.from(h.subarray(0, E2EE_HEADER_LEN)),
  };
}

export function deriveContentKey(fragKey: Buffer, header: ParsedHeader, password?: string): Buffer {
  if (!header.password) return fragKey;
  if (!password) throw Object.assign(new Error('This link is password-protected — pass --password'), { code: 'EPASSWORD' });
  const pw = crypto.pbkdf2Sync(Buffer.from(password.normalize('NFC'), 'utf8'), header.salt, E2EE_KDF_ITERATIONS, 32, 'sha256');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([fragKey, pw]), header.salt, Buffer.from(HKDF_INFO), 32));
}

function iv(prefix: Buffer, counter: number, last: boolean): Buffer {
  const b = Buffer.alloc(12);
  prefix.copy(b, 0);
  b.writeUInt32BE(counter >>> 0, 7);
  b[11] = last ? 1 : 0;
  return b;
}

function seal(key: Buffer, header: ParsedHeader, counter: number, last: boolean, pt: Buffer): Buffer {
  const c = crypto.createCipheriv('aes-256-gcm', key, iv(header.noncePrefix, counter, last));
  c.setAAD(header.raw);
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}

function open(key: Buffer, header: ParsedHeader, counter: number, last: boolean, ct: Buffer): Buffer {
  if (ct.length < E2EE_TAG_LEN) throw new Error('Truncated block');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv(header.noncePrefix, counter, last));
  d.setAAD(header.raw);
  d.setAuthTag(ct.subarray(ct.length - E2EE_TAG_LEN));
  try {
    return Buffer.concat([d.update(ct.subarray(0, ct.length - E2EE_TAG_LEN)), d.final()]);
  } catch {
    throw Object.assign(new Error('Decryption failed — wrong key/password, or the file was modified in transit'), { code: 'EDECRYPT' });
  }
}

export function chunkCount(size: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/** Exact ciphertext length for a plaintext of `size` bytes. */
export function encryptedSize(size: number, meta: E2eeMeta, chunkSize = E2EE_DEFAULT_CHUNK): number {
  const metaLen = Buffer.byteLength(JSON.stringify(meta)) + E2EE_TAG_LEN;
  return E2EE_HEADER_LEN + 4 + metaLen + size + chunkCount(size, chunkSize) * E2EE_TAG_LEN;
}

/**
 * Encrypt a file, yielding ciphertext pieces in order. Memory use is one chunk.
 * `meta.size` must equal the file's size; the file must not change while reading.
 */
export async function* encryptFile(
  filePath: string,
  fragKey: Buffer,
  meta: E2eeMeta,
  opts: { password?: string; chunkSize?: number } = {},
): AsyncGenerator<Buffer> {
  const header = parseHeader(buildHeader({ chunkSize: opts.chunkSize, password: !!opts.password }));
  const key = deriveContentKey(fragKey, header, opts.password);
  yield header.raw;
  const metaCt = seal(key, header, 0, false, Buffer.from(JSON.stringify(meta)));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(metaCt.length, 0);
  yield Buffer.concat([len, metaCt]);

  const n = chunkCount(meta.size, header.chunkSize);
  // The 32-bit counter must never wrap (a wrap would reuse the metadata nonce).
  if (n >= 0xffffffff) throw new Error('File too large for this chunk size');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(header.chunkSize);
    for (let i = 1; i <= n; i++) {
      const want = i < n ? header.chunkSize : meta.size - (n - 1) * header.chunkSize;
      let got = 0;
      while (got < want) {
        const r = fs.readSync(fd, buf, got, want - got, (i - 1) * header.chunkSize + got);
        if (r === 0) throw new Error('File shrank while encrypting');
        got += r;
      }
      yield seal(key, header, i, i === n, buf.subarray(0, want));
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Streaming decryptor: feed ciphertext with push(), receive plaintext via
 * `onData`. Call end() to assert the stream finished on a `last` block.
 */
export class Decryptor {
  // Byte queue: each received byte is copied once, when a block is complete.
  private q: Buffer[] = [];
  private qLen = 0;
  private header: ParsedHeader | null = null;
  private key: Buffer | null = null;
  private metaLen = -1;
  meta: E2eeMeta | null = null;
  private counter = 1;
  private n = 0;
  private done = false;
  bytesOut = 0;

  private fragKey: Buffer;
  private password: string | undefined;
  private onData: (pt: Buffer) => void;
  private onMeta?: (m: E2eeMeta, h: ParsedHeader) => void;

  constructor(
    fragKey: Buffer,
    password: string | undefined,
    onData: (pt: Buffer) => void,
    onMeta?: (m: E2eeMeta, h: ParsedHeader) => void,
  ) {
    this.fragKey = fragKey;
    this.password = password;
    this.onData = onData;
    this.onMeta = onMeta;
  }

  push(chunk: Buffer): void {
    if (chunk.length) { this.q.push(chunk); this.qLen += chunk.length; }
    this.drain();
  }

  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const h = this.q[0];
      const need = n - off;
      if (h.length <= need) { h.copy(out, off); off += h.length; this.q.shift(); }
      else { h.copy(out, off, 0, need); this.q[0] = h.subarray(need); off += need; }
    }
    this.qLen -= n;
    return out;
  }

  private drain(): void {
    if (!this.header) {
      if (this.qLen < E2EE_HEADER_LEN) return;
      this.header = parseHeader(this.take(E2EE_HEADER_LEN));
      this.key = deriveContentKey(this.fragKey, this.header, this.password);
    }
    if (!this.meta) {
      if (this.metaLen < 0) {
        if (this.qLen < 4) return;
        this.metaLen = this.take(4).readUInt32BE(0);
        if (this.metaLen > 64 * 1024) throw new Error('Corrupt stream (metadata too large)');
      }
      if (this.qLen < this.metaLen) return;
      const m = JSON.parse(open(this.key!, this.header, 0, false, this.take(this.metaLen)).toString('utf8'));
      if (typeof m?.name !== 'string' || !Number.isSafeInteger(m?.size) || m.size < 0) throw new Error('Corrupt metadata');
      this.meta = { name: String(m.name), size: m.size, mime: String(m.mime || 'application/octet-stream') };
      this.n = chunkCount(this.meta.size, this.header.chunkSize);
      this.onMeta?.(this.meta, this.header);
    }
    const h = this.header!;
    while (!this.done) {
      const last = this.counter === this.n;
      const ptLen = last ? this.meta!.size - (this.n - 1) * h.chunkSize : h.chunkSize;
      const need = ptLen + E2EE_TAG_LEN;
      if (this.qLen < need) return;
      const pt = open(this.key!, h, this.counter, last, this.take(need));
      this.bytesOut += pt.length;
      if (pt.length) this.onData(pt);
      if (last) this.done = true;
      else this.counter++;
    }
    if (this.done && this.qLen) throw new Error('Unexpected data after final block');
  }

  end(): void {
    if (!this.done) throw Object.assign(new Error('Encrypted stream ended early — the download is truncated'), { code: 'ETRUNCATED' });
  }
}

/** Decrypt a whole ciphertext file to `outPath`. Returns the embedded metadata. */
export async function decryptFileTo(inPath: string, outPath: string, fragKey: Buffer, password?: string): Promise<E2eeMeta> {
  const out = fs.openSync(outPath, 'w', 0o600);
  let meta: E2eeMeta | null = null;
  try {
    const dec = new Decryptor(fragKey, password, (pt) => { fs.writeSync(out, pt); }, (m) => { meta = m; });
    const rs = fs.createReadStream(inPath, { highWaterMark: 1024 * 1024 });
    for await (const c of rs) dec.push(c as Buffer);
    dec.end();
  } finally {
    fs.closeSync(out);
  }
  return meta!;
}
