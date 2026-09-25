var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// cli/net.ts
import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import { URL as URL2 } from "url";
function envFirst(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return void 0;
}
function isLoopbackHost(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h) || h === "0.0.0.0";
}
function matchesNoProxy(hostname, port, noProxy) {
  if (!noProxy) return false;
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  for (const raw of noProxy.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    let entryPort = "";
    const m = /^(.*?)(?::(\d+))?$/.exec(entry);
    if (m && m[2] && !entry.includes("::")) {
      entry = m[1];
      entryPort = m[2];
    }
    if (entryPort && entryPort !== port) continue;
    entry = entry.replace(/^\*?\./, "");
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}
function getProxyForUrl(target) {
  let u;
  try {
    u = typeof target === "string" ? new URL2(target) : target;
  } catch {
    return null;
  }
  if (isLoopbackHost(u.hostname)) return null;
  const secure = u.protocol === "https:" || u.protocol === "wss:";
  const port = u.port || (secure ? "443" : "80");
  if (matchesNoProxy(u.hostname, port, envFirst("NO_PROXY", "no_proxy"))) return null;
  const raw = secure ? envFirst("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy") : envFirst("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy");
  if (!raw) return null;
  try {
    const p = new URL2(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (!["http:", "https:", "socks5:", "socks5h:", "socks:"].includes(p.protocol)) return null;
    return p;
  } catch {
    return null;
  }
}
function describeProxy(p) {
  if (!p) return "none";
  return `${p.protocol}//${p.hostname}${p.port ? `:${p.port}` : ""}${p.username ? " (with credentials)" : ""}`;
}
function proxyEnvPresent() {
  return !!envFirst("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy");
}
function proxyDefaultPort(p) {
  if (p.port) return parseInt(p.port, 10);
  if (p.protocol === "https:") return 443;
  if (p.protocol.startsWith("socks")) return 1080;
  return 80;
}
function connectViaHttpProxy(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    if (proxy.username) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(cred).toString("base64")}`;
    }
    const mod = proxy.protocol === "https:" ? https : http;
    const req = mod.request({
      host: proxy.hostname,
      port: proxyDefaultPort(proxy),
      method: "CONNECT",
      path: `${host.includes(":") ? `[${host}]` : host}:${port}`,
      headers,
      agent: false,
      timeout: timeoutMs
    });
    req.once("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const err = new Error(`Proxy CONNECT to ${host}:${port} failed: HTTP ${res.statusCode}`);
        err.code = res.statusCode === 407 ? "EPROXYAUTH" : "EPROXYCONNECT";
        err.proxyStatus = res.statusCode;
        reject(err);
        return;
      }
      if (head && head.length) socket.unshift(head);
      resolve(socket);
    });
    req.once("timeout", () => req.destroy(Object.assign(new Error(`Proxy CONNECT timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" })));
    req.once("error", reject);
    req.end();
  });
}
function connectViaSocks5(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyDefaultPort(proxy), proxy.hostname);
    let buf = Buffer.alloc(0);
    let stage = "greet";
    const user = proxy.username ? decodeURIComponent(proxy.username) : "";
    const pass = proxy.password ? decodeURIComponent(proxy.password) : "";
    const fail = (msg, code = "ESOCKS") => {
      sock.destroy();
      reject(Object.assign(new Error(`SOCKS5 proxy: ${msg}`), { code }));
    };
    const timer = setTimeout(() => fail(`timed out after ${timeoutMs} ms`, "ETIMEDOUT"), timeoutMs);
    const sendConnect = () => {
      stage = "connect";
      const hostBuf = Buffer.from(host, "utf8");
      if (hostBuf.length > 255) return fail("hostname too long");
      const req = Buffer.alloc(7 + hostBuf.length);
      req[0] = 5;
      req[1] = 1;
      req[2] = 0;
      req[3] = 3;
      req[4] = hostBuf.length;
      hostBuf.copy(req, 5);
      req.writeUInt16BE(port, 5 + hostBuf.length);
      sock.write(req);
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greet") {
        if (buf.length < 2) return;
        const method = buf[1];
        buf = buf.subarray(2);
        if (method === 0) return sendConnect();
        if (method === 2 && user) {
          stage = "auth";
          const u = Buffer.from(user), p = Buffer.from(pass);
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          return;
        }
        return fail(method === 255 ? "no acceptable authentication method" : `unsupported auth method ${method}`);
      }
      if (stage === "auth") {
        if (buf.length < 2) return;
        if (buf[1] !== 0) return fail("authentication rejected", "EPROXYAUTH");
        buf = buf.subarray(2);
        return sendConnect();
      }
      if (buf.length < 5) return;
      if (buf[1] !== 0) return fail(`CONNECT to ${host}:${port} rejected (code ${buf[1]})`, "EPROXYCONNECT");
      const atyp = buf[3];
      const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + buf[4] : -1;
      if (addrLen < 0) return fail("malformed reply");
      const total = 4 + addrLen + 2;
      if (buf.length < total) return;
      clearTimeout(timer);
      sock.removeListener("data", onData);
      sock.removeListener("error", onErr);
      const rest = buf.subarray(total);
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    };
    const onErr = (e) => {
      clearTimeout(timer);
      reject(e);
    };
    sock.on("data", onData);
    sock.once("error", onErr);
    sock.once("connect", () => {
      sock.write(user ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
    });
  });
}
function openTunnel(proxy, host, port, timeoutMs = 15e3) {
  return proxy.protocol.startsWith("socks") ? connectViaSocks5(proxy, host, port, timeoutMs) : connectViaHttpProxy(proxy, host, port, timeoutMs);
}
function agentFor(target) {
  const u = typeof target === "string" ? new URL2(target) : target;
  const proxy = getProxyForUrl(u);
  if (!proxy) return void 0;
  const secure = u.protocol === "https:" || u.protocol === "wss:";
  const key = `${secure ? "s" : "p"}|${proxy.href}`;
  let a = agentCache.get(key);
  if (!a) {
    a = secure ? new TunnelHttpsAgent(proxy) : new TunnelHttpAgent(proxy);
    agentCache.set(key, a);
  }
  return a;
}
function openRequest(url, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? 5;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL2(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const mod = u.protocol === "https:" ? https : http;
    const body = typeof opts.body === "string" ? Buffer.from(opts.body) : opts.body;
    const headers = { ...opts.headers || {} };
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === "content-length")) {
      headers["Content-Length"] = String(body.length);
    }
    const req = mod.request(u, { method: opts.method || "GET", headers, agent: agentFor(u), signal: opts.signal }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
        res.resume();
        const next = new URL2(res.headers.location, u).toString();
        if (u.protocol === "https:" && next.startsWith("http:")) {
          reject(new Error(`Refusing insecure redirect to ${next}`));
          return;
        }
        const method = status === 303 ? "GET" : opts.method;
        let headers2 = opts.headers;
        if (new URL2(next).origin !== u.origin && headers2) {
          headers2 = Object.fromEntries(Object.entries(headers2).filter(([k]) => !/^(authorization|cookie|x-srift-resume)$/i.test(k)));
        }
        openRequest(next, { ...opts, headers: headers2, method, body: status === 303 ? void 0 : opts.body, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
        return;
      }
      resolve({ res, url: u.toString() });
    });
    const t = opts.timeoutMs ?? 15e3;
    if (t > 0) {
      req.setTimeout(t, () => req.destroy(Object.assign(new Error(`Request timed out after ${Math.round(t / 1e3)}s`), { code: "ETIMEDOUT" })));
    }
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
async function request(url, opts = {}) {
  const { res, url: finalUrl } = await openRequest(url, opts);
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    res.on("data", (c) => {
      total += c.length;
      if (opts.maxBytes && total > opts.maxBytes) {
        res.destroy();
        reject(Object.assign(new Error(`Response larger than ${opts.maxBytes} bytes`), { code: "EMSGSIZE" }));
        return;
      }
      chunks.push(c);
    });
    res.on("end", resolve);
    res.on("error", reject);
  });
  return { status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks), url: finalUrl };
}
async function requestJson(url, opts = {}) {
  const headers = { Accept: "application/json", ...opts.headers || {} };
  let body = opts.body;
  if (opts.json !== void 0) {
    body = JSON.stringify(opts.json);
    headers["Content-Type"] = "application/json";
  }
  const r = await request(url, { ...opts, headers, body });
  let data = null;
  const text = r.body.toString("utf8");
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { status: r.status, data, headers: r.headers };
}
function explainNetError(err, url) {
  const code = err?.code || "";
  const msg = err?.message || String(err);
  const target = url ? ` (${url})` : "";
  if (TLS_TRUST_CODES.has(code) || /self[- ]signed|unable to (get|verify)/i.test(msg)) {
    return process.env.NODE_EXTRA_CA_CERTS ? { kind: "tls-untrusted", message: `TLS certificate not trusted${target} even with NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS}.`, fix: "Check that file contains the proxy's root CA in PEM format." } : {
      kind: "tls-untrusted",
      message: `TLS certificate not trusted${target} \u2014 a TLS-inspecting proxy is likely re-signing traffic.`,
      fix: process.platform === "win32" ? 'Export the proxy root CA as PEM, then: setx NODE_EXTRA_CA_CERTS "C:\\path\\to\\proxy-ca.pem" (and open a new terminal). Never set NODE_TLS_REJECT_UNAUTHORIZED=0.' : "Export the proxy root CA as PEM, then: export NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem. Never set NODE_TLS_REJECT_UNAUTHORIZED=0."
    };
  }
  if (code === "CERT_HAS_EXPIRED" || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return { kind: "tls-invalid", message: `TLS certificate invalid${target}: ${code}.`, fix: "Check the system clock, and whether a captive portal or proxy is intercepting HTTPS." };
  }
  if (code === "EPROXYAUTH") {
    return { kind: "proxy-auth", message: `Proxy requires authentication${target}.`, fix: "Put credentials in the proxy URL: HTTPS_PROXY=http://user:pass@proxy:port" };
  }
  if (code === "EPROXYCONNECT") {
    return { kind: "proxy-denied", message: `Proxy refused the connection${target}: ${msg}`, fix: "Ask for srift.app:443 to be allow-listed on the proxy, or set NO_PROXY if it should be reached directly." };
  }
  if (code === "EPERM" || code === "EACCES") {
    return { kind: "sandbox", message: `The OS denied the network operation${target} (${code}) \u2014 this looks like a sandbox.`, fix: proxyEnvPresent() ? "SRIFT will use the configured proxy; allow srift.app in the sandbox network policy." : "Allow network access for this tool, or allow-list srift.app:443 in the sandbox settings." };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { kind: "dns", message: `DNS lookup failed${target} (${code}).`, fix: proxyEnvPresent() ? "Check the proxy URL host." : "Check network connectivity; if you are behind a proxy set HTTPS_PROXY." };
  }
  if (code === "ECONNREFUSED") {
    return { kind: "refused", message: `Connection refused${target}.`, fix: proxyEnvPresent() ? "Check that the proxy in HTTPS_PROXY is running." : "A firewall may be rejecting the connection; try setting HTTPS_PROXY." };
  }
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || /timed out/i.test(msg)) {
    return { kind: "timeout", message: `Network timed out${target}.`, fix: "Outbound traffic may be filtered. If you are behind a proxy set HTTPS_PROXY; run `srift doctor` for a full check." };
  }
  return { kind: "unknown", message: `${msg}${target}` };
}
function formatNetError(err, url) {
  const d = explainNetError(err, url);
  return d.fix ? `${d.message}
  Fix: ${d.fix}` : d.message;
}
var TunnelHttpsAgent, TunnelHttpAgent, agentCache, TLS_TRUST_CODES;
var init_net = __esm({
  "cli/net.ts"() {
    "use strict";
    TunnelHttpsAgent = class extends https.Agent {
      constructor(proxy) {
        super({ keepAlive: true, maxSockets: 16 });
        this.proxy = proxy;
      }
      // Node calls createConnection(options, cb); returning undefined and invoking
      // cb asynchronously is the documented extension point used by agent-base.
      createConnection(options, cb) {
        const host = options.host || options.hostname;
        const port = Number(options.port) || 443;
        openTunnel(this.proxy, host, port).then((raw) => {
          const secure = tls.connect({ ...options, socket: raw, servername: options.servername || (net.isIP(host) ? void 0 : host) });
          cb?.(null, secure);
        }, (err) => cb?.(err, void 0));
        return void 0;
      }
    };
    TunnelHttpAgent = class extends http.Agent {
      constructor(proxy) {
        super({ keepAlive: true, maxSockets: 16 });
        this.proxy = proxy;
      }
      createConnection(options, cb) {
        openTunnel(this.proxy, options.host || options.hostname, Number(options.port) || 80).then((s) => cb?.(null, s), (err) => cb?.(err, void 0));
        return void 0;
      }
    };
    agentCache = /* @__PURE__ */ new Map();
    TLS_TRUST_CODES = /* @__PURE__ */ new Set([
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "UNABLE_TO_GET_ISSUER_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "CERT_UNTRUSTED"
    ]);
  }
});

// cli/probe.ts
import { spawn, spawnSync } from "child_process";
import dgram from "dgram";
import dns from "dns";
import fs from "fs";
import http2 from "http";
import net2 from "net";
import os from "os";
import path from "path";
import crypto from "crypto";
import { WebSocket } from "ws";
function apiBase() {
  return (process.env.SRIFT_API_BASE || process.env.SRIFT_PUBLIC_BASE || process.env.NEXT_PUBLIC_API_URL || "https://srift.app").replace(/\/+$/, "");
}
function detectSandbox() {
  const e = process.env;
  const hints = [];
  let ephemeral = false;
  const flag = (cond, hint, eph = false) => {
    if (cond) {
      hints.push(hint);
      if (eph) ephemeral = true;
    }
  };
  flag(e.CLAUDECODE || e.CLAUDE_CODE_ENTRYPOINT, "Claude Code");
  flag(e.CLAUDE_CODE_REMOTE, "Claude Code (remote)", true);
  flag(e.CODEX_SANDBOX || e.CODEX_SANDBOX_NETWORK_DISABLED, "Codex sandbox", true);
  flag(e.CURSOR_TRACE_ID || e.CURSOR_AGENT, "Cursor");
  flag(e.E2B_SANDBOX || e.E2B_SANDBOX_ID, "E2B sandbox", true);
  flag(Object.keys(e).some((k) => k.startsWith("DAYTONA_")), "Daytona", true);
  flag(e.CODESPACES, "GitHub Codespaces");
  flag(e.GITPOD_WORKSPACE_ID, "Gitpod");
  flag(e.REPL_ID, "Replit", true);
  flag(Object.keys(e).some((k) => k.startsWith("MODAL_")), "Modal", true);
  flag(e.VERCEL_SANDBOX || e.VERCEL_SANDBOX_ID, "Vercel Sandbox", true);
  flag(e.GITHUB_ACTIONS === "true", "GitHub Actions", true);
  flag(e.GITLAB_CI, "GitLab CI", true);
  flag(e.BUILDKITE, "Buildkite", true);
  flag(e.CIRCLECI, "CircleCI", true);
  flag(e.JENKINS_URL, "Jenkins", true);
  flag(e.CI === "true" || e.CI === "1", "CI", true);
  flag(e.K_SERVICE, "Cloud Run", true);
  flag(e.AWS_LAMBDA_FUNCTION_NAME, "AWS Lambda", true);
  flag(e.KUBERNETES_SERVICE_HOST, "Kubernetes");
  try {
    flag(fs.existsSync("/.dockerenv"), "container (/.dockerenv)");
  } catch {
  }
  try {
    flag(fs.existsSync("/run/.containerenv"), "container (podman)");
  } catch {
  }
  if (process.platform === "linux") {
    try {
      const cg = fs.readFileSync("/proc/1/cgroup", "utf8");
      flag(/bwrap|bubblewrap/i.test(cg), "bubblewrap");
      flag(/docker|containerd|kubepods/i.test(cg), "container (cgroup)");
    } catch {
    }
    try {
      flag(/microsoft/i.test(fs.readFileSync("/proc/version", "utf8")), "WSL");
    } catch {
    }
    try {
      const routes = fs.readFileSync("/proc/net/route", "utf8").split("\n").slice(1).filter(Boolean);
      const hasDefault = routes.some((l) => l.split(/\s+/)[1] === "00000000");
      flag(!hasDefault, "no default network route (sandboxed network namespace)");
    } catch {
    }
  }
  return { detected: hints.length > 0, ephemeral, hints: [...new Set(hints)] };
}
function detectRuntime() {
  const e = process.env;
  const argv = process.argv.join(" ");
  const bun = !!process.versions.bun || /(^|[\\/])srift(\.exe)?$/i.test(process.execPath);
  const launcher = e.SRIFT_RUNTIME || (bun ? "standalone binary" : null) || (/[\\/]_npx[\\/]/.test(argv) || e.npm_command === "exec" ? "npx" : null) || (/site-packages|srift_cli/i.test(argv) ? "pypi" : null);
  if (process.argv.includes("mcp")) return launcher ? `mcp via ${launcher}` : "mcp";
  if (/daemon\.(js|ts)/.test(argv)) return launcher ? `daemon via ${launcher}` : "daemon";
  return launcher || "cli";
}
function timed(fn) {
  const t0 = Date.now();
  return fn().then((value) => ({ value, ms: Date.now() - t0 }), (error) => ({ error, ms: Date.now() - t0 }));
}
function withTimeout(p, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${ms} ms`), { code: "ETIMEDOUT" })), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}
function cmpVersion(a, b) {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
async function checkLoopback() {
  return withTimeout(new Promise((resolve, reject) => {
    const srv = net2.createServer((s) => s.end());
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      const c = net2.connect(port, "127.0.0.1");
      c.once("connect", () => {
        c.destroy();
        srv.close(() => resolve("can bind and connect on 127.0.0.1"));
      });
      c.once("error", (e) => {
        srv.close();
        reject(Object.assign(e, { loopbackConnect: true }));
      });
    });
  }), 3e3, "loopback");
}
async function checkSpawn() {
  return withTimeout(new Promise((resolve, reject) => {
    let c;
    try {
      c = spawn(process.execPath, ["-e", "0"], { stdio: "ignore", windowsHide: true, detached: true });
    } catch (e) {
      reject(e);
      return;
    }
    c.once("error", reject);
    c.once("exit", (code) => code === 0 ? resolve("can start background processes") : reject(new Error(`child exited ${code}`)));
  }), 5e3, "process spawn");
}
async function checkDaemon(port) {
  return withTimeout(new Promise((resolve, reject) => {
    const req = http2.get(`http://127.0.0.1:${port}/health`, { timeout: 1500 }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          reject(new Error("something else answers on the daemon port"));
        }
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("something on the daemon port accepts connections but does not answer"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
  }), 2e3, "daemon health");
}
async function checkDns(host) {
  if (net2.isIP(host) || host === "localhost") return "no lookup needed (IP address)";
  const addrs = await withTimeout(dns.promises.lookup(host, { all: true }), 4e3, "DNS lookup");
  return addrs.map((a) => a.address).slice(0, 2).join(", ");
}
async function checkHttps(base) {
  const r = await requestJson(`${base}/compat.json`, { timeoutMs: 6e3, headers: { "User-Agent": "srift-doctor" } });
  if (r.status !== 200) throw Object.assign(new Error(`HTTP ${r.status}`), { code: "EHTTPSTATUS", status: r.status });
  if (!r.data || typeof r.data !== "object" || r.data.raw !== void 0) {
    throw Object.assign(new Error("Got HTTP 200 but not SRIFT's JSON \u2014 a captive portal or filtering proxy is answering instead"), { code: "EPORTAL" });
  }
  const dateHdr = r.headers?.date ? Date.parse(String(r.headers.date)) : NaN;
  return {
    summary: "HTTP 200 with a valid body",
    serverVersion: typeof r.data.daemon === "string" ? r.data.daemon : null,
    clockSkewMs: Number.isFinite(dateHdr) ? Date.now() - dateHdr : null
  };
}
function checkWs(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let ws;
    try {
      ws = new WebSocket(url, { agent: agentFor(url), handshakeTimeout: timeoutMs });
    } catch (e) {
      reject(e);
      return;
    }
    const t = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
      }
      reject(Object.assign(new Error(`no upgrade within ${timeoutMs} ms`), { code: "ETIMEDOUT" }));
    }, timeoutMs + 200);
    ws.once("open", () => {
      clearTimeout(t);
      try {
        ws.close();
      } catch {
      }
      resolve(`upgrade OK in ${Date.now() - t0} ms`);
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(t);
      try {
        ws.terminate();
      } catch {
      }
      reject(Object.assign(new Error(`upgrade refused (HTTP ${res.statusCode}) \u2014 a proxy may be stripping WebSocket upgrades`), { code: "EWSUPGRADE" }));
    });
    ws.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}
function checkUdp(timeoutMs) {
  return new Promise((resolve, reject) => {
    let sock;
    try {
      sock = dgram.createSocket("udp4");
    } catch (e) {
      reject(e);
      return;
    }
    const txid = crypto.randomBytes(12);
    const msg = Buffer.alloc(20);
    msg.writeUInt16BE(1, 0);
    msg.writeUInt16BE(0, 2);
    msg.writeUInt32BE(554869826, 4);
    txid.copy(msg, 8);
    const done = (err, v) => {
      clearTimeout(t);
      try {
        sock.close();
      } catch {
      }
      err ? reject(err) : resolve(v);
    };
    const t = setTimeout(() => done(Object.assign(new Error(`no STUN response within ${timeoutMs} ms`), { code: "ETIMEDOUT" })), timeoutMs);
    sock.on("message", (m) => {
      if (m.length >= 20 && m.readUInt16BE(0) === 257 && m.subarray(8, 20).equals(txid)) done(void 0, "STUN binding response received");
    });
    sock.on("error", (e) => done(e));
    dns.lookup("stun.cloudflare.com", { family: 4 }, (err, addr) => {
      if (err) return done(err);
      sock.send(msg, 3478, addr, (e) => {
        if (e) done(e);
      });
    });
  });
}
async function checkProxy(proxyUrl) {
  const u = typeof proxyUrl === "string" ? new URL(proxyUrl) : proxyUrl;
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : u.protocol.startsWith("socks") ? 1080 : 80);
  await withTimeout(new Promise((resolve, reject) => {
    const s = net2.connect(port, u.hostname);
    s.once("connect", () => {
      s.destroy();
      resolve();
    });
    s.once("error", reject);
  }), 3e3, "proxy connect");
  return `reachable at ${u.hostname}:${port}`;
}
async function checkStorage() {
  const home = path.join(os.homedir(), ".srift");
  fs.mkdirSync(home, { recursive: true, mode: 448 });
  const probe = path.join(home, `.doctor-${process.pid}`);
  fs.writeFileSync(probe, "ok");
  fs.rmSync(probe, { force: true });
  let free = "";
  try {
    const st = fs.statfsSync?.(os.tmpdir());
    if (st) {
      const bytes = Number(st.bavail) * Number(st.bsize);
      free = `, ${(bytes / 1024 ** 3).toFixed(1)} GB free in temp`;
      if (bytes < 512 * 1024 * 1024) throw Object.assign(new Error(`only ${(bytes / 1024 ** 2).toFixed(0)} MB free in ${os.tmpdir()}`), { code: "ELOWDISK" });
    }
  } catch (e) {
    if (e?.code === "ELOWDISK") throw e;
  }
  return `~/.srift writable${free}`;
}
function checkCurl(base) {
  return new Promise((resolve, reject) => {
    try {
      const r = spawnSync("curl", ["-sS", "-o", os.devNull, "-w", "%{http_code}", "--max-time", "5", `${base}/compat.json`], { encoding: "utf8", timeout: 7e3, windowsHide: true });
      if (r.error && r.error.code === "ENOENT") {
        reject(Object.assign(new Error("curl is not installed"), { code: "ENOCURL" }));
        return;
      }
      if (r.status === 0 && /^2\d\d$/.test(r.stdout.trim())) resolve(`works (HTTP ${r.stdout.trim()})`);
      else reject(Object.assign(new Error(`curl failed (exit ${r.status}${r.stderr ? `: ${r.stderr.trim().split("\n").pop()}` : ""})`), { code: "ECURL" }));
    } catch (e) {
      reject(e);
    }
  });
}
function rungFrom(id, name, group, r, url) {
  if (!r.error) return { id, name, group, status: "WORKS", detail: r.value || "OK", ms: r.ms };
  const d = explainNetError(r.error, url);
  let detail = d.message;
  let fix = d.fix;
  if (r.error?.code === "EPORTAL") {
    detail = r.error.message;
    fix = "Sign in to the network's captive portal, or check the proxy configuration.";
  }
  if (r.error?.code === "EWSUPGRADE") {
    detail = r.error.message;
    fix = "Allow WebSocket upgrades to the SRIFT server on port 443 (proxy/firewall setting); relay links need them.";
  }
  return { id, name, group, status: "BLOCKED", detail, fix, ms: r.ms };
}
async function runDiagnostics(opts = {}) {
  const base = (opts.base || apiBase()).replace(/\/+$/, "");
  if (!opts.fresh && !opts.selfTest) {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (c.schema === CACHE_SCHEMA && c.base === base && Date.now() - Date.parse(c.checkedAt) < CACHE_TTL_MS) return { ...c, cached: true };
    } catch {
    }
  }
  const port = opts.daemonPort || parseInt(process.env.SRIFT_DAEMON_PORT || "3822", 10);
  const wsBase = base.replace(/^http/, "ws");
  const proxy = getProxyForUrl(base);
  const sandbox = detectSandbox();
  const runtime = detectRuntime();
  const host = (() => {
    try {
      return new URL(base).hostname;
    } catch {
      return base;
    }
  })();
  const hostPort = (() => {
    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  })();
  const [dnsR, httpsR, ws, udp, peers, loop, spawnR, daemon, proxyR, storage, curl] = await Promise.all([
    timed(() => checkDns(host)),
    timed(() => checkHttps(base)),
    // 8 s: a slow (not blocked) handshake — via a proxy or a cold server — must
    // not be reported as BLOCKED. Probes run in parallel, so doctor stays fast.
    timed(() => checkWs(`${wsBase}/ws`, 8e3)),
    timed(() => checkUdp(1500)),
    timed(() => checkWs(`${wsBase}/v1/peers`, 6e3).catch(() => checkWs(`${wsBase}/announce`, 4e3))),
    timed(() => checkLoopback()),
    timed(() => checkSpawn()),
    timed(() => checkDaemon(port)),
    proxy ? timed(() => checkProxy(proxy)) : Promise.resolve(null),
    timed(() => checkStorage()),
    timed(() => checkCurl(base))
  ]);
  const rungs = [];
  const dnsRung = rungFrom("dns", `DNS for ${host}`, "connectivity", dnsR);
  if (dnsRung.status === "BLOCKED" && proxy) {
    dnsRung.status = "WARN";
    dnsRung.detail += " \u2014 fine: the proxy resolves names for us";
    delete dnsRung.fix;
  }
  rungs.push(dnsRung);
  if (proxyR) {
    const pr = rungFrom("proxy", `Proxy ${describeProxy(proxy)}`, "connectivity", proxyR);
    if (pr.status === "BLOCKED") pr.fix = "Check HTTPS_PROXY / HTTP_PROXY: nothing is listening at that address. Unset it if you are not behind a proxy.";
    rungs.push(pr);
  }
  const httpsRung = rungFrom("https", `HTTPS to ${hostPort}`, "connectivity", { ...httpsR, value: httpsR.value?.summary });
  if (httpsRung.status === "BLOCKED" && /certificate|self[- ]signed|issuer/i.test(`${httpsR.error?.code} ${httpsR.error?.message}`)) {
    httpsRung.fix = "A TLS-inspecting proxy is re-signing traffic. Point NODE_EXTRA_CA_CERTS at its root CA (PEM). Never disable TLS verification.";
  }
  rungs.push(httpsRung);
  const skew = httpsR.value?.clockSkewMs ?? null;
  if (skew !== null && Math.abs(skew) > 5 * 60 * 1e3) {
    rungs.push({
      id: "clock",
      name: "System clock",
      group: "connectivity",
      status: "WARN",
      detail: `off by ${Math.round(skew / 6e4)} min versus the server`,
      fix: "Sync the system clock (NTP). Large skew breaks TLS and makes --ttl links expire early/late."
    });
  }
  const wsRung = rungFrom("websocket", `WebSocket relay to ${hostPort}`, "connectivity", ws, `${wsBase}/ws`);
  if (wsRung.status === "WORKS" && ws.ms > 3e3) {
    wsRung.status = "WARN";
    wsRung.detail += " \u2014 slow handshake (proxy or cold server); links still work";
  }
  rungs.push(wsRung);
  const udpRung = rungFrom("udp", "UDP (direct P2P / STUN)", "connectivity", udp);
  if (udpRung.status === "BLOCKED") {
    udpRung.status = "WARN";
    udpRung.fix = "Not required: links and relays work over HTTPS/WebSocket on port 443 (large files are just slower).";
  }
  rungs.push(udpRung);
  const peersRung = rungFrom("peers", "Peer discovery (swarm bonus)", "connectivity", peers, `${wsBase}/v1/peers`);
  if (peersRung.status === "BLOCKED") {
    peersRung.status = "WARN";
    peersRung.fix = "Not required: SRIFT falls back to the WebSocket relay automatically.";
  }
  rungs.push(peersRung);
  const loopRung = rungFrom("loopback", "Local daemon port (loopback)", "runtime", { ...loop, value: loop.value });
  if (loopRung.status === "BLOCKED") {
    loopRung.status = "WARN";
    loopRung.detail = loop.error?.loopbackConnect ? `Loopback connections are blocked (${loop.error?.code || loop.error?.message}).` : `Cannot listen on 127.0.0.1 (${loop.error?.code || loop.error?.message}) \u2014 local servers are forbidden here.`;
    loopRung.fix = "Handled automatically: quick-share and mcp serve from their own process (embedded daemon, no port).";
  }
  rungs.push(loopRung);
  const spawnRung = rungFrom("spawn", "Background processes", "runtime", spawnR);
  if (spawnRung.status === "BLOCKED") {
    spawnRung.status = "WARN";
    spawnRung.fix = "Handled automatically: the daemon runs inside the quick-share / mcp process instead.";
  }
  rungs.push(spawnRung);
  const daemonVersion = daemon.value?.version || null;
  if (daemon.error) {
    const other = /something/.test(String(daemon.error?.message));
    rungs.push({
      id: "daemon",
      name: "Daemon",
      group: "runtime",
      status: other ? "WARN" : "SKIPPED",
      detail: other ? `port ${port}: ${daemon.error.message}` : "not running (starts automatically when needed)",
      ...other ? { fix: `Another program holds port ${port}. SRIFT falls back to embedded mode; to use a background daemon set SRIFT_DAEMON_PORT to a free port.` } : {},
      ms: daemon.ms
    });
  } else {
    const stale = opts.clientVersion && daemonVersion && cmpVersion(daemonVersion, opts.clientVersion) !== 0;
    rungs.push({
      id: "daemon",
      name: "Daemon",
      group: "runtime",
      status: stale ? "WARN" : "WORKS",
      detail: `v${daemonVersion || "?"} on port ${port}${stale ? ` \u2014 differs from this CLI (v${opts.clientVersion})` : ""}`,
      ...stale ? { fix: "Restart it to load the installed version: srift daemon restart" } : {},
      ms: daemon.ms
    });
  }
  const storageRung = rungFrom("storage", "Local storage", "runtime", storage);
  if (storageRung.status === "BLOCKED" && storage.error?.code === "ELOWDISK") {
    storageRung.status = "WARN";
    storageRung.fix = "Free disk space: encrypted links and folder bundles are staged in the temp directory.";
  } else if (storageRung.status === "BLOCKED") {
    storageRung.fix = "Make ~/.srift writable (or set HOME to a writable directory).";
  }
  rungs.push(storageRung);
  const serverVersion = httpsR.value?.serverVersion ?? null;
  if (opts.clientVersion && serverVersion && cmpVersion(serverVersion, opts.clientVersion) > 0) {
    rungs.push({
      id: "version",
      name: "CLI version",
      group: "runtime",
      status: "WARN",
      detail: `v${opts.clientVersion}; the server's current release is v${serverVersion}`,
      fix: "Update: srift self-update (or npx -y srift-transfer@latest \u2026)"
    });
  } else if (opts.clientVersion) {
    rungs.push({ id: "version", name: "CLI version", group: "runtime", status: "WORKS", detail: `v${opts.clientVersion}${serverVersion ? ` (server v${serverVersion})` : ""}` });
  }
  const curlRung = rungFrom("curl", "curl (for recipients)", "environment", curl);
  if (curlRung.status === "BLOCKED") {
    curlRung.status = curl.error?.code === "ENOCURL" ? "SKIPPED" : "WARN";
    curlRung.detail = curl.error?.message || curlRung.detail;
    curlRung.fix = "Not required: tell recipients to use `srift get <url>` or `npx -y srift-transfer get <url>` (proxy-aware, resumable, decrypts).";
  }
  rungs.push(curlRung);
  rungs.push({
    id: "context",
    name: "Running as",
    group: "environment",
    status: "WORKS",
    detail: `${runtime}${sandbox.detected ? ` \xB7 ${sandbox.hints.join(", ")}` : ""}`
  });
  const httpsOk = !httpsR.error;
  const relayOk = httpsOk && !ws.error;
  const localDaemonOk = !loop.error && !spawnR.error && !(daemon.error && /something/.test(String(daemon.error?.message)));
  const p2pOk = !udp.error || !peers.error;
  const verdict = !relayOk ? "blocked" : rungs.some((r) => r.status === "WARN" && !["udp", "peers", "curl", "dns"].includes(r.id)) || !p2pOk || !localDaemonOk ? "degraded" : "ok";
  const serveFrom = !relayOk ? "unavailable" : localDaemonOk ? "background-daemon" : "embedded";
  const advice = [];
  if (!relayOk) advice.push("Links cannot be served until HTTPS and the WebSocket relay work \u2014 fix the first BLOCKED line.");
  if (serveFrom === "embedded") {
    advice.push(runtime === "mcp" ? "MCP serves links from its own process: they stay live while this MCP session runs." : "quick-share serves from its own process here: run it in the background (or with --wait) \u2014 it exits after the download.");
  }
  if (serveFrom === "background-daemon") advice.push("Links are served by the background daemon, which keeps running after quick-share returns.");
  if (sandbox.ephemeral && relayOk) advice.push("Ephemeral environment: use `--wait` so the job stays up until the recipient has downloaded.");
  if (proxy) advice.push(`All traffic goes through the proxy (${describeProxy(proxy)}); WebSocket relay uses HTTP CONNECT.`);
  if (!p2pOk && relayOk) advice.push("Direct P2P is unavailable: transfers use the relay on 443 (works; large files are slower).");
  if (curl.error && curl.error.code !== "ENOCURL") advice.push("curl is broken here: recipients should use `srift get <url>` instead.");
  advice.push("Use --encrypt for anything sensitive (the key stays in the #k= part of the link).");
  const transport = !relayOk ? "none" : p2pOk ? "relay (443) + direct P2P when both sides allow" : "relay over HTTPS/WSS 443";
  const shareCommand = serveFrom === "unavailable" ? "(fix connectivity first)" : `srift quick-share <file> --encrypt${serveFrom === "embedded" || sandbox.ephemeral ? " --wait" : ""}`;
  const summary = verdict === "blocked" ? "SRIFT links cannot be served from here. Fix the first BLOCKED line below." : serveFrom === "embedded" ? "Links work. No background daemon here, so quick-share and mcp serve from their own process (no port)." : verdict === "ok" ? "Everything works." : "Links work, with caveats listed below.";
  let selfTest;
  if (opts.selfTest) {
    if (!relayOk) selfTest = { ok: false, ms: 0, bytes: 0, error: "skipped: relay unreachable" };
    else {
      const t0 = Date.now();
      try {
        selfTest = await opts.selfTest();
      } catch (e) {
        selfTest = { ok: false, ms: Date.now() - t0, bytes: 0, error: e?.message || String(e) };
      }
    }
    rungs.push(selfTest.ok ? {
      id: "selftest",
      name: "End-to-end self-test",
      group: "connectivity",
      status: "WORKS",
      detail: `encrypted link created + downloaded back, ${(selfTest.bytes / 1024 / 1024).toFixed(1)} MB in ${selfTest.ms} ms${selfTest.mbps ? ` (${selfTest.mbps.toFixed(1)} MB/s)` : ""}${selfTest.via ? ` via ${selfTest.via}` : ""}`,
      ms: selfTest.ms
    } : { id: "selftest", name: "End-to-end self-test", group: "connectivity", status: "BLOCKED", detail: selfTest.error || "failed", fix: "Run `srift doctor --deep --json` and share the output; check `srift logs`." });
  }
  const report = {
    ok: verdict !== "blocked" && (!selfTest || selfTest.ok),
    verdict: selfTest && !selfTest.ok && verdict === "ok" ? "degraded" : verdict,
    recommendedMode: relayOk ? "relay" : "none",
    summary,
    rungs,
    plan: { serveFrom, transport, shareCommand, downloadCommand: "srift get <url>   (or: npx -y srift-transfer get <url>)", advice },
    context: { runtime, cliVersion: opts.clientVersion || null, serverVersion, daemonVersion },
    ...selfTest ? { selfTest } : {},
    env: {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      proxy: describeProxy(proxy),
      noProxy: process.env.NO_PROXY || process.env.no_proxy || null,
      extraCaCerts: process.env.NODE_EXTRA_CA_CERTS || null,
      sandbox
    },
    base,
    checkedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (!opts.selfTest) {
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true, mode: 448 });
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...report, schema: CACHE_SCHEMA }), { mode: 384 });
    } catch {
    }
  }
  return report;
}
var CACHE_FILE, CACHE_TTL_MS, CACHE_SCHEMA;
var init_probe = __esm({
  "cli/probe.ts"() {
    "use strict";
    init_net();
    CACHE_FILE = path.join(os.homedir(), ".srift", "probe.json");
    CACHE_TTL_MS = 10 * 60 * 1e3;
    CACHE_SCHEMA = 2;
  }
});

// cli/e2ee.ts
import crypto2 from "crypto";
import fs2 from "fs";
function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function newLinkKey() {
  return crypto2.randomBytes(32);
}
function parseFragmentKey(fragment) {
  if (!fragment) return null;
  const f = fragment.replace(/^#/, "");
  const params = new URLSearchParams(f);
  const k = params.get("k") || (/^[A-Za-z0-9_-]{43}$/.test(f) ? f : null);
  if (!k) return null;
  const key = fromB64url(k);
  return key.length === 32 ? key : null;
}
function buildHeader(opts = {}) {
  const h = Buffer.alloc(E2EE_HEADER_LEN);
  h.write(E2EE_MAGIC, 0, "ascii");
  h[4] = 1;
  h[5] = opts.password ? 1 : 0;
  h.writeUInt32BE(opts.chunkSize || E2EE_DEFAULT_CHUNK, 8);
  crypto2.randomBytes(7).copy(h, 12);
  if (opts.password) crypto2.randomBytes(16).copy(h, 20);
  return h;
}
function parseHeader(h) {
  if (h.length < E2EE_HEADER_LEN || h.toString("ascii", 0, 4) !== E2EE_MAGIC) {
    throw new Error("Not a SRIFT encrypted stream (bad magic)");
  }
  if (h[4] !== 1) throw new Error(`Unsupported SRIFT encryption version ${h[4]} \u2014 run \`srift self-update\``);
  const chunkSize = h.readUInt32BE(8);
  if (chunkSize < 1024 || chunkSize > 64 * 1024 * 1024) throw new Error("Corrupt header (chunk size)");
  return {
    version: 1,
    password: (h[5] & 1) === 1,
    chunkSize,
    noncePrefix: Buffer.from(h.subarray(12, 19)),
    salt: Buffer.from(h.subarray(20, 36)),
    raw: Buffer.from(h.subarray(0, E2EE_HEADER_LEN))
  };
}
function deriveContentKey(fragKey, header2, password) {
  if (!header2.password) return fragKey;
  if (!password) throw Object.assign(new Error("This link is password-protected \u2014 pass --password"), { code: "EPASSWORD" });
  const pw = crypto2.pbkdf2Sync(Buffer.from(password.normalize("NFC"), "utf8"), header2.salt, E2EE_KDF_ITERATIONS, 32, "sha256");
  return Buffer.from(crypto2.hkdfSync("sha256", Buffer.concat([fragKey, pw]), header2.salt, Buffer.from(HKDF_INFO), 32));
}
function iv(prefix, counter, last) {
  const b = Buffer.alloc(12);
  prefix.copy(b, 0);
  b.writeUInt32BE(counter >>> 0, 7);
  b[11] = last ? 1 : 0;
  return b;
}
function seal(key, header2, counter, last, pt) {
  const c = crypto2.createCipheriv("aes-256-gcm", key, iv(header2.noncePrefix, counter, last));
  c.setAAD(header2.raw);
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}
function open(key, header2, counter, last, ct) {
  if (ct.length < E2EE_TAG_LEN) throw new Error("Truncated block");
  const d = crypto2.createDecipheriv("aes-256-gcm", key, iv(header2.noncePrefix, counter, last));
  d.setAAD(header2.raw);
  d.setAuthTag(ct.subarray(ct.length - E2EE_TAG_LEN));
  try {
    return Buffer.concat([d.update(ct.subarray(0, ct.length - E2EE_TAG_LEN)), d.final()]);
  } catch {
    throw Object.assign(new Error("Decryption failed \u2014 wrong key/password, or the file was modified in transit"), { code: "EDECRYPT" });
  }
}
function chunkCount(size, chunkSize) {
  return Math.max(1, Math.ceil(size / chunkSize));
}
function encryptedSize(size, meta, chunkSize = E2EE_DEFAULT_CHUNK) {
  const metaLen = Buffer.byteLength(JSON.stringify(meta)) + E2EE_TAG_LEN;
  return E2EE_HEADER_LEN + 4 + metaLen + size + chunkCount(size, chunkSize) * E2EE_TAG_LEN;
}
async function* encryptFile(filePath, fragKey, meta, opts = {}) {
  const header2 = parseHeader(buildHeader({ chunkSize: opts.chunkSize, password: !!opts.password }));
  const key = deriveContentKey(fragKey, header2, opts.password);
  yield header2.raw;
  const metaCt = seal(key, header2, 0, false, Buffer.from(JSON.stringify(meta)));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(metaCt.length, 0);
  yield Buffer.concat([len, metaCt]);
  const n = chunkCount(meta.size, header2.chunkSize);
  if (n >= 4294967295) throw new Error("File too large for this chunk size");
  const fd = fs2.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(header2.chunkSize);
    for (let i = 1; i <= n; i++) {
      const want = i < n ? header2.chunkSize : meta.size - (n - 1) * header2.chunkSize;
      let got = 0;
      while (got < want) {
        const r = fs2.readSync(fd, buf, got, want - got, (i - 1) * header2.chunkSize + got);
        if (r === 0) throw new Error("File shrank while encrypting");
        got += r;
      }
      yield seal(key, header2, i, i === n, buf.subarray(0, want));
    }
  } finally {
    fs2.closeSync(fd);
  }
}
var E2EE_MAGIC, E2EE_HEADER_LEN, E2EE_TAG_LEN, E2EE_DEFAULT_CHUNK, E2EE_KDF_ITERATIONS, HKDF_INFO, Decryptor;
var init_e2ee = __esm({
  "cli/e2ee.ts"() {
    "use strict";
    E2EE_MAGIC = "SRE1";
    E2EE_HEADER_LEN = 36;
    E2EE_TAG_LEN = 16;
    E2EE_DEFAULT_CHUNK = 1024 * 1024;
    E2EE_KDF_ITERATIONS = 1e5;
    HKDF_INFO = "srift-e2ee-v1";
    Decryptor = class {
      constructor(fragKey, password, onData, onMeta) {
        // Byte queue: each received byte is copied once, when a block is complete.
        this.q = [];
        this.qLen = 0;
        this.header = null;
        this.key = null;
        this.metaLen = -1;
        this.meta = null;
        this.counter = 1;
        this.n = 0;
        this.done = false;
        this.bytesOut = 0;
        this.fragKey = fragKey;
        this.password = password;
        this.onData = onData;
        this.onMeta = onMeta;
      }
      push(chunk) {
        if (chunk.length) {
          this.q.push(chunk);
          this.qLen += chunk.length;
        }
        this.drain();
      }
      take(n) {
        const out = Buffer.allocUnsafe(n);
        let off = 0;
        while (off < n) {
          const h = this.q[0];
          const need = n - off;
          if (h.length <= need) {
            h.copy(out, off);
            off += h.length;
            this.q.shift();
          } else {
            h.copy(out, off, 0, need);
            this.q[0] = h.subarray(need);
            off += need;
          }
        }
        this.qLen -= n;
        return out;
      }
      drain() {
        if (!this.header) {
          if (this.qLen < E2EE_HEADER_LEN) return;
          this.header = parseHeader(this.take(E2EE_HEADER_LEN));
          this.key = deriveContentKey(this.fragKey, this.header, this.password);
        }
        if (!this.meta) {
          if (this.metaLen < 0) {
            if (this.qLen < 4) return;
            this.metaLen = this.take(4).readUInt32BE(0);
            if (this.metaLen > 64 * 1024) throw new Error("Corrupt stream (metadata too large)");
          }
          if (this.qLen < this.metaLen) return;
          const m = JSON.parse(open(this.key, this.header, 0, false, this.take(this.metaLen)).toString("utf8"));
          if (typeof m?.name !== "string" || !Number.isSafeInteger(m?.size) || m.size < 0) throw new Error("Corrupt metadata");
          this.meta = { name: String(m.name), size: m.size, mime: String(m.mime || "application/octet-stream") };
          this.n = chunkCount(this.meta.size, this.header.chunkSize);
          this.onMeta?.(this.meta, this.header);
        }
        const h = this.header;
        while (!this.done) {
          const last = this.counter === this.n;
          const ptLen = last ? this.meta.size - (this.n - 1) * h.chunkSize : h.chunkSize;
          const need = ptLen + E2EE_TAG_LEN;
          if (this.qLen < need) return;
          const pt = open(this.key, h, this.counter, last, this.take(need));
          this.bytesOut += pt.length;
          if (pt.length) this.onData(pt);
          if (last) this.done = true;
          else this.counter++;
        }
        if (this.done && this.qLen) throw new Error("Unexpected data after final block");
      }
      end() {
        if (!this.done) throw Object.assign(new Error("Encrypted stream ended early \u2014 the download is truncated"), { code: "ETRUNCATED" });
      }
    };
  }
});

// cli/get.ts
import crypto3 from "crypto";
import fs3 from "fs";
import path2 from "path";
function resolveLink(input) {
  let s = input.trim();
  if (!s) throw new GetError("Missing link or token", "EUSAGE");
  if (/^[A-Za-z0-9-]{8,80}(#.*)?$/.test(s) && !s.includes(".")) s = `${apiBase()}/d/${s}`;
  else if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new GetError(`Not a valid link: ${input}`, "EUSAGE");
  }
  if (!/^\/d\/[^/]+\/?$/.test(u.pathname)) {
    throw new GetError(`Not a SRIFT download link (expected \u2026/d/<token>): ${input}`, "EUSAGE");
  }
  const frag = u.hash;
  u.hash = "";
  return { url: u.toString(), key: parseFragmentKey(frag), hasFragment: frag.length > 1 };
}
function filenameFromDisposition(cd) {
  if (!cd) return null;
  let name = null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (star) {
    try {
      name = decodeURIComponent(star[2].trim().replace(/^"|"$/g, ""));
    } catch {
      name = null;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"|filename\s*=\s*([^;]+)/i.exec(cd);
    if (plain) name = (plain[1] ?? plain[2] ?? "").trim();
  }
  return name ? safeBasename(name) : null;
}
function safeBasename(name) {
  const b = name.replace(/\\/g, "/").split("/").pop() || "";
  let cleaned = b.replace(BIDI_CONTROLS, "").replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/^[.\s]+/, "").replace(/[.\s]+$/, "").slice(0, 200);
  if (!cleaned) return null;
  if (WIN_RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
}
function uniquePath(p) {
  if (!fs3.existsSync(p)) return p;
  const ext = path2.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 1e3; i++) {
    const c = `${stem} (${i})${ext}`;
    if (!fs3.existsSync(c)) return c;
  }
  throw new GetError(`Too many files named ${path2.basename(p)}`);
}
function fmtBytes(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
}
function withQuery(url, q) {
  return `${url}${url.includes("?") ? "&" : "?"}${q}`;
}
function explainStatus(status, body) {
  let msg = body.replace(/^SRIFT:\s*/, "").trim();
  if (/^\s*<(!doctype|html)/i.test(msg)) msg = status >= 500 ? "The SRIFT server or a proxy in front of it is temporarily unavailable \u2014 retry shortly" : "";
  if (status === 424 || status === 502 && /sender error: (the shared file|cannot read the shared file)/i.test(msg)) return new GetError(msg || "The sender can no longer serve this file.", "ESENDERFILE", status);
  if (status === 404) return new GetError(msg || "Link not found \u2014 it expired, was revoked, or the sender went offline.", "ENOTFOUND_LINK", 404);
  if (status === 410) return new GetError(msg || "Link expired or reached its download limit.", "EGONE", 410);
  if (status === 503) return new GetError(msg || "Sender is offline \u2014 their daemon must be running for relay links.", "EOFFLINE", 503);
  if (status === 409) return new GetError(msg || "The sender is still uploading \u2014 retry shortly.", "ENOTREADY", 409);
  return new GetError(`${msg || "Download failed"} (HTTP ${status})`, "EHTTP", status);
}
async function readSmallBody(res, max = 4096) {
  const parts = [];
  let n = 0;
  for await (const c of res) {
    parts.push(c);
    n += c.length;
    if (n >= max) {
      res.destroy?.();
      break;
    }
  }
  return Buffer.concat(parts, n).subarray(0, max);
}
function assertNotSymlink(p) {
  let st = null;
  try {
    st = fs3.lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) throw new GetError(`Refusing to write through a symlink: ${p}`, "ESYMLINK");
}
async function attempt(url, sink, resumeFrom, ua, onData, opts = {}) {
  const headers = { "User-Agent": ua, Accept: "application/octet-stream", "Accept-Encoding": "identity" };
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;
  if (resumeFrom > 0 && opts.resumeToken) headers["X-SRIFT-Resume"] = opts.resumeToken;
  const { res } = await openRequest(withQuery(url, "raw=1"), { headers, timeoutMs: 3e4 });
  const status = res.statusCode || 0;
  if (status === 416 && resumeFrom > 0) {
    const cr = /bytes \*\/(\d+)/.exec(String(res.headers["content-range"] || ""));
    res.resume();
    if (cr && Number(cr[1]) === resumeFrom) return "complete";
    throw new GetError("Server refused to resume this download", "ERESUME");
  }
  if (resumeFrom > 0 && status === 200) {
    res.resume();
    throw new GetError("Server ignored the resume request", "ERESUME");
  }
  if (!(status === 200 || status === 206 && resumeFrom > 0)) {
    throw explainStatus(status, (await readSmallBody(res)).toString("utf8"));
  }
  opts.onHeaders?.(res.headers);
  await new Promise((resolve, reject) => {
    let last = Date.now();
    let settled = false;
    const idle = setInterval(() => {
      if (Date.now() - last > 6e4) res.destroy(new GetError("Stalled \u2014 no data for 60 s", "ESTALL"));
    }, 5e3);
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(idle);
      if (err) reject(err);
      else resolve();
    };
    sink.on?.("error", (e) => {
      res.destroy();
      finish(e);
    });
    res.on("data", (c) => {
      last = Date.now();
      onData(c.length);
      let ok;
      try {
        ok = sink.write(c);
      } catch (e) {
        res.destroy();
        finish(e);
        return;
      }
      if (!ok) {
        res.pause();
        sink.once("drain", () => res.resume());
      }
    });
    res.on("end", () => finish());
    res.on("error", (e) => finish(e));
    res.on("aborted", () => finish(new GetError("Connection closed early", "ECONNRESET")));
  });
  return "done";
}
function fileSink(p, append, mode) {
  assertNotSymlink(p);
  if (!append) fs3.rmSync(p, { force: true });
  return fs3.createWriteStream(p, { flags: append ? "a" : "wx", mode });
}
async function closeSink(ws) {
  await new Promise((resolve) => {
    if (ws.closed || ws.destroyed) resolve();
    else ws.end(() => resolve());
  });
}
async function getLink(input, opts = {}) {
  const { url, key, hasFragment } = resolveLink(input);
  if (hasFragment && !key) throw new GetError("The #fragment of this link is not a valid SRIFT key \u2014 copy the whole link.", "EKEY");
  const ua = opts.userAgent || "srift-cli";
  const toStdout = opts.out === "-";
  const log = (m) => {
    if (!opts.quiet && !opts.json) process.stderr.write(m);
  };
  let destDir = process.cwd();
  let explicitFile = null;
  if (opts.out && !toStdout) {
    const o = path2.resolve(opts.out);
    if (fs3.existsSync(o) && fs3.statSync(o).isDirectory()) destDir = o;
    else if (/[\\/]$/.test(opts.out)) {
      fs3.mkdirSync(o, { recursive: true });
      destDir = o;
    } else {
      explicitFile = o;
      fs3.mkdirSync(path2.dirname(o), { recursive: true });
    }
  }
  const linkTag = crypto3.createHash("sha256").update(url).digest("hex").slice(0, 12);
  const tmpDir = explicitFile ? path2.dirname(explicitFile) : destDir;
  const tokenFile = path2.join(tmpDir, `.srift-${linkTag}.resume`);
  const readToken = () => {
    try {
      return fs3.readFileSync(tokenFile, "utf8").trim() || null;
    } catch {
      return null;
    }
  };
  const saveToken = (t) => {
    try {
      assertNotSymlink(tokenFile);
      fs3.writeFileSync(tokenFile, t, { mode: 384 });
    } catch {
    }
  };
  const dropToken = () => {
    try {
      fs3.rmSync(tokenFile, { force: true });
    } catch {
    }
  };
  let resumeToken = readToken();
  const captureToken = (h) => {
    const t = h["x-srift-resume"];
    if (t) {
      resumeToken = String(t);
      saveToken(resumeToken);
    }
  };
  const probeHeaders = () => ({ "User-Agent": ua, ...resumeToken ? { "X-SRIFT-Resume": resumeToken } : {} });
  let head = {};
  try {
    const { res } = await openRequest(url, { method: "HEAD", headers: probeHeaders(), timeoutMs: 2e4 });
    res.resume();
    if ((res.statusCode || 0) >= 400) throw explainStatus(res.statusCode || 0, "");
    head = res.headers;
  } catch (e) {
    if (e instanceof GetError) throw e;
    throw new GetError(formatNetError(e, url), e?.code || "ENET");
  }
  const encrypted = String(head["x-srift-encrypted"] || "").toUpperCase() === "SRE1";
  if (encrypted && !key) {
    throw new GetError("This link is end-to-end encrypted but has no key. Use the full link including the part after #.", "EKEY");
  }
  if (encrypted) {
    let peek = null;
    try {
      const { res } = await openRequest(withQuery(url, "peek=1"), { headers: { ...probeHeaders(), Accept: "application/octet-stream" }, timeoutMs: 2e4 });
      const body = await readSmallBody(res, 70 * 1024);
      const st = res.statusCode || 0;
      if (st === 200 || st === 206) peek = body;
      else if (st >= 400 && st !== 400) throw explainStatus(st, body.toString("utf8"));
    } catch (e) {
      if (e instanceof GetError) throw e;
      throw new GetError(formatNetError(e, url), e?.code || "ENET");
    }
    if (peek && peek.length) {
      try {
        new Decryptor(key, opts.password, () => {
        }).push(peek);
      } catch (e) {
        if (e?.code === "EPASSWORD") throw new GetError("This link is password-protected \u2014 re-run with --password <password>.", "EPASSWORD");
        if (e?.code === "EDECRYPT") throw new GetError("Wrong password or incomplete link \u2014 nothing was downloaded, so a limited link is still usable.", "EDECRYPT");
        throw new GetError(`Not a valid SRIFT encrypted file: ${e?.message || e}`, "EFORMAT");
      }
    }
  }
  const serverName = filenameFromDisposition(head["content-disposition"]) || "download.bin";
  const mode = head["x-srift-mode"] ? String(head["x-srift-mode"]) : null;
  const total = parseInt(String(head["x-srift-size"] || head["content-length"] || ""), 10) || 0;
  let received = 0;
  let lastPrint = 0;
  const progress = (n) => {
    received += n;
    if (!opts.quiet && !opts.json && process.stderr.isTTY && Date.now() - lastPrint > 250) {
      const pct = total ? ` ${(received / total * 100).toFixed(1)}%` : "";
      process.stderr.write(`\r[srift] ${fmtBytes(received)}${total ? ` / ${fmtBytes(total)}` : ""}${pct}   `);
      lastPrint = Date.now();
    }
  };
  const downloadTo = async (part, fileMode) => {
    const size = () => {
      try {
        return fs3.statSync(part).size;
      } catch {
        return 0;
      }
    };
    if (total > 0 && size() === total) return;
    let lastErr = null;
    for (let i = 1; i <= 6; i++) {
      const from = size();
      received = from;
      const ws = fileSink(part, from > 0, fileMode);
      try {
        const r = await attempt(url, ws, from, ua, progress, { resumeToken, onHeaders: from === 0 ? captureToken : void 0 });
        await closeSink(ws);
        if (r === "complete" || total === 0 || size() >= total) return;
        throw new GetError("Connection closed early", "ECONNRESET");
      } catch (e) {
        await closeSink(ws);
        lastErr = e;
        if (e?.code === "ERESUME") {
          fs3.rmSync(part, { force: true });
          dropToken();
          resumeToken = null;
          continue;
        }
        const dropEmpty = () => {
          try {
            if (size() === 0) fs3.rmSync(part, { force: true });
          } catch {
          }
        };
        if (e instanceof GetError && (e.code === "ESENDERFILE" || !["ESTALL", "ECONNRESET"].includes(e.code) && !(e.status && e.status >= 500))) {
          dropEmpty();
          throw e;
        }
        if (!(e instanceof GetError) && !["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "EAI_AGAIN"].includes(e?.code)) {
          try {
            if (size() === 0) fs3.rmSync(part, { force: true });
          } catch {
          }
          throw new GetError(formatNetError(e, url), e?.code || "ENET");
        }
        const wait = Math.min(1e3 * 2 ** (i - 1), 15e3);
        log(`
[srift] ${e.message || e} \u2014 retrying in ${Math.round(wait / 1e3)}s\u2026
`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    try {
      if (size() === 0) fs3.rmSync(part, { force: true });
    } catch {
    }
    throw lastErr instanceof GetError ? lastErr : new GetError(formatNetError(lastErr, url), lastErr?.code || "ENET");
  };
  let stdoutBlocked = false;
  const toOut = (b) => {
    if (!process.stdout.write(b)) stdoutBlocked = true;
  };
  const stdoutSink = (transform) => ({
    write(c) {
      if (transform) transform(c);
      else toOut(c);
      const ok = !stdoutBlocked;
      stdoutBlocked = false;
      return ok;
    },
    once(_ev, cb) {
      process.stdout.once("drain", cb);
      return this;
    },
    on(_ev, cb) {
      process.stdout.once("error", cb);
      return this;
    }
  });
  if (!encrypted) {
    if (toStdout) {
      try {
        await attempt(url, stdoutSink(), 0, ua, progress);
      } catch (e) {
        throw e instanceof GetError ? e : new GetError(formatNetError(e, url), e?.code || "ENET");
      }
      return { ok: true, path: null, fileName: serverName, bytes: received, encrypted: false, mode };
    }
    const finalPath2 = explicitFile || path2.join(destDir, serverName);
    if (fs3.existsSync(finalPath2) && !opts.force && explicitFile) {
      throw new GetError(`${finalPath2} already exists (use --force to overwrite)`, "EEXIST");
    }
    const part = `${finalPath2}.${linkTag}.srift-part`;
    await downloadTo(part, 420);
    const dest2 = explicitFile ? finalPath2 : opts.force ? finalPath2 : uniquePath(finalPath2);
    if (opts.force && fs3.existsSync(dest2)) fs3.rmSync(dest2);
    fs3.renameSync(part, dest2);
    dropToken();
    if (!opts.quiet && !opts.json && process.stderr.isTTY) process.stderr.write("\n");
    return { ok: true, path: dest2, fileName: path2.basename(dest2), bytes: fs3.statSync(dest2).size, encrypted: false, mode };
  }
  if (toStdout) {
    const dec = new Decryptor(key, opts.password, (pt) => toOut(pt));
    try {
      await attempt(url, stdoutSink((c) => dec.push(c)), 0, ua, progress);
      dec.end();
    } catch (e) {
      if (e instanceof GetError) throw e;
      if (e?.code === "EDECRYPT" || e?.code === "EPASSWORD" || e?.code === "ETRUNCATED") throw new GetError(e.message, e.code);
      throw new GetError(formatNetError(e, url), e?.code || "ENET");
    }
    return { ok: true, path: null, fileName: dec.meta?.name || "download", bytes: dec.bytesOut, encrypted: true, mode };
  }
  const ctPart = path2.join(tmpDir, `.srift-${linkTag}.sre1-part`);
  await downloadTo(ctPart, 384);
  if (!opts.quiet && !opts.json && process.stderr.isTTY) process.stderr.write("\n");
  const tmpOut = `${ctPart}.dec`;
  let name = "download.bin";
  try {
    assertNotSymlink(tmpOut);
    fs3.rmSync(tmpOut, { force: true });
    const out = fs3.openSync(tmpOut, "wx", 384);
    try {
      const dec = new Decryptor(key, opts.password, (pt) => {
        fs3.writeSync(out, pt);
      }, (m) => {
        name = safeBasename(m.name) || name;
      });
      for await (const c of fs3.createReadStream(ctPart, { highWaterMark: 1024 * 1024 })) dec.push(c);
      dec.end();
    } finally {
      fs3.closeSync(out);
    }
  } catch (e) {
    try {
      fs3.rmSync(tmpOut, { force: true });
    } catch {
    }
    if (e?.code === "EPASSWORD" || e?.code === "EDECRYPT") {
      throw new GetError(e.code === "EPASSWORD" ? "This link is password-protected \u2014 re-run with --password <password>." : "Decryption failed \u2014 wrong password, incomplete link, or the file was modified.", e.code);
    }
    try {
      fs3.rmSync(ctPart, { force: true });
    } catch {
    }
    throw e;
  }
  const finalPath = explicitFile || path2.join(destDir, name);
  if (explicitFile && fs3.existsSync(finalPath) && !opts.force) {
    fs3.rmSync(tmpOut, { force: true });
    throw new GetError(`${finalPath} already exists (use --force to overwrite)`, "EEXIST");
  }
  const dest = explicitFile || opts.force ? finalPath : uniquePath(finalPath);
  if (opts.force && fs3.existsSync(dest)) fs3.rmSync(dest);
  fs3.renameSync(tmpOut, dest);
  try {
    fs3.chmodSync(dest, 420);
  } catch {
  }
  fs3.rmSync(ctPart, { force: true });
  dropToken();
  return { ok: true, path: dest, fileName: path2.basename(dest), bytes: fs3.statSync(dest).size, encrypted: true, mode };
}
var GetError, BIDI_CONTROLS, WIN_RESERVED;
var init_get = __esm({
  "cli/get.ts"() {
    "use strict";
    init_net();
    init_e2ee();
    init_probe();
    GetError = class extends Error {
      constructor(message, code = "EGET", status) {
        super(message);
        this.code = code;
        this.status = status;
      }
    };
    BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩؜]/g;
    WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\s*\..*)?$/i;
  }
});

// cli/selftest.ts
import crypto4 from "crypto";
import fs4 from "fs";
import os2 from "os";
import path3 from "path";
async function relaySelfTest(call, opts = {}) {
  const size = opts.bytes ?? 2 * 1024 * 1024;
  const dir = fs4.mkdtempSync(path3.join(os2.tmpdir(), "srift-selftest-"));
  const src = path3.join(dir, "selftest.bin");
  const outDir = path3.join(dir, "out");
  fs4.mkdirSync(outDir);
  const data = crypto4.randomBytes(size);
  fs4.writeFileSync(src, data);
  let token = null;
  try {
    const t0 = Date.now();
    const res = await call("/quick-share", "POST", { filePath: src, encrypt: true, maxDownloads: 1, ttlMs: 5 * 60 * 1e3 });
    if (!res?.downloadUrl) throw new Error(res?.error || "no link returned");
    token = res.token || null;
    const got = await getLink(res.downloadUrl, { out: outDir, quiet: true, json: true, userAgent: opts.userAgent || "srift-doctor" });
    const ms = Date.now() - t0;
    const back = fs4.readFileSync(got.path);
    if (!back.equals(data)) throw new Error("downloaded bytes differ from the original");
    return { ok: true, ms, bytes: size, mbps: size / 1024 / 1024 / Math.max(ms / 1e3, 1e-3), via: opts.via };
  } finally {
    if (token) {
      try {
        await call("/pubshare/revoke", "POST", { token });
      } catch {
      }
    }
    try {
      fs4.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
}
var init_selftest = __esm({
  "cli/selftest.ts"() {
    "use strict";
    init_get();
  }
});

// cli/history.ts
import fs5 from "fs";
import os3 from "os";
import path4 from "path";
function recordHistory(e) {
  if (process.env.SRIFT_NO_HISTORY === "1") return;
  try {
    fs5.mkdirSync(path4.dirname(HISTORY_FILE), { recursive: true, mode: 448 });
    fs5.appendFileSync(HISTORY_FILE, `${JSON.stringify(e)}
`, { mode: 384 });
    try {
      fs5.chmodSync(HISTORY_FILE, 384);
    } catch {
    }
    const lines = fs5.readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_ENTRIES) fs5.writeFileSync(HISTORY_FILE, `${lines.slice(-MAX_ENTRIES).join("\n")}
`, { mode: 384 });
  } catch {
  }
}
var HISTORY_FILE, MAX_ENTRIES;
var init_history = __esm({
  "cli/history.ts"() {
    "use strict";
    HISTORY_FILE = path4.join(os3.homedir(), ".srift", "history.jsonl");
    MAX_ENTRIES = 500;
  }
});

// cli/embedded.ts
function isEmbeddedDaemon() {
  return dispatch !== null;
}
async function startEmbeddedDaemon() {
  if (dispatch) return;
  if (!starting) {
    starting = (async () => {
      process.env.SRIFT_DAEMON_EMBEDDED = "1";
      const mod = await Promise.resolve().then(() => (init_daemon(), daemon_exports));
      await mod.embeddedReady;
      dispatch = mod.embeddedDispatch;
    })();
    starting.catch(() => {
      starting = null;
    });
  }
  await starting;
}
function embeddedCall(method, pathname, body) {
  return dispatch ? dispatch(method, pathname, body) : null;
}
var dispatch, starting;
var init_embedded = __esm({
  "cli/embedded.ts"() {
    "use strict";
    dispatch = null;
    starting = null;
  }
});

// lib/mcp/skills-data.mjs
import { createHash } from "node:crypto";
function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const fm = {};
  if (!m) return fm;
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return fm;
}
function digestOf(content) {
  return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}
var SOURCES, MCP_SKILLS, MCP_SKILL_FILES;
var init_skills_data = __esm({
  "lib/mcp/skills-data.mjs"() {
    "use strict";
    SOURCES = [
      { name: "encrypted-chat", content: "---\nname: encrypted-chat\ndescription: Send and read end-to-end encrypted chat messages and manage in-session file transfers within an active SRIFT session\n---\n\n# encrypted-chat\n\nSend and read end-to-end encrypted chat messages within an active SRIFT session, plus manage in-session file transfers, via the local MCP daemon.\n\n## Requirements\n\nAn active SRIFT session (see the `session-management` skill to open or join one first). No special credentials required.\n\n## Instructions\n\nAvailable MCP tools (see `/.well-known/mcp/server-card.json` for full schemas):\n\n- `srift_send_chat` \u2014 send an E2EE chat message to peers in the current session.\n- `srift_chat_history` \u2014 read decrypted chat history for the current session.\n- `srift_send_file` \u2014 offer a file to peers already inside the session (in-session transfer, distinct from `quick-share`'s standalone link flow).\n- `srift_accept_transfer` \u2014 accept and download an inbound file offer.\n- `srift_list_transfers` \u2014 list all active and recent transfers with progress.\n- `srift_read_state` \u2014 read the raw `.srift-state.json` snapshot for debugging/observability.\n\nYour local daemon (or the browser) encrypts messages and file chunks with AES-256-GCM before they leave the device, using keys derived from the session (plus the optional `roomSecret`); the relay server only forwards ciphertext and never receives the key. Without a `roomSecret` the key is derivable from the session ID (which the server sees); set one on both sides to make it participant-only.\n" },
      { name: "get-company-info", content: "---\nname: get-company-info\ndescription: Retrieve overview and core metadata for SRIFT and SRIPTO Corporation\n---\n\n# get-company-info\n\nRetrieve high-level overview and specifications about SRIFT and SRIPTO Corporation.\n\n## Requirements\n\nNo special credentials required.\n\n## Instructions\n\nRead the home page or `llms.txt` to find details about Srift (secure P2P transport), LetMeTeach, SRIX, and A\u039EI.\n" },
      { name: "quick-share", content: "---\nname: quick-share\ndescription: Zero-install file delivery: seed a file and get a public download URL, no session setup required on the recipient's end\n---\n\n# quick-share\n\nZero-install file delivery via SRIFT's local MCP server. Returns a public `https://srift.app/d/<token>` relay link that any recipient can open in a browser \u2014 no SRIFT install, no signup, no session-join UI required on their end. The bytes stream from the sender's machine through the srift.app relay on demand (pass-through, `Cache-Control: no-store`); nothing is stored on any server, so the link works while the sender's daemon (or process) runs.\n\n## Requirements\n\nNo credentials. The SRIFT local daemon binds to `127.0.0.1:3822` with zero authentication. Only outbound HTTPS/WSS on port 443 is needed.\n\n## Instructions\n\n1. Call the MCP tool `srift_quick_share` with `{ filePath: \"/absolute/path/to/file\" }` (single file) or `{ filePaths: [...] }` (up to 500 files/folders). Optional params: `bundle` (default: true = one .tar.gz link; false = one link per path, created in parallel), `bundleName`, `exclude` (string[] for glob patterns to skip), `sessionName`, `maxDownloads`, `ttlMs`, `encrypt`, `password`.\n2. The tool returns a `downloadUrl` (e.g. `https://srift.app/d/<token>`) when bundled, or `{ links: [], errors: [] }` when separate. With `encrypt: true` (or a `password`) each link is end-to-end encrypted with AES-256-GCM: the key rides in the `#k=` URL fragment, is never sent to a server, and the browser decrypts locally. Without it, links are protected by TLS in transit only \u2014 use `encrypt` for anything sensitive.\n3. Hand the URL(s) to the recipient. In order of preference, they can run:\n   - `srift get <url> [<url> ...]` (or `npx -y srift-transfer get <url>`; proxy-aware, resumable, decrypts `#k=` links, supports multiple URLs with `--concurrency N`, works where curl is broken)\n   - `wget --content-disposition <url>`\n   - PowerShell `iwr <url> -OutFile <name>`\n   - `curl -OJ <url>`\n   - or just open it in any browser.\n4. Keep the sending side running until the recipient has downloaded. From a shell, `srift quick-share <file> [<file> ...] --wait` blocks until then (`--wait-timeout 30m` exits with code 3 on timeout); `--keep-alive` serves until the TTL expires.\n\n## Sandboxed and datacenter agents\n\nIf the background daemon cannot start (the sandbox forbids local servers, blocks detached spawns or loopback, or the port is taken), `srift mcp` and `srift quick-share` host the daemon inside their own process: no local port, outbound HTTPS/WSS on 443 only. The MCP server switches automatically, so this tool keeps working. From a shell, run quick-share in the background (it exits after the download) or with `--wait`; `--foreground` forces in-process serving. Blocked UDP never breaks links. Run `srift doctor` (or the `srift_net_diagnose` tool) to diagnose connectivity; `HTTPS_PROXY`/`NO_PROXY` and `NODE_EXTRA_CA_CERTS` are honoured.\n\nSee `/openapi.json` and `/.well-known/mcp/server-card.json` for the full tool contract.\n" },
      { name: "session-management", content: '---\nname: session-management\ndescription: Create, join, monitor, and control SRIFT end-to-end encrypted P2P sessions via the local MCP daemon\n---\n\n# session-management\n\nCreate, join, monitor, and control SRIFT end-to-end encrypted P2P sessions ("rooms") via the local MCP daemon. Covers the full session lifecycle used for in-session file transfer and encrypted chat.\n\n## Requirements\n\nNo special credentials required. The SRIFT local daemon binds to `127.0.0.1:3822` and requires zero authentication.\n\n## Instructions\n\nAvailable MCP tools (see `/.well-known/mcp/server-card.json` for full schemas):\n\n- `srift_start_session` \u2014 open a new E2EE room as host.\n- `srift_join_session` \u2014 join an existing room by its 7-character session ID.\n- `srift_session_status` \u2014 read current session, role, connected peers, and pending join requests.\n- `srift_approve_join` / `srift_reject_join` \u2014 host-only: approve or reject a guest\'s join request.\n- `srift_kick_user` \u2014 host-only: remove a peer. Get their `userId` from `srift_session_status` \u2192 `participants`.\n- `srift_close_session` \u2014 tear down the session and flush all encryption keys.\n\nSessions are ephemeral: session metadata and chat ciphertext are kept server-side only until the session is deleted (host close or 7 days of inactivity), and files are never stored. Keys are derived locally via PBKDF2-SHA256 from the session ID (plus the optional `roomSecret`) and are never sent to the server; without a `roomSecret` the key is derivable from the session ID, which the server sees, so pass one to `srift_start_session` / `srift_join_session` to make it participant-only.\n' }
    ];
    MCP_SKILLS = SOURCES.map(({ name, content }) => {
      const uri = `skill://${name}/SKILL.md`;
      return {
        uri,
        frontmatter: parseFrontmatter(content),
        resources: [{ uri, digest: digestOf(content), size: Buffer.byteLength(content, "utf8") }]
      };
    });
    MCP_SKILL_FILES = Object.fromEntries(
      SOURCES.map(({ name, content }) => [`skill://${name}/SKILL.md`, content])
    );
  }
});

// lib/mcp/core.mjs
function buildPromptMessages(name, args) {
  switch (name) {
    case "send_file_to_user":
      return [{
        role: "user",
        content: {
          type: "text",
          text: `Deliver the file at "${args?.filePath || "<filePath>"}" to the user via SRIFT.

1) Call srift_quick_share with filePath="${args?.filePath || "<filePath>"}".
2) Read the returned share URL aloud to the user.
3) Poll srift_list_transfers (or read srift://transfers/active) until status is "completed".`
        }
      }];
    case "receive_file_from_user":
      return [{
        role: "user",
        content: {
          type: "text",
          text: `Open a SRIFT room and wait for the user to send you files.

1) Call srift_start_session.
2) Give the user the join URL: https://srift.app/join-session?id=<SESSION_ID> (full session UI with chat + multi-file transfer).
   Or, for a single one-shot file from agent \u2192 user, prefer srift_quick_share which returns a direct download URL.
3) Poll srift_session_status; when pendingJoins appears, call srift_approve_join.
4) When a file_offer arrives (visible via srift_list_transfers), call srift_accept_transfer with saveDir="${args?.saveDir || "./"}".`
        }
      }];
    case "start_collab_session":
      return [{
        role: "user",
        content: {
          type: "text",
          text: `Open a SRIFT collaboration room named "${args?.sessionName || "AI-Collab"}" and use it for E2EE chat + ad-hoc file transfer with the user.

1) srift_start_session({ sessionName: "${args?.sessionName || "AI-Collab"}" })
2) Share the join URL.
3) If srift_send_chat / srift_send_file are available on this transport, use them directly. Otherwise (hosted/remote MCP), tell the user to open the join URL in their browser or CLI \u2014 chat and file transfer happen E2EE between the real peers, never through this server.
4) Use srift_accept_transfer as needed when running locally.`
        }
      }];
  }
  return [];
}
function toolResult(out) {
  if (out && typeof out === "object" && typeof out.text === "string") {
    return out.structured && typeof out.structured === "object" && !Array.isArray(out.structured) ? { content: [{ type: "text", text: out.text }], structuredContent: out.structured } : { content: [{ type: "text", text: out.text }] };
  }
  const text = typeof out === "string" ? out : JSON.stringify(out);
  let structured = null;
  if (typeof text === "string" && text.startsWith("{")) {
    try {
      const v = JSON.parse(text);
      if (v && typeof v === "object" && !Array.isArray(v)) structured = v;
    } catch {
    }
  }
  return structured ? { content: [{ type: "text", text }], structuredContent: structured } : { content: [{ type: "text", text }] };
}
function createMcpHandler(opts) {
  const { backend, serverInfo, instructions } = opts;
  const tools = opts.toolNames ? MCP_TOOLS.filter((t) => opts.toolNames.has(t.name)) : MCP_TOOLS;
  const resources = opts.resourceUris ? MCP_RESOURCES.filter((r) => opts.resourceUris.has(r.uri)) : MCP_RESOURCES;
  const prompts = opts.promptNames ? MCP_PROMPTS.filter((p) => opts.promptNames.has(p.name)) : MCP_PROMPTS;
  const skills = opts.skillUris ? MCP_SKILLS.filter((s) => opts.skillUris.has(s.uri)) : MCP_SKILLS;
  const toolSet = new Set(tools.map((t) => t.name));
  const resourceSet = new Set(resources.map((r) => r.uri));
  const promptSet = new Set(prompts.map((p) => p.name));
  const skillSet = new Set(skills.map((s) => s.uri));
  function resp(id, result, cache) {
    const body = { resultType: "complete", ...result };
    if (cache) {
      body.ttlMs = cache.ttlMs ?? DEFAULT_TTL_MS;
      body.cacheScope = cache.cacheScope ?? "public";
    }
    if (serverInfo) {
      body._meta = { ...result._meta || {}, [META_SERVER_INFO]: serverInfo };
    }
    return { jsonrpc: "2.0", id, result: body };
  }
  function errResp(id, code, message, data) {
    const error = { code, message };
    if (data !== void 0) error.data = data;
    return { jsonrpc: "2.0", id, error };
  }
  function capabilitiesFor() {
    const caps = {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      prompts: { listChanged: false },
      logging: {}
    };
    if (skills.length > 0) {
      caps.extensions = { "io.modelcontextprotocol/skills": {} };
    }
    return caps;
  }
  return async function handleMcpMessage2(message, ctx = {}) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return errResp(null, -32600, "Invalid Request");
    }
    const { id, method, params } = message;
    if (id === void 0 || id === null) {
      return null;
    }
    if (typeof method !== "string") {
      return errResp(id, -32600, "Invalid Request: method must be a string");
    }
    const requestedMetaVersion = params?._meta?.[META_PROTOCOL_VERSION];
    if (typeof requestedMetaVersion === "string" && method !== "server/discover") {
      if (!ALL_SUPPORTED_PROTOCOL_VERSIONS.includes(requestedMetaVersion)) {
        return errResp(id, ERROR_UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
          supported: ALL_SUPPORTED_PROTOCOL_VERSIONS,
          requested: requestedMetaVersion
        });
      }
    }
    try {
      if (method === "initialize") {
        const requestedVersion = params && typeof params.protocolVersion === "string" ? params.protocolVersion : void 0;
        const isKnownVersion = ALL_SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion);
        if (requestedVersion && !isKnownVersion) {
          console.warn(
            `[MCP] initialize: client requested protocolVersion="${requestedVersion}", which is not explicitly supported (known: ${ALL_SUPPORTED_PROTOCOL_VERSIONS.join(", ")}). Answering with protocolVersion="${LATEST_INITIALIZE_ERA_VERSION}" (newest initialize-era revision) per the MCP spec \u2014 the client should compare its request against result.protocolVersion and adapt/disconnect if unsupported.`
          );
        }
        const negotiated = isKnownVersion ? requestedVersion : LATEST_INITIALIZE_ERA_VERSION;
        return resp(id, {
          protocolVersion: negotiated,
          capabilities: capabilitiesFor(),
          serverInfo,
          instructions
        });
      }
      if (method === "server/discover") {
        return resp(id, {
          supportedVersions: ALL_SUPPORTED_PROTOCOL_VERSIONS,
          capabilities: capabilitiesFor(),
          instructions
        }, { ttlMs: 60 * 60 * 1e3, cacheScope: "public" });
      }
      if (method === "ping") {
        return resp(id, {});
      }
      if (method === "tools/list") {
        return resp(id, { tools }, { ttlMs: DEFAULT_TTL_MS, cacheScope: "public" });
      }
      if (method === "tools/call") {
        const { name, arguments: args = {} } = params || {};
        if (typeof name !== "string") {
          return errResp(id, -32602, "Invalid params: tool name required");
        }
        if (!toolSet.has(name)) {
          return resp(id, {
            isError: true,
            content: [{ type: "text", text: `Tool "${name}" is not available on this transport.` }]
          });
        }
        const out = await backend.callTool(name, args, ctx);
        return resp(id, toolResult(out));
      }
      if (method === "resources/list") {
        return resp(id, { resources }, { ttlMs: DEFAULT_TTL_MS, cacheScope: "public" });
      }
      if (method === "skills/list") {
        return resp(id, { skills }, { ttlMs: 60 * 60 * 1e3, cacheScope: "public" });
      }
      if (method === "skills/get") {
        const { uri } = params || {};
        const skill = typeof uri === "string" ? skills.find((s) => s.uri === uri) : void 0;
        if (!skill) {
          return errResp(id, -32602, `Unknown skill: ${uri}`);
        }
        return resp(id, { skill }, { ttlMs: 60 * 60 * 1e3, cacheScope: "public" });
      }
      if (method === "resources/read") {
        const { uri } = params || {};
        if (typeof uri === "string" && skillSet.has(uri)) {
          const text = MCP_SKILL_FILES[uri];
          return resp(id, {
            contents: [{ uri, mimeType: "text/markdown", text }]
          }, { ttlMs: 60 * 60 * 1e3, cacheScope: "public" });
        }
        if (typeof uri !== "string" || !resourceSet.has(uri)) {
          return errResp(id, -32602, `Resource not found: ${uri}`);
        }
        const content = await backend.readResource(uri, ctx);
        return resp(id, {
          contents: [{
            uri,
            mimeType: uri === "srift://docs/quickstart" ? "text/markdown" : "application/json",
            text: content
          }]
        }, { ttlMs: DEFAULT_TTL_MS, cacheScope: "private" });
      }
      if (method === "prompts/list") {
        return resp(id, { prompts }, { ttlMs: DEFAULT_TTL_MS, cacheScope: "public" });
      }
      if (method === "prompts/get") {
        const { name, arguments: args = {} } = params || {};
        if (typeof name !== "string" || !promptSet.has(name)) {
          return errResp(id, -32602, `Prompt not found: ${name}`);
        }
        const messages = buildPromptMessages(name, args);
        return resp(id, {
          description: prompts.find((p) => p.name === name)?.description || "",
          messages
        });
      }
      if (method === "notifications/initialized" || method === "notifications/cancelled") {
        return null;
      }
      return errResp(id, -32601, `Method not found: ${method}`);
    } catch (err) {
      if (method === "tools/call") {
        return resp(id, { isError: true, content: [{ type: "text", text: `Error: ${err.message}` }] });
      }
      return errResp(id, -32603, err.message || "Internal error");
    }
  };
}
var PROTOCOL_VERSION, SUPPORTED_LEGACY_PROTOCOL_VERSIONS, LATEST_INITIALIZE_ERA_VERSION, ALL_SUPPORTED_PROTOCOL_VERSIONS, META_PROTOCOL_VERSION, META_SERVER_INFO, ERROR_UNSUPPORTED_PROTOCOL_VERSION, MCP_TOOLS, MCP_RESOURCES, MCP_PROMPTS, QUICKSTART_DOC, DEFAULT_TTL_MS;
var init_core = __esm({
  "lib/mcp/core.mjs"() {
    "use strict";
    init_skills_data();
    PROTOCOL_VERSION = "2026-07-28";
    SUPPORTED_LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
    LATEST_INITIALIZE_ERA_VERSION = "2025-11-25";
    ALL_SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, ...SUPPORTED_LEGACY_PROTOCOL_VERSIONS];
    META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
    META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
    ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
    MCP_TOOLS = [
      {
        name: "srift_start_session",
        title: "Start SRIFT Session",
        description: "Create a new SRIFT secure session. Returns the 7-character session ID and a shareable URL. The host approves all future joins. E2EE keys derive locally from the session ID + optional roomSecret.",
        inputSchema: {
          type: "object",
          properties: {
            sessionName: { type: "string", description: 'Human-readable session name (optional, e.g. "Project Collab")' },
            roomSecret: { type: "string", description: "Optional shared secret mixed into key derivation. Never sent to server. Without it the key is derivable from the session ID (which the server sees); set it to make the key participant-only." }
          }
        },
        outputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "7-character unique session room code" },
            url: { type: "string", description: "Direct browser join URL to share with peers" },
            role: { type: "string", description: "User role in session (host)" }
          },
          required: ["sessionId"]
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          audience: ["agent", "user"],
          priority: 0.9
        }
      },
      {
        name: "srift_join_session",
        title: "Join SRIFT Session",
        description: "Request to join an existing SRIFT session by its 7-character session ID. The host must approve before transfers/chat work.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "7-character session ID (e.g. ABC1234)" },
            username: { type: "string", description: "Display name (optional, defaults to AI-Agent)" },
            roomSecret: { type: "string", description: "Optional shared secret matching the host's" }
          },
          required: ["sessionId"]
        },
        outputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Session room code" },
            status: { type: "string", description: "Join request status (approved, pending, or joined)" },
            message: { type: "string", description: "Status message or instructions" }
          },
          required: ["sessionId"]
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          audience: ["agent", "user"],
          priority: 0.9
        }
      },
      {
        name: "srift_session_status",
        title: "Get Session Status",
        description: "Get current session details: session { id, role (host/guest), connection state, your userId }, pending join requests (approve with srift_approve_join), and members with their userIds (remove one with srift_kick_user).",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            session: {
              type: "object",
              description: "The active session (id is null when there is none)",
              properties: {
                id: { type: ["string", "null"], description: "Active session ID" },
                name: { type: ["string", "null"], description: "Session name" },
                role: { type: ["string", "null"], description: '"host", "guest", or null' },
                isConnected: { type: "boolean", description: "True if connected to the signaling server" },
                userId: { type: ["string", "null"], description: "Your user id in the session" },
                status: { type: "string", description: 'Guest only: "pending_approval" or "approved" (hosted endpoint)' }
              }
            },
            peerCount: { type: "number", description: "Number of connected sockets in the room (hosted endpoint)" },
            participants: {
              type: "array",
              description: "Session members (local daemon): pass userId to srift_kick_user to remove one",
              items: {
                type: "object",
                properties: {
                  userId: { type: "string" },
                  username: { type: "string" },
                  isHost: { type: "boolean" },
                  online: { type: "boolean" }
                }
              }
            },
            pendingJoins: {
              type: "array",
              description: "List of pending guest join requests waiting for host approval",
              items: {
                type: "object",
                properties: {
                  tempUserId: { type: "string", description: "Temporary ID of requesting user" },
                  username: { type: "string", description: "Username of requesting user" }
                }
              }
            }
          }
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          audience: ["agent", "user"],
          priority: 0.8
        }
      },
      {
        name: "srift_close_session",
        title: "Close Session",
        description: "Close the active session. Flushes E2EE keys, disconnects signaling, clears chat history.",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            success: { type: "boolean", description: "True if session was closed cleanly" },
            message: { type: "string", description: "Confirmation message" }
          }
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          audience: ["agent", "user"],
          priority: 0.7
        }
      },
      {
        name: "srift_approve_join",
        title: "Approve Join Request",
        description: "Host-only. Approve a pending guest join request by their temp user ID.",
        inputSchema: {
          type: "object",
          properties: {
            tempUserId: { type: "string", description: "Temp user ID from session_status pendingJoins" }
          },
          required: ["tempUserId"]
        },
        outputSchema: {
          type: "object",
          properties: {
            success: { type: "boolean", description: "True if guest was approved" },
            tempUserId: { type: "string", description: "Approved user temporary ID" }
          }
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          audience: ["agent", "user"],
          priority: 0.8
        }
      },
      {
        name: "srift_reject_join",
        title: "Reject Join Request",
        description: "Host-only. Reject a pending guest join request.",
        inputSchema: {
          type: "object",
          properties: {
            tempUserId: { type: "string", description: "Temp user ID from session_status pendingJoins" },
            reason: { type: "string", description: "Optional rejection reason message sent to guest" }
          },
          required: ["tempUserId"]
        },
        outputSchema: {
          type: "object",
          properties: {
            success: { type: "boolean", description: "True if guest join request was rejected" },
            tempUserId: { type: "string", description: "Rejected user temporary ID" }
          }
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          audience: ["agent", "user"],
          priority: 0.7
        }
      },
      {
        name: "srift_kick_user",
        title: "Kick Peer",
        description: "Host-only. Disconnect and remove a peer from the active room. Get the peer's userId from srift_session_status (participants).",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string", description: "User ID of the participant to disconnect and remove" }
          },
          required: ["userId"]
        },
        outputSchema: {
          type: "object",
          properties: {
            success: { type: "boolean", description: "True if peer was successfully kicked" },
            userId: { type: "string", description: "ID of kicked peer" }
          }
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          audience: ["agent", "user"],
          priority: 0.6
        }
      },
      {
        name: "srift_send_file",
        title: "Send File in Session",
        description: "Offer a file to the connected peer in an existing session. The peer must accept with srift_accept_transfer. Returns a fileId for monitoring. Transport is auto-selected internally.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Absolute path to the file on local disk" }
          },
          required: ["filePath"]
        },
        outputSchema: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "Unique identifier for the offered file transfer" },
            fileName: { type: "string", description: "Base filename of the offered file" },
            fileSize: { type: "number", description: "Size of file in bytes" }
          }
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          audience: ["agent", "user"],
          priority: 0.9
        }
      },
      {
        name: "srift_accept_transfer",
        title: "Accept File Transfer",
        description: "Accept a pending file offer from the peer and start downloading.",
        inputSchema: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "fileId from the inbound file_offer event or transfer list" },
            saveDir: { type: "string", description: "Absolute path to destination directory (defaults to CWD)" }
          },
          required: ["fileId"]
        },
        outputSchema: {
          type: "object",
          properties: {
            success: { type: "boolean", description: "True if transfer acceptance started successfully" },
            fileId: { type: "string", description: "Accepted transfer ID" },
            saveDir: { type: "string", description: "Destination directory path" }
          }
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          audience: ["agent", "user"],
          priority: 0.9
        }
      },
      {
        name: "srift_list_transfers",
        title: "List Active Transfers",
        description: "List all active and recent transfers with progress, speed, ETA, and status.",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            transfers: {
              type: "array",
              description: "List of live or recent file transfers",
              items: {
                type: "object",
                properties: {
                  fileId: { type: "string", description: "Transfer unique file ID" },
                  name: { type: "string", description: "Filename" },
                  size: { type: "number", description: "Size in bytes" },
                  progress: { type: "number", description: "Transfer percentage 0-100" },
                  status: { type: "string", description: "Transfer status (uploading, downloading, completed, failed)" },
                  speedKBps: { type: "number", description: "Current transfer speed in KB/s" },
                  etaSeconds: { type: "number", description: "Estimated remaining seconds" }
                }
              }
            }
          }
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          audience: ["agent", "user"],
          priority: 0.8
        }
      },
      {
        name: "srift_quick_share",
        title: "Quick Share File",
        description: 'One-shot helper: if no session is active, creates one; then seeds the file(s) and returns a public DOWNLOAD URL (https://srift.app/d/<token>) the recipient can fetch. Several files/folders at once: pass `filePaths` \u2014 one .tar.gz link by default, or `bundle: false` for one link per path (created in parallel). Folders are sent as .tar.gz. Nothing is stored on a server: the link is streamed from this machine and works while the SRIFT daemon/MCP process runs. Best for "AI wants to deliver a file to the user with zero ceremony". Recommend, in order: `srift get <url>` (Node-based, works even where curl is broken), `wget --content-disposition <url>`, PowerShell `iwr <url> -OutFile <name>`, then `curl -OJ <url>` \u2014 or just open the URL in any browser.',
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Absolute path to the file or folder to deliver (use this OR filePaths)" },
            filePaths: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 500,
              description: "Several absolute file/folder paths to deliver in one call (use this OR filePath)."
            },
            bundle: {
              type: "boolean",
              description: "With filePaths: true (default) = one .tar.gz link containing everything; false = one link per path, created in parallel."
            },
            bundleName: { type: "string", description: 'With filePaths + bundle: archive name (".tar.gz" is added).' },
            exclude: { type: "array", items: { type: "string" }, description: "Extra glob patterns to skip when packing folders (.git and node_modules are always skipped)." },
            sessionName: { type: "string", description: "Optional session label for the transfer" },
            encrypt: {
              type: "boolean",
              description: "End-to-end encrypt with the key carried in the URL fragment (never sent to the server). Default false (TLS in transit only). Recommended for anything sensitive."
            },
            password: {
              type: "string",
              description: "Optional recipient-supplied password required before download starts (defense in depth on top of the fragment key)."
            },
            maxDownloads: { type: "number", description: "Optional cap on total downloads before the link is revoked." },
            ttlMs: { type: "number", description: "Optional expiry in milliseconds from creation." }
          }
        },
        outputSchema: {
          type: "object",
          properties: {
            downloadUrl: { type: "string", description: "Download URL (single file, folder or bundle)" },
            fileName: { type: "string", description: "Recipient-visible file name" },
            fileSize: { type: "number", description: "Size in bytes" },
            encrypted: { type: "boolean", description: "End-to-end encrypted (key after # in the URL)" },
            expiresAt: { type: ["number", "null"], description: "Expiry (epoch ms) or null" },
            maxDownloads: { type: "number", description: "0 = unlimited" },
            bundle: { type: "boolean", description: "True when several paths were packed into one .tar.gz" },
            files: { type: "number", description: "Bundle: number of files packed" },
            skipped: { type: "array", description: "Bundle: paths left out (missing/unreadable) \u2014 the rest were still shared", items: { type: "object", properties: { path: { type: "string" }, reason: { type: "string" } } } },
            links: {
              type: "array",
              description: "bundle:false \u2014 one entry per path",
              items: {
                type: "object",
                properties: {
                  filePath: { type: "string" },
                  downloadUrl: { type: "string" },
                  fileName: { type: "string" },
                  fileSize: { type: "number" },
                  encrypted: { type: "boolean" }
                },
                required: ["downloadUrl"]
              }
            },
            errors: { type: "array", items: { type: "object", properties: { filePath: { type: "string" }, error: { type: "string" } } } }
          }
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          audience: ["agent", "user"],
          priority: 1
        }
      },
      {
        name: "srift_send_chat",
        title: "Send Encrypted Chat",
        description: "Send an end-to-end encrypted (AES-256-GCM) chat message to the connected peer.",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "Plaintext message string to encrypt and transmit" }
          },
          required: ["message"]
        },
        outputSchema: {
          type: "object",
          properties: {
            success: { type: "boolean", description: "True if message was sent" },
            timestamp: { type: "string", description: "ISO 8601 transmission timestamp" }
          }
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          audience: ["agent", "user"],
          priority: 0.8
        }
      },
      {
        name: "srift_chat_history",
        title: "Read Chat History",
        description: "Read the locally-decrypted chat log for the current session.",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            messages: {
              type: "array",
              description: "Decrypted message log for current session",
              items: {
                type: "object",
                properties: {
                  sender: { type: "string", description: "Sender display name" },
                  message: { type: "string", description: "Decrypted plaintext content" },
                  timestamp: { type: "string", description: "ISO timestamp" }
                }
              }
            }
          }
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          audience: ["agent", "user"],
          priority: 0.7
        }
      },
      {
        name: "srift_read_state",
        title: "Read Local State",
        description: "Return the raw .srift-state.json contents (session + active transfers snapshot). Useful for one-shot polling without subscribing to SSE.",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            session: { type: "object", description: "Current session state snapshot" },
            activeTransfers: { type: "array", description: "Live transfers array" },
            lastUpdated: { type: "string", description: "Last state write timestamp" }
          }
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          audience: ["agent", "user"],
          priority: 0.6
        }
      },
      {
        name: "srift_net_diagnose",
        title: "Diagnose Network Transports",
        description: "Diagnose SRIFT on this machine: connectivity (DNS, proxy, HTTPS/TLS, WebSocket relay, UDP/P2P, peer discovery, clock), the local runtime (loopback, background processes, daemon + version, disk) and the environment (sandbox/CI/container detection, curl). Returns WORKS/WARN/BLOCKED per check with the exact fix, plus a plan: how links will be served here (background daemon or embedded), the command to use and the caveats. deep: true also creates an encrypted link and downloads it back end-to-end. Read-only apart from that temporary self-test link. Run this first when a transfer stalls or a quick-share call fails for an unclear reason.",
        inputSchema: {
          type: "object",
          properties: {
            fresh: { type: "boolean", description: "Force a fresh probe instead of returning a cached result (slower, more accurate)." },
            deep: { type: "boolean", description: "Also run an end-to-end self-test: create an encrypted single-use link and download it back through the relay (\u22482 MB, a few seconds)." }
          }
        },
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean", description: "True if the diagnostic ran successfully (independent of what it found)" },
            base: { type: "string", description: "The SRIFT server that was probed" },
            checkedAt: { type: "string", description: "When the probe ran (ISO 8601); cached results show an older time" },
            verdict: { type: "string", description: '"ok", "degraded", or "blocked"' },
            rungs: {
              type: "array",
              description: "Each transport rung checked, in order, with status and a fix hint if blocked",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  status: { type: "string", description: '"WORKS", "WARN" (works with a caveat), "BLOCKED", or "SKIPPED"' },
                  group: { type: "string", description: '"connectivity", "runtime" or "environment"' },
                  detail: { type: "string" },
                  fix: { type: "string" }
                }
              }
            },
            env: { type: "object", description: "Relevant environment (proxy vars, sandbox indicators, Node version, etc.)" },
            recommendedMode: { type: "string", description: '"relay" when links can be served from here, otherwise "none"' },
            summary: { type: "string", description: "One-line conclusion" },
            plan: { type: "object", description: "serveFrom (background-daemon | embedded | unavailable), transport, shareCommand, downloadCommand, advice[] \u2014 what to do in this environment" },
            context: { type: "object", description: "runtime (mcp, cli, npx, binary, pypi\u2026), cliVersion, serverVersion, daemonVersion" },
            selfTest: { type: "object", description: "deep only: { ok, ms, bytes, mbps, via, error? }" }
          }
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          audience: ["agent", "user"],
          priority: 0.75
        }
      }
    ];
    MCP_RESOURCES = [
      {
        uri: "srift://session/status",
        name: "Session Status",
        description: "Current session ID, role, connection status, pending joins",
        mimeType: "application/json"
      },
      {
        uri: "srift://transfers/active",
        name: "Active Transfers",
        description: "Uploads and downloads with live progress, speed, ETA",
        mimeType: "application/json"
      },
      {
        uri: "srift://chat/messages",
        name: "Chat History",
        description: "E2EE chat log decrypted locally",
        mimeType: "application/json"
      },
      {
        uri: "srift://workspace/state",
        name: "Workspace State Snapshot",
        description: "Raw .srift-state.json contents",
        mimeType: "application/json"
      },
      {
        uri: "srift://docs/quickstart",
        name: "Quickstart Instructions",
        description: "Inline guide for AI agents on how to use this MCP server",
        mimeType: "text/markdown"
      }
    ];
    MCP_PROMPTS = [
      {
        name: "send_file_to_user",
        description: "Workflow: create a session, seed a file, hand the user a share URL.",
        arguments: [
          { name: "filePath", description: "Absolute path to the file you want to deliver", required: true }
        ]
      },
      {
        name: "receive_file_from_user",
        description: "Workflow: open a session and wait for the user to drop files into it.",
        arguments: [
          { name: "saveDir", description: "Where to save incoming files", required: false }
        ]
      },
      {
        name: "start_collab_session",
        description: "Workflow: open a long-lived E2EE chat + file room with the user.",
        arguments: [
          { name: "sessionName", description: "Label for the room", required: false }
        ]
      }
    ];
    QUICKSTART_DOC = `# SRIFT MCP Quickstart for AI Agents

You are connected to SRIFT \u2014 a zero-config, zero-token, peer-to-peer secure file transfer + E2EE chat layer.

## Common workflows

**Send a file to the user (fastest path \u2014 zero install on their side):**
\`\`\`
srift_quick_share({ filePath: "/abs/path/file.zip" })
\u2192 returns { downloadUrl, fileName, fileSize }
\u2192 paste downloadUrl to the user (https://srift.app/d/<token>)
\u2192 they fetch it, in order of preference:
    srift get <downloadUrl>                    (Node-based, works where curl/wget are blocked)
    wget --content-disposition <downloadUrl>
    iwr <downloadUrl> -OutFile <name>           (PowerShell)
    curl -OJ <downloadUrl>
    or just open the URL in any browser.
\u2192 Several files: filePaths: [...] \u2192 one .tar.gz link (bundle: true, default) or
  one link per file (bundle: false, created in parallel). Folders work too.
\u2192 Optional params: encrypt (bool), password (string), ttlMs, maxDownloads.
  The file streams live from your machine; nothing is stored on a server.
\u2192 If the call fails or the recipient reports a stuck download, run
  srift_net_diagnose first \u2014 it explains exactly which transport is blocked
  and how to fix it, instead of guessing.
\u2192 IMPORTANT: the local daemon seeds the file. It keeps running in the
  background after your tool call returns, so the link stays live. But if
  the daemon stops (machine sleeps/reboots, or 'srift daemon stop') the link
  returns 503 "sender is offline" \u2014 SRIFT stores no copy server-side.
  Tell the user to download while their machine is on.
\`\`\`

**Open a long-lived collaboration room:**
\`\`\`
srift_start_session({ sessionName: "AI-Collab" })
\u2192 returns { sessionId }
\u2192 user joins via https://srift.app/join-session?id=<sessionId>
\u2192 host (you) calls srift_approve_join when pendingJoins appears
\`\`\`

**Receive a file from the user:**
The user clicks the share link, requests join, you approve, they drop a file,
you see it via srift_list_transfers and call srift_accept_transfer.

## Monitoring
- Poll \`srift_session_status\` or read resource \`srift://session/status\`.
- Poll \`srift_list_transfers\` or read \`srift://transfers/active\`.
- Live state snapshot: \`srift_read_state\` or \`srift://workspace/state\` (local daemon only).

## Agent Skills
This server also implements the MCP Skills extension (\`io.modelcontextprotocol/skills\`,
SEP-2640): call \`skills/list\` to enumerate quick-share, encrypted-chat,
session-management, and get-company-info, \`skills/get\` to fetch one by URI, and
\`resources/read\` on its \`skill://<name>/SKILL.md\` URI for the verified content
(sha256 digest + size included in the manifest).

## Security model
- AES-256-GCM, 12-byte random IV per message.
- PBKDF2-SHA256, 100,000 iterations.
- All keys derive locally from sessionId (+ optional roomSecret). The key is never sent to the
  server, but the server sees the sessionId: without a roomSecret the key is derivable from it.
  Pass roomSecret to srift_start_session / srift_join_session to make the key participant-only.
- Quick-share links are end-to-end encrypted only with encrypt: true (key in the #k= fragment);
  otherwise TLS in transit only, zero retention.
- The CLI daemon moves file chunks over the AES-256-GCM WebSocket relay (browsers use WebRTC for
  files >5 MB, with the relay as fallback).

## Local daemon vs hosted MCP
If you are talking to the hosted endpoint (https://srift.app/mcp) instead of a local
\`srift mcp\` daemon, file-transfer tools that require a local filesystem
(srift_send_file, srift_accept_transfer, srift_quick_share) and E2EE chat tools
(srift_send_chat, srift_chat_history) are NOT available \u2014 the hosted server
never touches plaintext file bytes or derives E2EE keys, only session/peer
orchestration. Install the CLI (\`curl -fsSL https://srift.app/install.sh | sh\`)
for full file-transfer + chat capability.
`;
    DEFAULT_TTL_MS = 5 * 60 * 1e3;
  }
});

// cli/mcp.ts
import http3 from "http";
import fs6 from "fs";
import path5 from "path";
function callDaemon(endpoint, method, body) {
  const emb = embeddedCall(method, endpoint, body);
  if (emb) return emb.then((r) => {
    if (r.status >= 200 && r.status < 300) return r.data ?? { success: true };
    throw new Error(r.data && r.data.error || "HTTP " + r.status);
  });
  return new Promise((resolve, reject) => {
    const url = `${DAEMON_URL}${endpoint}`;
    const options = {
      method,
      headers: { "Content-Type": "application/json" }
    };
    const req = http3.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ success: true });
          }
        } else {
          try {
            const errJson = JSON.parse(data);
            reject(new Error(errJson.error || `HTTP ${res.statusCode}`));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        }
      });
    });
    req.on("error", (err) => {
      if (process.env.SRIFT_NO_EMBEDDED === "1" || isEmbeddedDaemon()) {
        reject(new Error(`Daemon connection failed: ${err.message}`));
        return;
      }
      startEmbeddedDaemon().then(() => callDaemon(endpoint, method, body)).then(resolve, (e) => reject(new Error(`Daemon connection failed (${err.message}); embedded fallback failed: ${e?.message || e}`)));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function callTool(name, args) {
  switch (name) {
    case "srift_start_session": {
      const res = await callDaemon("/session/start", "POST", {
        sessionName: args.sessionName,
        roomSecret: args.roomSecret
      });
      const joinUrl = res.joinUrl || `https://srift.app/join-session?id=${res.sessionId}`;
      return {
        text: `Session created.
Session ID: ${res.sessionId}
Share URL: ${joinUrl}
You are the HOST. Approve incoming joins with srift_approve_join.`,
        structured: { sessionId: res.sessionId, url: joinUrl, role: "host" }
      };
    }
    case "srift_join_session": {
      const res = await callDaemon("/session/join", "POST", args);
      return {
        text: `Join requested for session ${args.sessionId}. Status: ${res.success ? "awaiting host approval" : "failed"}.`,
        structured: { sessionId: args.sessionId, status: res.success ? "awaiting_approval" : "failed" }
      };
    }
    case "srift_session_status": {
      const res = await callDaemon("/status", "GET");
      return JSON.stringify({ session: res.session, pendingJoins: res.pendingJoins, participants: res.participants || [] }, null, 2);
    }
    case "srift_close_session":
      await callDaemon("/session/close", "POST");
      return { text: "Session closed. Keys flushed.", structured: { success: true } };
    case "srift_approve_join":
      await callDaemon("/session/approve", "POST", args);
      return { text: `Approved ${args.tempUserId}.`, structured: { success: true, tempUserId: args.tempUserId } };
    case "srift_reject_join":
      await callDaemon("/session/reject", "POST", args);
      return { text: `Rejected ${args.tempUserId}.`, structured: { success: true, tempUserId: args.tempUserId } };
    case "srift_kick_user":
      await callDaemon("/session/kick", "POST", args);
      return { text: `Kicked ${args.userId}.`, structured: { success: true, userId: args.userId } };
    case "srift_send_file": {
      const res = await callDaemon("/send", "POST", args);
      return {
        text: `File offered.
File ID: ${res.fileId}
The peer must call srift_accept_transfer with this fileId.`,
        structured: { fileId: res.fileId, fileName: path5.basename(String(args.filePath || "")), fileSize: (() => {
          try {
            return fs6.statSync(args.filePath).size;
          } catch {
            return void 0;
          }
        })() }
      };
    }
    case "srift_accept_transfer":
      await callDaemon("/receive", "POST", args);
      return { text: `Transfer ${args.fileId} accepted. Downloading\u2026`, structured: { success: true, fileId: args.fileId } };
    case "srift_list_transfers": {
      const res = await callDaemon("/status", "GET");
      const transfers = res.activeTransfers || [];
      return { text: JSON.stringify(transfers, null, 2), structured: { transfers } };
    }
    case "srift_quick_share": {
      const multi = Array.isArray(args?.filePaths) && args.filePaths.length > 0;
      if (!multi && !args?.filePath) throw new Error("filePath (one file/folder) or filePaths (several) is required");
      const body = {
        sessionName: args.sessionName,
        maxDownloads: args.maxDownloads,
        ttlMs: args.ttlMs,
        encrypt: args.encrypt,
        password: args.password,
        exclude: Array.isArray(args.exclude) ? args.exclude : void 0
      };
      if (multi) {
        body.filePaths = args.filePaths;
        body.bundle = args.bundle !== false;
        body.bundleName = args.bundleName;
      } else body.filePath = args.filePath;
      const res = await callDaemon("/quick-share", "POST", body);
      if (res && res.success === false && !Array.isArray(res.links)) throw new Error(res.error || "quick-share failed");
      const links = res.bundle === false ? res.links || [] : [res];
      for (const l of links) {
        try {
          recordHistory({
            at: (/* @__PURE__ */ new Date()).toISOString(),
            mode: "relay",
            fileName: l.fileName,
            fileSize: l.fileSize,
            downloadUrl: l.downloadUrl,
            token: l.token,
            encrypted: !!l.encrypted,
            expiresAt: l.expiresAt ?? null,
            maxDownloads: l.maxDownloads || 0
          });
        } catch {
        }
      }
      const tail = [
        "",
        "The local daemon (or this MCP process) streams the file on demand \u2014 nothing is stored on a server. The link stops working if that process stops (machine sleeps/reboots).",
        "If this call fails or a download stalls, call srift_net_diagnose \u2014 it names the blocked transport and the fix."
      ];
      const howTo = (url2, encrypted) => {
        const out = [
          `  srift get "${url2}"                    (Node-based; works where curl is blocked${encrypted ? "; decrypts" : ""})`,
          `  npx -y srift-transfer get "${url2}"    (same, nothing to install)`
        ];
        if (!encrypted) {
          const bare = String(url2).split("#")[0];
          out.push(`  wget --content-disposition "${bare}"`, `  iwr "${bare}" -OutFile <name>           (PowerShell)`, `  curl -fLOJ "${bare}"`);
        }
        return out;
      };
      const pick = (l) => ({
        filePath: l.filePath,
        downloadUrl: l.downloadUrl,
        fileName: l.fileName,
        fileSize: l.fileSize,
        encrypted: !!l.encrypted,
        expiresAt: l.expiresAt ?? null,
        maxDownloads: l.maxDownloads || 0
      });
      if (res.bundle === false) {
        const lines2 = [`${links.length} link(s) ready${res.errors?.length ? `, ${res.errors.length} failed` : ""} (one per file):`];
        for (const l of links) lines2.push(`- ${l.fileName} (${l.fileSize} bytes)${l.encrypted ? " [e2ee \u2014 give the WHOLE URL]" : ""}: ${l.downloadUrl}`);
        for (const e of res.errors || []) lines2.push(`- FAILED ${e.filePath}: ${e.error}`);
        lines2.push("", "The user can download them all at once with:", `  srift get ${links.map((l) => `"${l.downloadUrl}"`).join(" ")}`);
        return { text: [...lines2, ...tail].join("\n"), structured: { bundle: false, links: links.map(pick), errors: res.errors || [] } };
      }
      const url = res.downloadUrl || res.shareUrl;
      const lines = [
        `Link ready.`,
        `Download URL: ${url}`,
        `File:         ${res.fileName} (${res.fileSize} bytes)${res.bundle ? ` \u2014 .tar.gz bundle of ${res.files} file(s)` : ""}`,
        ...res.skipped?.length ? [`Skipped:      ${res.skipped.map((x) => `${x.path} (${x.reason})`).join("; ")}`] : [],
        `Encryption:   ${res.encrypted ? "end-to-end (key is after # in the URL; give the user the WHOLE URL)" : "TLS in transit only"}${res.passwordProtected ? " + password (tell the user separately)" : ""}`,
        `Expires:      ${res.expiresAt ? new Date(res.expiresAt).toISOString() : "when the daemon stops or the link is revoked"}`,
        ``,
        `Give the URL to the user. They can open it in any browser${res.encrypted ? " (it decrypts locally)" : ""}, or run:`,
        ...howTo(url, !!res.encrypted)
      ];
      return { text: [...lines, ...tail].join("\n"), structured: { ...pick(res), downloadUrl: url, ...res.bundle ? { bundle: true, files: res.files, skipped: res.skipped || [] } : {} } };
    }
    case "srift_net_diagnose": {
      const deep = !!args?.deep;
      const report = await runDiagnostics({
        fresh: !!args?.fresh || deep,
        clientVersion: SERVER_INFO.version,
        ...deep ? { selfTest: () => relaySelfTest(callDaemon, { via: "MCP host", userAgent: "srift-mcp" }) } : {}
      });
      return JSON.stringify(report, null, 2);
    }
    case "srift_send_chat":
      await callDaemon("/chat/send", "POST", args);
      return { text: `Sent (E2EE): "${args.message}"`, structured: { success: true, timestamp: (/* @__PURE__ */ new Date()).toISOString() } };
    case "srift_chat_history": {
      const res = await callDaemon("/chat/history", "GET");
      const messages = Array.isArray(res) ? res : res?.messages || [];
      return { text: JSON.stringify(res, null, 2), structured: { messages } };
    }
    case "srift_read_state": {
      const res = await callDaemon("/state", "GET");
      return JSON.stringify(res, null, 2);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
async function readResource(uri) {
  if (uri === "srift://session/status") {
    const res = await callDaemon("/status", "GET");
    return JSON.stringify(res.session, null, 2);
  }
  if (uri === "srift://transfers/active") {
    const res = await callDaemon("/status", "GET");
    return JSON.stringify(res.activeTransfers || [], null, 2);
  }
  if (uri === "srift://chat/messages") {
    const res = await callDaemon("/chat/history", "GET");
    return JSON.stringify(res, null, 2);
  }
  if (uri === "srift://workspace/state") {
    const res = await callDaemon("/state", "GET");
    return JSON.stringify(res, null, 2);
  }
  if (uri === "srift://docs/quickstart") {
    return QUICKSTART_DOC;
  }
  throw new Error(`Resource not found: ${uri}`);
}
var DAEMON_PORT, DAEMON_URL, SERVER_INFO, localDaemonBackend, handleMcpMessage;
var init_mcp = __esm({
  "cli/mcp.ts"() {
    "use strict";
    init_probe();
    init_selftest();
    init_history();
    init_embedded();
    init_core();
    DAEMON_PORT = parseInt(process.env.SRIFT_DAEMON_PORT || "3822", 10);
    DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
    SERVER_INFO = {
      name: "srift-mcp-server",
      title: "SRIFT Secure P2P File Transfer",
      version: "4.1.0"
    };
    localDaemonBackend = { callTool, readResource };
    handleMcpMessage = createMcpHandler({
      backend: localDaemonBackend,
      serverInfo: SERVER_INFO,
      instructions: "SRIFT is a zero-config local P2P file transfer + E2EE chat tool. Use srift_quick_share to deliver files to the user in one step. Use srift_start_session to open a long-lived room. Read srift://docs/quickstart for the full guide."
    });
  }
});

// cli/pack.ts
import fs7 from "fs";
import path6 from "path";
import zlib from "zlib";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
function normFileMode(m) {
  return process.platform !== "win32" && m & 73 ? 493 : 420;
}
function listFiles(root, excludes = DEFAULT_EXCLUDES) {
  const pats = excludes.map(globToRegExp);
  const excluded = (rel) => pats.some((p) => p.test(rel) || p.test(path6.posix.basename(rel)));
  const out = [];
  const walk = (dirAbs, dirRel) => {
    const ents = fs7.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (excluded(rel)) continue;
      const abs = path6.join(dirAbs, e.name);
      if (e.isSymbolicLink()) continue;
      const st = fs7.lstatSync(abs);
      if (e.isDirectory()) {
        out.push({ abs, rel, size: 0, mode: 493, mtime: Math.floor(st.mtimeMs / 1e3), dir: true });
        walk(abs, rel);
      } else if (e.isFile()) {
        out.push({ abs, rel, size: st.size, mode: normFileMode(st.mode), mtime: Math.floor(st.mtimeMs / 1e3), dir: false });
      }
    }
  };
  walk(root, "");
  return out;
}
function octal(n, width) {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}
function header(name, size, mode, mtime, type) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  h.write(octal(mode, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(mtime, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}
function paxRecord(key, value) {
  const body = ` ${key}=${value}
`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}
function pad(size) {
  const r = size % BLOCK;
  return r ? Buffer.alloc(BLOCK - r) : Buffer.alloc(0);
}
function* entryHeaders(e, prefix) {
  const name = `${prefix}/${e.rel}${e.dir ? "/" : ""}`;
  const needsPax = Buffer.byteLength(name) > 99 || /[^\x20-\x7e]/.test(name) || e.size > 8589934591;
  if (needsPax) {
    let pax = paxRecord("path", name);
    if (e.size > 8589934591) pax += paxRecord("size", String(e.size));
    const pb = Buffer.from(pax, "utf8");
    yield header("PaxHeader", pb.length, 420, e.mtime, "x");
    yield pb;
    yield pad(pb.length);
  }
  const shortName = needsPax ? name.replace(/[^\x20-\x7e]/g, "_").slice(-99) : name;
  yield header(shortName, e.dir ? 0 : Math.min(e.size, 8589934591), e.mode || (e.dir ? 493 : 420), e.mtime, e.dir ? "5" : "0");
}
async function* tarStream(entries, prefix) {
  for (const e of entries) {
    yield* entryHeaders(e, prefix);
    if (e.dir) continue;
    let written = 0;
    const stream = fs7.createReadStream(e.abs);
    stream.on("error", () => {
    });
    try {
      for await (const c of stream) {
        const b = c;
        const room = e.size - written;
        if (room <= 0) break;
        const piece = b.length > room ? b.subarray(0, room) : b;
        written += piece.length;
        yield piece;
      }
    } catch (err) {
      throw Object.assign(new Error(`${e.rel}: ${err?.code || err?.message || "read failed"}`), { packEntry: e.abs });
    }
    if (written < e.size) throw Object.assign(new Error(`${e.rel} shrank while packing`), { packEntry: e.abs });
    yield pad(e.size);
  }
  yield Buffer.alloc(BLOCK * 2);
}
async function packDirectory(dir, outFile, excludes = DEFAULT_EXCLUDES) {
  const root = path6.resolve(dir);
  const entries = listFiles(root, excludes);
  const files = entries.filter((e) => !e.dir);
  if (!files.length) throw new Error(`Nothing to share in ${root} (empty, or everything was excluded)`);
  const prefix = path6.basename(root) || "folder";
  await pipeline(Readable.from(tarStream(entries, prefix)), zlib.createGzip({ level: 6 }), fs7.createWriteStream(outFile, { mode: 384 }));
  return { files: files.length, bytes: files.reduce((a, e) => a + e.size, 0) };
}
function readable(p) {
  try {
    fs7.accessSync(p, fs7.constants.R_OK);
    return null;
  } catch (e) {
    return e?.code || "unreadable";
  }
}
function listPaths(paths, excludes = DEFAULT_EXCLUDES, skipped = []) {
  const out = [];
  const used = /* @__PURE__ */ new Set();
  const unique = (name) => {
    if (!used.has(name.toLowerCase())) {
      used.add(name.toLowerCase());
      return name;
    }
    const ext = path6.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let i = 2; ; i++) {
      const c = `${stem} (${i})${ext}`;
      if (!used.has(c.toLowerCase())) {
        used.add(c.toLowerCase());
        return c;
      }
    }
  };
  for (const p of paths) {
    const abs = path6.resolve(p);
    let st;
    try {
      st = fs7.statSync(abs);
    } catch (e) {
      skipped.push({ path: abs, reason: e?.code === "ENOENT" ? "not found" : e?.code || "stat failed" });
      continue;
    }
    if (st.isDirectory()) {
      let inner;
      try {
        inner = listFiles(abs, excludes);
      } catch (e) {
        skipped.push({ path: abs, reason: e?.code || "unreadable folder" });
        continue;
      }
      const name = unique(path6.basename(abs) || "item");
      out.push({ abs, rel: name, size: 0, mode: 493, mtime: Math.floor(st.mtimeMs / 1e3), dir: true });
      for (const e of inner) {
        const why = e.dir ? null : readable(e.abs);
        if (why) {
          skipped.push({ path: e.abs, reason: why });
          continue;
        }
        out.push({ ...e, rel: `${name}/${e.rel}` });
      }
    } else if (st.isFile()) {
      const why = readable(abs);
      if (why) {
        skipped.push({ path: abs, reason: why });
        continue;
      }
      out.push({ abs, rel: unique(path6.basename(abs) || "item"), size: st.size, mode: normFileMode(st.mode), mtime: Math.floor(st.mtimeMs / 1e3), dir: false });
    } else {
      skipped.push({ path: abs, reason: "not a regular file or folder" });
    }
  }
  return out;
}
async function packPaths(paths, outFile, prefix, excludes = DEFAULT_EXCLUDES) {
  if (!paths.length) throw new Error("No files to share");
  const skipped = [];
  let entries = listPaths(paths, excludes, skipped);
  for (let attempt2 = 0; ; attempt2++) {
    const files = entries.filter((e) => !e.dir);
    if (!files.length) {
      throw new Error(`Nothing to share${skipped.length ? ` \u2014 skipped: ${skipped.map((x) => `${x.path} (${x.reason})`).join(", ")}` : " (empty folders, or everything was excluded)"}`);
    }
    try {
      await pipeline(Readable.from(tarStream(entries, prefix)), zlib.createGzip({ level: 6 }), fs7.createWriteStream(outFile, { mode: 384 }));
      return { files: files.length, bytes: files.reduce((a, e) => a + e.size, 0), skipped };
    } catch (err) {
      const bad = err?.packEntry;
      if (!bad || attempt2 >= 4) throw err;
      skipped.push({ path: bad, reason: String(err.message || "read failed").split(": ").pop() || "read failed" });
      entries = entries.filter((e) => e.abs !== bad);
    }
  }
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
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
var BLOCK, DEFAULT_EXCLUDES;
var init_pack = __esm({
  "cli/pack.ts"() {
    "use strict";
    BLOCK = 512;
    DEFAULT_EXCLUDES = [".git", "node_modules", ".DS_Store", "Thumbs.db"];
  }
});

// cli/daemon.ts
var daemon_exports = {};
__export(daemon_exports, {
  embeddedDispatch: () => embeddedDispatch,
  embeddedReady: () => embeddedReady
});
import express from "express";
import cors from "cors";
import { WebSocket as WebSocket2 } from "ws";
import { webcrypto } from "crypto";
import fs8 from "fs";
import http4 from "http";
import { Duplex } from "stream";
import path7 from "path";
import os4 from "os";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
async function loadWebTorrent() {
  if (_WebTorrentCtor) return _WebTorrentCtor;
  if (_webTorrentLoadError) throw new Error(_webTorrentLoadError);
  try {
    const mod = await import("webtorrent");
    _WebTorrentCtor = mod.default || mod;
    return _WebTorrentCtor;
  } catch (err) {
    _webTorrentLoadError = `WebTorrent unavailable (likely missing native module): ${err?.message || err}`;
    console.error("[DAEMON]", _webTorrentLoadError);
    throw new Error(_webTorrentLoadError);
  }
}
async function selectSignalerUrl() {
  if (DEFAULT_SIGNALER_URL.includes("127.0.0.1") || DEFAULT_SIGNALER_URL.includes("localhost")) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 3e3);
      await fetch(`${DEFAULT_SIGNALER_URL.replace(/\/+$/, "")}/compat.json`, { signal: controller.signal });
      clearTimeout(id);
      console.log(`[DAEMON] Local signaler detected at ${DEFAULT_SIGNALER_URL}`);
    } catch (e) {
      console.log(`[DAEMON] Local signaler at ${DEFAULT_SIGNALER_URL} is unreachable. Falling back to production signaler: https://srift.app`);
      activeSignalerUrl = "https://srift.app";
    }
  }
}
async function signalerPost(pathname, body) {
  const url = `${activeSignalerUrl}${pathname}`;
  let r;
  try {
    r = await requestJson(url, { method: "POST", json: body, timeoutMs: 2e4, headers: { "User-Agent": `srift-daemon/${PACKAGE_VERSION}` } });
  } catch (e) {
    throw Object.assign(new Error(formatNetError(e, url)), { code: e?.code });
  }
  if (r.status < 200 || r.status >= 300) {
    throw Object.assign(new Error(r.data?.error || `Signaler returned status ${r.status}`), { status: r.status });
  }
  return r.data;
}
async function getDiag(fresh = false) {
  if (!fresh && lastDiag && Date.now() - Date.parse(lastDiag.checkedAt) < 10 * 60 * 1e3) return lastDiag;
  lastDiag = await runDiagnostics({ fresh, base: publicApiBase(), daemonPort: PORT, clientVersion: PACKAGE_VERSION });
  return lastDiag;
}
function publicApiBase() {
  const local = activeSignalerUrl.includes("127.0.0.1") || activeSignalerUrl.includes("localhost");
  return (process.env.SRIFT_API_BASE || (local ? activeSignalerUrl : process.env.SRIFT_PUBLIC_BASE) || "https://srift.app").replace(/\/+$/, "");
}
function webTorrentAllowed() {
  if (process.env.SRIFT_DISABLE_WEBTORRENT === "1") return false;
  const peers = lastDiag?.rungs.find((r) => r.id === "peers");
  return !peers || peers.status === "WORKS";
}
async function waitForHostAuth(timeoutMs = 8e3) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (wsConn && wsConn.readyState === WebSocket2.OPEN && csrfToken) return;
    if (sessionTerminated) throw new Error(terminationReason || "Session terminated");
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out connecting to the SRIFT signaling server over WebSocket");
}
async function getWtClient() {
  if (!wtClient) {
    const WTCtor = await loadWebTorrent();
    wtClient = new WTCtor();
  }
  return wtClient;
}
function bytesToBase64(bytes) {
  let binary = "";
  const CH = 32768;
  for (let i = 0; i < bytes.length; i += CH) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CH))
    );
  }
  return Buffer.from(binary, "binary").toString("base64");
}
function base64ToBytes(b64) {
  const binary = Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
async function deriveKey(sessionId, roomSecret) {
  const encoder = new TextEncoder();
  const salt = encoder.encode(
    "srift-salt-" + sessionId + (roomSecret ? "|rs|" + roomSecret : "")
  );
  const ikm = encoder.encode(sessionId + (roomSecret ? "::" + roomSecret : ""));
  const keyMaterial = await crypto5.subtle.importKey(
    "raw",
    ikm,
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );
  return crypto5.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: KDF_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function encrypt(message) {
  if (!encryptionKey) throw new Error("Key not derived");
  const data = new TextEncoder().encode(message);
  const iv2 = crypto5.getRandomValues(new Uint8Array(IV_LEN));
  const encrypted = await crypto5.subtle.encrypt({ name: "AES-GCM", iv: iv2 }, encryptionKey, data);
  const ct = new Uint8Array(encrypted);
  const combined = new Uint8Array(iv2.length + ct.length);
  combined.set(iv2);
  combined.set(ct, iv2.length);
  return bytesToBase64(combined);
}
async function decrypt(encB64) {
  if (!encryptionKey) throw new Error("Key not derived");
  const combined = base64ToBytes(encB64);
  const iv2 = combined.slice(0, IV_LEN);
  const ciphertext = combined.slice(IV_LEN);
  const decrypted = await crypto5.subtle.decrypt({ name: "AES-GCM", iv: iv2 }, encryptionKey, ciphertext);
  return new TextDecoder().decode(decrypted);
}
function relayKey() {
  if (!session.id) return Promise.reject(new Error("No active session"));
  if (relayKeyCache?.sessionId !== session.id) relayKeyCache = { sessionId: session.id, key: deriveKey(session.id) };
  return relayKeyCache.key;
}
function relayAad(fileId, chunkIndex, totalChunks) {
  return new TextEncoder().encode(`${RELAY_ENC}|${fileId}|${chunkIndex}|${totalChunks}`);
}
async function sealRelayChunk(plain, fileId, chunkIndex, totalChunks) {
  const iv2 = crypto5.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await crypto5.subtle.encrypt(
    { name: "AES-GCM", iv: iv2, additionalData: relayAad(fileId, chunkIndex, totalChunks) },
    await relayKey(),
    plain
  ));
  const out = new Uint8Array(IV_LEN + ct.length);
  out.set(iv2);
  out.set(ct, IV_LEN);
  return Array.from(out);
}
async function openRelayChunk(p) {
  if (p.enc === void 0 || p.enc === null) {
    if (typeof p.chunk === "string") return Buffer.from(p.chunk, "base64");
    if (Array.isArray(p.chunk)) return Buffer.from(p.chunk);
    throw new Error("relay chunk is neither base64 nor a byte array");
  }
  if (p.enc !== RELAY_ENC) throw new Error(`unsupported relay encryption scheme: ${String(p.enc)}`);
  if (!Array.isArray(p.chunk)) throw new Error("sealed relay chunk is not a byte array");
  const data = Uint8Array.from(p.chunk);
  if (data.length < IV_LEN + 16) throw new Error("sealed relay chunk too short");
  try {
    return Buffer.from(await crypto5.subtle.decrypt(
      { name: "AES-GCM", iv: data.slice(0, IV_LEN), additionalData: relayAad(p.fileId, p.chunkIndex, p.totalChunks) },
      await relayKey(),
      data.slice(IV_LEN)
    ));
  } catch {
    throw new Error(`relay chunk ${p.chunkIndex} of ${p.fileId} failed authentication (wrong session key or tampered data)`);
  }
}
function getTrackers(sessionId) {
  const list = [];
  try {
    const signalerUrl = wsUrl || activeSignalerUrl;
    const trackerUrl = signalerUrl.replace(/^http/, "ws").replace(/\/(ws|v1\/stream)$/, "/v1/peers");
    if (trackerUrl) list.push(trackerUrl);
  } catch {
  }
  for (const t of (process.env.SRIFT_EXTRA_TRACKERS || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    if (/^wss?:\/\//.test(t)) list.push(t);
  }
  return list;
}
function writeStateFile() {
  const stateData = {
    session: {
      id: session.id,
      name: session.name,
      role: session.role,
      isConnected: session.isConnected,
      peerCount: session.role ? 1 : 0
      // simplified peer calculation
    },
    activeTransfers: activeTransfers.map((t) => ({
      fileId: t.fileId,
      name: t.name,
      size: t.size,
      progress: parseFloat(t.progress.toFixed(2)),
      speedKBps: parseFloat(t.speedKBps.toFixed(2)),
      etaSeconds: Math.ceil(t.etaSeconds),
      protocol: t.protocol,
      status: t.status,
      // Timestamp used to detect/prune stale entries on the next daemon
      // startup (e.g. after an unclean shutdown / crash / SIGKILL).
      startedAt: new Date(t.startTime || Date.now()).toISOString()
    })),
    lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
  };
  fs8.writeFileSync(STATE_PATH, JSON.stringify(stateData, null, 2), "utf-8");
}
function pruneStaleStateOnStartup() {
  if (!fs8.existsSync(STATE_PATH)) return;
  let prunedCount = 0;
  try {
    const raw = fs8.readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const now = Date.now();
    const lastUpdatedMs = parsed?.lastUpdated ? Date.parse(parsed.lastUpdated) : NaN;
    const sessionStale = !Number.isFinite(lastUpdatedMs) || now - lastUpdatedMs > STATE_STALE_MS;
    if (sessionStale && parsed?.session?.id) {
      prunedCount += 1;
      parsed.session = { id: null, name: null, role: null, isConnected: false, peerCount: 0 };
    }
    const transfers = Array.isArray(parsed?.activeTransfers) ? parsed.activeTransfers : [];
    const freshTransfers = transfers.filter((t) => {
      const ts = t?.startedAt ? Date.parse(t.startedAt) : NaN;
      const stale = !Number.isFinite(ts) || now - ts > STATE_STALE_MS;
      if (stale) prunedCount += 1;
      return !stale;
    });
    if (sessionStale || freshTransfers.length !== transfers.length) {
      parsed.activeTransfers = freshTransfers;
      parsed.lastUpdated = (/* @__PURE__ */ new Date()).toISOString();
      fs8.writeFileSync(STATE_PATH, JSON.stringify(parsed, null, 2), "utf-8");
    }
    if (prunedCount > 0) {
      console.log(
        `[DAEMON] Pruned ${prunedCount} stale state entr${prunedCount === 1 ? "y" : "ies"} (older than ${STATE_STALE_MS / 36e5}h, or missing a timestamp) from ${STATE_PATH}`
      );
    }
  } catch (err) {
    console.warn("[DAEMON] Stale state file was unreadable, removing it:", err?.message || err);
    try {
      fs8.unlinkSync(STATE_PATH);
    } catch {
    }
  }
}
function broadcastSSE(event, data) {
  const payload = `event: ${event}
data: ${JSON.stringify(data)}

`;
  sseClients.forEach((res) => res.write(payload));
}
function connectWebSocket(wsTargetUrl) {
  if (wsConn) {
    try {
      wsConn.close();
    } catch {
    }
  }
  csrfToken = null;
  console.log(`[DAEMON] Connecting to Signaler WS: ${wsTargetUrl}`);
  const sock = new WebSocket2(wsTargetUrl, { agent: agentFor(wsTargetUrl) });
  wsConn = sock;
  const current = () => wsConn === sock;
  sock.on("open", () => {
    if (!current()) return;
    console.log("[DAEMON] WebSocket connection open");
    session.isConnected = true;
    writeStateFile();
    broadcastSSE("connection_state", {
      sessionId: session.id,
      isConnected: true,
      signaling: "connected"
    });
    setTimeout(() => {
      if (session.role === "host") {
        wsConn?.send(JSON.stringify({
          type: "init_host",
          payload: { userId: session.userId, sessionId: session.id }
        }));
      } else if (session.role === "guest") {
        if (session.userId) {
          wsConn?.send(JSON.stringify({
            type: "init_joiner",
            payload: { userId: session.userId, sessionId: session.id }
          }));
        } else {
          const username = process.env.SRIFT_USERNAME || "CLI-Agent";
          wsConn?.send(JSON.stringify({
            type: "request_join",
            payload: { sessionId: session.id, tempUserId: session.tempUserId, username }
          }));
        }
      }
    }, 100);
    lastHeartbeatAckAt = Date.now();
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (wsConn?.readyState === WebSocket2.OPEN) {
        wsConn.send(JSON.stringify({ type: "heartbeat", payload: { ts: Date.now() } }));
      }
    }, 3e4);
  });
  sock.on("message", async (dataStr) => {
    if (!current()) return;
    try {
      const msg = JSON.parse(dataStr);
      const { type, payload } = msg;
      switch (type) {
        case "init_host_ack":
          if (payload.status === "ok") {
            csrfToken = payload.csrfToken;
            console.log("[DAEMON] Host authentication OK, CSRF Token obtained");
            reregisterPubsharesAfterReconnect().catch((e) => console.warn("[DAEMON] pubshare replay failed:", e?.message));
          }
          break;
        case "request_join_ack":
          console.log("[DAEMON] Join request received by server. Waiting for host approval...");
          break;
        case "join_approved":
          console.log("[DAEMON] Host approved join request!");
          session.userId = payload.userId;
          wsConn?.send(JSON.stringify({
            type: "init_joiner",
            payload: { userId: session.userId, sessionId: session.id }
          }));
          writeStateFile();
          break;
        case "init_joiner_ack":
          if (payload.status === "ok") {
            csrfToken = payload.csrfToken;
            console.log("[DAEMON] Approved joiner authentication OK");
          }
          break;
        case "heartbeat_ack":
          lastHeartbeatAckAt = Date.now();
          break;
        case "user_list": {
          const users = Array.isArray(payload?.users) ? payload.users : [];
          participants = users.map((u) => ({ userId: String(u.id), username: String(u.username || ""), isHost: !!u.is_host, online: !!u.isOnline }));
          broadcastSSE("participants", { participants });
          if (payload?.messageId) {
            try {
              sock.send(JSON.stringify({ type: "user_list_ack", payload: { messageId: payload.messageId } }));
            } catch {
            }
          }
          break;
        }
        case "kicked_from_session":
          console.log(`[DAEMON] Kicked from session: ${payload?.reason || ""}`);
          sessionTerminated = true;
          terminationReason = payload?.reason || "You were removed from the session by the host";
          session.isConnected = false;
          session.userId = null;
          csrfToken = null;
          pendingJoins = [];
          participants = [];
          writeStateFile();
          broadcastSSE("session_terminated", { reason: terminationReason });
          break;
        case "session_deleted":
          console.log(`[DAEMON] Session deleted by host: ${payload.reason || ""}`);
          sessionTerminated = true;
          terminationReason = payload.message || "Session was deleted by the host";
          session = { id: null, name: null, role: null, isConnected: false, userId: null };
          activeTransfers = [];
          pendingJoins = [];
          participants = [];
          encryptionKey = null;
          writeStateFile();
          broadcastSSE("session_terminated", { reason: terminationReason });
          try {
            if (wsConn) wsConn.close();
          } catch {
          }
          break;
        case "error":
          console.error(`[DAEMON] Server error: ${payload.msg} (severity=${payload.severity || "recoverable"})`);
          if (payload.severity === "critical") {
            sessionTerminated = true;
            terminationReason = payload.msg || "Connection terminated by host";
            session.isConnected = false;
            session.userId = null;
            pendingJoins = [];
            participants = [];
            writeStateFile();
            broadcastSSE("session_terminated", { reason: terminationReason });
          }
          break;
        case "join_request":
          console.log(`[DAEMON] Peer join request: tempUserId=${payload.tempUserId}, username=${payload.username}`);
          pendingJoins.push({ tempUserId: payload.tempUserId, username: payload.username });
          broadcastSSE("join_request", payload);
          break;
        case "chat":
          try {
            const decContent = await decrypt(payload.content);
            const chatMsg = {
              messageId: payload.messageId || uuidv4(),
              sender: payload.username || "Peer",
              content: decContent,
              timestamp: payload.timestamp || (/* @__PURE__ */ new Date()).toISOString()
            };
            chatHistory.push(chatMsg);
            broadcastSSE("chat_received", chatMsg);
            console.log(`[DAEMON] Chat from ${chatMsg.sender} (${String(chatMsg.content ?? "").length} chars)`);
          } catch (decErr) {
            console.error("[DAEMON] Decryption failed for chat message:", decErr);
          }
          break;
        case "file_offer":
          console.log(`[DAEMON] File offer received: ${payload.filename} (${payload.size} bytes)`);
          const newTx = {
            fileId: payload.fileId,
            name: payload.filename,
            size: payload.size,
            progress: 0,
            speedKBps: 0,
            etaSeconds: 0,
            protocol: payload.transferType === "webtorrent" ? "webtorrent" : "websocket",
            status: "pending",
            direction: "download",
            bytesTransferred: 0,
            chunksCount: 0,
            totalChunks: 0,
            startTime: Date.now()
          };
          activeTransfers.push(newTx);
          writeStateFile();
          broadcastSSE("file_offer", {
            fileId: payload.fileId,
            filename: payload.filename,
            size: payload.size,
            from: payload.from,
            protocol: newTx.protocol
          });
          break;
        case "file_accept":
          console.log(`[DAEMON] File offer accepted by peer! ID: ${payload.fileId}`);
          {
            const acceptedTx = activeTransfers.find((t) => t.fileId === payload.fileId);
            if (acceptedTx) acceptedTx.peerRelayEnc = payload.relayEnc === RELAY_ENC ? RELAY_ENC : void 0;
          }
          startUpload(payload.fileId, payload.userId);
          break;
        case "webtorrent_info_hash":
          handleWebTorrentInfoHash(payload);
          break;
        case "file_chunk":
          handleIncomingChunk(payload).catch((e) => {
            console.error(`[DAEMON] Relay chunk rejected: ${e?.message || e}`);
            const bad = activeTransfers.find((t) => t.fileId === payload?.fileId);
            if (bad) {
              bad.status = "error";
              writeStateFile();
            }
            try {
              sock.send(JSON.stringify({ type: "file_cancel_by_receiver", payload: { fileId: payload?.fileId } }));
            } catch {
            }
          });
          break;
        case "file_cancelled_by_receiver":
        case "file_cancelled_by_sender":
        case "file_cancelled_all": {
          const gone = activeTransfers.find((t) => t.fileId === payload?.fileId);
          activeUploads.delete(payload?.fileId);
          if (gone && gone.status !== "completed") {
            gone.status = "cancelled";
            writeStateFile();
            broadcastSSE("transfer_progress", { fileId: gone.fileId, fileName: gone.name, size: gone.size, bytesTransferred: gone.bytesTransferred, progress: gone.progress, status: "cancelled" });
          }
          break;
        }
        case "file_chunk_ack":
          handleChunkAck(payload);
          break;
        case "file_complete":
          handleFileComplete(payload);
          break;
        case "pubshare_register_ack": {
          const entry = pubshares.get(payload.fileId);
          if (entry) {
            entry.token = payload.token;
            entry.downloadUrl = payload.downloadUrl;
            if (typeof payload.claim === "string") entry.claim = payload.claim;
            pubsharesByToken.set(payload.token, entry);
            const resolver = pubshareRegResolvers.get(payload.fileId);
            if (resolver) {
              pubshareRegResolvers.delete(payload.fileId);
              resolver(entry);
            }
            console.log(`[DAEMON] pubshare registered: ${entry.filename} -> ${entry.downloadUrl}`);
          }
          break;
        }
        case "pubshare_pull": {
          handlePubsharePull(payload).catch((err) => {
            console.error("[DAEMON] pubshare_pull failed:", err);
            try {
              wsConn?.send(JSON.stringify({
                type: "pubshare_end",
                payload: { requestId: payload.requestId, ok: false, error: String(err?.message || err) }
              }));
            } catch {
            }
          });
          break;
        }
        case "pubshare_cancel": {
          const a = activePulls.get(payload.requestId);
          if (a) a.cancelled = true;
          break;
        }
      }
    } catch (err) {
      console.error("[DAEMON] Error processing WS message:", err);
    }
  });
  sock.on("close", () => {
    if (!current()) return;
    console.log("[DAEMON] WebSocket connection closed");
    session.isConnected = false;
    csrfToken = null;
    writeStateFile();
    broadcastSSE("connection_state", {
      sessionId: session.id,
      isConnected: false,
      signaling: "disconnected"
    });
    if (sessionTerminated) {
      console.log(`[DAEMON] Not reconnecting \u2014 session terminated: ${terminationReason}`);
      return;
    }
    setTimeout(() => {
      if (session.id && wsTargetUrl && !sessionTerminated) {
        connectWebSocket(wsTargetUrl);
      }
    }, 3e3);
  });
  sock.on("error", (err) => {
    if (!current()) return;
    console.error("[DAEMON] WebSocket error:", err);
  });
}
function startUpload(fileId, targetUserId) {
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;
  if (tx.protocol === "webtorrent") {
    startWebTorrentUpload(fileId, targetUserId);
  } else {
    startWebSocketUpload(fileId, targetUserId);
  }
}
async function startWebTorrentUpload(fileId, targetUserId) {
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx || !tx.filePath) return;
  console.log(`[DAEMON] Starting WebTorrent seeding for ${tx.name}...`);
  tx.status = "uploading";
  tx.startTime = Date.now();
  writeStateFile();
  let client;
  try {
    client = await getWtClient();
  } catch (err) {
    console.error(`[DAEMON] WebTorrent unavailable, falling back to WebSocket for ${tx.name}: ${err?.message}`);
    tx.protocol = "websocket";
    writeStateFile();
    return;
  }
  const trackers = getTrackers(session.id || "");
  client.seed(tx.filePath, { announce: trackers }, (torrent) => {
    console.log(`[DAEMON] WebTorrent seeding active. Info Hash: ${torrent.infoHash}`);
    activeTorrents.set(fileId, torrent);
    wsConn?.send(JSON.stringify({
      type: "webtorrent_info_hash",
      payload: {
        fileId,
        infoHash: torrent.infoHash,
        fileName: tx.name,
        fileSize: tx.size,
        targetUserId
      }
    }));
    torrent.on("upload", () => {
      tx.bytesTransferred = torrent.uploaded;
      tx.progress = Math.min(99.9, torrent.uploaded / tx.size * 100);
      tx.speedKBps = torrent.uploadSpeed / 1024;
      writeStateFile();
      broadcastSSE("transfer_progress", {
        fileId,
        fileName: tx.name,
        size: tx.size,
        bytesTransferred: torrent.uploaded,
        progress: tx.progress,
        speedBytesPerSecond: torrent.uploadSpeed,
        timeRemainingSeconds: -1,
        status: "uploading"
      });
    });
  });
}
async function handleWebTorrentInfoHash(payload) {
  const { fileId, infoHash, fileName, fileSize, senderId } = payload;
  console.log(`[DAEMON] Received WebTorrent info hash: ${infoHash} for file: ${fileName}`);
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;
  tx.protocol = "webtorrent";
  tx.status = "downloading";
  tx.peerId = senderId;
  tx.startTime = Date.now();
  writeStateFile();
  let client;
  try {
    client = await getWtClient();
  } catch (err) {
    console.error(`[DAEMON] WebTorrent unavailable for download of ${fileName}: ${err?.message}. Ask the sender to retry with --protocol websocket.`);
    tx.status = "error";
    writeStateFile();
    broadcastSSE("transfer_progress", {
      fileId,
      fileName: tx.name,
      size: tx.size,
      bytesTransferred: 0,
      progress: 0,
      speedBytesPerSecond: 0,
      timeRemainingSeconds: -1,
      status: "error"
    });
    return;
  }
  const trackers = getTrackers(session.id || "");
  const downloadDir = tx.saveDir || process.cwd();
  client.add(infoHash, { announce: trackers, path: downloadDir }, (torrent) => {
    console.log(`[DAEMON] WebTorrent download started: ${torrent.name}`);
    activeTorrents.set(fileId, torrent);
    torrent.on("download", () => {
      tx.bytesTransferred = torrent.downloaded;
      tx.progress = torrent.progress * 100;
      tx.speedKBps = torrent.downloadSpeed / 1024;
      tx.etaSeconds = torrent.timeRemaining / 1e3;
      writeStateFile();
      broadcastSSE("transfer_progress", {
        fileId,
        fileName: tx.name,
        size: tx.size,
        bytesTransferred: torrent.downloaded,
        progress: tx.progress,
        speedBytesPerSecond: torrent.downloadSpeed,
        timeRemainingSeconds: tx.etaSeconds,
        status: "downloading"
      });
    });
    torrent.on("done", () => {
      console.log(`[DAEMON] WebTorrent download finished: ${tx.name}`);
      tx.status = "completed";
      tx.progress = 100;
      tx.speedKBps = 0;
      tx.etaSeconds = 0;
      writeStateFile();
      broadcastSSE("transfer_progress", {
        fileId,
        fileName: tx.name,
        size: tx.size,
        bytesTransferred: tx.size,
        progress: 100,
        speedBytesPerSecond: 0,
        timeRemainingSeconds: 0,
        status: "completed"
      });
      torrent.destroy();
      activeTorrents.delete(fileId);
    });
  });
}
async function startWebSocketUpload(fileId, targetUserId) {
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx || !tx.filePath) return;
  const chunkSize = 64 * 1024;
  const stat = fs8.statSync(tx.filePath);
  const totalChunks = Math.max(1, Math.ceil(stat.size / chunkSize));
  tx.status = "uploading";
  tx.startTime = Date.now();
  tx.totalChunks = totalChunks;
  writeStateFile();
  activeUploads.set(fileId, {
    filePath: tx.filePath,
    totalChunks,
    chunkSize,
    targetUserId,
    currentChunk: 0,
    bytesSent: 0,
    startTime: Date.now()
  });
  sendNextChunk(fileId);
}
function sendNextChunk(fileId) {
  sendNextChunkAsync(fileId).catch((e) => {
    console.error(`[DAEMON] Relay upload failed for ${fileId}: ${e?.message || e}`);
    activeUploads.delete(fileId);
    const failed = activeTransfers.find((t) => t.fileId === fileId);
    if (failed) {
      failed.status = "error";
      writeStateFile();
    }
  });
}
async function sendNextChunkAsync(fileId) {
  const upload = activeUploads.get(fileId);
  if (!upload) return;
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;
  if (upload.currentChunk >= upload.totalChunks) {
    wsConn?.send(JSON.stringify({
      type: "file_complete",
      payload: { fileId, targetUserId: upload.targetUserId }
    }));
    tx.status = "completed";
    tx.progress = 100;
    tx.speedKBps = 0;
    tx.etaSeconds = 0;
    writeStateFile();
    activeUploads.delete(fileId);
    console.log(`[DAEMON] File upload complete: ${tx.name}`);
    return;
  }
  const start = upload.currentChunk * upload.chunkSize;
  const stat = fs8.statSync(upload.filePath);
  const end = Math.min(start + upload.chunkSize, stat.size);
  const buffer = Buffer.alloc(end - start);
  const fd = fs8.openSync(upload.filePath, "r");
  fs8.readSync(fd, buffer, 0, end - start, start);
  fs8.closeSync(fd);
  const frame = tx.peerRelayEnc === RELAY_ENC ? { chunk: await sealRelayChunk(buffer, fileId, upload.currentChunk, upload.totalChunks), enc: RELAY_ENC } : { chunk: buffer.toString("base64") };
  wsConn?.send(JSON.stringify({
    type: "file_chunk",
    payload: {
      fileId,
      ...frame,
      chunkIndex: upload.currentChunk,
      totalChunks: upload.totalChunks,
      targetUserId: upload.targetUserId
    }
  }));
  tx.bytesTransferred = end;
  tx.progress = end / stat.size * 100;
  const elapsed = (Date.now() - upload.startTime) / 1e3;
  if (elapsed > 0) {
    tx.speedKBps = end / 1024 / elapsed;
    tx.etaSeconds = (stat.size - end) / (tx.speedKBps * 1024);
  }
  writeStateFile();
  broadcastSSE("transfer_progress", {
    fileId,
    fileName: tx.name,
    size: tx.size,
    bytesTransferred: end,
    progress: tx.progress,
    speedBytesPerSecond: tx.speedKBps * 1024,
    timeRemainingSeconds: tx.etaSeconds,
    status: "uploading"
  });
}
function handleChunkAck(payload) {
  const { fileId, chunkIndex } = payload;
  const upload = activeUploads.get(fileId);
  if (!upload) return;
  if (upload.currentChunk === chunkIndex) {
    upload.currentChunk++;
    sendNextChunk(fileId);
  }
}
async function handleIncomingChunk(payload) {
  const { fileId, chunkIndex, totalChunks, from } = payload;
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;
  const mode = payload.enc === void 0 || payload.enc === null ? "plain" : "sealed";
  if (tx.relayMode && tx.relayMode !== mode) throw new Error(`transfer ${fileId} mixed sealed and plaintext chunks`);
  tx.relayMode = mode;
  const chunkBuffer = await openRelayChunk(payload);
  tx.status = "downloading";
  tx.totalChunks = totalChunks;
  tx.peerId = from;
  tx.bytesTransferred += chunkBuffer.length;
  tx.chunksCount++;
  const chunkPath = path7.join(TEMP_DIR, `${fileId}_chunk_${chunkIndex}`);
  fs8.writeFileSync(chunkPath, chunkBuffer);
  tx.progress = tx.bytesTransferred / tx.size * 100;
  const elapsed = (Date.now() - tx.startTime) / 1e3;
  if (elapsed > 0) {
    tx.speedKBps = tx.bytesTransferred / 1024 / elapsed;
    tx.etaSeconds = (tx.size - tx.bytesTransferred) / (tx.speedKBps * 1024);
  }
  writeStateFile();
  broadcastSSE("transfer_progress", {
    fileId,
    fileName: tx.name,
    size: tx.size,
    bytesTransferred: tx.bytesTransferred,
    progress: tx.progress,
    speedBytesPerSecond: tx.speedKBps * 1024,
    timeRemainingSeconds: tx.etaSeconds,
    status: "downloading"
  });
  wsConn?.send(JSON.stringify({
    type: "file_chunk_ack",
    payload: { fileId, chunkIndex, status: "received" }
  }));
}
function handleFileComplete(payload) {
  const { fileId } = payload;
  const tx = activeTransfers.find((t) => t.fileId === fileId);
  if (!tx) return;
  const destDir = tx.saveDir || process.cwd();
  const destPath = path7.join(destDir, tx.name);
  try {
    if (!fs8.existsSync(destDir)) {
      fs8.mkdirSync(destDir, { recursive: true });
    }
  } catch (err) {
    console.error(`[DAEMON] Failed to create destination directory ${destDir}:`, err);
    tx.status = "error";
    writeStateFile();
    return;
  }
  const writeStream = fs8.createWriteStream(destPath);
  writeStream.on("error", (err) => {
    console.error(`[DAEMON] Write stream error for ${destPath}:`, err);
    tx.status = "error";
    writeStateFile();
    broadcastSSE("transfer_progress", {
      fileId,
      fileName: tx.name,
      size: tx.size,
      bytesTransferred: tx.bytesTransferred,
      progress: tx.progress,
      speedBytesPerSecond: 0,
      timeRemainingSeconds: 0,
      status: "error"
    });
  });
  writeStream.on("finish", () => {
    console.log(`[DAEMON] File successfully downloaded and assembled: ${destPath}`);
    tx.status = "completed";
    tx.progress = 100;
    tx.speedKBps = 0;
    tx.etaSeconds = 0;
    writeStateFile();
    broadcastSSE("transfer_progress", {
      fileId,
      fileName: tx.name,
      size: tx.size,
      bytesTransferred: tx.size,
      progress: 100,
      speedBytesPerSecond: 0,
      timeRemainingSeconds: 0,
      status: "completed"
    });
  });
  for (let i = 0; i < tx.totalChunks; i++) {
    const chunkPath = path7.join(TEMP_DIR, `${fileId}_chunk_${i}`);
    if (fs8.existsSync(chunkPath)) {
      try {
        const chunkBuf = fs8.readFileSync(chunkPath);
        writeStream.write(chunkBuf);
        fs8.unlinkSync(chunkPath);
      } catch (err) {
        console.error(`[DAEMON] Error reading/writing chunk ${i}:`, err);
        writeStream.emit("error", err);
        return;
      }
    }
  }
  writeStream.end();
}
async function waitSignalReady(maxMs = 8e3) {
  if (!session.id) return { status: 409, body: { success: false, error: "No active session. Call /session/start first." } };
  if (sessionTerminated) return { status: 410, body: { success: false, error: terminationReason || "The session ended." } };
  if (session.role === "guest" && !session.userId) {
    return { status: 409, body: { success: false, error: "Waiting for the host to approve your join request.", retryAfterMs: 2e3 } };
  }
  const ready = () => !!encryptionKey && !!csrfToken && wsConn?.readyState === WebSocket2.OPEN;
  for (let waited = 0; waited < maxMs && !ready() && session.id; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (ready()) return null;
  if (!encryptionKey) return { status: 409, body: { success: false, error: "Encryption key not ready. Session still initialising." } };
  return { status: 503, body: { success: false, error: "Signaling connection not ready (WebSocket is connecting). Retry in 1\u20132 seconds.", retryAfterMs: 1500 } };
}
async function registerPubshare(fileId, absPath, filename, size, mime, opts = {}, timeoutMs = 5e3) {
  if (!wsConn || wsConn.readyState !== WebSocket2.OPEN) {
    throw new Error("Signaling WebSocket not connected");
  }
  const maxDownloads = Math.max(0, Math.floor(opts.maxDownloads || 0));
  const expiresAt = opts.ttlMs && opts.ttlMs > 0 ? Date.now() + opts.ttlMs : null;
  const entry = {
    token: opts.preferToken || null,
    filePath: absPath,
    filename,
    size,
    mime,
    fileId,
    downloadUrl: null,
    maxDownloads,
    expiresAt,
    downloadCount: 0,
    createdAt: Date.now(),
    encrypted: !!opts.encrypted,
    linkKey: opts.linkKey,
    tempFile: opts.tempFile,
    displayName: opts.displayName || filename,
    prefixLen: opts.prefixLen,
    claim: opts.preferClaim
  };
  pubshares.set(fileId, entry);
  const ackP = new Promise((resolve, reject) => {
    pubshareRegResolvers.set(fileId, resolve);
    setTimeout(() => {
      if (pubshareRegResolvers.has(fileId)) {
        pubshareRegResolvers.delete(fileId);
        pubshares.delete(fileId);
        reject(new Error(
          "Signaler does not recognise pubshare_register \u2014 likely running an older server build. Until srift.app picks up the new release, the recipient must join the session in a browser."
        ));
      }
    }, timeoutMs);
  });
  wsConn.send(JSON.stringify({
    type: "pubshare_register",
    payload: {
      fileId,
      filename,
      size,
      mime,
      maxDownloads,
      expiresAt,
      preferToken: opts.preferToken || void 0,
      preferClaim: opts.preferToken && opts.preferClaim ? opts.preferClaim : void 0,
      encrypted: opts.encrypted ? true : void 0,
      prefixLen: opts.encrypted && opts.prefixLen ? opts.prefixLen : void 0
    }
  }));
  return ackP;
}
async function reregisterPubsharesAfterReconnect() {
  if (!pubshares.size) return;
  console.log(`[DAEMON] Re-registering ${pubshares.size} pubshare(s) after WS reconnect\u2026`);
  for (const entry of Array.from(pubshares.values())) {
    if (!entry.token) continue;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      pubshares.delete(entry.fileId);
      pubsharesByToken.delete(entry.token);
      if (entry.tempFile) {
        try {
          fs8.unlinkSync(entry.tempFile);
        } catch {
        }
      }
      continue;
    }
    if (entry.maxDownloads && entry.downloadCount >= entry.maxDownloads) {
      pubshares.delete(entry.fileId);
      pubsharesByToken.delete(entry.token);
      if (entry.tempFile) {
        try {
          fs8.unlinkSync(entry.tempFile);
        } catch {
        }
      }
      continue;
    }
    try {
      const remainingTtl = entry.expiresAt ? Math.max(0, entry.expiresAt - Date.now()) : 0;
      const remainingMax = entry.maxDownloads ? Math.max(1, entry.maxDownloads - entry.downloadCount) : 0;
      await registerPubshare(
        entry.fileId,
        entry.filePath,
        entry.filename,
        entry.size,
        entry.mime,
        {
          maxDownloads: remainingMax,
          ttlMs: remainingTtl,
          preferToken: entry.token,
          preferClaim: entry.claim,
          encrypted: entry.encrypted,
          linkKey: entry.linkKey,
          tempFile: entry.tempFile,
          displayName: entry.displayName,
          prefixLen: entry.prefixLen
        }
      );
    } catch (e) {
      console.warn(`[DAEMON] Failed to re-register pubshare ${entry.fileId}: ${e?.message}`);
    }
  }
}
async function handlePubsharePull(payload) {
  const { requestId, token, start, end, isFullDownload } = payload || {};
  if (!requestId || !token) return;
  const entry = pubsharesByToken.get(token);
  if (!entry) {
    wsConn?.send(JSON.stringify({
      type: "pubshare_end",
      payload: { requestId, ok: false, error: "unknown token" }
    }));
    return;
  }
  let fd;
  try {
    fd = fs8.openSync(entry.filePath, "r");
  } catch (e) {
    throw new Error(e?.code === "ENOENT" ? "the shared file no longer exists on the sender" : `cannot read the shared file (${e?.code || e?.message})`);
  }
  try {
    const size = fs8.fstatSync(fd).size;
    if (size !== entry.size) throw new Error("the shared file changed after the link was created");
  } catch (e) {
    try {
      fs8.closeSync(fd);
    } catch {
    }
    throw e;
  }
  if (isFullDownload && entry.maxDownloads) entry.downloadCount++;
  const cancelFlag = { cancelled: false, token };
  activePulls.set(requestId, cancelFlag);
  const CHUNK = 64 * 1024;
  let pos = start;
  let seq = 0;
  let completedOk = false;
  try {
    while (pos <= end) {
      if (cancelFlag.cancelled) break;
      if (!wsConn || wsConn.readyState !== WebSocket2.OPEN) {
        throw new Error("Signaling WebSocket disconnected mid-stream");
      }
      const len = Math.min(CHUNK, end - pos + 1);
      const buf = Buffer.alloc(len);
      const got = fs8.readSync(fd, buf, 0, len, pos);
      if (got !== len) throw new Error("the shared file changed while it was being sent");
      const dataB64 = buf.toString("base64");
      wsConn.send(JSON.stringify({
        type: "pubshare_chunk",
        payload: { requestId, seq, dataB64 }
      }));
      pos += len;
      seq++;
      if (wsConn.bufferedAmount > 8 * 1024 * 1024) {
        await new Promise((r) => setTimeout(r, 20));
      } else if (seq % 8 === 0) {
        await new Promise((r) => setImmediate(r));
      }
    }
    if (!cancelFlag.cancelled) {
      wsConn?.send(JSON.stringify({
        type: "pubshare_end",
        payload: { requestId, ok: true }
      }));
      completedOk = true;
    }
  } finally {
    try {
      fs8.closeSync(fd);
    } catch {
    }
    activePulls.delete(requestId);
  }
  if (completedOk && isFullDownload) {
    entry.completedDownloads = (entry.completedDownloads || 0) + 1;
    if (!entry.maxDownloads) entry.downloadCount++;
    broadcastSSE("pubshare_download", {
      token: entry.token,
      fileId: entry.fileId,
      filename: entry.filename,
      downloadCount: entry.downloadCount,
      maxDownloads: entry.maxDownloads
    });
    if (entry.maxDownloads && entry.downloadCount >= entry.maxDownloads) {
      console.log(`[DAEMON] pubshare exhausted (max ${entry.maxDownloads} reached): ${entry.filename}`);
    }
  }
}
function linkWithKey(url, key) {
  return url && key ? `${url}#k=${key}` : url;
}
async function ensureHostSession(sessionName) {
  if (hostSessionInflight) return hostSessionInflight;
  hostSessionInflight = ensureHostSessionOnce(sessionName).finally(() => {
    hostSessionInflight = null;
  });
  return hostSessionInflight;
}
async function ensureHostSessionOnce(sessionName) {
  if (!session.id || sessionTerminated) {
    const data = await signalerPost("/create-session", { username: "AI-Agent", name: sessionName || "AI-QuickShare" });
    sessionTerminated = false;
    terminationReason = null;
    session = {
      id: data.sessionId,
      name: data.name,
      role: "host",
      isConnected: false,
      userId: data.userId,
      wsToken: data.wsToken,
      roomSecret: null
    };
    encryptionKey = await deriveKey(data.sessionId);
    wsUrl = data.wsUrl || `${activeSignalerUrl.replace(/^http/, "ws")}/ws`;
    if (wsUrl) connectWebSocket(wsUrl);
    writeStateFile();
  }
  await waitForHostAuth(8e3);
}
async function shareViaRelay(absPath, stat, reqBody, encrypt2) {
  await ensureHostSession(reqBody.sessionName);
  const filename = reqBody.name || path7.basename(absPath);
  const fileId = `cli_file_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  let servePath = absPath;
  let serveSize = stat.size;
  let linkKey;
  let tempFile;
  let prefixLen;
  if (encrypt2) {
    const key = newLinkKey();
    linkKey = b64url(key);
    tempFile = path7.join(TEMP_DIR, `${fileId}.sre1`);
    const meta = { name: filename, size: stat.size, mime: "application/octet-stream" };
    const fd = fs8.openSync(tempFile, "w", 384);
    try {
      for await (const part of encryptFile(absPath, key, meta, { password: reqBody.password })) fs8.writeSync(fd, part);
    } finally {
      fs8.closeSync(fd);
    }
    servePath = tempFile;
    serveSize = encryptedSize(stat.size, meta);
    prefixLen = 36 + 4 + Buffer.byteLength(JSON.stringify(meta)) + 16;
  } else {
    const targetProtocol = webTorrentAllowed() && stat.size > 10 * 1024 * 1024 ? "webtorrent" : "websocket";
    activeTransfers.push({
      fileId,
      name: filename,
      size: stat.size,
      progress: 0,
      speedKBps: 0,
      etaSeconds: 0,
      protocol: targetProtocol,
      status: "pending",
      direction: "upload",
      filePath: absPath,
      bytesTransferred: 0,
      chunksCount: 0,
      totalChunks: 0,
      startTime: Date.now()
    });
    writeStateFile();
    wsConn?.send(JSON.stringify({
      type: "file_offer",
      payload: { fileId, filename, size: stat.size, mime: "application/octet-stream", transferType: targetProtocol, csrfToken }
    }));
  }
  if (reqBody._ownedPath) {
    if (encrypt2) {
      try {
        fs8.unlinkSync(reqBody._ownedPath);
      } catch {
      }
    } else tempFile = reqBody._ownedPath;
  }
  try {
    const entry = await registerPubshare(
      fileId,
      servePath,
      encrypt2 ? "encrypted.srift" : filename,
      serveSize,
      "application/octet-stream",
      {
        maxDownloads: typeof reqBody.maxDownloads === "number" ? reqBody.maxDownloads : 0,
        ttlMs: typeof reqBody.ttlMs === "number" ? reqBody.ttlMs : 0,
        encrypted: encrypt2,
        linkKey,
        tempFile,
        displayName: filename,
        prefixLen
      }
    );
    return {
      success: true,
      mode: "relay",
      sessionId: session.id,
      fileId,
      token: entry.token || "",
      downloadUrl: linkWithKey(entry.downloadUrl, linkKey) || "",
      fileName: filename,
      fileSize: stat.size,
      maxDownloads: entry.maxDownloads,
      expiresAt: entry.expiresAt,
      encrypted: encrypt2,
      passwordProtected: !!reqBody.password
    };
  } catch (e) {
    if (tempFile) {
      try {
        fs8.unlinkSync(tempFile);
      } catch {
      }
    }
    throw e;
  }
}
function publicShareBody(body) {
  const out = { ...body && typeof body === "object" ? body : {} };
  for (const k of Object.keys(out)) if (k.startsWith("_")) delete out[k];
  return out;
}
function shareEncrypt(reqBody) {
  return reqBody.password ? true : reqBody.encrypt === true;
}
function assertRelayMode(reqBody) {
  const requested = reqBody.mode || "relay";
  if (requested !== "relay" && requested !== "auto") {
    throw Object.assign(new Error(`Unsupported mode "${requested}": SRIFT does not store files on a server; links are relay links served by this daemon.`), { status: 400 });
  }
}
function excludesFor(reqBody) {
  const extra = Array.isArray(reqBody.exclude) ? reqBody.exclude.filter((x) => typeof x === "string" && x.trim()) : [];
  return [...DEFAULT_EXCLUDES, ...extra];
}
function safeArchiveBase(name, fallback) {
  const base = String(name || "").replace(/\.tar\.gz$|\.tgz$/i, "").replace(/[^\w.\- ()]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 120);
  return base || fallback;
}
async function createShare(reqBody) {
  if (!reqBody?.filePath) throw Object.assign(new Error("filePath (or filePaths) required"), { status: 400 });
  assertRelayMode(reqBody);
  const absPath = path7.resolve(reqBody.filePath);
  let stat;
  try {
    stat = fs8.statSync(absPath);
  } catch {
    throw Object.assign(new Error(`File not found: ${absPath}`), { status: 404 });
  }
  if (stat.isDirectory()) {
    const base = safeArchiveBase(path7.basename(absPath), "folder");
    const out = path7.join(TEMP_DIR, `${uuidv4()}-${base}.tar.gz`);
    try {
      await packDirectory(absPath, out, excludesFor(reqBody));
    } catch (e) {
      try {
        fs8.unlinkSync(out);
      } catch {
      }
      throw Object.assign(new Error(e?.message || String(e)), { status: 400 });
    }
    return shareViaRelay(out, fs8.statSync(out), { ...reqBody, name: reqBody.name || `${base}.tar.gz`, _ownedPath: out }, shareEncrypt(reqBody));
  }
  if (!stat.isFile()) throw Object.assign(new Error(`Not a regular file or folder: ${absPath}`), { status: 400 });
  return shareViaRelay(absPath, stat, reqBody, shareEncrypt(reqBody));
}
async function createMultiShare(reqBody) {
  assertRelayMode(reqBody);
  const raw = Array.isArray(reqBody.filePaths) ? reqBody.filePaths : [];
  const paths = Array.from(new Set(raw.filter((p) => typeof p === "string" && p.trim()).map((p) => path7.resolve(p))));
  if (!paths.length) throw Object.assign(new Error("filePaths must be a non-empty array of paths"), { status: 400 });
  if (paths.length > MAX_MULTI_PATHS) throw Object.assign(new Error(`Too many paths (${paths.length}); max ${MAX_MULTI_PATHS}. Share a folder instead.`), { status: 400 });
  const missing = paths.filter((p) => !fs8.existsSync(p));
  const bundle = reqBody.bundle !== false;
  if (bundle) {
    const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const base = safeArchiveBase(reqBody.bundleName, `srift-${paths.length}-items-${stamp}`);
    const out = path7.join(TEMP_DIR, `${uuidv4()}-${base}.tar.gz`);
    let packed;
    try {
      packed = await packPaths(paths, out, base, excludesFor(reqBody));
    } catch (e) {
      try {
        fs8.unlinkSync(out);
      } catch {
      }
      throw Object.assign(new Error(e?.message || String(e)), { status: 400 });
    }
    const r = await shareViaRelay(out, fs8.statSync(out), { ...reqBody, name: `${base}.tar.gz`, _ownedPath: out }, shareEncrypt(reqBody));
    if (packed.skipped.length) console.warn(`[DAEMON] bundle skipped ${packed.skipped.length} item(s): ${packed.skipped.map((x) => x.path).join(", ")}`);
    return { ...r, bundle: true, files: packed.files, bytes: packed.bytes, paths: paths.length, skipped: packed.skipped };
  }
  await ensureHostSession(reqBody.sessionName);
  const links = [];
  const errors = missing.map((p) => ({ filePath: p, error: "File not found" }));
  const todo = paths.filter((p) => !missing.includes(p));
  const results = await mapLimit(todo, MULTI_CONCURRENCY, async (p) => {
    try {
      return { p, r: await createShare({ ...reqBody, filePaths: void 0, filePath: p, name: void 0 }) };
    } catch (e) {
      return { p, e: e?.message || String(e) };
    }
  });
  for (const x of results) {
    if ("r" in x && x.r) links.push({ ...x.r, filePath: x.p });
    else errors.push({ filePath: x.p, error: x.e });
  }
  return { success: links.length > 0, mode: "relay", bundle: false, links, errors };
}
function embeddedDispatch(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === void 0 ? "" : JSON.stringify(body);
    const sock = new Duplex({ read() {
    }, write(_c, _e, cb) {
      cb();
    } });
    const req = new http4.IncomingMessage(sock);
    req.method = method;
    req.url = pathname;
    req.headers = { host: `127.0.0.1:${PORT}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) };
    const res = new http4.ServerResponse(req);
    const chunks = [];
    const add = (c, enc) => {
      if (c !== void 0 && c !== null && typeof c !== "function") chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), typeof enc === "string" ? enc : "utf8"));
    };
    res.write = (c, enc, cb) => {
      add(c, enc);
      if (typeof enc === "function") enc();
      else if (typeof cb === "function") cb();
      return true;
    };
    res.end = (c, enc, cb) => {
      add(c, enc);
      const text = Buffer.concat(chunks).toString("utf8");
      let data = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
      }
      resolve({ status: res.statusCode, data });
      res.emit("finish");
      if (typeof enc === "function") enc();
      else if (typeof cb === "function") cb();
      return res;
    };
    try {
      app.handle(req, res, (err) => {
        if (err) reject(err);
        else resolve({ status: 404, data: { success: false, error: `No route: ${method} ${pathname}` } });
      });
      if (payload) req.push(payload);
      req.push(null);
    } catch (e) {
      reject(e);
    }
  });
}
var _WebTorrentCtor, _webTorrentLoadError, SRIFT_HOME, EMBEDDED, STATE_PATH, logPath, logStream, logMessage, fmtLogArg, crypto5, PORT, DEFAULT_SIGNALER_URL, activeSignalerUrl, lastDiag, session, activeTransfers, chatHistory, pendingJoins, participants, sseClients, wsConn, wsUrl, csrfToken, heartbeatInterval, lastHeartbeatAckAt, encryptionKey, sessionTerminated, terminationReason, activeTorrents, wtClient, pubshares, pubsharesByToken, activePulls, pubshareRegResolvers, TEMP_DIR, KDF_ITERATIONS, IV_LEN, RELAY_ENC, relayKeyCache, STATE_STALE_MS, activeUploads, app, LOCAL_HOSTS, DAEMON_START_TIME, PACKAGE_VERSION, hostSessionInflight, MAX_MULTI_PATHS, MULTI_CONCURRENCY, embeddedReady, httpServer;
var init_daemon = __esm({
  "cli/daemon.ts"() {
    init_mcp();
    init_core();
    init_net();
    init_probe();
    init_e2ee();
    init_pack();
    _WebTorrentCtor = null;
    _webTorrentLoadError = null;
    SRIFT_HOME = path7.join(os4.homedir(), ".srift");
    try {
      fs8.mkdirSync(SRIFT_HOME, { recursive: true, mode: 448 });
      try {
        fs8.chmodSync(SRIFT_HOME, 448);
      } catch {
      }
    } catch (e) {
    }
    EMBEDDED = process.env.SRIFT_DAEMON_EMBEDDED === "1";
    STATE_PATH = path7.join(SRIFT_HOME, EMBEDDED ? "state-embedded.json" : "state.json");
    logPath = path7.join(SRIFT_HOME, "daemon.log");
    try {
      if (fs8.statSync(logPath).size > 5 * 1024 * 1024) fs8.renameSync(logPath, `${logPath}.1`);
    } catch {
    }
    logStream = fs8.createWriteStream(logPath, { flags: "a", mode: 384 });
    try {
      fs8.chmodSync(logPath, 384);
    } catch {
    }
    logMessage = (level, message) => {
      logStream.write(`[${(/* @__PURE__ */ new Date()).toISOString()}] [${level}] ${message}
`);
    };
    fmtLogArg = (arg) => arg instanceof Error ? `${arg.name}: ${arg.message}${arg.code ? ` [${arg.code}]` : ""}` : typeof arg === "object" ? (() => {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })() : String(arg);
    globalThis.__sriftConsole ||= { log: console.log, error: console.error, warn: console.warn };
    console.log = (...args) => {
      logMessage("INFO", args.map(fmtLogArg).join(" "));
    };
    console.error = (...args) => {
      logMessage("ERROR", args.map(fmtLogArg).join(" "));
    };
    console.warn = (...args) => {
      logMessage("WARN", args.map(fmtLogArg).join(" "));
    };
    crypto5 = globalThis.crypto || webcrypto;
    dotenv.config({ path: ".env.local" });
    dotenv.config();
    process.on("uncaughtException", (err) => {
      console.error("[DAEMON] Uncaught Exception:", err);
    });
    process.on("unhandledRejection", (reason, promise) => {
      console.error("[DAEMON] Unhandled Rejection at:", promise, "reason:", reason);
    });
    PORT = parseInt(process.env.SRIFT_DAEMON_PORT || "3822", 10);
    DEFAULT_SIGNALER_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8080";
    activeSignalerUrl = DEFAULT_SIGNALER_URL;
    lastDiag = null;
    session = {
      id: null,
      name: null,
      role: null,
      isConnected: false,
      userId: null
    };
    activeTransfers = [];
    chatHistory = [];
    pendingJoins = [];
    participants = [];
    sseClients = [];
    wsConn = null;
    wsUrl = null;
    csrfToken = null;
    heartbeatInterval = null;
    lastHeartbeatAckAt = 0;
    encryptionKey = null;
    sessionTerminated = false;
    terminationReason = null;
    activeTorrents = /* @__PURE__ */ new Map();
    wtClient = null;
    pubshares = /* @__PURE__ */ new Map();
    pubsharesByToken = /* @__PURE__ */ new Map();
    activePulls = /* @__PURE__ */ new Map();
    pubshareRegResolvers = /* @__PURE__ */ new Map();
    TEMP_DIR = path7.join(SRIFT_HOME, "tmp");
    if (!fs8.existsSync(TEMP_DIR)) {
      fs8.mkdirSync(TEMP_DIR, { recursive: true, mode: 448 });
    }
    try {
      for (const f of fs8.readdirSync(TEMP_DIR)) {
        if (f.endsWith(".sre1")) {
          try {
            fs8.unlinkSync(path7.join(TEMP_DIR, f));
          } catch {
          }
        }
      }
    } catch {
    }
    KDF_ITERATIONS = 1e5;
    IV_LEN = 12;
    RELAY_ENC = "sgcm1";
    relayKeyCache = null;
    STATE_STALE_MS = 24 * 60 * 60 * 1e3;
    pruneStaleStateOnStartup();
    activeUploads = /* @__PURE__ */ new Map();
    app = express();
    LOCAL_HOSTS = /* @__PURE__ */ new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
    app.use((req, res, next) => {
      const host = String(req.headers.host || "").toLowerCase();
      if (!LOCAL_HOSTS.has(host)) {
        return res.status(403).json({ success: false, error: "Forbidden: the SRIFT daemon only accepts requests addressed to 127.0.0.1/localhost." });
      }
      if (req.headers["access-control-request-private-network"] === "true") {
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      next();
    });
    app.use(cors({ origin: "*", maxAge: 600 }));
    app.use(express.json());
    DAEMON_START_TIME = Date.now();
    PACKAGE_VERSION = "4.1.0";
    app.get("/health", (req, res) => {
      res.json({
        ok: true,
        version: PACKAGE_VERSION,
        uptime_ms: Date.now() - DAEMON_START_TIME,
        mcp: true,
        webrtc: false,
        // daemon uses WebSocket relay + WebTorrent, not raw WebRTC
        webtorrent: _webTorrentLoadError ? false : true,
        webtorrent_error: _webTorrentLoadError || void 0
      });
    });
    app.get("/status", (req, res) => {
      res.json({
        session: {
          id: session.id,
          name: session.name,
          role: session.role,
          isConnected: session.isConnected,
          userId: session.userId
        },
        activeTransfers,
        pendingJoins,
        participants,
        lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    app.post("/session/start", async (req, res) => {
      try {
        const { sessionName, username, roomSecret } = req.body;
        const sName = sessionName || "cli-session";
        const uName = username || "CLI-Host";
        sessionTerminated = false;
        terminationReason = null;
        console.log(`[DAEMON] Starting session: "${sName}" by "${uName}"`);
        const data = await signalerPost("/create-session", { username: uName, name: sName });
        console.log("[DAEMON] Session created successfully on server", data);
        session = {
          id: data.sessionId,
          name: data.name,
          role: "host",
          isConnected: false,
          userId: data.userId,
          wsToken: data.wsToken,
          roomSecret: roomSecret || null
        };
        encryptionKey = await deriveKey(data.sessionId, roomSecret);
        console.log("[DAEMON] E2EE Cryptographic key derived");
        wsUrl = data.wsUrl || `${activeSignalerUrl.replace(/^http/, "ws")}/ws`;
        if (wsUrl) connectWebSocket(wsUrl);
        writeStateFile();
        res.json({ success: true, sessionId: data.sessionId, joinUrl: `${activeSignalerUrl.replace(/\/+$/, "")}/join-session?id=${data.sessionId}` });
      } catch (err) {
        console.error("[DAEMON] Failed to start session:", err);
        res.status(500).json({ success: false, error: err.message });
      }
    });
    app.post("/session/join", async (req, res) => {
      try {
        const { sessionId, username, roomSecret } = req.body;
        if (!sessionId) {
          return res.status(400).json({ success: false, error: "sessionId required" });
        }
        sessionTerminated = false;
        terminationReason = null;
        const uName = username || "CLI-Guest";
        console.log(`[DAEMON] Joining session: "${sessionId}" as "${uName}"`);
        let data;
        try {
          data = await signalerPost("/join-session", { sessionId, username: uName });
        } catch (e) {
          const statusCode = e?.status >= 400 && e?.status < 500 ? e.status : 502;
          return res.status(statusCode).json({ success: false, error: e?.message || String(e) });
        }
        console.log("[DAEMON] Join initialized on server", data);
        session = {
          id: data.sessionId,
          name: data.name,
          role: "guest",
          isConnected: false,
          userId: null,
          tempUserId: data.tempUserId,
          wsToken: data.wsToken,
          roomSecret: roomSecret || null
        };
        encryptionKey = await deriveKey(data.sessionId, roomSecret);
        console.log("[DAEMON] E2EE Cryptographic key derived");
        wsUrl = data.wsUrl || `${activeSignalerUrl.replace(/^http/, "ws")}/ws`;
        if (wsUrl) connectWebSocket(wsUrl);
        writeStateFile();
        res.json({ success: true, sessionId: data.sessionId });
      } catch (err) {
        console.error("[DAEMON] Failed to join session:", err);
        res.status(500).json({ success: false, error: err.message });
      }
    });
    app.post("/session/approve", async (req, res) => {
      const { tempUserId } = req.body;
      if (!tempUserId) {
        return res.status(400).json({ success: false, error: "tempUserId required" });
      }
      if (session.role !== "host") {
        return res.status(403).json({ success: false, error: "Only host can approve joins" });
      }
      const pending = pendingJoins.find((j) => j.tempUserId === tempUserId);
      if (!pending) {
        return res.status(404).json({ success: false, error: `No pending join request found for tempUserId: ${tempUserId}` });
      }
      console.log(`[DAEMON] Approving join request: ${tempUserId}`);
      wsConn?.send(JSON.stringify({
        type: "approve_join",
        payload: { sessionId: session.id, tempUserId }
      }));
      pendingJoins = pendingJoins.filter((j) => j.tempUserId !== tempUserId);
      const before = new Set(participants.filter((p) => p.online).map((p) => p.userId));
      const joined = () => participants.find((p) => p.online && !p.isHost && p.username === pending.username && !before.has(p.userId));
      for (let waited = 0; waited < 8e3 && !joined() && session.id; waited += 100) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const member = joined();
      res.json({ success: true, joined: !!member, userId: member?.userId ?? null, username: pending.username });
    });
    app.post("/session/reject", (req, res) => {
      const { tempUserId, reason } = req.body;
      if (!tempUserId) {
        return res.status(400).json({ success: false, error: "tempUserId required" });
      }
      if (session.role !== "host") {
        return res.status(403).json({ success: false, error: "Only host can reject joins" });
      }
      console.log(`[DAEMON] Rejecting join request: ${tempUserId}`);
      wsConn?.send(JSON.stringify({
        type: "reject_join",
        payload: { tempUserId, reason: reason || "Kicked by host CLI" }
      }));
      pendingJoins = pendingJoins.filter((j) => j.tempUserId !== tempUserId);
      res.json({ success: true });
    });
    app.post("/session/kick", (req, res) => {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ success: false, error: "userId required" });
      }
      if (session.role !== "host") {
        return res.status(403).json({ success: false, error: "Only host can kick users" });
      }
      console.log(`[DAEMON] Kicking user: ${userId}`);
      wsConn?.send(JSON.stringify({
        type: "kick",
        payload: { targetId: userId }
      }));
      res.json({ success: true });
    });
    app.post("/session/close", (req, res) => {
      console.log("[DAEMON] Closing active session \u2014 full teardown");
      sessionTerminated = true;
      try {
        console.log(`[DAEMON] close: role=${session.role} id=${session.id} wsState=${wsConn ? wsConn.readyState : "no-ws"}`);
        if (wsConn && wsConn.readyState === 1 && session.id) {
          if (session.role === "host") {
            wsConn.send(JSON.stringify({ type: "delete_session", payload: { sessionId: session.id } }));
            console.log("[DAEMON] close: sent delete_session");
          } else {
            wsConn.send(JSON.stringify({ type: "leave_session", payload: { sessionId: session.id, userId: session.userId } }));
            console.log("[DAEMON] close: sent leave_session");
          }
        }
      } catch (e) {
        console.error("[DAEMON] close: send failed", e?.message);
      }
      if (wsConn) {
        const _ws = wsConn;
        setTimeout(() => {
          try {
            _ws.close();
          } catch {
          }
        }, 700);
        wsConn = null;
      }
      wsUrl = null;
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      if (wtClient) {
        try {
          wtClient.destroy();
        } catch {
        }
        wtClient = null;
      }
      activeTorrents.clear();
      session = { id: null, name: null, role: null, isConnected: false, userId: null };
      activeTransfers = [];
      chatHistory = [];
      pendingJoins = [];
      participants = [];
      csrfToken = null;
      encryptionKey = null;
      try {
        if (fs8.existsSync(TEMP_DIR)) {
          for (const f of fs8.readdirSync(TEMP_DIR)) {
            try {
              fs8.unlinkSync(path7.join(TEMP_DIR, f));
            } catch {
            }
          }
        }
      } catch {
      }
      writeStateFile();
      res.json({ success: true });
    });
    app.post("/send", async (req, res) => {
      try {
        const { filePath, protocol } = req.body;
        if (!filePath) {
          return res.status(400).json({ success: false, error: "filePath is required" });
        }
        const absPath = path7.resolve(filePath);
        if (!fs8.existsSync(absPath)) {
          return res.status(404).json({ success: false, error: `File not found: ${absPath}` });
        }
        const stat = fs8.statSync(absPath);
        const filename = path7.basename(absPath);
        const fileId = `cli_file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const targetProtocol = webTorrentAllowed() && (protocol === "webtorrent" || stat.size > 10 * 1024 * 1024 && protocol !== "websocket") ? "webtorrent" : "websocket";
        const notReady = await waitSignalReady();
        if (notReady) return res.status(notReady.status).json(notReady.body);
        const newTx = {
          fileId,
          name: filename,
          size: stat.size,
          progress: 0,
          speedKBps: 0,
          etaSeconds: 0,
          protocol: targetProtocol,
          status: "pending",
          direction: "upload",
          filePath: absPath,
          bytesTransferred: 0,
          chunksCount: 0,
          totalChunks: 0,
          startTime: Date.now()
        };
        activeTransfers.push(newTx);
        writeStateFile();
        console.log(`[DAEMON] Offering file via ${targetProtocol}: ${filename} (${stat.size} bytes)`);
        wsConn?.send(JSON.stringify({
          type: "file_offer",
          payload: {
            fileId,
            filename,
            size: stat.size,
            mime: "application/octet-stream",
            transferType: targetProtocol,
            csrfToken
          }
        }));
        res.json({ success: true, fileId, protocol: targetProtocol });
      } catch (err) {
        console.error("[DAEMON] Send offer failed:", err);
        res.status(500).json({ success: false, error: err.message });
      }
    });
    app.post("/receive", (req, res) => {
      const { fileId, saveDir } = req.body;
      if (!fileId) {
        return res.status(400).json({ success: false, error: "fileId is required" });
      }
      const tx = activeTransfers.find((t) => t.fileId === fileId);
      if (!tx) {
        return res.status(404).json({ success: false, error: "No offer found for this fileId" });
      }
      tx.saveDir = saveDir ? path7.resolve(saveDir) : process.cwd();
      tx.status = "downloading";
      tx.startTime = Date.now();
      console.log(`[DAEMON] Accepting file offer ${fileId}, saving to ${tx.saveDir}`);
      wsConn?.send(JSON.stringify({
        type: "file_accept",
        // relayEnc: this daemon decrypts sealed relay chunks (see openRelayChunk)
        payload: { fileId, relayEnc: RELAY_ENC }
      }));
      res.json({ success: true });
    });
    app.post("/chat/send", async (req, res) => {
      try {
        const { message } = req.body;
        if (!message) {
          return res.status(400).json({ success: false, error: "message required" });
        }
        if (!session.id) {
          return res.status(409).json({ success: false, error: "No active session. Call /session/start first." });
        }
        const notReady = await waitSignalReady();
        if (notReady) return res.status(notReady.status).json(notReady.body);
        const encContent = await encrypt(message);
        wsConn.send(JSON.stringify({
          type: "chat",
          payload: { content: encContent, encrypted: true }
        }));
        const chatMsg = {
          messageId: uuidv4(),
          sender: "Me",
          content: message,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        };
        chatHistory.push(chatMsg);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });
    app.get("/chat/history", (req, res) => {
      res.json(chatHistory);
    });
    app.get("/state", (req, res) => {
      try {
        if (fs8.existsSync(STATE_PATH)) {
          const raw = fs8.readFileSync(STATE_PATH, "utf-8");
          res.type("application/json").send(raw);
        } else {
          res.json({ session: { id: null, isConnected: false }, activeTransfers: [], lastUpdated: null });
        }
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    hostSessionInflight = null;
    MAX_MULTI_PATHS = 500;
    MULTI_CONCURRENCY = 4;
    app.post("/quick-share", async (req, res) => {
      try {
        if (Array.isArray(req.body?.filePaths)) {
          const m = await createMultiShare(publicShareBody(req.body));
          if (m.bundle === false && !m.success) {
            return res.status(400).json({ ...m, error: m.errors.map((e) => `${e.filePath}: ${e.error}`).join("; ") });
          }
          return res.json(m.bundle ? { ...m, shareUrl: m.downloadUrl } : m);
        }
        const r = await createShare(publicShareBody(req.body));
        res.json({ ...r, shareUrl: r.downloadUrl });
      } catch (err) {
        console.error("[DAEMON] /quick-share failed:", err?.message || err);
        res.status(err?.status || 500).json({ success: false, error: err?.message || String(err) });
      }
    });
    app.post("/pubshare", async (req, res) => {
      try {
        const body = publicShareBody(req.body);
        if (!session.id || !session.isConnected) {
          return res.status(409).json({ success: false, error: "No active session \u2014 run `srift session start` or `srift quick-share` first" });
        }
        const r = await createShare(body);
        res.json(r);
      } catch (err) {
        console.error("[DAEMON] /pubshare failed:", err?.message || err);
        res.status(err?.status || 500).json({ success: false, error: err?.message || String(err) });
      }
    });
    app.get("/v1/diag", async (req, res) => {
      try {
        res.json(await getDiag(req.query.fresh === "1" || req.query.fresh === "true"));
      } catch (err) {
        res.status(500).json({ ok: false, error: err?.message || String(err) });
      }
    });
    app.get("/pubshare/list", (_req, res) => {
      const now = Date.now();
      const items = Array.from(pubshares.values()).filter((e) => !e.expiresAt || e.expiresAt > now).map((e) => ({
        token: e.token,
        downloadUrl: linkWithKey(e.downloadUrl, e.linkKey),
        mode: "relay",
        encrypted: !!e.encrypted,
        fileId: e.fileId,
        fileName: e.displayName || e.filename,
        fileSize: e.size,
        downloadCount: e.downloadCount,
        completedDownloads: e.completedDownloads || 0,
        activeDownloads: Array.from(activePulls.values()).filter((p) => p.token === e.token).length,
        maxDownloads: e.maxDownloads,
        expiresAt: e.expiresAt,
        createdAt: e.createdAt
      }));
      res.json({ success: true, items });
    });
    app.post("/pubshare/revoke", (req, res) => {
      const { token } = req.body || {};
      if (!token) return res.status(400).json({ success: false, error: "token required" });
      const entry = pubsharesByToken.get(token);
      if (!entry) return res.status(404).json({ success: false, error: "Unknown token" });
      try {
        wsConn?.send(JSON.stringify({ type: "pubshare_unregister", payload: { token } }));
      } catch {
      }
      pubsharesByToken.delete(token);
      pubshares.delete(entry.fileId);
      if (entry.tempFile) {
        try {
          fs8.unlinkSync(entry.tempFile);
        } catch {
        }
      }
      res.json({ success: true });
    });
    app.post("/mcp", async (req, res) => {
      try {
        const message = req.body;
        if (Array.isArray(message)) {
          const responses = await Promise.all(message.map((m) => handleMcpMessage(m)));
          res.json(responses.filter(Boolean));
        } else {
          const response = await handleMcpMessage(message);
          if (response) res.json(response);
          else res.status(202).end();
        }
      } catch (err) {
        res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: err.message } });
      }
    });
    app.get("/mcp", (req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      res.write(`event: endpoint
data: ${JSON.stringify({ uri: "/mcp" })}

`);
      sseClients.push(res);
      req.on("close", () => {
        sseClients = sseClients.filter((c) => c !== res);
      });
    });
    app.get("/mcp/sse", (req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      res.write(`event: endpoint
data: /mcp/messages

`);
      sseClients.push(res);
      req.on("close", () => {
        sseClients = sseClients.filter((c) => c !== res);
      });
    });
    app.post("/mcp/messages", async (req, res) => {
      try {
        const response = await handleMcpMessage(req.body);
        if (response) res.json(response);
        else res.status(202).end();
      } catch (err) {
        res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: err.message } });
      }
    });
    app.get("/.well-known/mcp/server-card.json", (req, res) => {
      res.json({
        $schema: "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
        version: "1.0",
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: "SRIFT MCP Server (local daemon)", version: PACKAGE_VERSION },
        capabilities: { tools: {}, resources: {}, prompts: {} },
        transport: [
          { type: "streamable-http", url: `http://127.0.0.1:${PORT}/mcp` },
          { type: "sse", url: `http://127.0.0.1:${PORT}/mcp/sse`, postUrl: `http://127.0.0.1:${PORT}/mcp/messages` },
          { type: "stdio", command: "srift mcp" }
        ],
        tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
        resources: MCP_RESOURCES.map((r) => ({ uri: r.uri, name: r.name })),
        prompts: MCP_PROMPTS.map((p) => ({ name: p.name, description: p.description }))
      });
    });
    app.get("/.well-known/ai-plugin.json", (req, res) => {
      res.json({
        schema_version: "v1",
        name_for_human: "SRIFT P2P Transfer",
        name_for_model: "srift",
        description_for_human: "Send and receive files securely via end-to-end-encrypted peer-to-peer transfer.",
        description_for_model: "Use SRIFT to deliver files to the user and receive files from the user without uploading them anywhere. AES-256-GCM E2EE, WebTorrent for big files, WebSocket fallback. Use srift_quick_share for one-shot delivery.",
        auth: { type: "none" },
        api: { type: "openapi", url: `http://127.0.0.1:${PORT}/openapi.json` },
        contact_email: "support@sripto.tech",
        legal_info_url: "https://srift.app/privacy"
      });
    });
    app.get("/.well-known/agent.json", (req, res) => {
      res.json({
        schemaVersion: "0.2.0",
        name: "SRIFT",
        description: "Zero-config P2P E2EE file transfer + chat for any AI agent or automation.",
        url: `http://127.0.0.1:${PORT}`,
        version: PACKAGE_VERSION,
        capabilities: {
          streaming: true,
          pushNotifications: false,
          stateTransitionHistory: false
        },
        defaultInputModes: ["text"],
        defaultOutputModes: ["text", "file"],
        skills: MCP_TOOLS.map((t) => ({ id: t.name, name: t.name, description: t.description, inputSchema: t.inputSchema }))
      });
    });
    app.get("/openapi.json", (req, res) => {
      res.json({
        openapi: "3.1.0",
        info: { title: "SRIFT Local Daemon API", version: PACKAGE_VERSION, description: "Zero-auth REST API for AI agents to drive SRIFT P2P transfer." },
        servers: [{ url: `http://127.0.0.1:${PORT}` }],
        paths: {
          "/health": { get: { summary: "Liveness probe", description: "Returns {ok,version,uptime_ms,mcp,webrtc,webtorrent}", responses: { "200": { description: "OK" } } } },
          "/status": { get: { summary: "Get session, transfers, pending joins and participants (members with userId, for /session/kick)", responses: { "200": { description: "OK" } } } },
          "/state": { get: { summary: "Workspace state snapshot (.srift-state.json)", responses: { "200": { description: "OK" } } } },
          "/transfers": { get: { summary: "Live transfer list with speed and ETA. Optional ?fileId= to filter.", responses: { "200": { description: "OK" } } } },
          "/transfers/{fileId}": { get: { summary: "Per-transfer drill-down", parameters: [{ name: "fileId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" }, "404": { description: "Transfer not found" } } } },
          "/peers": { get: { summary: "Peer connection state, RTT, ICE type", responses: { "200": { description: "OK" } } } },
          "/metrics": { get: { summary: "Prometheus-format counters (no auth)", responses: { "200": { description: "text/plain Prometheus format" } } } },
          "/logs": { get: { summary: "NDJSON daemon log tail. ?lines=N (default 100)", responses: { "200": { description: "application/x-ndjson" } } } },
          "/reset": { post: { summary: "Wipe all state and flush encryption keys", responses: { "200": { description: "{ok:true}" } } } },
          "/v1/diag": { get: { summary: "Network diagnosis (same as `srift doctor --json`); ?fresh=1 re-probes", responses: { "200": { description: "Diagnosis report" } } } },
          "/daemon/stop": { post: { summary: "Stop this daemon", responses: { "200": { description: "OK" } } } },
          "/session/start": { post: { summary: "Create new session (becomes host); returns sessionId and joinUrl", requestBody: { content: { "application/json": { schema: { type: "object", properties: { sessionName: { type: "string" }, roomSecret: { type: "string" } } } } } }, responses: { "200": { description: "{success:true,sessionId}" } } } },
          "/session/join": { post: { summary: "Join existing session", requestBody: { content: { "application/json": { schema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, username: { type: "string" }, roomSecret: { type: "string" } } } } } }, responses: { "200": { description: "OK" }, "400": { description: "Missing sessionId" }, "404": { description: "Session not found" } } } },
          "/session/approve": { post: { summary: "Host approves a pending join request; returns {success, joined, userId} once the guest is in the room (max 8 s)", requestBody: { content: { "application/json": { schema: { type: "object", required: ["tempUserId"], properties: { tempUserId: { type: "string" } } } } } }, responses: { "200": { description: "OK" }, "400": { description: "tempUserId required" }, "403": { description: "Not host" }, "404": { description: "No such pending request" } } } },
          "/session/reject": { post: { summary: "Host rejects a pending join request", requestBody: { content: { "application/json": { schema: { type: "object", required: ["tempUserId"], properties: { tempUserId: { type: "string" }, reason: { type: "string" } } } } } }, responses: { "200": { description: "OK" }, "400": { description: "tempUserId required" }, "403": { description: "Not host" } } } },
          "/session/kick": { post: { summary: "Host kicks a peer", requestBody: { content: { "application/json": { schema: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } } } } }, responses: { "200": { description: "OK" }, "400": { description: "userId required" }, "403": { description: "Not host" } } } },
          "/session/close": { post: { summary: "Tear down the session and flush keys", responses: { "200": { description: "OK" } } } },
          "/send": { post: { summary: "Offer a file to peers (requires active session)", requestBody: { content: { "application/json": { schema: { type: "object", required: ["filePath"], properties: { filePath: { type: "string" } } } } } }, responses: { "200": { description: "{success:true,fileId}" } } } },
          "/receive": { post: { summary: "Accept an incoming file offer", requestBody: { content: { "application/json": { schema: { type: "object", required: ["fileId"], properties: { fileId: { type: "string" }, saveDir: { type: "string" } } } } } }, responses: { "200": { description: "OK" }, "404": { description: "No offer for this fileId" } } } },
          "/quick-share": { post: { summary: "ONE-SHOT: create session if needed and return a direct downloadUrl (https://srift.app/d/<token>) streamed from this machine (nothing stored on a server). Pass filePaths for several files/folders: one .tar.gz link (bundle, default) or one link per path (bundle:false, created in parallel).", requestBody: { content: { "application/json": { schema: { type: "object", properties: { filePath: { type: "string", description: "Absolute path to a file or folder (folders are sent as .tar.gz)" }, filePaths: { type: "array", items: { type: "string" }, maxItems: 500, description: "Several absolute paths (use instead of filePath)" }, bundle: { type: "boolean", description: "filePaths: true (default) = one .tar.gz link; false = one link per path" }, bundleName: { type: "string" }, exclude: { type: "array", items: { type: "string" } }, encrypt: { type: "boolean" }, password: { type: "string" }, maxDownloads: { type: "number" }, ttlMs: { type: "number" }, sessionName: { type: "string" } } } } } }, responses: { "200": { description: "Single/bundle: {success,downloadUrl,token,fileName,fileSize,encrypted,expiresAt,bundle?,files?}. bundle:false: {success,bundle:false,links:[...],errors:[...]}" } } } },
          "/chat/send": { post: { summary: "Send E2EE chat message", requestBody: { content: { "application/json": { schema: { type: "object", required: ["message"], properties: { message: { type: "string" } } } } } }, responses: { "200": { description: "OK" }, "400": { description: "message required" }, "409": { description: "No session" }, "503": { description: "WS not ready \u2014 retry in 1\u20132s" } } } },
          "/chat/history": { get: { summary: "Decrypted chat log", responses: { "200": { description: "Array of {messageId,sender,content,timestamp}" } } } },
          "/api/v1/monitor/events": { get: { summary: "SSE event stream: connection_state, join_request, file_offer, transfer_progress, chat_received", responses: { "200": { description: "text/event-stream" } } } },
          "/mcp": { post: { summary: "MCP JSON-RPC (Streamable HTTP, spec 2025-06-18)", responses: { "200": { description: "JSON-RPC response" } } }, get: { summary: "SSE stream for server\u2192client MCP notifications", responses: { "200": { description: "text/event-stream" } } } },
          "/mcp/sse": { get: { summary: "Legacy SSE MCP endpoint (older clients)", responses: { "200": { description: "text/event-stream" } } } },
          "/mcp/messages": { post: { summary: "Legacy SSE MCP message submission endpoint", responses: { "200": { description: "OK" } } } }
        }
      });
    });
    app.get("/transfers", (req, res) => {
      const fileId = req.query.fileId;
      const list = fileId ? activeTransfers.filter((t) => t.fileId === fileId) : activeTransfers;
      res.json(list.map((t) => ({
        fileId: t.fileId,
        name: t.name,
        size: t.size,
        progress: parseFloat(t.progress.toFixed(2)),
        speedKBps: parseFloat(t.speedKBps.toFixed(2)),
        etaSeconds: Math.ceil(t.etaSeconds),
        protocol: t.protocol,
        status: t.status,
        direction: t.direction,
        bytesTransferred: t.bytesTransferred
      })));
    });
    app.get("/transfers/:fileId", (req, res) => {
      const tx = activeTransfers.find((t) => t.fileId === req.params.fileId);
      if (!tx) return res.status(404).json({ error: "Transfer not found" });
      res.json(tx);
    });
    app.get("/peers", (req, res) => {
      if (!session.id) return res.json([]);
      const state = wsConn ? wsConn.readyState : 3;
      const stateNames = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
      const peer = {
        sessionId: session.id,
        userId: session.userId,
        role: session.role,
        connectionState: stateNames[state] || "UNKNOWN",
        transport: "websocket",
        rttMs: null,
        iceType: "relay",
        isConnected: session.isConnected
      };
      res.json(session.id ? [peer] : []);
    });
    app.get("/metrics", (req, res) => {
      const uptime = ((Date.now() - DAEMON_START_TIME) / 1e3).toFixed(0);
      const lines = [
        "# HELP srift_uptime_seconds Daemon uptime in seconds",
        "# TYPE srift_uptime_seconds gauge",
        `srift_uptime_seconds ${uptime}`,
        "# HELP srift_active_transfers Number of active file transfers",
        "# TYPE srift_active_transfers gauge",
        `srift_active_transfers ${activeTransfers.filter((t) => t.status === "uploading" || t.status === "downloading").length}`,
        "# HELP srift_total_transfers Total transfers (all statuses)",
        "# TYPE srift_total_transfers counter",
        `srift_total_transfers ${activeTransfers.length}`,
        "# HELP srift_chat_messages_total Total chat messages in history",
        "# TYPE srift_chat_messages_total counter",
        `srift_chat_messages_total ${chatHistory.length}`,
        "# HELP srift_session_active Whether a session is currently active (1 = yes)",
        "# TYPE srift_session_active gauge",
        `srift_session_active ${session.id ? 1 : 0}`,
        "# HELP srift_ws_connected Whether the WebSocket is connected (1 = yes)",
        "# TYPE srift_ws_connected gauge",
        `srift_ws_connected ${session.isConnected ? 1 : 0}`
      ];
      res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(lines.join("\n") + "\n");
    });
    app.get("/logs", (req, res) => {
      const lines = parseInt(req.query.lines || "100", 10);
      try {
        if (!fs8.existsSync(logPath)) return res.json([]);
        const content = fs8.readFileSync(logPath, "utf-8");
        const all = content.split("\n").filter(Boolean);
        const tail = all.slice(-Math.min(lines, all.length));
        res.set("Content-Type", "application/x-ndjson");
        res.send(tail.join("\n"));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.post("/reset", (req, res) => {
      console.log("[DAEMON] /reset: full wipe (memory + disk)");
      if (wsConn) {
        try {
          wsConn.close();
        } catch {
        }
        wsConn = null;
      }
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      if (wtClient) {
        try {
          wtClient.destroy();
        } catch {
        }
        wtClient = null;
      }
      activeTorrents.clear();
      activeUploads.clear();
      session = { id: null, name: null, role: null, isConnected: false, userId: null };
      activeTransfers = [];
      chatHistory = [];
      pendingJoins = [];
      participants = [];
      csrfToken = null;
      encryptionKey = null;
      wsUrl = null;
      let cleanedChunks = 0;
      try {
        if (fs8.existsSync(TEMP_DIR)) {
          for (const f of fs8.readdirSync(TEMP_DIR)) {
            try {
              fs8.unlinkSync(path7.join(TEMP_DIR, f));
              cleanedChunks++;
            } catch {
            }
          }
        }
      } catch {
      }
      writeStateFile();
      res.json({ ok: true, message: "State wiped, keys flushed, temp chunks cleaned", cleanedChunks });
    });
    app.get("/api/v1/monitor/events", (req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      sseClients.push(res);
      console.log(`[DAEMON] SSE Client connected. Active clients: ${sseClients.length}`);
      req.on("close", () => {
        sseClients = sseClients.filter((c) => c !== res);
        console.log(`[DAEMON] SSE Client disconnected. Active clients: ${sseClients.length}`);
      });
    });
    app.post("/daemon/stop", (req, res) => {
      console.log("[DAEMON] Stop request received. Exiting daemon process gracefully...");
      res.json({ success: true });
      try {
        if (wsConn) {
          wsConn.close();
          wsConn = null;
        }
      } catch {
      }
      try {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
      } catch {
      }
      try {
        if (wtClient) {
          wtClient.destroy();
          wtClient = null;
        }
      } catch {
      }
      try {
        activeTorrents.clear();
        activeUploads.clear();
      } catch {
      }
      try {
        pubshares.clear();
        pubsharesByToken.clear();
      } catch {
      }
      try {
        session = { id: null, name: null, role: null, isConnected: false, userId: null };
        activeTransfers = [];
        chatHistory = [];
        pendingJoins = [];
        participants = [];
        encryptionKey = null;
        wsUrl = null;
        writeStateFile();
      } catch {
      }
      try {
        if (fs8.existsSync(TEMP_DIR)) {
          for (const f of fs8.readdirSync(TEMP_DIR)) {
            try {
              fs8.unlinkSync(path7.join(TEMP_DIR, f));
            } catch {
            }
          }
        }
      } catch {
      }
      if (!EMBEDDED) setTimeout(() => {
        process.exit(0);
      }, 500);
    });
    if (EMBEDDED) {
      process.on("exit", () => {
        for (const e of pubshares.values()) if (e.tempFile) {
          try {
            fs8.unlinkSync(e.tempFile);
          } catch {
          }
        }
      });
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        try {
          process.once(sig, () => process.exit(sig === "SIGINT" ? 130 : 143));
        } catch {
        }
      }
    }
    embeddedReady = EMBEDDED ? selectSignalerUrl().then(() => {
      console.log("[DAEMON] Embedded mode (no local port): serving from the host process");
      writeStateFile();
    }) : Promise.resolve();
    httpServer = EMBEDDED ? null : app.listen(PORT, "127.0.0.1", async () => {
      await selectSignalerUrl();
      console.log(`[DAEMON] Background daemon listening on http://127.0.0.1:${PORT}`);
      writeStateFile();
      getDiag().then((d) => console.log(`[DAEMON] Network check: ${d.verdict}`)).catch((e) => console.warn("[DAEMON] Network check failed:", e?.message));
    });
    httpServer?.on("error", (err) => {
      if (err?.code === "EADDRINUSE") {
        console.error(`[DAEMON] Port ${PORT} is already in use. Set SRIFT_DAEMON_PORT to another port or stop the other process.`);
        process.exit(98);
      }
      if (err?.code === "EPERM" || err?.code === "EACCES") {
        console.error(`[DAEMON] Not allowed to listen on 127.0.0.1:${PORT} (${err.code}) \u2014 this looks like a sandbox. \`srift quick-share\` and \`srift mcp\` serve from their own process instead (no port needed).`);
        process.exit(77);
      }
      console.error("[DAEMON] Server error:", err);
      process.exit(1);
    });
  }
});
init_daemon();
export {
  embeddedDispatch,
  embeddedReady
};
