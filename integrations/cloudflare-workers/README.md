# Cloudflare Workers integration

Workers can't host the SRIFT daemon (no long-running TCP), but they can call SRIFT discovery and
proxy MCP requests to a user's local daemon via Cloudflare Tunnel.

```js
// worker.mjs
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Proxy MCP JSON-RPC to the user's tunneled daemon.
    if (url.pathname === "/mcp" && req.method === "POST") {
      return fetch(`${env.SRIFT_TUNNEL_URL}/mcp`, { method: "POST", headers: req.headers, body: await req.text() });
    }

    // Serve discovery (static)
    if (url.pathname === "/.well-known/mcp/server-card.json") {
      return fetch("https://srift.app/.well-known/mcp/server-card.json");
    }

    return new Response("SRIFT Worker — POST /mcp", { status: 200 });
  },
};
```

For users to reach their local daemon from a Worker, ask them to run:
```bash
cloudflared tunnel --url http://127.0.0.1:3822
```
and set the resulting URL as `SRIFT_TUNNEL_URL` secret.
