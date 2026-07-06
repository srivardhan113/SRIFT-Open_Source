"""
DSPy × SRIFT — declare SRIFT as a DSPy tool.
pip install dspy-ai
"""
import os, sys
import dspy

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python"))
from srift import Srift

srift = Srift()

class QuickShare(dspy.Tool):
    def __init__(self):
        super().__init__(
            name="srift_quick_share",
            desc="Deliver a local file to the user via E2EE P2P transfer. Returns share URL.",
            input_keys=["filePath"],
        )
    def __call__(self, filePath: str):
        return srift.quick_share(filePath)

dspy.settings.configure(lm=dspy.OpenAI(model="gpt-4o-mini"))
agent = dspy.ReAct("question -> answer", tools=[QuickShare()])
print(agent(question="Share /tmp/test.txt with me"))
