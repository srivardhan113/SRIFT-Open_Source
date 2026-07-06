/**
 * LangChain JS × SRIFT.
 *
 * npm install @langchain/openai @langchain/core langchain
 * node langchain_js.mjs
 */
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { createToolCallingAgent, AgentExecutor } from "langchain/agents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { Srift } from "../../sdk/node/srift.mjs";

const srift = new Srift();

const sriftQuickShare = tool(async ({ filePath, sessionName }) => srift.quickShare(filePath, { sessionName }), {
  name: "srift_quick_share",
  description: "Deliver a file to the user via E2EE P2P transfer. Returns a share URL.",
  schema: z.object({ filePath: z.string(), sessionName: z.string().optional() }),
});

const sriftStatus = tool(async () => srift.status(), {
  name: "srift_status",
  description: "Get SRIFT session and active transfers.",
  schema: z.object({}),
});

const llm = new ChatOpenAI({ model: "gpt-4o-mini" });
const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You can use SRIFT to deliver files to the user."],
  ["user", "{input}"],
  ["placeholder", "{agent_scratchpad}"],
]);

const agent = createToolCallingAgent({ llm, tools: [sriftQuickShare, sriftStatus], prompt });
const executor = new AgentExecutor({ agent, tools: [sriftQuickShare, sriftStatus] });

console.log(await executor.invoke({ input: "Share /tmp/test.txt with me" }));
