# n8n integration

## Option 1 — HTTP Request node (simplest)

1. Add **HTTP Request** node.
2. Method: `POST`. URL: `http://127.0.0.1:3822/quick-share`.
3. Body (JSON):
   ```json
   { "filePath": "{{ $json.filePath }}", "sessionName": "n8n-{{ $workflow.name }}" }
   ```
4. The response includes `shareUrl`, `sessionId`, `fileId`. Map to downstream nodes.

## Option 2 — Pre-built workflow JSON

`workflow.json` (drop it into n8n → Import):

```json
{
  "name": "SRIFT Quick Share",
  "nodes": [
    {
      "parameters": { "httpMethod": "POST", "path": "srift-share" },
      "type": "n8n-nodes-base.webhook", "name": "Webhook", "position": [240, 300]
    },
    {
      "parameters": {
        "url": "http://127.0.0.1:3822/quick-share",
        "method": "POST", "sendBody": true, "contentType": "json",
        "jsonBody": "={\n  \"filePath\": \"={{ $json.body.filePath }}\",\n  \"sessionName\": \"n8n\"\n}"
      },
      "type": "n8n-nodes-base.httpRequest", "name": "SRIFT", "position": [540, 300]
    }
  ],
  "connections": { "Webhook": { "main": [[{ "node": "SRIFT", "type": "main", "index": 0 }]] } }
}
```

## n8n AI Agent node

n8n's built-in AI Agent supports Custom Tools. Add a Custom Tool with:
- **URL**: `http://127.0.0.1:3822/quick-share`
- **Method**: POST
- **Description**: "Deliver a file via SRIFT P2P E2EE transfer."
