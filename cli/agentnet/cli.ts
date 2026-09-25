/**
 * `srift agentnet …` (alias `srift an …`) — addresses, live discovery, knocks,
 * presence, E2EE messaging and calls between AI agents. See "A2A Plan.md".
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import * as C from '../../lib/agentnet/crypto.mjs';
import {
  decodeOwnershipToken, encodeInvite, encodeOwnershipToken, handleTag, normalizeHandle, ownerTag, signOwnership, verifyOwnership,
} from '../../lib/agentnet/card.mjs';
import { autoDescribe } from './describe.ts';
import {
  addInvite, anDir, clearLock, ensureIdentity, findGroup, getContact, hasIdentity, inboxPath, loadConfig, loadContacts, loadGroups, loadInvites, markRead, readSent,
  outboxClear, outboxList, readInbox, readLock, readMarkers, removeContact, revokeInvites, rotateIdentity, saveConfig, saveIdentity,
  acquireLock, clearStopRequest, heartbeatLock, prune, requestStop, rotateLog, stopRequested, upsertContact, wipe, type Identity, type InboxRecord, type KnockPolicy, type PresenceMode,
} from './local.ts';
import { AgentNode, type SessionBackend } from './node.ts';
import { agentsOf, find, liveCard, resolveAll, type Resolved } from './resolve.ts';

export type Helpers = { ensureDaemon?: () => Promise<unknown>; callDaemon?: (e: string, m: 'GET' | 'POST', b?: any) => Promise<any> };

const HELP = `SRIFT AgentNet — permanent addresses, LIVE discovery, knocks, E2EE messaging and calls between AI agents.
No database anywhere: relays keep only what is live (RAM) and route only to ONLINE agents.

Identity (your "phone number")
  srift an id [--name N] [--description D] [--skills a,b]   show/create your address + handle tag
  srift an id handle @name              set a handle; your tag is name~xxxxxxxx (key-derived, unforgeable)
  srift an id owner <srift-own:token> | --clear      accept an owner's signed claim
  srift an id link-domain acme.com [--name support]  print /.well-known/srift for your domain
  srift an id export <file> | import <file> | rotate
Be found (live)
  srift an host ["one-line description"] [--skills a,b] [--accept-knocks | --decide "cmd"] [--poll]
                                        go online AND discoverable (datacenter/VM/AGI style)
  srift an describe ["one line"] [--auto]   set the self-written one-liner shown in search
  srift an set-status available|busy|away    srift an hide   (stop being searchable)
  srift an up [--discoverable] [--poll] [--detach]   go online;  srift an down
Find & reach others
  srift an search "what you need" [--watch] [--limit 10]   live search; --watch notifies as matches come online
  srift an find <srift:addr|@name|@name~xxxxxxxx|@owner/agent|owner:@owner|name@domain|domain|invite|"need">
  srift an knock <to> "hey, it's me — …" [--wait 60]    ask to connect; they accept/reject with a note
  srift an connect "what you need" [--max 5] [--wait 30] [--note "…"] [--message "…" | --no-message]
                                        search → knock best matches → first accept → conversation starts
                                        (your need is sent as the first message; then chat / file / call)
  srift an answer <knockId> accept|reject ["note"]      srift an knock-policy ask|accept|reject|decide [--decide "cmd"]
Conversations, files, groups (all end-to-end encrypted, delivered only to online members)
  srift an chat <to|group>              interactive chat (type /file <path> to send a file, /quit to leave)
  srift an history <to|group> [--limit 50]
  srift an file <to> <path>             native encrypted file transfer (chunked, SHA-256 verified)
  srift an files                        files you received (saved under ~/.srift/agentnet/files/)
  srift an group create "name" [<to> …] | add <group> <to> … | remove <group> <addr> | promote <group> <addr>
  srift an group rename <group> "name" | leave <group> | join <group> | list | show <group>
  srift an group send <group> "text" [--queue] | file <group> <path> | call <group> [--purpose "…"]
Messaging & presence
  srift an status <to>   srift an watch <to> [--timeout 300]
  srift an send <to> "text" [--file f] [--queue]   delivered | offline | unconfirmed | queued
  srift an inbox [--all] [--requests] [--knocks] [--json]   srift an wait [--timeout 300]   srift an outbox list|clear
  srift an presence mode everyone|contacts|nobody | allow <addr> | deny <addr>
Calls (existing SRIFT E2EE sessions)
  srift an call <to> [--purpose "…"] [--ring-when-online]    srift an accept <callId> | reject <callId>
Contacts, owners, invites
  srift an contacts add <to|invite> [--name N] [--policy auto|ask] | list | remove | block | unblock <addr>
  srift an owner sign <agentAddress>    srift an owner agents [@owner]
  srift an invite [--once] [--ttl 1d (default 7d) | --no-expiry] [--open] | list | revoke      srift an report <addr> [--reason R]
Hooks (wake a sleeping agent)
  srift an hook set [--url https://…] [--secret S] [--exec "cmd"] [--allow-unknown] | off | show
Local data
  srift an retention <days> [--files <days>]   srift an prune   srift an wipe [--all] --yes
  --ephemeral (on up/host/mcp/chat): keep conversations in RAM only; received files in a temp dir wiped on exit
  --verbose (on up/host): print message text even when output is not a terminal (node.log never gets it by default)
Relays (anyone can run one; they peer to form one network)
  srift an relay list | add <url> | remove <url> | serve [--port 8787] [--host 0.0.0.0] [--peers url1,url2]
MCP
  srift an mcp                          separate MCP server with 24 srift_an_* tools
Add --json to any command for machine-readable output.`;

const VALUED = new Set(['--name', '--description', '--skills', '--file', '--timeout', '--purpose', '--reason', '--policy', '--url', '--secret',
  '--exec', '--port', '--host', '--ttl', '--label', '--limit', '--wait', '--max', '--note', '--decide', '--peers', '--status', '--message', '--files']);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean {
  return args.includes(name);
}
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUED.has(args[i])) { i++; continue; }
    if (args[i].startsWith('--')) continue;
    out.push(args[i]);
  }
  return out;
}
function fmtResult(r: Resolved): string {
  const c = r.card;
  const tag = r.tag || (c ? handleTag(c) : '');
  const own = c?.owner ? `  owned by @${ownerTag(c.owner)}` : '';
  const live = r.online ? `  ● online${r.status && r.status !== 'available' ? ` (${r.status})` : ''}` : '';
  const lines = [`${r.address}  @${tag}${c?.name ? `  ${c.name}` : ''}${live}${own}  [${r.source}${r.attest?.domain ? ', domain ' + r.attest.domain : ''}]`];
  if (r.oneLine) lines.push(`    “${r.oneLine}”`);
  if (c?.skills?.length) lines.push(`    skills: ${c.skills.join(', ')}`);
  return lines.join('\n');
}

export async function run(argv: string[], helpers: Helpers = {}): Promise<void> {
  const args = argv.slice(1); // drop "agentnet"/"an"
  const json = has(args, '--json');
  // RAM-only conversation data for this process (see local.ts EPHEMERAL MODE).
  if (has(args, '--ephemeral')) process.env.SRIFT_AN_EPHEMERAL = '1';
  const pos = positionals(args);
  const sub = pos[0];
  const out = (human: string, data: unknown) => console.log(json ? JSON.stringify(data) : human);
  const fail = (msg: string, code = 1): never => {
    if (json) console.log(JSON.stringify({ error: msg }));
    else console.error(`[agentnet] ${msg}`);
    process.exit(code);
  };
  const sessions: SessionBackend | undefined = helpers.callDaemon
    ? { ensure: helpers.ensureDaemon || (async () => {}), call: helpers.callDaemon }
    : undefined;
  const log = (m: string) => { if (!json) console.error(`[agentnet] ${m}`); };

  /**
   * Transient node. needReplies=true: if another node already owns the identity, attach as a SIDECAR
   * (only consumes replies to our own requests); otherwise receive fully for the duration.
   */
  const withNode = async <T>(needReplies: boolean, fn: (n: AgentNode) => Promise<T>): Promise<T> => {
    const { identity } = ensureIdentity();
    // Receive fully only while holding the node lock; otherwise attach as a helper listener.
    const owns = needReplies && acquireLock();
    const n = new AgentNode(identity, { recv: owns, sidecar: needReplies && !owns, sessions, log, hooks: false });
    try {
      await n.start();
      return await fn(n);
    } finally {
      await n.stop().catch(() => {});
      if (owns) clearLock();
    }
  };
  const target = async (q: string | undefined): Promise<string> => {
    if (!q) return fail('Missing <to>.');
    const direct = C.normalizeAddress(q);
    if (direct && q.replace(/^srift:/i, '').replace(/-/g, '').length === 20) return direct;
    const r = await resolveAll(q);
    if (r.length > 1) {
      return fail(`"${q}" matches ${r.length} online agents — names are not unique. Use the full tag:\n${r.map((x) => `  @${x.tag || (x.card ? handleTag(x.card) : x.address)}  ${x.oneLine || ''}`).join('\n')}`);
    }
    if (r.length === 1) return r[0].address;
    return fail(`Could not resolve "${q}" (not online, or unknown). Try: srift an search "${q}"`);
  };

  /** Run the online node in the foreground (shared by `up` and `host`). */
  const runOnline = async (identity: Identity): Promise<void> => {
    if (!acquireLock()) {
      const lock = readLock();
      fail(`Already online (node pid ${lock?.pid ?? '?'}). Stop it with: srift an down`);
    }
    // Message bodies are shown on an interactive terminal (or --verbose); background logs (node.log) get metadata only.
    const showBodies = (!!process.stdout.isTTY || has(args, '--verbose')) && !(process.env.SRIFT_AN_EPHEMERAL === '1' && !process.stdout.isTTY);
    const body = (t: unknown) => (showBodies ? String(t ?? '') : `[${String(t ?? '').length} chars]`);
    const n = new AgentNode(identity, { recv: true, sessions, log: (m) => console.error(`[agentnet] ${m}`), forcePoll: has(args, '--poll') });
    n.on('message', (r: InboxRecord) => {
      if (json) return console.log(JSON.stringify({ event: 'message', ...r }));
      if (r.type === 'receipt' || r.type === 'knock_answer') return;
      if (r.type === 'knock') return console.log(`[${new Date().toISOString()}] KNOCK from ${r.fromName ? r.fromName + ' ' : ''}${r.from}: ${body(r.body?.note)}${r.body?.oneLine && showBodies ? `\n    they are: “${r.body.oneLine}”` : ''}\n    → srift an answer ${r.id} accept|reject "note"`);
      if (r.type === 'file') return console.log(`[${new Date().toISOString()}] FILE from ${r.fromName ? r.fromName + ' ' : ''}${r.from}: ${showBodies ? r.body?.name : '[file]'} (${r.body?.size} bytes)`);
      console.log(`[${new Date().toISOString()}] ${r.request ? '(request) ' : ''}${r.type} from ${r.fromName ? r.fromName + ' ' : ''}${r.from}: ${body(r.body?.text ?? r.body?.purpose)}`);
    });
    n.on('connected', (e) => console.error(`[agentnet] online via ${e.relay} (${e.transport})`));
    n.on('outbox_delivered', (i) => console.error(`[agentnet] queued message ${i.id} delivered to ${i.to}`));
    n.on('call_accepted', (c) => console.error(`[agentnet] auto-answered call ${c.callId} (session ${c.sessionId})`));
    n.on('knock_answered', (k) => console.error(`[agentnet] ${k.accepted ? 'accepted' : 'rejected'} knock from ${k.from}${k.note ? `: ${k.note}` : ''}`));
    try {
      await n.start();
    } catch (e) {
      clearLock();
      throw e;
    }
    const hb = setInterval(heartbeatLock, 5000);
    hb.unref?.();
    const b = n.beacon();
    console.error(`[agentnet] ONLINE as ${identity.address} (@${handleTag(n.card())})${b ? `\n[agentnet] discoverable: “${b.oneLine}”` : ''} — Ctrl+C to go offline`);
    clearStopRequest();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearStopRequest();
      await n.stop().catch(() => {});
      clearLock();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('SIGHUP', stop);
    // A bug in one message must never take the agent offline.
    process.on('unhandledRejection', (e: any) => console.error(`[agentnet] recovered from error: ${e?.message || e}`));
    process.on('uncaughtException', (e: any) => console.error(`[agentnet] recovered from error: ${e?.message || e}`));
    // `srift an down` writes a stop request: graceful shutdown on every OS (Windows kill() cannot be caught).
    setInterval(() => { if (stopRequested()) void stop(); }, 500);
    await new Promise(() => {});
  };

  switch (sub) {
    case undefined:
    case 'help':
      console.log(HELP);
      return;

    // ─── identity ──────────────────────────────────────────────
    case 'id':
    case 'whoami': {
      const action = pos[1];
      if (action === 'export') {
        const file = pos[2] || fail('Usage: srift an id export <file>');
        const { identity } = ensureIdentity();
        fs.writeFileSync(file as string, JSON.stringify(identity, null, 2), { mode: 0o600 });
        return out(`Exported identity (PRIVATE KEYS) to ${file}. Keep it secret.`, { exported: file, address: identity.address });
      }
      if (action === 'import') {
        const file = pos[2] || fail('Usage: srift an id import <file>');
        const idt = JSON.parse(fs.readFileSync(file as string, 'utf8')) as Identity;
        if (C.addressFromEdPub(idt.edPub) !== idt.address || !idt.edPriv || !idt.xPriv) fail('Not a valid AgentNet identity file.');
        if (hasIdentity() && !has(args, '--force')) fail('An identity already exists. Re-run with --force to replace it.');
        saveIdentity(idt);
        return out(`Imported ${idt.address}`, { address: idt.address });
      }
      if (action === 'rotate') {
        const { identity } = ensureIdentity();
        const next = rotateIdentity(identity);
        saveIdentity(next);
        return out(`Rotated: ${identity.address} → ${next.address}\nThe rotation record is signed by the old key. Tell contacts your new address (or send them your new invite).`,
          { from: identity.address, to: next.address, rotation: next.rotations?.at(-1) });
      }
      if (action === 'handle') {
        const h = normalizeHandle(pos[2] || '') || fail('Usage: srift an id handle @name (3-32 chars: a-z 0-9 -)');
        const { identity } = ensureIdentity();
        identity.profile.handle = h as string;
        saveIdentity(identity);
        const tag = handleTag({ address: identity.address, handle: h as string });
        return out(`Handle set: @${h}\nYour unique tag: @${tag}   (names can repeat; the ~suffix comes from your key and cannot be forged)\nIt is live whenever you are online (no registry, no database).`, { handle: h, tag });
      }
      if (action === 'owner') {
        const { identity } = ensureIdentity();
        if (has(args, '--clear')) {
          delete identity.profile.owner;
          saveIdentity(identity);
          return out('Owner link removed (a running node re-announces within 5 s).', { owner: null });
        }
        const token = pos[2] || fail('Usage: srift an id owner <srift-own:token> | --clear   (the owner runs: srift an owner sign <this agent address>)');
        let proof: any;
        try { proof = decodeOwnershipToken(token); } catch { return fail('Not a valid ownership token.'); }
        if (proof.agent !== identity.address) fail(`That token is for ${proof.agent}, not this agent (${identity.address}).`);
        if (!verifyOwnership(proof, identity.address)) fail('Ownership signature does not verify.');
        identity.profile.owner = proof;
        saveIdentity(identity);
        return out(`Owned by @${ownerTag(proof)} — confirmed by both signatures.\nWhile online, others can reach this agent as @${proof.name || ownerTag(proof)}/${identity.profile.handle || identity.profile.name || '<name>'}.`, { owner: proof.address, ownerTag: ownerTag(proof) });
      }
      if (action === 'link-domain') {
        const domain = pos[2] || fail('Usage: srift an id link-domain acme.com [--name support]');
        const { identity } = ensureIdentity();
        const n = new AgentNode(identity, { recv: false });
        const doc = { v: 1, agents: [{ name: flag(args, '--name') || 'agent', address: identity.address, card: n.card() }] };
        if (json) return console.log(JSON.stringify(doc));
        console.log(`Host this JSON at https://${domain}/.well-known/srift (content-type: application/json):\n`);
        console.log(JSON.stringify(doc, null, 2));
        console.log(`\nThen anyone can reach you as ${doc.agents[0].name}@${domain} (DNS-based, no registry).`);
        return;
      }
      const { identity, created } = ensureIdentity();
      let changed = false;
      for (const k of ['name', 'description'] as const) { const v = flag(args, `--${k}`); if (v !== undefined) { identity.profile[k] = v; changed = true; } }
      const skills = flag(args, '--skills');
      if (skills !== undefined) { identity.profile.skills = skills.split(',').map((s) => s.trim()).filter(Boolean); changed = true; }
      if (changed) saveIdentity(identity);
      const tag = handleTag({ address: identity.address, handle: identity.profile.handle, name: identity.profile.name });
      return out(
        `${created ? 'Created new identity.\n' : ''}Address:      ${identity.address}\nTag:          @${tag}\n` +
          `Name:         ${identity.profile.name || '-'}\nSkills:       ${identity.profile.skills.join(', ') || '-'}\n` +
          `One-liner:    ${identity.profile.oneLine || `(auto) ${autoDescribe(identity.profile)}`}\n` +
          `Discoverable: ${identity.profile.discoverable ? 'yes (while online)' : 'no — srift an host "…" to be found'}\n` +
          `Owner:        ${identity.profile.owner ? '@' + ownerTag(identity.profile.owner) : '-'}\nRelays:       ${loadConfig().relays.join(', ')}\nHome:         ${anDir()}`,
        { address: identity.address, tag, created, profile: identity.profile, relays: loadConfig().relays },
      );
    }

    // ─── being found ──────────────────────────────────────────
    case 'describe': {
      const { identity } = ensureIdentity();
      const text = pos.slice(1).join(' ').trim();
      const line = (text && !has(args, '--auto') ? text : autoDescribe(identity.profile)).slice(0, 160);
      identity.profile.oneLine = line;
      saveIdentity(identity);
      return out(`One-liner: “${line}”${readLock() ? '\n(the running node re-announces within 5 s)' : ''}`, { oneLine: line });
    }
    case 'set-status': {
      const st = pos[1] as 'available' | 'busy' | 'away';
      if (!['available', 'busy', 'away'].includes(st)) fail('Usage: srift an set-status available|busy|away');
      const { identity } = ensureIdentity();
      identity.profile.status = st;
      saveIdentity(identity);
      return out(`Status: ${st}`, { status: st });
    }
    case 'hide': {
      const { identity } = ensureIdentity();
      identity.profile.discoverable = false;
      saveIdentity(identity);
      return out('Not discoverable any more (still reachable by address/contacts while online).', { discoverable: false });
    }
    case 'host':
    case 'up': {
      if (has(args, '--detach')) {
        const childArgs = [...process.execArgv, process.argv[1], ...process.argv.slice(2).filter((a) => a !== '--detach')];
        fs.mkdirSync(anDir(), { recursive: true });
        rotateLog();
        const logFd = fs.openSync(path.join(anDir(), 'node.log'), 'a');
        const child = spawn(process.execPath, childArgs, { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true });
        child.unref();
        return out(`AgentNet node started in background (pid ${child.pid}). Log: ${path.join(anDir(), 'node.log')}`, { pid: child.pid });
      }
      const { identity } = ensureIdentity();
      if (sub === 'host' || has(args, '--discoverable')) {
        identity.profile.discoverable = true;
        const text = sub === 'host' ? pos.slice(1).join(' ').trim() : '';
        if (text) identity.profile.oneLine = text.slice(0, 160);
        const skills = flag(args, '--skills');
        if (skills) identity.profile.skills = skills.split(',').map((s) => s.trim()).filter(Boolean);
        const name = flag(args, '--name');
        if (name) identity.profile.name = name;
        if (!identity.profile.oneLine) identity.profile.oneLine = autoDescribe(identity.profile);
        saveIdentity(identity);
      }
      if (has(args, '--accept-knocks')) saveConfig({ knockPolicy: 'accept' });
      const decide = flag(args, '--decide');
      if (decide) saveConfig({ knockPolicy: 'decide', hooks: { ...loadConfig().hooks, decide } });
      return runOnline(identity);
    }
    case 'down': {
      const lock = readLock();
      if (!lock) return out('No AgentNet node is running.', { running: false });
      requestStop();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && readLock()) await new Promise((r) => setTimeout(r, 200));
      if (readLock()) {
        try { process.kill(lock.pid, 'SIGTERM'); } catch (e: any) { fail(`Could not stop pid ${lock.pid}: ${e?.message}`); }
        clearStopRequest();
        return out(`Node pid ${lock.pid} did not stop gracefully; terminated.`, { stopped: lock.pid, graceful: false });
      }
      return out(`Stopped node pid ${lock.pid} (graceful).`, { stopped: lock.pid, graceful: true });
    }

    // ─── discovery ────────────────────────────────────────────
    case 'search': {
      const q = pos.slice(1).join(' ').trim() || fail('Usage: srift an search "what you need" [--watch]');
      const limit = Math.min(50, Number(flag(args, '--limit') || 10));
      if (!has(args, '--watch')) {
        const res = await withNode(false, (n) => n.search(q as string, limit));
        if (json) return console.log(JSON.stringify({ query: q, results: res }));
        if (!res.length) return console.log('No matching agents online right now. Use --watch to be notified when one comes online.');
        for (const r of res) console.log(fmtResult(r));
        return;
      }
      const timeoutMs = Number(flag(args, '--timeout') || 0) * 1000;
      const { identity } = ensureIdentity();
      const n = new AgentNode(identity, { recv: false, log });
      await n.start();
      const first = await n.seek(q as string);
      if (json) console.log(JSON.stringify({ event: 'results', query: q, results: first.results }));
      else {
        console.error(first.results.length ? `[agentnet] ${first.results.length} online now:` : '[agentnet] none online yet — watching…');
        for (const r of first.results.slice(0, limit)) console.log(fmtResult(r));
        console.error('[agentnet] watching for new matches (Ctrl+C to stop)…');
      }
      n.on('discovery', (d: any) => {
        const r: Resolved = { address: d.address, card: d.card, source: 'live', online: true, oneLine: d.oneLine, status: d.status, tag: d.tag, relay: d.relay };
        if (json) console.log(JSON.stringify({ event: 'discovery', ...r }));
        else console.log(`\n🔔 now online: ${fmtResult(r)}`);
      });
      const stop = async () => { await n.stop(); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      if (timeoutMs) setTimeout(stop, timeoutMs);
      await new Promise(() => {});
      return;
    }
    case 'find': {
      const q = pos.slice(1).join(' ') || fail('Usage: srift an find <query>');
      const res = await find(q as string, Number(flag(args, '--limit') || 10));
      if (json) return console.log(JSON.stringify({ results: res }));
      if (!res.length) return console.log('No agents found (discovery is live: the agent must be online).');
      for (const r of res) console.log(fmtResult(r));
      return;
    }
    case 'knock': {
      const a = await target(pos[1]);
      const note = pos.slice(2).join(' ').trim() || `Hi, it's ${ensureIdentity().identity.profile.name || 'an agent'} — can we connect?`;
      const waitMs = Number(flag(args, '--wait') || 60) * 1000;
      const r = await withNode(true, (n) => n.knock(a, note, { waitMs }));
      const human = r.delivery !== 'delivered' && r.delivery !== 'unconfirmed'
        ? `${a} is ${r.delivery === 'offline' ? 'offline' : `unreachable (${r.delivery})`}.`
        : r.timedOut ? `No answer from ${a} within ${waitMs / 1000}s (their agent may decide later — check 'srift an inbox').`
          : r.accepted ? `✔ ${a} accepted${r.note ? `: “${r.note}”` : ''}. You are now contacts — continue with: srift an chat ${a}`
            : `✖ ${a} declined${r.note ? `: “${r.note}”` : ''}.`;
      out(human, r);
      if (!r.accepted) process.exit(r.delivery === 'offline' ? 3 : 2);
      return;
    }
    case 'answer': {
      const id = pos[1] || fail('Usage: srift an answer <knockId> accept|reject ["note"]');
      const verdict = pos[2];
      if (verdict !== 'accept' && verdict !== 'reject') fail('Usage: srift an answer <knockId> accept|reject ["note"]');
      const note = pos.slice(3).join(' ').trim() || undefined;
      const r = await withNode(false, (n) => n.answerKnock(id as string, verdict === 'accept', note));
      return out(`${verdict === 'accept' ? 'Accepted' : 'Rejected'} (${r.result}).`, r);
    }
    case 'connect': {
      const need = pos.slice(1).join(' ').trim() || fail('Usage: srift an connect "what you need" [--max 5] [--wait 30]');
      const max = Number(flag(args, '--max') || 5);
      const waitMs = Number(flag(args, '--wait') || 30) * 1000;
      const r = await withNode(true, (n) => {
        n.on('connect_try', (c: Resolved) => log(`knocking @${c.tag || c.address}${c.oneLine ? ` — “${c.oneLine}”` : ''}`));
        n.on('connect_rejected', (c: any) => log(`  declined${c.note ? `: “${c.note}”` : ''} → trying next`));
        return n.connect(need as string, { max, waitMs, note: flag(args, '--note'), message: has(args, '--no-message') ? false : flag(args, '--message') });
      });
      if (json) console.log(JSON.stringify(r));
      else if (r.connected) console.log(`✔ Connected with ${r.connected.address} (@${r.connected.tag})${r.connected.note ? `: “${r.connected.note}”` : ''}` +
        `${r.firstMessage ? `\n  First message ${r.firstMessage.result}.` : ''}\n  Continue: srift an chat ${r.connected.address}   ·   srift an file ${r.connected.address} <path>   ·   srift an call ${r.connected.address}`);
      else console.log(r.candidates ? `No one accepted (${r.tried.length} tried). Try again later or broaden the request.` : 'No matching agents online right now. Try: srift an search "…" --watch');
      if (!r.connected) process.exit(2);
      return;
    }
    // ─── conversations ────────────────────────────────────────
    case 'history': {
      const q = pos[1] || fail('Usage: srift an history <to|group> [--limit 50]');
      const g = findGroup(q as string);
      const peer = g ? null : await target(q);
      const limit = Number(flag(args, '--limit') || 50);
      const me = ensureIdentity().identity.address;
      const inbound = readInbox().filter((r) => ['msg', 'group_msg', 'file'].includes(r.type) && (g ? (r as any).group?.id === g.state.id || r.body?.groupId === g.state.id : r.from === peer && !r.body?.groupId));
      const outbound = readSent().filter((r) => (g ? r.groupId === g.state.id : r.to === peer && !r.groupId));
      const seenGroupMsg = new Set<string>();
      const items = [
        ...inbound.map((r) => ({ ts: r.ts, who: r.fromName || r.from, mine: false, type: r.type, text: r.type === 'file' ? `📎 ${r.body?.name} (${r.body?.size} bytes) → ${r.body?.path}` : r.body?.text ?? '' })),
        ...outbound.filter((r) => { const k = r.body?.msgId || r.id; if (g && seenGroupMsg.has(k)) return false; seenGroupMsg.add(k); return true; })
          .map((r) => ({ ts: r.ts, who: 'me', mine: true, type: r.type, text: r.type === 'file' ? `📎 ${r.body?.name} (${r.body?.size} bytes)` : r.body?.text ?? r.body?.note ?? '', result: r.result })),
      ].sort((x, y) => x.ts - y.ts).slice(-limit);
      if (json) return console.log(JSON.stringify({ conversation: g ? { group: g.state.id, name: g.state.name } : { peer }, me, items }));
      if (!items.length) return console.log('No messages yet.');
      for (const i of items) console.log(`${new Date(i.ts * 1000).toISOString().slice(11, 19)}  ${i.mine ? 'me' : i.who}: ${i.text}${(i as any).result && (i as any).result !== 'delivered' ? `  (${(i as any).result})` : ''}`);
      return;
    }
    case 'chat': {
      const q = pos[1] || fail('Usage: srift an chat <to|group>');
      const g = findGroup(q as string);
      const peer = g ? null : await target(q);
      const { identity } = ensureIdentity();
      const ownsChatLock = acquireLock();
      const locked = !ownsChatLock;
      const n = new AgentNode(identity, { recv: ownsChatLock, sidecar: locked, sessions, log, hooks: false });
      await n.start();
      const label = g ? `#${g.state.name} (${g.state.members.length} members)` : peer;
      const matches = (r: InboxRecord) => (g ? ((r as any).group?.id === g.state.id || r.body?.groupId === g.state.id) : r.from === peer && !r.body?.groupId) && ['msg', 'group_msg', 'file', 'group_update'].includes(r.type);
      const show = (r: InboxRecord) => {
        const who = r.fromName || r.from.slice(0, 16);
        const text = r.type === 'file' ? `📎 ${r.body?.name} (${r.body?.size} bytes) saved to ${r.body?.path}` : r.type === 'group_update' ? `(group updated: v${r.body?.version}, ${r.body?.members} members)` : r.body?.text ?? '';
        process.stdout.write(`\r${new Date(r.ts * 1000).toISOString().slice(11, 19)}  ${who}: ${text}\n> `);
      };
      console.log(`[agentnet] chatting with ${label} — end-to-end encrypted. /file <path> sends a file, /quit exits.`);
      const seenIds = new Set(readInbox().map((r) => r.id));
      if (!locked) n.on('message', (r: InboxRecord) => { if (matches(r)) { seenIds.add(r.id); show(r); } });
      const tail = setInterval(() => { for (const r of readInbox()) if (!seenIds.has(r.id)) { seenIds.add(r.id); if (matches(r)) show(r); } }, 700);
      let finished = false;
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
      let inputClosed = false;
      const prompt = () => { if (!inputClosed && !finished) rl.prompt(); };
      prompt();
      const finish = async () => { if (finished) return; finished = true; clearInterval(tail); rl.close(); await n.stop(); if (ownsChatLock) clearLock(); process.exit(0); };
      // Lines are handled strictly in order (piped input included); exiting waits for pending sends.
      let chain: Promise<void> = Promise.resolve();
      let closing = false;
      const handle = async (line: string) => {
        const t = line.trim();
        if (!t) return prompt();
        if (t === '/quit' || t === '/exit') { closing = true; return finish(); }
        try {
          if (t.startsWith('/file ')) {
            const fp = path.resolve(t.slice(6).trim().replace(/^"|"$/g, ''));
            if (g) {
              const r = await n.groupSendFile(g.state.id, fp);
              console.log(`  📎 ${path.basename(fp)}: ${r.results.filter((x) => x.result === 'delivered').length}/${r.results.length} members received it`);
            } else {
              const r = await n.sendFile(peer!, fp);
              console.log(`  📎 ${path.basename(fp)}: ${r.result}${r.reason ? ` — ${r.reason}` : ''}`);
            }
          } else if (g) {
            const r = await n.groupSend(g.state.id, t);
            if (r.delivered < r.total) console.log(`  (delivered to ${r.delivered}/${r.total} online members)`);
          } else {
            const r = await n.send(peer!, 'msg', { text: t });
            if (r.result !== 'delivered') console.log(`  (${r.result}${r.result === 'offline' ? ' — not sent; they are offline' : ''})`);
          }
        } catch (e: any) {
          console.log(`  error: ${e?.message}`);
        }
        prompt();
      };
      rl.on('line', (line) => { chain = chain.then(() => (closing ? undefined : handle(line))); });
      rl.on('close', () => { inputClosed = true; void chain.then(() => finish()); });
      process.on('SIGINT', () => { void finish(); });
      await new Promise(() => {});
      return;
    }
    case 'file': {
      const a = await target(pos[1]);
      const fp = pos[2] || fail('Usage: srift an file <to> <path>');
      const r = await withNode(true, (n) => n.sendFile(a, path.resolve(fp as string), { onProgress: (p) => { if (!json) process.stderr.write(`\r[agentnet] sending ${path.basename(fp as string)} ${Math.round(p * 100)}%`); } }));
      if (!json) process.stderr.write('\n');
      out(r.result === 'delivered' ? `Delivered ${r.name} (${r.size} bytes) to ${a} in ${((r.ms || 0) / 1000).toFixed(1)}s — SHA-256 verified by the receiver.` : `Not delivered: ${r.result}${r.reason ? ` — ${r.reason}` : ''}`, r);
      if (r.result !== 'delivered') process.exit(r.result === 'offline' ? 3 : 1);
      return;
    }
    case 'files': {
      const recs = readInbox().filter((r) => r.type === 'file');
      if (json) return console.log(JSON.stringify({ files: recs.map((r) => ({ from: r.from, fromName: r.fromName, ...r.body, ts: r.ts })) }));
      if (!recs.length) return console.log('No files received yet.');
      for (const r of recs) console.log(`${new Date(r.ts * 1000).toISOString()}  ${r.body?.name}  ${r.body?.size} bytes  from ${r.fromName || r.from}${r.body?.groupId ? ` in group ${r.body.groupId}` : ''}\n    ${r.body?.path}`);
      return;
    }
    case 'group': {
      const action = pos[1] || 'list';
      const gid = (q: string | undefined): string => {
        const g = q ? findGroup(q) : null;
        if (!g) return fail(`Unknown group "${q}". See: srift an group list`);
        return g.state.id;
      };
      if (action === 'list') {
        const all = Object.values(loadGroups());
        if (json) return console.log(JSON.stringify({ groups: all.map((g) => ({ id: g.state.id, name: g.state.name, status: g.status, members: g.state.members.length, version: g.state.version, admin: g.state.admins.includes(ensureIdentity().identity.address) })) }));
        if (!all.length) return console.log('No groups. Create one: srift an group create "name" <member> …');
        const me = ensureIdentity().identity.address;
        for (const g of all) console.log(`${g.state.id}  #${g.state.name}  ${g.state.members.length} members  ${g.status}${g.state.admins.includes(me) ? '  (admin)' : ''}`);
        return;
      }
      if (action === 'show') {
        const g = findGroup(pos[2] || '') || fail('Usage: srift an group show <group>');
        if (json) return console.log(JSON.stringify(g));
        console.log(`#${g.state.name}  ${g.state.id}  v${g.state.version}  status=${g.status}`);
        for (const m of g.state.members) console.log(`  ${m.address}  ${m.name || ''}${g.state.admins.includes(m.address) ? '  (admin)' : ''}${(g.left || []).includes(m.address) ? '  (left)' : ''}`);
        return;
      }
      if (action === 'create') {
        const name = pos[2] || fail('Usage: srift an group create "name" [<to> …]');
        const members = await Promise.all(pos.slice(3).map((x) => target(x)));
        const r = await withNode(false, (n) => n.groupCreate(name as string, members));
        return out(`Created #${r.group.name} (${r.group.id}) with ${r.group.members.length} members.\n${Object.entries(r.delivery).map(([a, s]) => `  ${a}: ${s}`).join('\n')}\nChat: srift an chat ${r.group.id}`, r);
      }
      if (action === 'add') {
        const id = gid(pos[2]);
        const members = await Promise.all(pos.slice(3).map((x) => target(x)));
        if (!members.length) fail('Usage: srift an group add <group> <to> …');
        const r = await withNode(false, (n) => n.groupAdd(id, members));
        return out(`#${r.group.name} now has ${r.group.members.length} members (v${r.group.version}).`, r);
      }
      if (action === 'remove' || action === 'promote') {
        const id = gid(pos[2]);
        const a = C.normalizeAddress(pos[3] || '') || fail(`Usage: srift an group ${action} <group> <address>`);
        const r = await withNode(false, (n) => (action === 'remove' ? n.groupRemove(id, a as string) : n.groupPromote(id, a as string)));
        return out(`${action === 'remove' ? 'Removed' : 'Promoted'} ${a} (v${r.group.version}).`, r);
      }
      if (action === 'rename') {
        const id = gid(pos[2]);
        const r = await withNode(false, (n) => n.groupRename(id, pos.slice(3).join(' ') || fail('Usage: srift an group rename <group> "name"')));
        return out(`Renamed to #${r.group.name}.`, r);
      }
      if (action === 'leave') {
        const id = gid(pos[2]);
        await withNode(false, (n) => n.groupLeave(id));
        return out(`Left ${id}.`, { left: id });
      }
      if (action === 'join') {
        const id = gid(pos[2]);
        const r = await withNode(false, async (n) => n.groupJoin(id));
        return out(`Joined #${r.state.name}.`, { joined: id });
      }
      if (action === 'send') {
        const id = gid(pos[2]);
        const text = pos.slice(3).join(' ') || fail('Usage: srift an group send <group> "text"');
        const r = await withNode(false, (n) => n.groupSend(id, text as string, { queue: has(args, '--queue') }));
        return out(`Delivered to ${r.delivered}/${r.total} members.${r.delivered < r.total ? ` Offline: ${Object.entries(r.results).filter(([, v]) => v !== 'delivered' && v !== 'unconfirmed').map(([k, v]) => `${k} (${v})`).join(', ')}` : ''}`, r);
      }
      if (action === 'file') {
        const id = gid(pos[2]);
        const fp = pos[3] || fail('Usage: srift an group file <group> <path>');
        const r = await withNode(true, (n) => n.groupSendFile(id, path.resolve(fp as string)));
        const ok = r.results.filter((x) => x.result === 'delivered').length;
        return out(`${path.basename(fp as string)} delivered to ${ok}/${r.results.length} members (SHA-256 verified).\n${r.results.map((x) => `  ${x.to}: ${x.result}${x.reason ? ` — ${x.reason}` : ''}`).join('\n')}`, r);
      }
      if (action === 'call') {
        if (!sessions) fail('Calls need the SRIFT daemon.');
        const id = gid(pos[2]);
        return withNode(false, async (n) => {
          const r = await n.groupCall(id, flag(args, '--purpose'));
          log(`group session ${r.sessionId}: invited ${Object.keys(r.invited).length} members — waiting for them to join…`);
          const joined = await r.approved;
          out(`${joined} member(s) joined session ${r.sessionId}. Use 'srift chat' / 'srift send' in the session.`, { sessionId: r.sessionId, invited: r.invited, joined });
        });
      }
      return fail('Usage: srift an group create|add|remove|promote|rename|leave|join|list|show|send|file|call');
    }

    case 'knock-policy': {
      const p = pos[1] as KnockPolicy;
      if (!['ask', 'accept', 'reject', 'decide'].includes(p)) fail('Usage: srift an knock-policy ask|accept|reject|decide [--decide "cmd"]');
      const decide = flag(args, '--decide');
      if (p === 'decide' && !decide && !loadConfig().hooks.decide) fail('decide needs --decide "cmd" (prints {"accept":bool,"note":"…"})');
      saveConfig({ knockPolicy: p, ...(decide ? { hooks: { ...loadConfig().hooks, decide } } : {}) });
      return out(`Knock policy: ${p}`, { knockPolicy: p });
    }

    // ─── messaging & presence ─────────────────────────────────
    case 'status': {
      const a = await target(pos[1]);
      const state = await withNode(false, (n) => n.presence(a));
      const lc = state === 'online' ? await liveCard(a).catch(() => null) : null;
      return out(`${a}: ${state}${lc?.beacon?.oneLine ? ` — “${lc.beacon.oneLine}”` : ''}`, { address: a, state, oneLine: lc?.beacon?.oneLine, status: lc?.beacon?.status });
    }
    case 'watch': {
      const a = await target(pos[1]);
      const timeout = Number(flag(args, '--timeout') || 300) * 1000;
      const online = await withNode(false, (n) => n.waitOnline(a, timeout));
      if (!online) fail(`${a} did not come online within ${timeout / 1000}s (or its status is hidden).`, 2);
      return out(`${a} is online`, { address: a, state: 'online' });
    }
    case 'send': {
      const a = await target(pos[1]);
      const textArg = pos.slice(2).join(' ');
      const file = flag(args, '--file');
      if (!textArg && !file) fail('Usage: srift an send <to> "text" [--file f] [--queue]');
      const body: any = { text: textArg };
      if (file && !has(args, '--link')) {
        // Native E2EE transfer over AgentNet (recipient must be online and accept files from you).
        const res = await withNode(true, async (n) => {
          const m = textArg ? await n.send(a, 'msg', body) : null;
          const f = await n.sendFile(a, path.resolve(file), { onProgress: (p) => { if (!json) process.stderr.write(`\r[agentnet] sending ${path.basename(file)} ${Math.round(p * 100)}%`); } });
          return { message: m, file: f };
        });
        if (!json) process.stderr.write('\n');
        out(res.file.result === 'delivered' ? `Delivered ${res.file.name} (${res.file.size} bytes, SHA-256 verified by ${a}).` : `File not delivered: ${res.file.result}${res.file.reason ? ` — ${res.file.reason}` : ''}`, res);
        if (res.file.result !== 'delivered') process.exit(res.file.result === 'offline' ? 3 : 1);
        return;
      }
      if (file) {
        if (!helpers.callDaemon) fail('File attachments need the SRIFT daemon.');
        await helpers.ensureDaemon?.();
        const share = await helpers.callDaemon!('/quick-share', 'POST', { filePath: path.resolve(file!), encrypt: true });
        if (!share?.downloadUrl) fail(`quick-share failed: ${share?.error || 'unknown error'}`);
        body.attachments = [{ name: path.basename(file!), url: share.downloadUrl, size: share.size }];
      }
      const queue = has(args, '--queue');
      const r = await withNode(false, (n) => n.send(a, 'msg', body, { queue }));
      const human: Record<string, string> = {
        delivered: `Delivered to ${a}.`,
        offline: `${a} is offline — nothing was sent or stored. Retry later, or use --queue (kept on THIS machine; delivered by 'srift an up').`,
        unconfirmed: `Sent to ${a} (they hide their online status, so delivery cannot be confirmed).`,
        queued: `${a} is offline — queued in your local outbox; 'srift an up' delivers it when they come online.`,
      };
      out(human[r.result] || `Send failed: ${r.result}${r.error ? ` (${r.error})` : ''}`, { to: a, ...r });
      if (!['delivered', 'unconfirmed', 'queued'].includes(r.result)) process.exit(r.result === 'offline' ? 3 : 1);
      if (queue && r.result === 'queued' && !readLock()) console.error("[agentnet] note: no node running — start one with 'srift an up --detach' to deliver queued messages.");
      return;
    }
    case 'outbox': {
      if (pos[1] === 'clear') return out(`Cleared ${outboxClear()} queued message(s).`, { cleared: true });
      const items = outboxList();
      if (json) return console.log(JSON.stringify({ items }));
      if (!items.length) return console.log('Outbox empty.');
      for (const i of items) console.log(`${i.id}  → ${i.to}  ${i.type}  attempts=${i.attempts}  queued ${new Date(i.createdAt * 1000).toISOString()}`);
      return;
    }
    case 'inbox': {
      const read = readMarkers();
      let recs = readInbox().filter((r) => has(args, '--receipts') || r.type !== 'receipt');
      if (!has(args, '--all')) recs = recs.filter((r) => !read.has(r.id));
      if (has(args, '--requests')) recs = recs.filter((r) => r.request);
      if (has(args, '--knocks')) recs = recs.filter((r) => r.type === 'knock');
      markRead(recs.map((r) => r.id));
      if (json) return console.log(JSON.stringify({ messages: recs }));
      if (!recs.length) return console.log(has(args, '--all') ? 'Inbox empty.' : 'No unread messages. (--all to show everything)');
      for (const r of recs) {
        const who = `${r.fromName ? r.fromName + ' ' : ''}${r.from}`;
        const tag = r.request ? ' [request]' : '';
        let line = r.body?.text ?? '';
        if (r.type === 'call') line = `CALL ${r.body?.purpose ? '— ' + r.body.purpose : ''}  → srift an accept ${r.id}`;
        if (r.type === 'call_answer') line = `call ${r.body?.callId} ${r.body?.accepted ? 'accepted' : 'declined'}`;
        if (r.type === 'knock') line = `KNOCK: ${r.body?.note || ''}${r.body?.oneLine ? ` (they are: “${r.body.oneLine}”)` : ''}  → srift an answer ${r.id} accept|reject "note"`;
        if (r.type === 'knock_answer') line = `knock ${r.body?.accepted ? 'ACCEPTED' : 'declined'}${r.body?.note ? `: “${r.body.note}”` : ''}`;
        if (r.body?.attachments?.length) line += `  [files: ${r.body.attachments.map((a: any) => `${a.name} ${a.url}`).join(', ')}]`;
        console.log(`${new Date(r.ts * 1000).toISOString()}  ${who}${tag}\n  ${r.type}: ${line}`);
      }
      return;
    }
    case 'wait': {
      const timeoutMs = Number(flag(args, '--timeout') || 300) * 1000;
      const isNew = (r: InboxRecord, readSet: Set<string>) => r.type !== 'receipt' && !readSet.has(r.id);
      const deliver = (r: InboxRecord) => { markRead([r.id]); out(`${r.type} from ${r.fromName ? r.fromName + ' ' : ''}${r.from}: ${r.body?.text ?? r.body?.note ?? r.body?.purpose ?? ''}`, r); };
      const pending = readInbox().filter((r) => isNew(r, readMarkers()));
      if (pending.length) return deliver(pending[0]);
      if (readLock()) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const next = readInbox().find((r) => isNew(r, readMarkers()));
          if (next) return deliver(next);
          await new Promise((r) => setTimeout(r, 500));
        }
        return fail('Timed out waiting for a message.', 2);
      }
      const { identity } = ensureIdentity();
      if (!acquireLock()) return fail('Another node started meanwhile; run wait again.');
      const n = new AgentNode(identity, { recv: true, sessions, log, hooks: true });
      await n.start().catch((e) => { clearLock(); throw e; });
      const rec = await new Promise<InboxRecord | null>((resolve) => {
        const t = setTimeout(() => resolve(null), timeoutMs);
        n.on('message', (r: InboxRecord) => { if (r.type !== 'receipt') { clearTimeout(t); resolve(r); } });
      });
      await n.stop();
      clearLock();
      if (!rec) return fail('Timed out waiting for a message.', 2);
      return deliver(rec);
    }
    case 'presence': {
      const action = pos[1];
      if (action === 'mode') {
        const m = pos[2] as PresenceMode;
        if (!['everyone', 'contacts', 'nobody'].includes(m)) fail('Usage: srift an presence mode everyone|contacts|nobody');
        saveConfig({ presenceMode: m });
        return out(`Presence visible to: ${m}${m !== 'everyone' ? ' (you will not appear in live search)' : ''}`, { presenceMode: m });
      }
      if (action === 'allow' || action === 'deny') {
        const a = C.normalizeAddress(pos[2] || '') || fail('Invalid address');
        upsertContact(a as string, { presence: action });
        return out(`${a}: presence ${action}`, { address: a, presence: action });
      }
      return out(`Presence mode: ${loadConfig().presenceMode}`, { presenceMode: loadConfig().presenceMode });
    }

    // ─── calls ────────────────────────────────────────────────
    case 'call': {
      if (!sessions) fail('Calls need the SRIFT daemon.');
      const a = await target(pos[1]);
      const purpose = flag(args, '--purpose');
      const timeoutMs = Number(flag(args, '--timeout') || 300) * 1000;
      return withNode(false, async (n) => {
        if (has(args, '--ring-when-online')) {
          log(`waiting for ${a} to come online…`);
          if (!(await n.waitOnline(a, timeoutMs))) return fail(`${a} did not come online.`, 2);
        }
        const r = await n.call(a, purpose, { approveTimeoutMs: timeoutMs });
        if (!r.approved) return fail(r.result === 'offline' ? `${a} is offline — call not placed.` : `Call failed: ${r.result} ${r.error || ''}`, r.result === 'offline' ? 3 : 1);
        log(`ringing ${a} (session ${r.sessionId})…`);
        const joined = await r.approved;
        if (!joined) return fail('No answer.', 2);
        out(`Connected: ${a} joined session ${r.sessionId}. Use 'srift chat' / 'srift send' in the session.`, { ...r, approved: true });
      });
    }
    case 'accept':
    case 'reject': {
      const callId = pos[1] || fail(`Usage: srift an ${sub} <callId>`);
      return withNode(false, async (n) => {
        if (sub === 'reject') { await n.rejectCall(callId as string, flag(args, '--reason')); return out('Declined.', { callId, accepted: false }); }
        if (!sessions) return fail('Calls need the SRIFT daemon.');
        const r = await n.acceptCall(callId as string);
        out(`Joined session ${r.sessionId}.`, r);
      });
    }

    // ─── contacts, owners, invites ────────────────────────────
    case 'contacts': {
      const action = pos[1] || 'list';
      if (action === 'list') {
        const all = Object.values(loadContacts());
        if (json) return console.log(JSON.stringify({ contacts: all.map((c) => ({ ...c, inviteToken: undefined, card: c.card ? { handle: c.card.handle, name: c.card.name } : undefined })) }));
        if (!all.length) return console.log('No contacts.');
        for (const c of all) console.log(`${c.address}  ${c.name || c.card?.name || ''}  policy=${c.policy} presence=${c.presence}`);
        return;
      }
      if (action === 'add') {
        const raw = pos[2] || fail('Usage: srift an contacts add <to|invite link>');
        const isInv = raw.includes('/c#') || raw.startsWith('srift-inv:');
        const viaInvite = isInv ? (await resolveAll(raw).catch((e) => fail(`Bad invite: ${e?.message}`)))[0] : null;
        const a = viaInvite ? viaInvite.address : await target(raw);
        const card = viaInvite?.card || (await liveCard(a).catch(() => null))?.card || getContact(a)?.card;
        const c = upsertContact(a, {
          name: flag(args, '--name') || viaInvite?.card?.name,
          policy: (flag(args, '--policy') as any) === 'ask' ? 'ask' : 'auto',
          card,
          inviteToken: viaInvite?.inviteToken,
        });
        return out(`Saved ${a}${c.name ? ` as ${c.name}` : ''}${card ? ' (verified card)' : ' (keys will be learned when they are online or message you)'}.`, { contact: { ...c, inviteToken: undefined } });
      }
      const a = C.normalizeAddress(pos[2] || '') || fail('Invalid address');
      if (action === 'remove') return out(removeContact(a as string) ? 'Removed.' : 'Not a contact.', { removed: a });
      if (action === 'block') { upsertContact(a as string, { policy: 'blocked', presence: 'deny' }); return out(`Blocked ${a}.`, { blocked: a }); }
      if (action === 'unblock') { upsertContact(a as string, { policy: 'ask', presence: 'allow' }); return out(`Unblocked ${a}.`, { unblocked: a }); }
      return fail('Usage: srift an contacts add|list|remove|block|unblock');
    }
    case 'owner': {
      const action = pos[1] || 'agents';
      if (action === 'sign') {
        const agent = C.normalizeAddress(pos[2] || '') || fail('Usage: srift an owner sign <agentAddress>');
        const { identity } = ensureIdentity();
        const proof = signOwnership(identity, agent as string, { name: identity.profile.handle });
        if (identity.profile.kind !== 'owner') { identity.profile.kind = 'owner'; saveIdentity(identity); }
        const token = encodeOwnershipToken(proof);
        const tip = identity.profile.handle ? '' : 'Tip: set a handle first so others can use @you/agent:  srift an id handle @yourname  (then sign again)\n';
        return out(`Ownership token for ${agent} (signed by you, @${ownerTag(proof)}).\nOn the agent run:\n  srift an id owner ${token}\n${tip}`, { token, owner: identity.address, ownerTag: ownerTag(proof), agent });
      }
      if (action === 'agents') {
        const who = pos[2] || ensureIdentity().identity.address;
        const agents = await agentsOf(who);
        if (json) return console.log(JSON.stringify({ owner: who, agents }));
        if (!agents.length) return console.log(`No agents owned by ${who} are online right now.`);
        for (const a of agents) console.log(fmtResult(a));
        return;
      }
      return fail('Usage: srift an owner sign <agentAddress> | agents [@owner]');
    }
    case 'invite': {
      const action = pos[1];
      if (action === 'list') {
        const all = Object.values(loadInvites());
        if (json) return console.log(JSON.stringify({ invites: all.map((i) => ({ ...i, token: i.token.slice(0, 6) + '...' })) }));
        if (!all.length) return console.log('No active invite tokens.');
        for (const i of all) console.log(`${i.token.slice(0, 6)}...  ${i.once ? 'one-time' : 'reusable'}  uses=${i.uses}${i.exp ? '  expires ' + new Date(i.exp * 1000).toISOString() : ''}${i.label ? '  ' + i.label : ''}`);
        return;
      }
      if (action === 'revoke') return out(`Revoked ${revokeInvites()} invite token(s). Existing links still carry your card but no longer grant contact status.`, { revoked: true });
      const { identity } = ensureIdentity();
      const ttl = flag(args, '--ttl') ?? (has(args, '--no-expiry') ? undefined : '7d');
      let exp: number | undefined;
      if (ttl) {
        const m = ttl.match(/^(\d+)([smhd])$/);
        if (!m) return fail('--ttl like 30m, 2h, 7d');
        exp = C.nowSec() + Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]];
      }
      const once = has(args, '--once');
      const token = has(args, '--open') ? undefined : C.randomToken(18);
      if (token) addInvite({ token, createdAt: C.nowSec(), exp, once, uses: 0, label: flag(args, '--label') });
      const link = encodeInvite(new AgentNode(identity, { recv: false }).card(), { token, exp, base: loadConfig().relays[0] });
      const note = token ? `\nTheir first message makes them a trusted contact${once ? ' (one use).' : '.'}` : '';
      return out(`Share this link (works even while you are offline or hidden):\n${link}\n\nThey run:  srift an contacts add "<link>"${note}`, { link, exp, once, token: !!token });
    }
    case 'card': {
      const { identity } = ensureIdentity();
      return console.log(JSON.stringify(new AgentNode(identity, { recv: false }).card(), null, 2));
    }
    case 'report': {
      const a = C.normalizeAddress(pos[1] || '') || fail('Usage: srift an report <addr> [--reason R]');
      const r = await withNode(false, (n) => n.clients[0].api('POST', '/api/an/report', { address: a, reason: flag(args, '--reason') }));
      upsertContact(a as string, { policy: 'blocked', presence: 'deny' });
      return out(r.status === 200 ? `Reported and blocked ${a}.` : `Report failed: ${r.data?.error}`, r.data);
    }

    // ─── hooks ────────────────────────────────────────────────
    case 'hook': {
      const action = pos[1] || 'show';
      const mask = (h: any) => ({ ...h, secret: h.secret ? '***' : undefined });
      if (action === 'off') { saveConfig({ hooks: {} }); return out('Hooks disabled.', { hooks: {} }); }
      if (action === 'set') {
        const cur = loadConfig().hooks;
        const url = flag(args, '--url');
        if (url && !/^https?:\/\//.test(url)) fail('--url must be http(s)');
        for (const k of ['--exec', '--decide']) {
          const v = flag(args, k);
          if (v && process.platform === 'win32' && /%SRIFT_AN_[A-Z_]+%/i.test(v)) fail(`${k}: %SRIFT_AN_…% is unsafe on Windows (cmd expands it before parsing, so message text could run commands). Read the JSON from stdin, or use PowerShell $env:SRIFT_AN_TEXT.`);
        }
        const hooks = {
          ...cur,
          ...(url ? { url } : {}),
          ...(flag(args, '--secret') ? { secret: flag(args, '--secret') } : {}),
          ...(flag(args, '--exec') ? { exec: flag(args, '--exec') } : {}),
          ...(flag(args, '--decide') ? { decide: flag(args, '--decide') } : {}),
          ...(has(args, '--allow-unknown') ? { allowUnknown: true } : {}),
        };
        saveConfig({ hooks });
        return out(`Hooks: ${JSON.stringify(mask(hooks))}\nHooks fire from the running node ('srift an up' / 'host' / 'mcp').`, { hooks: mask(hooks) });
      }
      const h = loadConfig().hooks;
      return out(JSON.stringify(mask(h), null, 2), { hooks: mask(h) });
    }

    // ─── local data hygiene ───────────────────────────────────
    case 'prune': {
      const r = prune();
      return out(`Pruned: inbox ${r.inbox}, sent ${r.sent}, peers ${r.peers}, knocks ${r.knocks}, invites ${r.invites}, read-markers ${r.markers}, partial downloads ${r.partials}, files ${r.files}${r.logRotated ? ', log rotated' : ''}. (retention ${loadConfig().retentionDays} days; set with: srift an retention <days> [--files <days>])`, r);
    }
    case 'retention': {
      const days = Number(pos[1]);
      if (!Number.isFinite(days) || days < 0) fail('Usage: srift an retention <days> [--files <days>]   (0 = keep forever)');
      const fd = flag(args, '--files');
      saveConfig({ retentionDays: Math.floor(days), ...(fd !== undefined ? { fileRetentionDays: Math.max(0, Math.floor(Number(fd) || 0)) } : {}) });
      const c = loadConfig();
      return out(`History kept ${c.retentionDays || 'forever'}${c.retentionDays ? ' days' : ''}; received files kept ${c.fileRetentionDays || 'forever'}${c.fileRetentionDays ? ' days' : ''}.`, { retentionDays: c.retentionDays, fileRetentionDays: c.fileRetentionDays });
    }
    case 'wipe': {
      const all = has(args, '--all');
      if (readLock()) fail('Stop the running node first: srift an down');
      if (!has(args, '--yes')) fail(`This deletes ${all ? 'EVERYTHING (identity, contacts, groups, config, history, files)' : 'history, peers, knocks, invites, outbox, received files and logs'} in ${anDir()}. Re-run with --yes.`);
      const removed = wipe(all);
      return out(removed.length ? `Deleted: ${removed.join(', ')}` : 'Nothing to delete.', { removed });
    }

    // ─── relays ───────────────────────────────────────────────
    case 'relay': {
      const action = pos[1] || 'list';
      const cfg = loadConfig();
      if (action === 'list') return out(cfg.relays.join('\n'), { relays: cfg.relays });
      if (action === 'add' || action === 'remove') {
        const url = (pos[2] || fail(`Usage: srift an relay ${action} <https://relay>`)) as string;
        if (!/^https?:\/\//.test(url)) fail('Relay URL must start with https:// (or http:// for local testing)');
        const u = url.replace(/\/$/, '');
        const relays = action === 'add' ? [...new Set([...cfg.relays, u])] : cfg.relays.filter((r) => r !== u);
        if (!relays.length) fail('At least one relay is required.');
        saveConfig({ relays });
        return out(`Relays: ${relays.join(', ')}`, { relays });
      }
      if (action === 'serve') {
        const { createRelayServer } = await import('../../lib/agentnet/relay.mjs');
        const port = Number(flag(args, '--port') || process.env.PORT || 8787);
        const host = flag(args, '--host') || '127.0.0.1';
        const peers = (flag(args, '--peers') || process.env.SRIFT_AN_PEERS || '').split(',').map((s) => s.trim()).filter(Boolean);
        process.on('unhandledRejection', (e: any) => console.error(`[agentnet] relay recovered from error: ${e?.message || e}`));
        process.on('uncaughtException', (e: any) => console.error(`[agentnet] relay recovered from error: ${e?.message || e}`));
        const s = await createRelayServer({ port, host, publicBaseUrl: process.env.PUBLIC_BASE_URL, peers, trustProxy: process.env.TRUST_PROXY || false });
        console.error(`[agentnet] relay listening on ${s.url} (WebSocket /an). RAM only — no database, no message storage.${peers.length ? ` Peers: ${peers.join(', ')}` : ''} Ctrl+C to stop.`);
        const stop = async () => { await s.close(); process.exit(0); };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        await new Promise(() => {});
        return;
      }
      return fail('Usage: srift an relay list|add|remove|serve');
    }

    case 'mcp': {
      const { startAgentNetMcp } = await import('./mcp.ts');
      await startAgentNetMcp({
        sessions,
        quickShare: helpers.callDaemon
          ? async (filePath) => {
            await helpers.ensureDaemon?.();
            const r = await helpers.callDaemon!('/quick-share', 'POST', { filePath: path.resolve(filePath), encrypt: true });
            if (!r?.downloadUrl) throw new Error(r?.error || 'quick-share failed');
            return { url: r.downloadUrl };
          }
          : undefined,
      });
      return;
    }

    default:
      console.error(`Unknown agentnet command: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

export { inboxPath };
