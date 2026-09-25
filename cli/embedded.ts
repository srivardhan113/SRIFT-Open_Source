/**
 * Embedded daemon: run the SRIFT daemon inside this process (CLI or MCP
 * server) instead of as a background HTTP server on 127.0.0.1.
 *
 * Used automatically when the background daemon cannot start — sandboxes that
 * forbid local servers (EPERM/EACCES on bind), blocked detached spawns, or
 * blocked loopback connections. It needs only outbound HTTPS/WSS on 443, opens
 * no port, and stores nothing on any server: links are relay links streamed
 * from this process, so they stay live while it runs.
 */

export type DaemonResponse = { status: number; data: any };
type Dispatch = (method: 'GET' | 'POST', pathname: string, body?: unknown) => Promise<DaemonResponse>;

let dispatch: Dispatch | null = null;
let starting: Promise<void> | null = null;

export function isEmbeddedDaemon(): boolean {
  return dispatch !== null;
}

export async function startEmbeddedDaemon(): Promise<void> {
  if (dispatch) return;
  if (!starting) {
    starting = (async () => {
      process.env.SRIFT_DAEMON_EMBEDDED = '1';
      const mod: any = await import('./daemon.ts');
      await mod.embeddedReady;
      dispatch = mod.embeddedDispatch as Dispatch;
    })();
    starting.catch(() => { starting = null; });
  }
  await starting;
}

/** In-process daemon call; null when not embedded. */
export function embeddedCall(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<DaemonResponse> | null {
  return dispatch ? dispatch(method, pathname, body) : null;
}

/** The host's real console (the daemon module redirects console.* to ~/.srift/daemon.log). */
export function realConsole(): { log: (...a: any[]) => void; error: (...a: any[]) => void; warn: (...a: any[]) => void } {
  return (globalThis as any).__sriftConsole || console;
}

/**
 * Run `fn` with console.* pointing at the real terminal, for human-readable
 * output produced by helpers that use console.log. JSON output must use
 * process.stdout.write directly instead.
 */
export async function withRealConsole<T>(fn: () => Promise<T> | T): Promise<T> {
  const real = (globalThis as any).__sriftConsole;
  if (!real) return fn();
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = real.log; console.error = real.error; console.warn = real.warn;
  try { return await fn(); } finally { console.log = saved.log; console.error = saved.error; console.warn = saved.warn; }
}
