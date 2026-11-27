// MCP stdio smoke test for the public mirror's CI: start `srift mcp`, send initialize + tools/list,
// and check the server names itself and lists its tools (srift_quick_share among them).
// Usage: node .github/scripts/mcp-smoke.mjs <path to the srift CLI entry>
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'

const cli = process.argv[2]
if (!cli) {
  console.error('usage: node mcp-smoke.mjs <srift cli entry>')
  process.exit(2)
}

const MIN_TOOLS = 15
const child = spawn(process.execPath, [cli, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let failed = false

const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`)
const request = (id, method, params = {}) =>
  new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })

createInterface({ input: child.stdout }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return console.error(`non-JSON on stdout: ${line.slice(0, 200)}`) }
  const waiter = msg.id !== undefined && pending.get(msg.id)
  if (!waiter) return
  pending.delete(msg.id)
  if (msg.error) waiter.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
  else waiter.resolve(msg.result)
})

const timer = setTimeout(() => finish('timed out after 60 s waiting for the MCP server'), 60_000)

function finish(error) {
  clearTimeout(timer)
  if (error) { failed = true; console.error(`FAIL: ${error}`) }
  child.kill()
  // `srift mcp` may have started the background daemon: stop it so the job does not keep a process alive.
  spawnSync(process.execPath, [cli, 'daemon', 'stop'], { stdio: 'ignore', timeout: 15_000 })
  process.exit(failed ? 1 : 0)
}

child.on('exit', (code) => { if (pending.size) finish(`server exited early (code ${code})`) })

try {
  const init = await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'srift-mirror-ci', version: '1' },
  })
  const name = init?.serverInfo?.name
  if (!name) throw new Error('initialize returned no serverInfo.name')
  console.log(`initialize: ${name} ${init.serverInfo.version ?? ''} (protocol ${init.protocolVersion})`)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  const { tools = [] } = await request(2, 'tools/list')
  const names = tools.map((t) => t.name)
  console.log(`tools/list: ${names.length} tools: ${names.join(', ')}`)
  if (names.length < MIN_TOOLS) throw new Error(`expected at least ${MIN_TOOLS} tools, got ${names.length}`)
  if (!names.includes('srift_quick_share')) throw new Error('srift_quick_share missing from tools/list')
  finish()
} catch (err) {
  finish(err.message)
}
