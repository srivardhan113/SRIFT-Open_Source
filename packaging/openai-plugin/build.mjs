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

// The directory asks for tasks, intended users and limitations; this listing describes only what the
// hosted server does from ChatGPT (the local CLI's features are not part of this plugin).
const longDescription = limit('longDescription', [
  'SRIFT opens private rooms where people send files and chat directly between their own devices, end-to-end encrypted. Keys are generated on each device; the server never sees file or chat content and stores none of it. No account is needed to join.',
  '',
  'What you can ask ChatGPT to do: open a room and give you its join link, show who is in the room and who is waiting, let people in or turn them away, remove a participant, see which files were shared and whether they were accepted, join a room by its ID, close the room, and get help diagnosing a connection problem.',
  '',
  'Who it is for: anyone who wants to send large files or talk privately with someone, without uploading to a cloud drive or creating accounts, and who wants ChatGPT to set up and manage the room.',
  '',
  'Limitations: ChatGPT manages the room but cannot read, upload or send files itself; the people in the room send files from their own browser or the SRIFT app. Rooms are temporary and end when closed or after 7 days without activity.',
].join('\n'), 4000);

const plugin = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'srift',
  version: pkg.version,
  description: 'Open private, end-to-end encrypted rooms where people send files and chat directly between their devices: join links, who gets in, which files were shared. No accounts.',
  author: { name: 'SRIFT', url: 'https://srift.app' },
  homepage: 'https://srift.app',
  repository: 'https://github.com/srivardhan113/SRIFT-Open_Source',
  license: 'MIT',
  keywords: ['file-transfer', 'p2p', 'e2ee', 'decentralized', 'sessions', 'agent-to-agent'],
  extensions: {
    'com.openai': {
      interface: {
        displayName: limit('displayName', 'SRIFT', 30),
        shortDescription: limit('shortDescription', 'Private file-sharing rooms', 30),
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

// Only the skill written for this plugin: the shared plugin/skills/ describe the local CLI (installs,
// Peerknock, filesystem), which ChatGPT cannot use and the directory's skill scan flags.
const skillsSrc = path.join(import.meta.dirname, 'skills');
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
