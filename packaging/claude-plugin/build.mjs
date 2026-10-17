#!/usr/bin/env node
// Packages plugin/ as the ZIP that claude.ai accepts under Customize > Plugins > Add > Upload plugin.
// Verified against https://claude.com/docs/plugins/build (2026-10-17): the archive may hold the plugin
// folder as its single top-level entry, or the folder's contents directly; the manifest must then be at
// .claude-plugin/plugin.json. We ship the folder as the single top-level entry (`srift/...`).
import path from 'node:path';
import fs from 'node:fs';
import { collect, writeZip } from '../../scripts/lib/zip.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const plugin = path.join(root, 'plugin');
const manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
for (const must of ['.claude-plugin/plugin.json', 'README.md', 'LICENSE', 'icon.png', '.mcp.json', 'skills']) {
  if (!fs.existsSync(path.join(plugin, must))) throw new Error(`plugin/${must} missing`);
}
if (fs.existsSync(path.join(plugin, 'bin'))) throw new Error('a top-level bin/ stops claude.ai and Cowork from installing the plugin');

const out = path.join(import.meta.dirname, 'dist', `srift-claude-plugin-${manifest.version}.zip`);
const entries = collect(plugin, 'srift/').filter(([name]) => !/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/.test(name));
const r = writeZip(out, entries);
console.log(`wrote ${path.relative(root, out)} (${r.entries} files, ${r.bytes} bytes)`);
console.log('upload at: claude.ai → Customize → Plugins → Add → Upload plugin');
