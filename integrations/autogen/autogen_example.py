"""
Microsoft AutoGen × SRIFT.

Works with AutoGen 0.4+ (autogen-core, autogen-agentchat).
pip install autogen-agentchat autogen-core autogen-ext[openai]
"""
import os, sys, asyncio
from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.ui import Console
from autogen_ext.models.openai import OpenAIChatCompletionClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python"))
from srift import Srift

srift = Srift()

def srift_quick_share(filePath: str, sessionName: str = "") -> dict:
    """Deliver a file to the user via E2EE P2P transfer. Returns share URL."""
    return srift.quick_share(filePath, sessionName or None)

def srift_status() -> dict:
    """Get SRIFT session and active transfers."""
    return srift.status()

async def main():
    model = OpenAIChatCompletionClient(model="gpt-4o-mini")
    agent = AssistantAgent("file_courier", model_client=model, tools=[srift_quick_share, srift_status])
    await Console(agent.run_stream(task="Share /tmp/test.txt with me using SRIFT"))

if __name__ == "__main__":
    asyncio.run(main())
