# SRIFT Privacy Policy & Legal Terms

This document details the privacy posture, legal terms, and operational boundaries of the SRIFT platform. 

SRIFT is built from the ground up on a **Zero-Knowledge Architecture**. We do not collect, read, or store any of your files, messages, or metadata.

---

## 🔒 Privacy in Plain English

Here is exactly how Srift handles your data:

1.  **No File Storage:** We do not store your files on any cloud servers. Files are transferred directly peer-to-peer (P2P).
2.  **No Message Logs:** Chat messages are encrypted end-to-end and are never stored or logged on our infrastructure.
3.  **No Accounts:** You do not need to create an account, register an email, or sign in to use Srift.
4.  **No Tokens or Keys on Servers:** All cryptographic encryption keys are derived and maintained locally on your device. They are never sent to the signaling server.
5.  **No Ad Tracking:** We do not sell ads, collect cookies for tracking, or use third-party advertising trackers.
6.  **No Metadata Logging:** We do not keep logs of who connected to whom, or when.
7.  **Government/Subpoena Proof:** Because we do not store files, keys, account credentials, or transit logs, we have no useful data to provide to third parties or law enforcement agencies under subpoena.

---

## 🏗️ Zero-Knowledge Architecture

The signaling server handles only the routing of encrypted connection offers and network coordination (via WebRTC/WebTorrent/WebSockets).
*   **Local Encryption:** All data payload chunks are encrypted client-side using AES-256-GCM prior to transmission.
*   **Key Derivation:** The signaling server only receives a hashed session identifier, never the key derivation password or raw encryption keys.
*   **E2E Enforcement:** The signaling server routes ciphertext payloads only. It is mathematically blind to the contents of the transfer.

---

## ⚖️ Terms of Use & Responsibilities

By using SRIFT, you accept and agree to the following conditions:

*   You are fully responsible for the activities conducted through your sessions.
*   You must comply with all applicable local, national, and international laws.

### Prohibited Activities
You explicitly agree not to use the service to:
*   Share copyrighted material without authorization.
*   Transmit malware, viruses, trojans, or harmful code.
*   Conduct illegal activities, illicit transactions, or cybercrimes.
*   Harass, threaten, stalk, or harm others.
*   Attempt to breach the security or integrity of Srift or other connected peers.
*   Use the service for criminal activities or terrorism.

---

## 🛠️ Disclaimer & Limitation of Liability

SRIFT is provided "as is", without warranty of any kind, express or implied. In no event shall the authors, maintainers, or copyright holders be liable for any claim, damages, or other liability arising from, out of, or in connection with the software or the use of the software.
