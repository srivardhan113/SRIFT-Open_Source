# Google Cloud Run integration

Cloud Run **can** host the SRIFT daemon — it supports long-running HTTP and WebSocket connections.

## Deploy SRIFT to Cloud Run

```bash
gcloud run deploy srift-daemon \
  --source . \
  --dockerfile integrations/docker/Dockerfile \
  --region asia-south1 \
  --port 3822 \
  --allow-unauthenticated \
  --set-env-vars SRIFT_PUBLIC_BASE=https://srift.app
```

After deploy, point your agent runtime at the Cloud Run URL:
```bash
export SRIFT_BASE_URL=https://srift-daemon-xxxxx-uc.a.run.app
```

## Concerns

- **Authentication**: by default `--allow-unauthenticated` makes the daemon public. Use Cloud Run
  IAM bindings to restrict. Or run with `--no-allow-unauthenticated` and use IAP / OIDC.
- **Statelessness**: Cloud Run instances may scale to zero; sessions die with them. Use
  `min-instances=1` for long-lived sessions.
- **WebTorrent**: outbound UDP works on Cloud Run; inbound does not — file transfers will use
  WebSocket relay fallback.

## Vertex AI Agent Builder

Wire SRIFT as an **OpenAPI tool** by uploading `https://srift.app/openapi.json`. Vertex AI Agent
Builder will auto-generate function declarations.
