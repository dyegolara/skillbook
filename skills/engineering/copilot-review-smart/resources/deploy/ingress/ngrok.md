# Ingress: ngrok

Fastest for a dev machine, but the free tier hands out a **new URL on every
restart**. That is fine: the Hook is bound by id, so a changed
`PR_MONITOR_PUBLIC_URL` updates the existing Hook instead of creating a
duplicate.

```bash
# Terminal 1 — expose the local Listener.
ngrok http 8787
# Copy the https://<id>.ngrok-free.app URL.
```

The Listener can also do this for you (it uses the ngrok local API at
`127.0.0.1:4040` and cleans the tunnel up on exit):

```bash
PR_MONITOR_REPOS="owner/repo" \
PR_MONITOR_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
node pr_monitor_webhook.mjs --serve --setup-hooks --tunnel ngrok
```

Without `--tunnel`, pass the URL explicitly:

```bash
PR_MONITOR_PUBLIC_URL="https://<id>.ngrok-free.app" \
PR_MONITOR_REPOS="owner/repo" \
PR_MONITOR_WEBHOOK_SECRET="..." \
node pr_monitor_webhook.mjs --serve --setup-hooks
```

Notes:

- A paid ngrok domain keeps the URL stable across restarts.
- Verify with `--list-hooks`; recent delivery statuses are shown per Hook.
- If you restart ngrok without re-running `--setup-hooks`, the Hook still
  points at the old URL — run `--setup-hooks` again (it PATCHes by id).
