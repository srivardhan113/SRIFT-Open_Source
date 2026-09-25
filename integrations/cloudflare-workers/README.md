# Cloudflare Workers integration

Workers can't run the SRIFT daemon (no long-running processes), but they can use the hosted MCP
endpoint, or proxy to a daemon you run elsewhere.

## Option 1 — hosted MCP (no daemon)

`https://srift.app/mcp` (Streamable HTTP) exposes the 9 session and control tools. File transfer
and chat need a local daemon (`srift mcp`).

## Option 2 — proxy to your own daemon through a protected tunnel

The daemon has no authentication, so put the tunnel behind Cloudflare Access (or another access
control) and never expose it publicly. The daemon accepts only loopback `Host` headers, so the
tunnel must rewrite it:

```bash
cloudflared tunnel --url http://127.0.0.1:3822 --http-host-header 127.0.0.1:3822
```

```js
// worker.mjs
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/mcp" && req.method === "POST") {
      return fetch(`${env.SRIFT_TUNNEL_URL}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          // Cloudflare Access service token for the tunnel
          "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
          "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
        },
        body: await req.text(),
      });
    }
    return new Response("SRIFT Worker — POST /mcp", { status: 200 });
  },
};
```
