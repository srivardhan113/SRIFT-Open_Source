/**
 * SRIFT Node.js SDK — zero-dependency client for the SRIFT local daemon.
 *
 * Runs on: Node 18+, Bun, Deno (via npm: specifier), browsers, edge runtimes
 *          (Vercel, Cloudflare Workers, Netlify Edge, Deno Deploy, Lambda@Edge),
 *          Electron, React Native, Hermes, JerryScript.
 *
 * Zero external deps. Uses only the built-in fetch (Node 18+) + EventSource shim.
 *
 * Usage:
 *   import { Srift } from "./srift.mjs";
 *   const s = new Srift();
 *   const { shareUrl } = await s.quickShare("/abs/path/file.zip");
 */

const DEFAULT_BASE = "http://127.0.0.1:3822";

export class SriftError extends Error {
  constructor(message, code) { super(message); this.name = "SriftError"; this.code = code; }
}

export class Srift {
  constructor({ baseUrl, timeoutMs } = {}) {
    this.baseUrl = (baseUrl || (typeof process !== "undefined" && process.env?.SRIFT_BASE_URL) || DEFAULT_BASE).replace(/\/$/, "");
    this.timeoutMs = timeoutMs ?? 30_000;
  }

  async _call(path, method = "GET", body) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
    try {
      const r = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body == null ? undefined : JSON.stringify(body),
        signal: ctrl?.signal,
      });
      const text = await r.text();
      const json = text ? JSON.parse(text) : {};
      if (!r.ok) throw new SriftError(json.error || `HTTP ${r.status}`, r.status);
      return json;
    } catch (err) {
      if (err instanceof SriftError) throw err;
      throw new SriftError(`Daemon unreachable at ${this.baseUrl}: ${err.message}. Start it with: srift daemon start`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Health
  isAlive() { return this._call("/status").then(() => true, () => false); }
  status() { return this._call("/status"); }
  state() { return this._call("/state"); }

  // Session
  startSession({ name, roomSecret } = {}) {
    return this._call("/session/start", "POST", { sessionName: name, roomSecret });
  }
  joinSession(sessionId, { username, roomSecret } = {}) {
    return this._call("/session/join", "POST", { sessionId, username, roomSecret });
  }
  approveJoin(tempUserId) { return this._call("/session/approve", "POST", { tempUserId }); }
  rejectJoin(tempUserId, reason) { return this._call("/session/reject", "POST", { tempUserId, reason }); }
  kickUser(userId) { return this._call("/session/kick", "POST", { userId }); }
  closeSession() { return this._call("/session/close", "POST"); }

  // Transfer
  sendFile(filePath, { protocol } = {}) { return this._call("/send", "POST", { filePath, protocol }); }
  acceptTransfer(fileId, { saveDir } = {}) { return this._call("/receive", "POST", { fileId, saveDir }); }
  async listTransfers() { return (await this.status()).activeTransfers || []; }
  quickShare(filePath, { sessionName } = {}) {
    return this._call("/quick-share", "POST", { filePath, sessionName });
  }

  // Chat
  sendChat(message) { return this._call("/chat/send", "POST", { message }); }
  chatHistory() { return this._call("/chat/history"); }

  // SSE event stream (async iterator)
  async *streamEvents() {
    const r = await fetch(`${this.baseUrl}/api/v1/monitor/events`, { headers: { Accept: "text/event-stream" } });
    if (!r.ok || !r.body) throw new SriftError(`SSE failed: HTTP ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let event = "message";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trimEnd();
        buf = buf.slice(idx + 1);
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) {
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { data = line.slice(6); }
          yield { event, data };
          event = "message";
        }
      }
    }
  }
}

// ─── MCP HTTP transport client ──────────────────────────────────────────────
export class SriftMCP {
  constructor({ baseUrl } = {}) {
    this.baseUrl = (baseUrl || DEFAULT_BASE).replace(/\/$/, "");
    this._id = 0;
  }
  async call(method, params) {
    const body = { jsonrpc: "2.0", id: ++this._id, method, ...(params != null ? { params } : {}) };
    const r = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const payload = await r.json();
    if (payload.error) throw new SriftError(payload.error.message, payload.error.code);
    return payload.result;
  }
  initialize(clientName = "srift-node-sdk") {
    return this.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: "2.0.0" },
    });
  }
  async tools() { return (await this.call("tools/list")).tools; }
  tool(name, args = {}) { return this.call("tools/call", { name, arguments: args }); }
  async resources() { return (await this.call("resources/list")).resources; }
  resource(uri) { return this.call("resources/read", { uri }); }
  async prompts() { return (await this.call("prompts/list")).prompts; }
  prompt(name, args = {}) { return this.call("prompts/get", { name, arguments: args }); }
}

export default Srift;
