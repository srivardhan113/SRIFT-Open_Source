#!/usr/bin/env node
// Builds the ZIP for the ChatGPT + Codex plugin directory (platform.openai.com/plugins).
// Verified against developers.openai.com/plugins/build/plugins and /plugins/deploy/submission (2026-10-17):
//   - plugin.json (Agent Plugins 1.0.0 schema) at the ZIP ROOT, not inside a wrapper folder
//   - mcp.json at the root with the ONE remote server ("type": "streamable-http"); no auth block for a public server
//   - skills/<name>/SKILL.md, assets/ (square PNG >= 48 px for logo and composerIcon, <= 5 MiB, <= 4096 px)
//   - OpenAI-specific listing fields under extensions["com.openai"].interface; paths start with ./
//   - displayName and shortDescription <= 30 chars, longDescription <= 4000; no "MCP"/"Plugin" in the name
import fs from 'node:fs';
import path from 'node:path';
import { collect, writeZip } from '../../scripts/lib/zip.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const stage = path.join(import.meta.dirname, 'dist', 'stage');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')); // version source that also exists in the public mirror
const limit = (label, s, max) => { if (s.length > max) throw new Error(`${label} is ${s.length} chars, max ${max}`); return s; };

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'assets'), { recursive: true });

const longDescription = limit('longDescription', [
  'SRIFT is decentralized, end-to-end encrypted file transfer, chat and calls: human to human, human to AI agent, and AI agent to AI agent. Keys are generated on the devices, nothing is stored on a server, there is no database and no account.',
  '',
  'From ChatGPT or Codex this plugin reaches the hosted SRIFT server at https://srift.app/mcp: open an end-to-end encrypted session and get a join link anyone can open in a browser, approve or reject who joins, see who is in the room, watch transfers with speed and ETA, read the session state, close the session, and run a network diagnosis that says which transports work and how to fix the ones that do not.',
  '',
  'Sending files from this machine, encrypted chat between peers, and Peerknock (agent-to-agent addresses, live search, knocks, chat, files, groups and calls) run on the local SRIFT CLI (npm srift-transfer, PyPI srift) and are described by the bundled skills, which also tell an agent how to install it. Open source, MIT.',
].join('\n'), 4000);

const plugin = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'srift',
  version: pkg.version,
  description: 'Decentralized, end-to-end encrypted file transfer, chat and calls: human to human, human to AI agent, and AI agent to AI agent. Sessions, join links, transfers, diagnostics. No accounts.',
  author: { name: 'SRIFT', url: 'https://srift.app' },
  homepage: 'https://srift.app',
  repository: 'https://github.com/srivardhan113/SRIFT-Open_Source',
  license: 'MIT',
  keywords: ['file-transfer', 'p2p', 'e2ee', 'decentralized', 'sessions', 'agent-to-agent'],
  extensions: {
    'com.openai': {
      interface: {
        displayName: limit('displayName', 'SRIFT', 30),
        shortDescription: limit('shortDescription', 'Decentralized E2EE sharing', 30),
        longDescription,
        developerName: 'SRIFT',
        category: 'Productivity',
        websiteURL: 'https://srift.app',
        supportURL: 'https://srift.app/.well-known/security.txt',
        privacyPolicyURL: 'https://srift.app/privacy',
        termsOfServiceURL: 'https://srift.app/privacy#terms',
        defaultPrompt: [
          'Start a SRIFT session and give me the join link',
          'Who is in my SRIFT session and are any transfers running?',
          'Run SRIFT network diagnostics and tell me what to fix',
        ],
        brandColor: '#7C3AED',
        logo: './assets/logo.png',
        composerIcon: './assets/logo.png',
      },
    },
  },
};
fs.writeFileSync(path.join(stage, 'plugin.json'), JSON.stringify(plugin, null, 2) + '\n');

const mcp = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: { srift: { type: 'streamable-http', url: 'https://srift.app/mcp' } },
};
fs.writeFileSync(path.join(stage, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n');

const skillsSrc = path.join(root, 'plugin', 'skills');
for (const name of fs.readdirSync(skillsSrc)) {
  const src = path.join(skillsSrc, name, 'SKILL.md');
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(path.join(stage, 'skills', name), { recursive: true });
  fs.copyFileSync(src, path.join(stage, 'skills', name, 'SKILL.md'));
}
const icon = fs.readFileSync(path.join(root, 'plugin', 'icon.png'));
const w = icon.readUInt32BE(16), h = icon.readUInt32BE(20);
if (w !== h || w < 48 || w > 4096 || icon.length > 5 * 1024 * 1024) throw new Error(`icon must be square, 48..4096 px, <= 5 MiB (got ${w}x${h}, ${icon.length} bytes)`);
fs.writeFileSync(path.join(stage, 'assets', 'logo.png'), icon);
fs.copyFileSync(path.join(root, 'plugin', 'LICENSE'), path.join(stage, 'LICENSE'));
fs.writeFileSync(path.join(stage, 'README.md'),
  `# SRIFT\n\n${plugin.description}\n\nRemote MCP server: https://srift.app/mcp (no authentication). Privacy: https://srift.app/privacy. Terms: https://srift.app/privacy#terms. Support: https://srift.app/.well-known/security.txt. Source: ${plugin.repository}\n`);

// The manifest sits at the ZIP root (no wrapper folder).
const out = path.join(import.meta.dirname, 'dist', `srift-openai-plugin-${pkg.version}.zip`);
const r = writeZip(out, collect(stage, ''));
console.log(`wrote ${path.relative(root, out)} (${r.entries} files, ${r.bytes} bytes); staged tree in ${path.relative(root, stage)}`);
console.log('upload at: https://platform.openai.com/plugins → Upload new or existing plugin');
