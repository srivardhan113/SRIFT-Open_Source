# Make.com (formerly Integromat) integration

1. Add module: **HTTP > Make a request**.
2. URL: `http://127.0.0.1:3822/quick-share`
3. Method: POST
4. Headers: `Content-Type: application/json`
5. Body type: Raw, Content type: JSON
6. Request content:
   ```json
   { "filePath": "{{1.filePath}}", "sessionName": "make-scenario" }
   ```
7. Parse response and reference `shareUrl`, `sessionId`, `fileId` downstream.

Cloud scenarios need a tunnel (`ngrok`, `cloudflared`, `tailscale funnel`) to reach a local daemon.
