/**
 * SRIFT AgentNet — self-description.
 *
 * Every discoverable agent advertises a one-line description of itself. The
 * best author is the agent's own LLM (MCP tool `srift_an_announce`). For
 * headless agents / VMs, `autoDescribe()` writes one from what the machine can
 * observe about itself: its profile, the project it serves (package.json,
 * pyproject.toml, Cargo.toml, go.mod, README), and where it runs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Profile } from './local.ts';

const MAX = 160;

function read(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function firstSentence(s: string): string {
  const clean = s.replace(/[`*_#>\[\]]/g, '').replace(/\s+/g, ' ').trim();
  const m = clean.match(/^(.{20,}?[.!?])(\s|$)/);
  return (m ? m[1] : clean).slice(0, 140);
}

export type ProjectInfo = { name?: string; summary?: string; stack?: string };

/** What project does this agent live in? (cwd, walking up at most 3 levels) */
export function detectProject(start = process.cwd()): ProjectInfo {
  let dir = start;
  for (let i = 0; i < 4; i++) {
    const pkg = read(path.join(dir, 'package.json'));
    if (pkg) {
      try {
        const j = JSON.parse(pkg);
        // Private projects are never advertised to the network.
        if (j.private === true) return { stack: 'Node.js' };
        return { name: j.name, summary: j.description, stack: 'Node.js' };
      } catch { /* not json */ }
    }
    const py = read(path.join(dir, 'pyproject.toml'));
    if (py) {
      return {
        name: py.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1],
        summary: py.match(/^\s*description\s*=\s*"([^"]+)"/m)?.[1],
        stack: 'Python',
      };
    }
    const cargo = read(path.join(dir, 'Cargo.toml'));
    if (cargo) {
      return {
        name: cargo.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1],
        summary: cargo.match(/^\s*description\s*=\s*"([^"]+)"/m)?.[1],
        stack: 'Rust',
      };
    }
    const gomod = read(path.join(dir, 'go.mod'));
    if (gomod) return { name: gomod.match(/^module\s+(\S+)/m)?.[1]?.split('/').pop(), stack: 'Go' };
    // README content is NOT used: it may describe private work. Only published manifests are.
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

function runtimeLabel(): string {
  if (process.env.KUBERNETES_SERVICE_HOST) return 'Kubernetes';
  if (fs.existsSync('/.dockerenv')) return 'container';
  if (process.env.GITHUB_ACTIONS) return 'GitHub Actions';
  if (process.env.CODESPACES) return 'Codespace';
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return 'AWS Lambda';
  if (process.env.K_SERVICE) return 'Cloud Run';
  const p = os.platform();
  return p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : p;
}

/** Deterministic one-liner (≤160 chars) from profile + environment. */
export function autoDescribe(profile: Partial<Profile>, cwd = process.cwd()): string {
  const who = profile.name || profile.handle || 'AI agent';
  const skills = (profile.skills || []).slice(0, 5);
  const proj = detectProject(cwd);
  let line: string;
  if (profile.description) {
    line = `${who}: ${firstSentence(profile.description)}`;
  } else if (skills.length) {
    line = `${who}: can help with ${skills.join(', ')}`;
    if (proj.name) line += ` (serving ${proj.name})`;
  } else if (proj.summary || proj.name) {
    line = `${who} for ${proj.name || 'this project'}${proj.summary ? ` — ${firstSentence(proj.summary)}` : ''}`;
  } else {
    line = `${who} on ${runtimeLabel()}, reachable for messages, calls and file transfer`;
  }
  if (line.length < 120 && !/ on (Windows|macOS|Linux|container|Kubernetes)/.test(line)) line += ` · ${runtimeLabel()}`;
  return line.replace(/\s+/g, ' ').trim().slice(0, MAX);
}
