# AWS Lambda integration

A SRIFT link streams the file from the process that created it; nothing is stored on a server.
So a Lambda can hand out a file only while the invocation is still running (max 15 minutes).

## Pattern A — share from inside the invocation (recommended)

Add Node.js 20+ to the function (or use a Node.js runtime) and run the CLI in-process. It needs only
outbound HTTPS/WSS on port 443 and no local server:

```python
# handler.py  (Python runtime with a Node.js layer, or `pip install srift`, which bundles Node.js)
import json, subprocess

def lambda_handler(event, context):
    path = "/tmp/report.pdf"                      # e.g. downloaded from S3 first
    # --foreground: serve from this process; --wait: return only after the download
    p = subprocess.Popen(
        ["srift", "quick-share", path, "--once", "--foreground", "--wait", "--wait-timeout", "12m", "--json"],
        stdout=subprocess.PIPE, text=True,
    )
    link = json.loads(p.stdout.readline())["downloadUrl"]
    notify_user(link)                              # send it via email / Slack / your API
    p.wait()                                       # keep serving until downloaded or timed out
    return {"statusCode": 200, "body": json.dumps({"downloadUrl": link})}
```

The link stops working when the invocation ends, so the recipient has to download it within the
time you keep the function running.

## Pattern B — call a daemon on another machine through a tunnel (advanced)

The SRIFT daemon has no authentication: anyone who can reach it can share any file it can read.
Only expose it through a tunnel that you protect (Cloudflare Access, Tailscale, an IP allowlist),
never publicly. It also accepts only loopback `Host` headers, so the tunnel must rewrite it:

```bash
cloudflared tunnel --url http://127.0.0.1:3822 --http-host-header 127.0.0.1:3822
# or: ngrok http 3822 --host-header=rewrite
```

```python
import json, os, urllib.request

def lambda_handler(event, context):
    req = urllib.request.Request(
        f"{os.environ['SRIFT_TUNNEL_URL']}/quick-share",
        data=json.dumps({"filePath": event["filePath"]}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "srift-lambda"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return {"statusCode": 200, "body": r.read().decode()}
```

## Python SDK

`pip install srift` gives the `srift` command and `from srift import Srift` (the SDK talks to a
daemon at `SRIFT_BASE_URL`, default `http://127.0.0.1:3822`). As a single file:
`curl -O https://srift.app/sdk/python/srift.py`.
