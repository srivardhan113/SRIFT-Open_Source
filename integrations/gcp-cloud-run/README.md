# Google Cloud Run integration

The SRIFT daemon listens on `127.0.0.1` only, has no authentication, and accepts only loopback
`Host` headers. Never deploy it as a public Cloud Run service. Use one of these instead.

## Option 1 — run SRIFT inside your agent's container (simplest)

Install the CLI in the agent image and share files from the same process tree:

```dockerfile
RUN npm install -g srift-transfer     # or: pip install srift
```

```bash
srift quick-share /tmp/report.pdf --json --wait --wait-timeout 30m
```

In a sandbox that blocks background processes, quick-share serves from its own process
(`--foreground`) and needs only outbound HTTPS/WSS on port 443. Keep the instance alive until the
download finishes (the link streams from the instance; nothing is stored).

## Option 2 — sidecar container in the same service

Cloud Run multi-container services share `localhost` between containers. Add the daemon as a
sidecar (image from `integrations/docker/Dockerfile`) and call `http://127.0.0.1:3822` from the
agent container. Only the agent container gets the ingress port; the sidecar gets none.

```yaml
# service.yaml (excerpt)
spec:
  template:
    spec:
      containers:
        - name: agent
          image: REGION-docker.pkg.dev/PROJECT/repo/agent
          ports: [{ containerPort: 8080 }]
          env: [{ name: SRIFT_BASE_URL, value: "http://127.0.0.1:3822" }]
        - name: srift
          image: REGION-docker.pkg.dev/PROJECT/repo/srift-daemon:4.1.0
```

Notes:
- Instances can scale to zero; sessions and links die with the instance. Use `min-instances=1`
  (and CPU always allocated) if links must stay up.
- Transfers use the encrypted WebSocket relay; no inbound ports are needed.

## Vertex AI Agent Builder

Use the hosted MCP endpoint `https://srift.app/mcp` for session control, or wire the local daemon
API from https://srift.app/openapi.json as an OpenAPI tool that runs next to a daemon as above.
