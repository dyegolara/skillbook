# Ingress: cloudflared

Quick tunnels need no Cloudflare account; a **named tunnel** plus a DNS record
gives a stable hostname. Quick tunnels hand out a new
`https://<words>.trycloudflare.com` URL on every start — the Hook is updated by
id when you re-run setup.

Quick tunnel (dev), driven by the Listener:

```bash
PR_MONITOR_REPOS="owner/repo" \
PR_MONITOR_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
node pr_monitor_webhook.mjs --serve --setup-hooks --tunnel cloudflared
```

Manual quick tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
# Use the printed https://<words>.trycloudflare.com as PR_MONITOR_PUBLIC_URL.
```

Named tunnel (stable, recommended for real Hosts):

```bash
cloudflared tunnel login
cloudflared tunnel create pr-monitor
cloudflared tunnel route dns pr-monitor pr-monitor.example.com
cloudflared tunnel run --url http://127.0.0.1:8787 pr-monitor
```

Then set `PR_MONITOR_PUBLIC_URL="https://pr-monitor.example.com"` and run
`--serve --setup-hooks`.

Notes:

- Cloudflare terminates TLS; the Listener stays on `127.0.0.1:8787`.
- The ingress must forward the request body unchanged: the signature is an
  HMAC over the raw bytes.
- `--list-hooks` shows whether GitHub's deliveries reach the tunnel.
