"""
LangChain × SRIFT — register SRIFT tools for any LangChain agent.

Run: pip install langchain langchain-openai && python langchain_python.py
"""
import os, sys
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.prompts import ChatPromptTemplate

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python"))
from srift import Srift

srift = Srift()

@tool
def srift_quick_share(filePath: str, sessionName: str = "") -> dict:
    """Deliver a file to the user via E2EE P2P transfer. Returns a share URL."""
    return srift.quick_share(filePath, sessionName or None)

@tool
def srift_status() -> dict:
    """Get current SRIFT session and active transfers."""
    return srift.status()

@tool
def srift_send_chat(message: str) -> dict:
    """Send an E2EE chat message to the connected SRIFT peer."""
    return srift.send_chat(message)

llm = ChatOpenAI(model="gpt-4o-mini")
prompt = ChatPromptTemplate.from_messages([
    ("system", "You can use SRIFT to deliver files to the user."),
    ("user", "{input}"),
    ("placeholder", "{agent_scratchpad}"),
])
agent = create_tool_calling_agent(llm, [srift_quick_share, srift_status, srift_send_chat], prompt)
executor = AgentExecutor(agent=agent, tools=[srift_quick_share, srift_status, srift_send_chat])

if __name__ == "__main__":
    print(executor.invoke({"input": "Share /tmp/test.txt with me"}))
