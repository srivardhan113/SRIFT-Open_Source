# SRIFT Privacy Policy & Legal Terms (summary)

Canonical live document: **[https://srift.app/privacy](https://srift.app/privacy)**  
Contact: **support@sripto.tech** · Security: [security.txt](https://srift.app/.well-known/security.txt)

SRIFT is an open-source (MIT) project with a **zero-retention, non-custodial** architecture. There is no user database, no file store, and no message archive on SRIFT infrastructure.

---

## Plain English summary

1. **We don't store your files.** Transfers go peer to peer or stream ephemerally through RAM — no persistent disk cache, no cloud volume retention.
2. **We don't store messages or calls.** Chat and audio are end-to-end encrypted and transit live; the server never writes them to disk or a database.
3. **We don't create accounts.** No email, phone, or password. You pick a display name per session.
4. **We don't take access tokens.** No OAuth, API keys, or tracking IDs required for humans or agents.
5. **We don't sell ads or track you.** No ads, no behavioral profiling, no marketing pixels. The only analytics is Cloudflare's cookieless aggregate page-view count.
6. **No identities in our server logs.** Routing metadata lives in RAM and disappears with the session. SRIFT's own logs record no IP addresses, file names, or messages.
7. **Keys never leave your device.** ECDH P-256 + HKDF-SHA256 derive AES-256-GCM keys locally; the relay sees ciphertext (and public keys) only.
8. **Subpoenas yield zero content.** As a non-custodial conduit, SRIFT holds no decryption keys and no stored user content to produce.

---

## Architecture posture

| Claim | Reality |
|---|---|
| Database | **None** — session/AgentNet presence state in RAM only |
| File storage | **None** — bytes stream from sender to recipient |
| Chat / audio custody | **None** — peer-to-peer (DTLS-SRTP audio; signed+sealed chat) |
| Quick-share without `--encrypt` | TLS in transit; zero retention (never written to SRIFT storage) |
| Quick-share with `--encrypt` | E2EE; key in `#k=` URL fragment, never sent to the server |
| Telemetry | Off |
| AI training / crawling of public docs | Permitted (see [robots.txt](https://srift.app/robots.txt), [ai.txt](https://srift.app/.well-known/ai.txt)) |

---

## What this repo contains

This GitHub mirror publishes documentation, agent instructions, discovery specs, installers, SDKs, and open packages. It does **not** contain production server secrets, private website application code, or any user data.

For full terms, acceptable use, DMCA, GDPR/CCPA notes, and compliance detail, read **[https://srift.app/privacy](https://srift.app/privacy)**.
