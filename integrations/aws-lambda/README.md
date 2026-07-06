# AWS Lambda integration

Lambda can't host the SRIFT daemon (15-min timeout, no persistent ports). Two patterns:

## Pattern A — Lambda calls user's daemon via API Gateway + tunnel

```python
# handler.py
import json, urllib.request

def lambda_handler(event, context):
    body = json.loads(event["body"])
    req = urllib.request.Request(
        f"{os.environ['SRIFT_TUNNEL_URL']}/quick-share",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return {"statusCode": 200, "body": r.read().decode()}
```

Set `SRIFT_TUNNEL_URL` to user's `cloudflared`/`ngrok`/`tailscale funnel` URL.

## Pattern B — Lambda for one-shot operations only

Use `/quick-share` as a one-shot: each Lambda invocation creates a session, seeds a file already
in S3 (download to /tmp first), returns the share URL. The session dies with the Lambda but the
share URL stays valid until the user opens it.

## Lambda Layers

Drop `sdk/python/srift.py` into a Lambda layer for instant `import srift` across all your functions.
