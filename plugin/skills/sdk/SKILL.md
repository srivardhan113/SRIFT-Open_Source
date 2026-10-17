---
name: sdk
description: Call the local SRIFT daemon from Python, Node, Go, Rust, Java, .NET, PHP, Ruby, shell, or curl. Use when writing application code rather than invoking MCP tools.
---

# sdk

The language SDKs are thin clients of the local daemon at `http://127.0.0.1:3822`. They are not separate networks. The Claude plugin already starts the local MCP server (`srift mcp`, 15 tools), Peerknock (`srift peerknock mcp`, 25 `srift_pk_*` tools), and the hosted endpoint `https://srift.app/mcp` (9 tools, no filesystem). Use an SDK when the task is application code.

## Which install

| Need | Use |
|---|---|
| CLI and local MCP from Node | `npm i -g srift-transfer`, then `srift mcp` (npm package `srift-transfer`, command name `srift`) |
| CLI, local MCP, and the Python SDK | `pip install srift`, then `srift mcp` (PyPI package `srift`) |
| Peerknock MCP | the same install, then `srift peerknock mcp`. Read https://srift.app/.well-known/agent-skills/peerknock/SKILL.md first |
| Hosted session tools, no install | `POST https://srift.app/mcp` |
| Any other language | one file from `https://srift.app/sdk/<lang>/` |

npm and PyPI ship the same CLI. Do not start both: they both bind `127.0.0.1:3822`.

## Python (published)

```python
from srift import Srift
print(Srift().quick_share("/abs/path/file.zip")["downloadUrl"])
```

## Node (single file; the library package `srift` is not on npm yet)

```js
import { Srift } from "./srift.mjs";
const s = new Srift();
await s.quickShare("/abs/path/file.zip");
```

Download: `https://srift.app/sdk/node/srift.mjs`

## Other languages (source in this repo; download the file; not on a package registry yet)

- Go: `https://srift.app/sdk/go/srift.go`
- Rust: `https://srift.app/sdk/rust/srift.rs`
- Java: `https://srift.app/sdk/java/Srift.java`
- .NET: `https://srift.app/sdk/dotnet/Srift.cs`
- PHP: `https://srift.app/sdk/php/srift.php`
- Ruby: `https://srift.app/sdk/ruby/srift.rb`
- Shell: `https://srift.app/sdk/shell/srift.sh`
- PowerShell: `https://srift.app/sdk/shell/srift.ps1`
- curl recipes: `https://srift.app/sdk/curl/recipes.sh`

Go, Rust, Java, .NET, PHP, and Ruby implement the core REST calls (quick share, sessions, chat, transfers). Node and Python also stream events and speak MCP-over-HTTP. Set `SRIFT_BASE_URL` only to change the local port.
