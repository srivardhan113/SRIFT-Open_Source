/**
 * The HTTPS session stream for the CLI daemon: the same protocol browsers use when WebSockets never
 * open (lib/http-stream-client.ts ↔ lib/server/http-stream.mjs), behind the `ws` API the daemon
 * already speaks (on/send/close/terminate/readyState). Requests go through cli/net.ts, so HTTPS_PROXY,
 * NO_PROXY and NODE_EXTRA_CA_CERTS apply exactly as for every other CLI request.
 */
import { EventEmitter } from 'node:events';
import { HttpStreamSocket } from '../lib/http-stream-client.ts';
import { requestJson } from './net.ts';

export class NodeHttpStreamSocket extends EventEmitter {
  private readonly s: HttpStreamSocket;

  constructor(wsUrl: string, sessionId: string) {
    super();
    this.s = new HttpStreamSocket(wsUrl, sessionId, async (url, body, timeoutMs, signal) => {
      const r = await requestJson(url, { method: 'POST', json: body, timeoutMs, signal });
      return { status: r.status, body: r.data };
    });
    this.s.onopen = () => this.emit('open');
    this.s.onmessage = (ev) => this.emit('message', ev.data);
    this.s.onerror = (e) => { if (this.listenerCount('error')) this.emit('error', e); };
    this.s.onclose = (ev) => this.emit('close', ev.code, ev.reason);
  }

  get readyState(): number { return this.s.readyState; }
  get bufferedAmount(): number { return this.s.bufferedAmount; }
  send(data: string): void { this.s.send(data); }
  close(code?: number, reason?: string): void { this.s.close(code, reason); }
  /** Same as close: there is no half-open TCP socket to kill. */
  terminate(): void { this.s.close(1006, 'terminated'); }
}
