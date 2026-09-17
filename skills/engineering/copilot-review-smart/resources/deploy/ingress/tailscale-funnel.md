# Ingress: Tailscale Funnel

Best when the Host is already on a tailnet: Funnel gives a **stable** public
HTTPS URL, so the Hook never has to be updated after the first setup.

```bash
# 1. Enable HTTPS certificates + Funnel for this machine.
tailscale cert "$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')"
sudo tailscale funnel --bg 8787

# 2. The public base URL is your node's DNS name with https://:
#    https://<host>.<tailnet>.ts.net
export PR_MONITOR_PUBLIC_URL="https://<host>.<tailnet>.ts.net"
```

Then run the Listener and register the Hook (the URL is stable, so this is a
one-time setup):

```bash
PR_MONITOR_REPOS="owner/repo" \
PR_MONITOR_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
PR_MONITOR_PUBLIC_URL="https://<host>.<tailnet>.ts.net" \
node pr_monitor_webhook.mjs --serve --setup-hooks
```

Notes:

- Funnel serves HTTPS on port 443; the Listener can keep binding
  `127.0.0.1:8787`.
- `tailscale funnel status` shows the active mapping.
- Rotate the secret later with `--rotate-secret`; the Hook URL stays valid.
