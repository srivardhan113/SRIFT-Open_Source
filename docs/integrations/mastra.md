# Mastra + SRIFT

Verified against `mastra.ai/reference/tools/mcp-client` and
`mastra.ai/docs/mcp/overview`. `MCPClient` auto-detects stdio vs. HTTP based
on whether you provide `command` or `url`.

```bash
npm install @mastra/mcp
```

## Local stdio (full 15-tool catalogue, requires Node.js)

```ts
import { MCPClient } from '@mastra/mcp';

const mcp = new MCPClient({
  servers: {
    srift: {
      command: 'npx',
      args: ['-y', 'srift-transfer', 'mcp'],
    },
  },
});

const tools = await mcp.getTools();
```

## Hosted (zero-install, 9-tool session/control subset)

```ts
import { MCPClient } from '@mastra/mcp';

const mcp = new MCPClient({
  servers: {
    srift: {
      url: new URL('https://srift.app/mcp'),
    },
  },
});

const tools = await mcp.getTools();
```

Pass `tools` (or `toolsets`, for per-request/per-user server configs — see
Mastra's docs) into a Mastra `Agent`'s `tools` option.
