# Docker MCP Catalog submission

Staging copy of the three files `docker/mcp-registry` requires for a
**remote** (non-containerized) server, per that repo's `CONTRIBUTING.md`:

```
srift/
├── server.yaml   # name, type: remote, meta, about, remote.{transport_type,url}
├── tools.json    # [] — remote servers use dynamic tool discovery
└── readme.md
```

`server.yaml` points at SRIFT's existing hosted MCP endpoint
(`https://srift.app/mcp`, streamable-http, 8-tool orchestration subset — see
`AGENTS.md`) — no Dockerfile or image build is required for a remote-type
submission.

## To submit (maintainer, manual — do not automate the fork/PR)

```bash
gh repo fork docker/mcp-registry --clone
cp -r packaging/docker-mcp/srift docker-mcp-registry/servers/srift
cd docker-mcp-registry
git checkout -b add-srift
git add servers/srift
git commit -m "Add SRIFT remote MCP server"
git push -u origin add-srift
gh pr create --repo docker/mcp-registry --title "Add SRIFT remote MCP server" \
  --body "Adds servers/srift — hosted, zero-auth MCP endpoint at https://srift.app/mcp."
```

Re-verify the schema against the live `CONTRIBUTING.md` before submitting —
the registry's format is not versioned/stable and may have changed.
