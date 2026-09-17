# Ingress: reverse proxy (nginx / Caddy / Traefik / any HTTPS terminator)

Any reverse proxy works as long as it:

1. serves **public HTTPS with a trusted certificate** (GitHub will not deliver
   to plain HTTP or self-signed certs),
2. forwards `POST /github/webhook` and `GET /healthz` to the Listener,
3. forwards the request body **unchanged** (the HMAC is over the raw bytes)
   and passes headers through (`X-Hub-Signature-256`, `X-GitHub-Event`,
   `X-GitHub-Delivery`).

nginx:

```nginx
server {
  listen 443 ssl;
  server_name pr-monitor.example.com;

  ssl_certificate     /etc/letsencrypt/live/pr-monitor.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/pr-monitor.example.com/privkey.pem;

  location /github/webhook {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  location /healthz {
    proxy_pass http://127.0.0.1:8787;
  }
}
```

Caddy:

```caddyfile
pr-monitor.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Then:

```bash
PR_MONITOR_PUBLIC_URL="https://pr-monitor.example.com" \
PR_MONITOR_REPOS="owner/repo" \
PR_MONITOR_WEBHOOK_SECRET="..." \
node pr_monitor_webhook.mjs --serve --setup-hooks
```

`--setup-hooks` probes `$PR_MONITOR_PUBLIC_URL/healthz` before touching GitHub
and refuses to create a Hook it cannot verify — fix the proxy (or use cron
mode) rather than registering a broken Hook.
