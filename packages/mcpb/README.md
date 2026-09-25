# SRIFT .mcpb bundle

An [MCP Bundle](https://github.com/anthropics/mcpb) (`manifest_version: "0.3"`,
verified against `MANIFEST.md` in that repo) that lets Claude Desktop (and any
other MCPB-aware host) install SRIFT's MCP server with one click/drag instead
of hand-editing JSON config.

- `manifest.json` — the bundle manifest. **Generated, not hand-edited.**
  `tools` is derived from `lib/mcp/core.mjs`'s `MCP_TOOLS` (the single source
  of truth also used by the stdio and hosted MCP transports), so it can never
  drift out of sync with the real tool catalogue.
- `build.mjs` — regenerates `manifest.json`, stages `packages/cli/dist/` +
  the manifest + an icon into `staging/`, and (with `--pack`) zips it into
  `srift.mcpb` via `npx @anthropic-ai/mcpb pack`.

## Build

```bash
node packages/cli/build.mjs   # ensure packages/cli/dist/ is fresh
node packages/mcpb/build.mjs --pack
```

Produces `packages/mcpb/srift.mcpb`. Without `--pack` it only refreshes
`manifest.json` and `staging/` (useful for diffing what would change without
needing the `@anthropic-ai/mcpb` CLI installed).

## Distributing

Attach `srift.mcpb` to each GitHub release (wired into
`.github/workflows/release-distribution.yml`'s `mcpb` job) so users can
download it directly from the Releases page, and submit it to the
[Anthropic MCPB directory](https://github.com/anthropics/mcpb) /
[Smithery](https://smithery.ai) / [Glama](https://glama.ai) bundle listings
per their respective submission docs (out of scope here — packaging only).

## Unverified

The exact JSON Schema for the `compatibility` block (`platforms`/`runtimes`
key names and value shapes) was not confirmed against a byte-exact schema
example at time of writing — `MANIFEST.md`'s prose describes it as "platform
and runtime requirements" without a full worked example. Re-check
`github.com/anthropics/mcpb/blob/main/MANIFEST.md` before relying on that
block to gate installs in a host that enforces it strictly.
