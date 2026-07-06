# Zapier integration

## Webhooks by Zapier

1. New Zap → trigger of your choice.
2. Action: **Webhooks by Zapier** → **POST**.
3. URL: `http://127.0.0.1:3822/quick-share` (or expose the daemon via a tunnel for cloud Zaps).
4. Payload type: JSON.
5. Data: `filePath = {{trigger.path}}`, `sessionName = zap-{{trigger.title}}`.

## Zapier AI Actions

Zapier AI Actions accept any OpenAPI 3.x. Upload [`https://srift.app/openapi.json`](https://srift.app/openapi.json)
to expose all 14 SRIFT operations to any Zapier-connected GPT.

## Tunneling

Because the daemon binds to `127.0.0.1` by default, cloud Zapier needs a tunnel
(`ngrok http 3822`, `cloudflared tunnel`, `tailscale funnel 3822`) to reach it.
