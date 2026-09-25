# Vercel AI SDK + SRIFT

Verified against `ai-sdk.dev/docs/reference/ai-sdk-core/create-mcp-client`
and `ai-sdk.dev/docs/reference/ai-sdk-core/mcp-stdio-transport`. The MCP
client (`createMCPClient` / `Experimental_StdioMCPTransport`) is marked
experimental by Vercel and Node.js-only for stdio — expect the import path
(`@ai-sdk/mcp`) to move as it stabilizes.

```bash
npm install @ai-sdk/mcp
```

## Local stdio (full 15-tool catalogue, requires Node.js)

```ts
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';

const client = await createMCPClient({
  transport: new Experimental_StdioMCPTransport({
    command: 'npx',
    args: ['-y', 'srift-transfer', 'mcp'],
  }),
});

const tools = await client.tools();
```

## Hosted (zero-install, 9-tool session/control subset)

```ts
import { createMCPClient } from '@ai-sdk/mcp';

const client = await createMCPClient({
  transport: { type: 'http', url: 'https://srift.app/mcp' }, // Streamable HTTP
});

const tools = await client.tools();
```

Pass `tools` into `generateText`/`streamText`'s `tools` option alongside any
other AI SDK tools. Close the client (`await client.close()`) when done —
the stdio transport keeps a subprocess alive otherwise.

`https://srift.app/mcp` speaks MCP's Streamable HTTP transport (it does not serve the legacy
SSE transport), so use `type: 'http'`. The local daemon also serves legacy SSE at
`http://127.0.0.1:3822/mcp/sse` for older clients.
