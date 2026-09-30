# SRIFT Quick-Share End-to-End Encryption Specification

**Format:** SRE1 (SRIFT Encrypted v1)

**Status:** In use. Backwards compatible. See implementations in `cli/e2ee.ts` and `public/d-decrypt.js` for canonical behavior.

---

## Overview

SRIFT quick-share links support end-to-end encryption using AES-256-GCM with keys placed in the URL fragment. The encryption key never reaches the server in any HTTP request—browsers and clients don't transmit URL fragments to servers—so the relay only ever handles ciphertext.

Quick-share links are relay-only: the sender's local daemon streams the bytes on demand through the srift.app relay and nothing is stored server-side. Encryption is opt-in via `--encrypt` or `--password` on the sender side.

**Decryption happens client-side:**
- In the browser: `/d/<token>` serves an HTML page that decrypts locally using WebCrypto
- In the CLI: `srift get <url>` decrypts during download
- Plain curl/wget: receives ciphertext (cannot decrypt without implementing this spec)

---

## Threat Model

### What the server can see
- **Ciphertext size** — which reveals the approximate file size (plaintext + 16 bytes per chunk + header)
- **Timing** — how long transfers take, pattern of requests
- **Download count** — how many times the link is fetched
- **Metadata**: link expiry, download limits, created-at time
- **User IP** — for any initial request

### What the server **cannot** see
- **Plaintext filename** — encrypted in the metadata block
- **File content** — AES-256-GCM ciphertext
- **Encryption key** — never transmitted; only in the URL fragment
- **Password** — only the random salt is in the header; the password itself is known only to sender and recipient

### Security assumptions
- The sender shares the full link (including fragment) via a trusted channel (direct message, email, secure chat, etc.)
- If the link is leaked, an attacker who obtains the full URL can decrypt the file; the password (if set) provides a second factor
- The relay server operator is assumed to be honest-but-curious (does not have the key, so cannot cheat by decrypting)

---

## Format Specification

### Header (36 bytes, fixed)

```
Offset  Size   Field             Description
------  -----  -----             -----------
0       4      magic             ASCII "SRE1"
4       1      version           u8, currently 1
5       1      flags             u8; bit 0 = password present
6–7     2      (reserved)        MUST be 0x0000
8       4      chunkSize         u32 big-endian; bytes per chunk, 1024–67108864 (64 MB)
12      7      noncePrefix       7 random bytes; forms the first 7 bytes of every IV
19      1      (reserved)        MUST be 0x00
20      16     salt              16 random bytes; used for password PBKDF2 + HKDF
```

All multibyte integers are big-endian.

### Metadata Block

Follows the header immediately (no gap).

```
Offset  Size   Field             Description
------  -----  -----             -----------
36      4      metaLen           u32 big-endian; total length of encrypted metadata (plaintext + 16-byte tag)
40      *      ciphertext        AES-256-GCM(counter=0, lastFlag=0) of the JSON metadata
```

The ciphertext includes the 16-byte authentication tag appended by the cipher.

**Plaintext metadata (before encryption):**
```json
{
  "name": "filename.ext",
  "size": 12345,
  "mime": "application/octet-stream"
}
```

- `name`: UTF-8 filename (may include forward slashes for paths; no directory traversal protection at this layer — that's the application's responsibility)
- `size`: Plaintext file size in bytes (so the recipient knows expected length before downloading all chunks)
- `mime`: IANA MIME type (e.g. "text/plain", "image/png"); informational, not enforced

### Data Chunks

Follow the metadata block immediately.

Each chunk is encrypted under a separate counter, allowing partial decryption and out-of-order verification (with a caveat on reordering attacks; see IV construction below).

```
Offset  Size   Field             Description
------  -----  -----             -----------
*       C      plaintext         Up to chunkSize bytes of file data
                                 (last chunk may be shorter; others are exactly chunkSize)
*       16     authTag           AES-256-GCM authentication tag (appended by cipher)
```

Total encrypted size per chunk: `len(plaintext) + 16` bytes.

### Complete File Layout

```
[Header (36 B)]
[MetaLen (4 B)] [Encrypted Metadata + Tag (metaLen bytes)]
[Chunk 1 plaintext] [Chunk 1 tag (16 B)]
[Chunk 2 plaintext] [Chunk 2 tag (16 B)]
...
[Chunk N plaintext] [Chunk N tag (16 B)]
```

---

## Cryptography

### Ciphertext Authentication

**Cipher:** AES-256-GCM (Galois/Counter Mode)
- **Key size:** 256 bits (32 bytes)
- **IV (nonce) size:** 96 bits (12 bytes), structured as below
- **Tag size:** 128 bits (16 bytes, always appended)
- **AAD (Additional Authenticated Data):** Always the 36-byte header

### Nonce (IV) Construction

Each block uses a unique nonce to prevent key reuse attacks:

```
Byte   Offset  Content
-----  ------  -------
0–6    0–6     noncePrefix (7 bytes from header)
7–10   7–10    counter (u32 big-endian: chunk index)
11     11      lastFlag (0x00 for all but final chunk, 0x01 for final chunk)
```

**Example:**
- Metadata block: `noncePrefix || 0x00000000 || 0x00` (counter 0, not last)
- Chunk 1: `noncePrefix || 0x00000001 || 0x00` (counter 1, not last)
- Chunk N (last): `noncePrefix || counter_n || 0x01` (counter N, is last)

The `lastFlag` is part of the nonce, so the last chunk cannot be swapped with a non-last chunk; this prevents truncation attacks.

### Key Derivation

**Without password (link-key mode):**
```
contentKey = fragKey
```

The `fragKey` is 32 random bytes, directly used as the AES-256 key.

**With password (two-factor mode):**
```
pwKey = PBKDF2-SHA256(password_utf8_nfc, header.salt, 100000 iterations, 32 bytes)
contentKey = HKDF-SHA256(fragKey || pwKey, header.salt, "srift-e2ee-v1", 32 bytes)
```

- **PBKDF2:** 100,000 iterations (as of 2026; intended for ~100 ms on 2024 hardware)
- **Password normalization:** NFC (Composed) form, UTF-8 encoded
- **HKDF:** SHA-256 hash, salt from header, info string "srift-e2ee-v1"
- **Output:** 32 bytes, used directly as AES-256 key

The password is never transmitted. Decryption needs both the fragment key and the password: the link alone is not enough, and neither is the password alone. A leaked link therefore stays protected by the password, but only as strongly as the password resists offline guessing (100,000 PBKDF2 iterations per guess) by someone who also has the ciphertext.

---

## URL Fragment Key

The encryption key is placed after `#` in the URL:

```
https://srift.app/d/<token>#k=<base64url_key>
```

**Format:**
- Base64url encoding (RFC 4648 §5): no padding, `-` instead of `+`, `_` instead of `/`
- Always exactly 43 characters for a 32-byte key
- The fragment is not sent to the server in any HTTP request

**Peek without decryption:**
- **Endpoint:** `GET /d/<token>?peek=1`
- **Returns:** First `36 + 4 + metaLen` bytes (header + metadata length + encrypted metadata)
- **Does not consume** a download from `--max-downloads` limit
- **Use case:** the browser page shows the filename and size, and `srift get` checks the key/password, before anything is downloaded
- **Limited links:** once a `--once` link has been used, peek returns 410 unless the request carries the `X-SRIFT-Resume` token issued with that download

---

## Encryption Process (Sender)

```
1. Read plaintext file (size S)
2. Generate 32-byte random key
3. Generate 7-byte random noncePrefix
4. Generate 16-byte random salt (if password is set)
5. Build header (36 bytes)
6. Serialize metadata JSON, encrypt with counter=0, append tag
7. For each chunk of the file (counter = 1, 2, ..., N):
   - Read up to chunkSize bytes
   - If this is the last chunk, set lastFlag = 0x01, else 0x00
   - Construct IV = noncePrefix || counter || lastFlag
   - Encrypt plaintext with AES-256-GCM(key, IV, header as AAD)
   - Append 16-byte tag
8. Emit: [header][metaLen][metadata ciphertext][chunks...]
9. Base64url-encode the key, place in URL fragment: #k=...
```

### Reference Implementation

See `cli/e2ee.ts` functions:
- `buildHeader()` — construct the 36-byte header
- `encryptFile()` — streaming encryption generator
- `deriveContentKey()` — password-based key derivation

---

## Decryption Process (Recipient)

```
1. Extract fragment from URL: location.hash or URL parser
2. Decode base64url key (must be 32 bytes, 43 chars)
3. Fetch /d/<token> (or /d/<token>?peek=1 for metadata only)
4. Read 36-byte header, validate magic and version
5. Derive contentKey from fragKey + password (if needed)
6. Read metaLen (4 bytes), extract encrypted metadata (metaLen bytes)
7. Decrypt metadata with counter=0, lastFlag=0, verify tag
8. Parse JSON to get filename and total size
9. For each chunk (counter = 1, 2, ..., N):
   - Read plaintext, tag
   - Construct IV = noncePrefix || counter || lastFlag_from_file
   - Decrypt with AES-256-GCM(key, IV, header as AAD), verify tag
   - Append plaintext to output
10. Save file with decrypted name
```

### Browser Implementation

See `public/d-decrypt.js` functions:
- `parseHeader()` — extract metadata from the 36-byte header
- `contentKey()` — derive key from password using SubtleCrypto
- `open()` — decrypt a block with AES-GCM verification
- `readMetaBlock()` — extract and decrypt metadata

---

## Compatibility & Versioning

### Version field (header byte 4)
- **Current:** 1
- **Future:** Clients encountering version > 1 MUST refuse to decrypt and display an error message directing users to update SRIFT

### Breaking changes
Any change to the header format, AAD, nonce construction, or KDF parameters requires a new version number.

### Non-breaking improvements
- Larger default chunkSize (if header is extended, keep version number; new fields after byte 35 are safe)
- Additional MIME types or metadata fields (JSON is versioned separately)

---

## Error Handling

### Decryption failures
**`"Wrong password, or the file was modified."`** (if password flag is set)
**`"Decryption failed — the link is incomplete or the file was modified."`** (if no password)

These errors can result from:
- Tag verification failure (modified ciphertext, truncation, corruption)
- Incorrect password (PBKDF2 derivation yields wrong key)
- Out-of-order or missing chunks

### Truncation attacks
Because the lastFlag is part of the nonce, an attacker who truncates the file stream will fail tag verification on the (now-final) chunk. Each chunk must be verified independently.

### Replay attacks
The nonce includes a counter and lastFlag, so chunks cannot be replayed or reordered without detection.

---

## Examples

### Example 1: Unencrypted relay link

Link: `https://srift.app/d/TOKEN`

- No fragment
- Server sees plaintext file (zero retention — streamed from sender daemon)
- Recipient downloads via `curl`, `wget`, browser

### Example 2: Encrypted relay link with link key only

Sender runs:
```bash
srift quick-share file.zip --encrypt
```

Link: `https://srift.app/d/TOKEN#k=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm`

- 43-character base64url key in fragment
- The sender's daemon encrypts and streams the file through the relay on demand
- The relay forwards ciphertext only and stores nothing (cannot see plaintext)
- Recipient opens in browser or runs `srift get "<url>"` to decrypt locally
- No password protection

### Example 3: Encrypted relay link with password

Sender runs:
```bash
srift quick-share file.zip --encrypt --password mysecret
```

Link: `https://srift.app/d/TOKEN#k=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm`

- Header flag byte 5 bit 0 = 1 (password present)
- Header contains 16-byte salt
- Recipient must provide password; browser shows password prompt or `srift get "<url>" --password mysecret`
- Server sees header + salt (not the password)
- Even if the link is leaked, the password provides a second authentication factor

---

## Testing

Both implementations (Node.js and browser) have test vectors that must round-trip:
- Encrypt a file, decrypt it, verify byte-for-byte equality
- Corrupt a single byte in the ciphertext, confirm decryption fails
- Drop the final chunk, confirm truncation is detected
- Provide a wrong password, confirm derivation yields the wrong key and decryption fails

See `tests/relay-encryption.test.ts` and `tests/encryption.test.ts`.

---

## References

- **AES-256-GCM:** NIST SP 800-38D, Recommendation for Block Cipher Modes of Operation: Galois/Counter Mode (GCM)
- **PBKDF2:** RFC 8018, PKCS #5: Password-Based Cryptography Specification Version 2.1
- **HKDF:** RFC 5869, HMAC-based Extract-and-Expand Key Derivation Function (HKDF)
- **Base64url:** RFC 4648 Section 5, The Base64url Data Encodings
- **WebCrypto:** MDN Web Docs, Web Crypto API, https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API

---

**Document status:** Final (2026-09-23)  
**Last updated by:** SRIFT development team  
**Canonical implementations:** `cli/e2ee.ts`, `public/d-decrypt.js`
