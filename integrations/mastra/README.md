# Mastra integration

```ts
import { Mastra } from "@mastra/core";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Srift } from "../../sdk/node/srift.mjs";

const srift = new Srift();

const sriftQuickShare = createTool({
  id: "srift_quick_share",
  description: "Deliver a file to the user via E2EE P2P transfer.",
  inputSchema: z.object({ filePath: z.string(), sessionName: z.string().optional() }),
  execute: async ({ context }) => srift.quickShare(context.filePath, { sessionName: context.sessionName }),
});

new Mastra({
  agents: {
    courier: new Agent({ name: "courier", instructions: "You deliver files via SRIFT.", tools: { sriftQuickShare } }),
  },
});
```
