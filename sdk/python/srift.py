"""
SRIFT Python SDK — zero-config, zero-dep client for the local SRIFT daemon.

Works with: CPython 3.8+, PyPy, Conda, Poetry, Pipenv, uv, rye, hatch.
Runs on:    Windows, macOS, Linux, WSL, Termux, iSH, Replit, Codespaces, Lambda,
            Cloud Run, GKE, EKS, Fargate, Cloudflare Sandbox, Vercel Edge (Python),
            Modal, RunPod, SageMaker, Databricks, Colab, Jupyter, Kaggle.

Zero external dependencies. Uses only stdlib (urllib + json).

Usage:
    from srift import Srift
    srift = Srift()
    result = srift.quick_share("/abs/path/file.zip")
    print(result["shareUrl"])   # → https://srift.app/join-session?id=ABC1234

Async usage (if you want non-blocking, requires Python 3.8+):
    from srift import AsyncSrift
    async with AsyncSrift() as s:
        result = await s.quick_share("/abs/path/file.zip")
"""
from __future__ import annotations
import json
import os
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional

__all__ = ["Srift", "AsyncSrift", "SriftError"]
__version__ = "2.0.0"


class SriftError(RuntimeError):
    """Raised when the daemon returns an error or is unreachable."""


class Srift:
    """Synchronous client for the SRIFT local daemon (default: http://127.0.0.1:3822)."""

    def __init__(self, base_url: Optional[str] = None, timeout: float = 30.0):
        self.base_url = (base_url or os.environ.get("SRIFT_BASE_URL") or "http://127.0.0.1:3822").rstrip("/")
        self.timeout = timeout

    # ─── HTTP plumbing ──────────────────────────────────────────────────────
    def _call(self, path: str, method: str = "GET", body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode("utf-8"))
                raise SriftError(err.get("error", str(e))) from e
            except json.JSONDecodeError:
                raise SriftError(f"HTTP {e.code}: {e.reason}") from e
        except urllib.error.URLError as e:
            raise SriftError(
                f"Daemon unreachable at {self.base_url}. Start it with: srift daemon start\n"
                f"({e.reason})"
            ) from e

    # ─── Health ─────────────────────────────────────────────────────────────
    def is_alive(self) -> bool:
        try:
            self._call("/status")
            return True
        except SriftError:
            return False

    def status(self) -> Dict[str, Any]:
        """Get session details + active transfers + pending join requests."""
        return self._call("/status")

    def state(self) -> Dict[str, Any]:
        """Read the workspace .srift-state.json snapshot."""
        return self._call("/state")

    # ─── Session ────────────────────────────────────────────────────────────
    def start_session(self, name: Optional[str] = None, room_secret: Optional[str] = None) -> Dict[str, Any]:
        return self._call("/session/start", "POST", {"sessionName": name, "roomSecret": room_secret})

    def join_session(self, session_id: str, username: Optional[str] = None, room_secret: Optional[str] = None) -> Dict[str, Any]:
        return self._call("/session/join", "POST", {"sessionId": session_id, "username": username, "roomSecret": room_secret})

    def approve_join(self, temp_user_id: str) -> Dict[str, Any]:
        return self._call("/session/approve", "POST", {"tempUserId": temp_user_id})

    def reject_join(self, temp_user_id: str, reason: Optional[str] = None) -> Dict[str, Any]:
        return self._call("/session/reject", "POST", {"tempUserId": temp_user_id, "reason": reason})

    def kick_user(self, user_id: str) -> Dict[str, Any]:
        return self._call("/session/kick", "POST", {"userId": user_id})

    def close_session(self) -> Dict[str, Any]:
        return self._call("/session/close", "POST")

    # ─── Transfer ───────────────────────────────────────────────────────────
    def send_file(self, file_path: str, protocol: Optional[str] = None) -> Dict[str, Any]:
        return self._call("/send", "POST", {"filePath": file_path, "protocol": protocol})

    def accept_transfer(self, file_id: str, save_dir: Optional[str] = None) -> Dict[str, Any]:
        return self._call("/receive", "POST", {"fileId": file_id, "saveDir": save_dir})

    def list_transfers(self) -> List[Dict[str, Any]]:
        s = self.status()
        return s.get("activeTransfers", [])

    def quick_share(self, file_path: str, session_name: Optional[str] = None) -> Dict[str, Any]:
        """One-shot: ensure session, seed file, return share URL. Use this 90% of the time."""
        return self._call("/quick-share", "POST", {"filePath": file_path, "sessionName": session_name})

    # ─── Chat ───────────────────────────────────────────────────────────────
    def send_chat(self, message: str) -> Dict[str, Any]:
        return self._call("/chat/send", "POST", {"message": message})

    def chat_history(self) -> List[Dict[str, Any]]:
        return self._call("/chat/history")

    # ─── SSE event stream ───────────────────────────────────────────────────
    def stream_events(self):
        """Generator that yields {event, data} dicts from /api/v1/monitor/events."""
        req = urllib.request.Request(f"{self.base_url}/api/v1/monitor/events")
        resp = urllib.request.urlopen(req, timeout=None)
        event_type = "message"
        for raw in resp:
            line = raw.decode("utf-8").rstrip("\n")
            if line.startswith("event: "):
                event_type = line[7:].strip()
            elif line.startswith("data: "):
                try:
                    yield {"event": event_type, "data": json.loads(line[6:])}
                except json.JSONDecodeError:
                    yield {"event": event_type, "data": line[6:]}
                event_type = "message"


# ─── Async client (asyncio) ─────────────────────────────────────────────────
class AsyncSrift:
    """Async client. Requires aiohttp OR falls back to threadpool of sync client."""

    def __init__(self, base_url: Optional[str] = None, timeout: float = 30.0):
        self._sync = Srift(base_url, timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def _run(self, fn, *args, **kwargs):
        import asyncio
        return await asyncio.get_event_loop().run_in_executor(None, lambda: fn(*args, **kwargs))

    async def is_alive(self) -> bool:
        return await self._run(self._sync.is_alive)

    async def state(self) -> Dict[str, Any]:
        return await self._run(self._sync.state)

    async def quick_share(self, file_path: str, session_name: Optional[str] = None) -> Dict[str, Any]:
        return await self._run(self._sync.quick_share, file_path, session_name)

    async def status(self) -> Dict[str, Any]:
        return await self._run(self._sync.status)

    async def send_chat(self, message: str) -> Dict[str, Any]:
        return await self._run(self._sync.send_chat, message)

    async def start_session(self, **kw) -> Dict[str, Any]:
        return await self._run(self._sync.start_session, **kw)

    async def join_session(self, session_id: str, **kw) -> Dict[str, Any]:
        return await self._run(self._sync.join_session, session_id, **kw)

    async def approve_join(self, temp_user_id: str) -> Dict[str, Any]:
        return await self._run(self._sync.approve_join, temp_user_id)

    async def reject_join(self, temp_user_id: str, reason: Optional[str] = None) -> Dict[str, Any]:
        return await self._run(self._sync.reject_join, temp_user_id, reason)

    async def kick_user(self, user_id: str) -> Dict[str, Any]:
        return await self._run(self._sync.kick_user, user_id)

    async def close_session(self) -> Dict[str, Any]:
        return await self._run(self._sync.close_session)

    async def send_file(self, file_path: str, **kw) -> Dict[str, Any]:
        return await self._run(self._sync.send_file, file_path, **kw)

    async def accept_transfer(self, file_id: str, **kw) -> Dict[str, Any]:
        return await self._run(self._sync.accept_transfer, file_id, **kw)

    async def chat_history(self) -> List[Dict[str, Any]]:
        return await self._run(self._sync.chat_history)

    async def list_transfers(self) -> List[Dict[str, Any]]:
        return await self._run(self._sync.list_transfers)



# ─── MCP client (JSON-RPC over HTTP) ────────────────────────────────────────
class SriftMCP:
    """Minimal MCP HTTP transport client — useful when wrapping SRIFT as a sub-tool."""
    def __init__(self, base_url: Optional[str] = None):
        self.base_url = (base_url or "http://127.0.0.1:3822").rstrip("/")
        self._id = 0

    def _next_id(self):
        self._id += 1
        return self._id

    def call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        body = {"jsonrpc": "2.0", "id": self._next_id(), "method": method}
        if params is not None:
            body["params"] = params
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(f"{self.base_url}/mcp", data=data, method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        if "error" in payload:
            raise SriftError(payload["error"].get("message", "MCP error"))
        return payload.get("result", {})

    def initialize(self, client_name: str = "srift-python-sdk") -> Dict[str, Any]:
        return self.call("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": client_name, "version": __version__},
        })

    def tools(self) -> List[Dict[str, Any]]:
        return self.call("tools/list").get("tools", [])

    def tool(self, name: str, **args) -> Any:
        return self.call("tools/call", {"name": name, "arguments": args})


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python srift.py <quick-share|status|...> [args]")
        sys.exit(1)
    s = Srift()
    cmd = sys.argv[1]
    if cmd == "quick-share":
        print(json.dumps(s.quick_share(sys.argv[2]), indent=2))
    elif cmd == "status":
        print(json.dumps(s.status(), indent=2))
    elif cmd == "send":
        print(json.dumps(s.send_file(sys.argv[2]), indent=2))
    elif cmd == "chat":
        print(json.dumps(s.send_chat(sys.argv[2]), indent=2))
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
