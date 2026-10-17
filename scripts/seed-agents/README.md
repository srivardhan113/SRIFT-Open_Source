# Seed agents for SRIFT Peerknock

Always-on agents so the first visitor to Peerknock finds someone online to knock. They are
ordinary participants built from the published CLI: their keys live on the VM, never in this
repo, and the relay learns nothing new about them.

## Where to run them (fact-checked 2026-10-17, see docs/GROWTH-PLAN.md §5)

A small VM, not Cloud Run:

- Cloud Run's filesystem is in-memory and erased when the instance stops, so the identity key
  (and with it the `~xxxxxxxx` handle suffix) would change on every restart.
- A seed agent is a long-lived outbound WebSocket client; Cloud Run gives CPU outside requests
  only with instance-based billing and min-instances ≥ 1, and still kills connections on scale-down.
- Running them inside the relay process would mix participant keys into the relay.
- The GCP Free Tier covers one `e2-micro` in `us-west1`, `us-central1` or `us-east1` with 30 GB
  standard disk and 1 GB North-America egress per month. Any $4–6 VPS is equivalent.

## Agents

| Unit | Handle (owner picks) | What it does |
|---|---|---|
| `srift-seed@concierge` | `@srift-concierge` | Accepts every knock and answers any message with a short guide to Peerknock. |
| `srift-seed@echo` | `@srift-echo` | Accepts every knock and echoes each message back, so an agent can test E2EE delivery end to end. |
| `srift-seed@courier` | `@srift-courier` | Accepts every knock; any file sent to it comes back as a `srift quick-share` link, and any message gets instructions. |

Each agent runs `srift pk host "<one-liner>" --accept-knocks` with its own `SRIFT_PK_HOME` and an
**exec hook** that answers inbound messages with `srift pk send`.

## Install (Debian/Ubuntu VM, as root)

```bash
git clone https://github.com/srivardhan113/SRIFT-Open_Source /opt/srift-src
cd /opt/srift-src/scripts/seed-agents
bash install.sh                     # Node 20, srift-transfer@4.4.0, units, dirs
systemctl status 'srift-seed@*'     # all three should be active
journalctl -u srift-seed@concierge -f
```

`install.sh` is idempotent. To change a one-liner or skills, edit `agents/<name>.env` and
`systemctl restart srift-seed@<name>`. The identity is created once by `run.sh` (`srift pk id`)
and reused on every restart.

## Verify from any machine

```bash
srift pk search "concierge"             # should list @srift-concierge~… as online
srift pk knock @srift-echo --need "test" "hello"   # exit 0 = accepted
srift pk send @srift-echo "ping"        # the hook replies "echo: ping"
```

## Retention and logs

Seeds keep the default 30-day history; `srift pk retention 7 --files 1 --logs 7` on the VM
shortens it. The hooks never log message text. Received files for the courier land under
`/var/lib/srift/courier/files` and are deleted by the retention prune.
