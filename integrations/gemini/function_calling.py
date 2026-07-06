"""
Google Gemini × SRIFT — function-calling integration.

Works with Gemini 1.5 / 2.0 / 2.5 Pro and Flash. Also wires up for Vertex AI.

Run: pip install google-generativeai && export GOOGLE_API_KEY=... && python function_calling.py
"""
import os, sys, json
import google.generativeai as genai

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python"))
from srift import Srift

genai.configure(api_key=os.environ["GOOGLE_API_KEY"])
srift = Srift()

def srift_quick_share(filePath: str, sessionName: str = "") -> dict:
    """Deliver any local file to the user via E2EE P2P transfer. Returns a share URL."""
    return srift.quick_share(filePath, sessionName or None)

def srift_status() -> dict:
    """Get current SRIFT session and active transfers."""
    return srift.status()

def srift_send_chat(message: str) -> dict:
    """Send an E2EE chat message to the connected peer."""
    return srift.send_chat(message)

model = genai.GenerativeModel("gemini-2.0-flash", tools=[srift_quick_share, srift_status, srift_send_chat])
chat = model.start_chat(enable_automatic_function_calling=True)

if __name__ == "__main__":
    prompt = sys.argv[1] if len(sys.argv) > 1 else "Share /tmp/test.txt with me using SRIFT."
    r = chat.send_message(prompt)
    print(r.text)
