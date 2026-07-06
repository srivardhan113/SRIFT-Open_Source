/**
 * Vercel AI SDK × SRIFT.
 *
 * npm install ai @ai-sdk/openai zod
 */
import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { Srift } from "../../sdk/node/srift.mjs";

const srift = new Srift();

const result = await generateText({
  model: openai("gpt-4o-mini"),
  tools: {
    srift_quick_share: tool({
      description: "Deliver a file to the user via E2EE P2P transfer. Returns a share URL.",
      parameters: z.object({ filePath: z.string(), sessionName: z.string().optional() }),
      execute: async ({ filePath, sessionName }) => srift.quickShare(filePath, { sessionName }),
    }),
    srift_status: tool({
      description: "SRIFT session + active transfers.",
      parameters: z.object({}),
      execute: async () => srift.status(),
    }),
  },
  maxSteps: 5,
  prompt: "Share /tmp/test.txt with me using SRIFT.",
});

console.log(result.text);
