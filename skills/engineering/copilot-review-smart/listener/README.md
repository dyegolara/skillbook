# @skillbook/pr-monitor-listener

The webhook-first Listener for the copilot-review-smart skill, extracted from
the single `pr_monitor_webhook.mjs` script per ADR 0002 (a script past ~500
lines of real logic becomes its own package with one module per concern).

Provenance: extracted verbatim from
`skills/engineering/copilot-review-smart/pr_monitor_webhook.mjs` (v2.3.0) with
no behaviour change; the skill's `pr_monitor_webhook.mjs` is now the CLI shim
that re-exports `src/cli.mjs`'s `main()`.

Deliberate deviation from ADR 0002's "(where TypeScript applies)": this
package stays plain ESM JavaScript because it is a skill runtime dependency —
the "install skill, run script" contract must hold with nothing but Node
(>= 18) installed, and a TypeScript build step would break it. Type checking
for this package is a candidate follow-up once a build story exists.

Modules (one per reason the code changes):

- `src/paths.mjs` — script paths and runtime defaults
- `src/signature.mjs` — HMAC verification, Delivery classification, keys
- `src/state.mjs` — Listener state (Expectations, Hook ids) persistence
- `src/tick-runner.mjs` — spawning and parsing Ticks
- `src/listener.mjs` — Flows, Expectations, debounce and tick queue
- `src/http-transport.mjs` — `/healthz` and the signed webhook endpoint
- `src/notify.mjs` — serialized owner-notification dispatch
- `src/hooks.mjs` — GitHub Hook CRUD and secret rotation
- `src/tunnels.mjs` — ngrok/cloudflared dev tunnels
- `src/daemon.mjs` — pid files, status, stop, detach
- `src/cli.mjs` — argument parsing, config resolution, commands
