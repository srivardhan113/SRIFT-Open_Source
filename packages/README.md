# SRIFT Workspace Packages

This directory contains standalone, publishable packages maintained within the SRIFT repository.

## Packages

| Package | Directory | Description | Distribution |
|---|---|---|---|
| [`srift-transfer`](./cli) | [`packages/cli`](./cli) | Official CLI tool and Model Context Protocol (MCP) server for SRIFT. | [npm: `srift-transfer`](https://www.npmjs.com/package/srift-transfer) |

---

## `srift-transfer` (`packages/cli`)

The `srift-transfer` package is built from `cli/{index,daemon}.ts` into an optimized, self-contained bundle for standalone npm distribution.

### Key Features
- **Zero-Config File Sharing**: Deliver files from AI agent environments via public download URLs (`srift quick-share`).
- **Native MCP Server**: Exposes 14 Model Context Protocol tools over stdio and Streamable HTTP for Claude, Cursor, Windsurf, Continue, Zed, and Codex.
- **Lightweight Dependencies**: Strips the website's frontend dependency tree (React, Next.js, Radix UI, etc.), shipping with only 6 lightweight runtime dependencies.
- **Cross-Platform**: Fully compatible with Node.js 20+ on Linux, macOS, and Windows.

### Building & Testing
```bash
# Build package bundles via esbuild into packages/cli/dist/
npm run build:cli

# Run package integrity, drift-guard, and packaging tests
npm test
```

For complete usage, CLI commands, and MCP client configurations, see [`packages/cli/README.md`](./cli/README.md).
