/**
 * End-to-end relay self-test for `srift doctor --deep` and
 * `srift_net_diagnose { deep: true }`: create an encrypted single-use link to
 * random bytes, download it back through the SRIFT server with the real
 * downloader, byte-compare, measure throughput, clean up.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getLink } from './get.ts';
import type { SelfTestResult } from './probe.ts';

type Call = (endpoint: string, method: 'GET' | 'POST', body?: any) => Promise<any>;

export async function relaySelfTest(call: Call, opts: { bytes?: number; via?: string; userAgent?: string } = {}): Promise<SelfTestResult> {
  const size = opts.bytes ?? 2 * 1024 * 1024;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srift-selftest-'));
  const src = path.join(dir, 'selftest.bin');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir);
  const data = crypto.randomBytes(size);
  fs.writeFileSync(src, data);
  let token: string | null = null;
  try {
    const t0 = Date.now();
    const res = await call('/quick-share', 'POST', { filePath: src, encrypt: true, maxDownloads: 1, ttlMs: 5 * 60 * 1000 });
    if (!res?.downloadUrl) throw new Error(res?.error || 'no link returned');
    token = res.token || null;
    const got = await getLink(res.downloadUrl, { out: outDir, quiet: true, json: true, userAgent: opts.userAgent || 'srift-doctor' });
    const ms = Date.now() - t0;
    const back = fs.readFileSync(got.path!);
    if (!back.equals(data)) throw new Error('downloaded bytes differ from the original');
    return { ok: true, ms, bytes: size, mbps: size / 1024 / 1024 / Math.max(ms / 1000, 0.001), via: opts.via };
  } finally {
    if (token) { try { await call('/pubshare/revoke', 'POST', { token }); } catch { /* single-use: already gone */ } }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
