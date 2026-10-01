# Deploying the copilot-review-smart Listener

The Listener (`pr_monitor_webhook.mjs`) is platform-agnostic plain Node: it
needs Node >= 18, an authenticated `gh` CLI, network access to GitHub and
OpenRouter, and a public HTTPS URL that reaches `POST /github/webhook`. **This
folder does not pick a platform for you**: the agent (or the operator) chooses
where to run it — a VPS, a container host, a machine at home — based on what
the Host already has.

## What every deployment needs

| Env | Purpose |
|---|---|
| `PR_MONITOR_REPOS` | watched repos, comma-separated (`owner/repo,...`) |
| `PR_MONITOR_WEBHOOK_SECRET` | HMAC secret; `--rotate-secret` prints a fresh one |
| `PR_MONITOR_PUBLIC_URL` | public base URL that reaches the Listener |
| `gh` auth | `GH_TOKEN`, or a mounted `~/.config/gh` from `gh auth login` |
| `OPENROUTER_API_KEY` | decision LLM (env / `~/.pr-monitor.env` / `~/.hermes/.env`) |
| volume | `~/.cache/pr-monitor/` for state, Expectations and pid/log files |

Optional: `PR_MONITOR_LOGIN`, `PR_MONITOR_DEBOUNCE_MS`,
`PR_MONITOR_TICK_TIMEOUT`, `PR_MONITOR_STARTUP_TICK=0`,
`PR_MONITOR_NOTIFY_CMD`, `PR_MONITOR_WEBHOOK_HOST`/`PORT`,
`PR_MONITOR_WEBHOOK_LOG`, `PR_MONITOR_MODEL`.

## Steps

1. Make the Listener reachable: pick an ingress recipe from
   [`ingress/`](./ingress/) (Tailscale Funnel, ngrok, cloudflared, reverse
   proxy) and set `PR_MONITOR_PUBLIC_URL` to the public base URL.
2. Run the Listener: foreground `--serve` while testing, `--daemon` (pid +
   log files under `~/.cache/pr-monitor/`) or a supervisor (systemd unit
   below) for real.
3. Register the Hook: `--serve --setup-hooks` (verifies the public URL and
   waits for GitHub's ping), or `--setup-hooks` against a running instance.
4. Check it: `--status` (pid + health) and `--list-hooks` (Hook delivery
   status). `--teardown` removes the Hook; `--rotate-secret` rotates it.

Docker users: see [`Dockerfile`](./Dockerfile) and
[`docker-compose.yml`](./docker-compose.yml). Systemd users:
[`copilot-review-smart-listener.service`](./copilot-review-smart-listener.service).

Cron mode stays available on Hosts with no public URL:

```bash
PR_MONITOR_REPOS="your-org/your-repo" node pr_monitor.mjs --json-report
```
