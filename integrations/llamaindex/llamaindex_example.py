"""
LlamaIndex × SRIFT.
pip install llama-index llama-index-llms-openai
"""
import os, sys
from llama_index.core.tools import FunctionTool
from llama_index.core.agent import ReActAgent
from llama_index.llms.openai import OpenAI

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python"))
from srift import Srift

srift = Srift()

quick_share_tool = FunctionTool.from_defaults(
    fn=lambda filePath, sessionName="": srift.quick_share(filePath, sessionName or None),
    name="srift_quick_share",
    description="Deliver a local file to the user via E2EE P2P transfer. Returns a share URL.",
)
status_tool = FunctionTool.from_defaults(fn=srift.status, name="srift_status", description="Current SRIFT session state.")

agent = ReActAgent.from_tools([quick_share_tool, status_tool], llm=OpenAI(model="gpt-4o-mini"), verbose=True)
print(agent.chat("Share /tmp/test.txt with me using SRIFT"))
