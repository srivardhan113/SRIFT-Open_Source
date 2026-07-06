"""
OpenAI function-calling × SRIFT.

Run: pip install openai && python function_calling.py
Requires: the SRIFT daemon to be running (auto-starts on first `srift` command).
"""
import json
import os
import sys
from openai import OpenAI

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python"))
from srift import Srift  # zero-dep client

client = OpenAI()
srift = Srift()

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "srift_quick_share",
            "description": "Deliver a file to the user via end-to-end-encrypted P2P transfer. Returns a share URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filePath": {"type": "string", "description": "Absolute path to the file on disk"},
                    "sessionName": {"type": "string"},
                },
                "required": ["filePath"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "srift_status",
            "description": "Get current session state and active transfers",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def run_tool(name: str, args: dict) -> str:
    if name == "srift_quick_share":
        return json.dumps(srift.quick_share(args["filePath"], args.get("sessionName")))
    if name == "srift_status":
        return json.dumps(srift.status())
    return json.dumps({"error": f"unknown tool {name}"})


def main(prompt: str):
    msgs = [{"role": "user", "content": prompt}]
    while True:
        resp = client.chat.completions.create(model="gpt-4o-mini", messages=msgs, tools=TOOLS)
        m = resp.choices[0].message
        msgs.append(m)
        if not m.tool_calls:
            print(m.content); return
        for tc in m.tool_calls:
            args = json.loads(tc.function.arguments)
            result = run_tool(tc.function.name, args)
            msgs.append({"role": "tool", "tool_call_id": tc.id, "content": result})


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "Share /tmp/test.txt with me using SRIFT.")
