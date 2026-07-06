"""
CrewAI × SRIFT — give any Crew agent file-delivery superpowers.

pip install crewai crewai-tools
"""
import os, sys
from crewai import Agent, Task, Crew
from crewai.tools import tool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python"))
from srift import Srift

srift = Srift()

@tool("SRIFT Quick Share")
def quick_share(file_path: str) -> str:
    """Deliver a local file to the user via E2EE P2P transfer. Returns share URL."""
    r = srift.quick_share(file_path)
    return f"Share URL: {r['shareUrl']}  (session {r['sessionId']}, file {r['fileId']})"

courier = Agent(
    role="File Courier",
    goal="Deliver files to the user securely.",
    backstory="You use SRIFT to ship files without uploading them to any cloud.",
    tools=[quick_share],
)

task = Task(description="Share /tmp/build.zip with the user.", agent=courier, expected_output="A share URL.")
print(Crew(agents=[courier], tasks=[task]).kickoff())
