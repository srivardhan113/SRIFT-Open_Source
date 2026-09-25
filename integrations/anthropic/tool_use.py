"""
Claude (Anthropic) Messages API × SRIFT tool use.

Run: pip install anthropic && python tool_use.py
"""
import json, os, sys
import anthropic

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python"))
from srift import Srift

client = anthropic.Anthropic()
srift = Srift()

TOOLS = [
    {
        "name": "srift_quick_share",
        "description": "Share a local file with the user. Returns a download link (https://srift.app/d/<token>) that opens in any browser; the file streams from this machine and is not stored on a server.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filePath": {"type": "string"},
                "sessionName": {"type": "string"},
            },
            "required": ["filePath"],
        },
    },
    {
        "name": "srift_send_chat",
        "description": "Send an E2EE chat message to the connected SRIFT peer.",
        "input_schema": {"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]},
    },
    {
        "name": "srift_status",
        "description": "Get session + transfers + pending joins.",
        "input_schema": {"type": "object", "properties": {}},
    },
]


def run_tool(name, args):
    if name == "srift_quick_share": return srift.quick_share(args["filePath"], args.get("sessionName"))
    if name == "srift_send_chat":   return srift.send_chat(args["message"])
    if name == "srift_status":      return srift.status()
    return {"error": f"unknown tool: {name}"}


def main(prompt):
    messages = [{"role": "user", "content": prompt}]
    while True:
        r = client.messages.create(model="claude-sonnet-5", max_tokens=2048, tools=TOOLS, messages=messages)
        messages.append({"role": "assistant", "content": r.content})
        if r.stop_reason != "tool_use":
            for blk in r.content:
                if blk.type == "text": print(blk.text)
            return
        tool_results = []
        for blk in r.content:
            if blk.type == "tool_use":
                out = run_tool(blk.name, blk.input)
                tool_results.append({"type": "tool_result", "tool_use_id": blk.id, "content": json.dumps(out)})
        messages.append({"role": "user", "content": tool_results})


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "Please share /tmp/test.txt with me using SRIFT.")
