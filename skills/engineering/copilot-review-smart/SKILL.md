---
name: copilot-review-smart
description: "Smart Copilot PR-review watchdog (multi-repo) that reads review state + timestamps, checks merge conflicts first, and lets an LLM decide (rebase/review/fix/notify/wait) instead of pinging daily. Webhook-first Listener with Expectation fallback; cron as alternate mode. Use for PR monitors that kept spamming '@copilot code review'."
version: 2.3.0
author: Hermes Agent (Marcus)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [GitHub, Copilot, PR-monitor, Code-Review, Webhook, Cron, LLM-decision]
---

# Copilot Review — Smart (LLM-decided) watchdog

Webhook-first: a signed GitHub Delivery wakes one tick scoped to the affected
PR, and the fallback is an **Expectation** the tick arms (`next_check_at`) —
not a schedule. Cron is the alternate mode for Hosts that cannot expose a
public HTTPS endpoint. Design record:
`docs/adr/0005-webhook-first-expectation-fallback.md` (repo root).

Both modes drive open PRs toward a Copilot clean bill of health without
spamming: they ping `@copilot code review` only when a review is actually
useful, ask Copilot to resolve merge conflicts when needed, and tell the OWNER
when a PR is ready for human review — staying silent the rest of the time.

Triggers:

- "Stop spamming @copilot on that PR, it's already clean."
- "Watch PRs and tell ME when one is ready, not ping Copilot forever."
- "Set up the webhook PR watchdog (Listener) on this Host."
- Building a PR-monitor cron that should be quiet when there's nothing to do.

## Reference implementation

`pr_monitor.mjs` (next to this file) is the portable reference tick script:
plain ESM JavaScript, no build step, runs on Node >= 18 with an
authenticated `gh` CLI (see `docs/adr/0002` for the repo's script standard).
It is env-driven and **the repos to watch are passed as context, never
defaulted** — an installed skill must not silently watch someone else's
repos:

```bash
DRY_RUN=1 PR_MONITOR_REPOS="your-org/your-repo" node pr_monitor.mjs
```

`pr_monitor_webhook.mjs` is the Listener (webhook transport only, no decision
logic): plain ESM, `node:http`, no dependencies. Its implementation lives in
the `listener/` package next to this file (one module per concern — see
`listener/README.md`); the script itself is the CLI shim. It spawns ticks of
`pr_monitor.mjs` and arms their Expectations:

```bash
PR_MONITOR_REPOS="your-org/your-repo" \
PR_MONITOR_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
PR_MONITOR_PUBLIC_URL="https://your-public-host" \
node pr_monitor_webhook.mjs --serve --setup-hooks
```

Other env: `PR_MONITOR_STATE_PATH` (default `~/.cache/pr-monitor/state.json`)
and `DRY_RUN=1` (print would-be comments, never post, never persist state).
The decision source — an explicit command, an explicit model+credential pair,
or the auto-discovered agent session, with its precedence, settings and launch
examples — is documented under
[Decision source](#decision-source-what-an-invoking-agent-defines-or-exports).

## Invocation API

Tick (shipped):

- **One-shot repo scope**: `node pr_monitor.mjs --repo owner/repo --json-report`
- **One-shot single-PR scope**: `node pr_monitor.mjs --pr owner/repo#123 --json-report`
- **Env equivalents**: `PR_MONITOR_REPOS`, `PR_MONITOR_PR`, `PR_MONITOR_REPORT=jsonl`
- **PR ref formats**: `owner/repo#123` or `https://github.com/owner/repo/pull/123`

Listener (webhook mode):

- `node pr_monitor_webhook.mjs --serve [--setup-hooks] [--keep-alive] [--tunnel ngrok|cloudflared]`
- `node pr_monitor_webhook.mjs --daemon` / `--stop` / `--status`
- `node pr_monitor_webhook.mjs --setup-hooks [--rotate-secret]` / `--list-hooks` / `--teardown`

Contract:

- One tick invocation = **exactly one tick** of the watchdog.
- Repo scope and single-PR scope are **mutually exclusive**; missing scope fails fast.
- `--json-report` / `PR_MONITOR_REPORT=jsonl` emits **one JSON line per PR** plus
  **one overall JSON line** at the end for machine-readable loop control. Each PR
  line carries `next_check_at` and `owner_notifications` for the Listener.
- `DRY_RUN=1` still prints would-be comments, but never posts to GitHub and never
  persists state.

Implementation status:

- [x] single-PR scope
- [x] agent-facing JSON tick report
- [x] transcript-based All-clear / Notify-ready
- [x] needs-human terminal reporting
- [x] fixture harness runner for one-shot and loop scenarios
- [x] webhook Listener (`pr_monitor_webhook.mjs`)
- [x] `next_check_at` + structured owner notifications in the tick report
- [x] Hook management, process management, Expectation persistence, tunnels, deploy recipes

Harness command:

```bash
npm run harness:copilot-review-smart -- all-clear-human
npm run harness:copilot-review-smart -- loop-single-pr-to-done --loop
```

Loop recipe (caller-owned; the script never sleeps):

1. Run one tick.
2. Read the final overall JSON line.
3. If `done: true`, tell the owner the scope reached either **All-clear** or
   **needs-human**, then stop.
4. Otherwise sleep the cadence (default **1 hour**, never below **15 minutes**)
   and run the next tick.

Terminal meanings in the JSON report:

- `terminal: "done"` → All-clear observed; Notify-ready path.
- `terminal: "needs-human"` → the loop cannot safely advance on its own for this
  head sha (for example conflict retries exhausted, or recurring LLM failure).
- `terminal: "skipped"` → draft/WIP PR skipped entirely and excluded from loop
  completion.

## Webhook mode (primary)

Full design record:
`docs/adr/0005-webhook-first-expectation-fallback.md` (repo root).

A delivery is a trigger, not a decision: it wakes one tick scoped to the
affected PR (`--pr`), and the existing gates + LLM decide the next step.

Lifecycle:

1. Invocation ensures the Hook (`--setup-hooks`, idempotent, bound by hook id)
   and starts the Listener (`--serve` foreground, `--daemon` detached so the
   invoking session can end).
2. The Listener runs one **Startup tick** over the watched repos to recover
   deliveries missed while it was down (`PR_MONITOR_STARTUP_TICK=0` disables).
3. Deliveries are verified (HMAC), filtered (watched repo, own Echo), debounced
   per PR (`PR_MONITOR_DEBOUNCE_MS`, default 30s) and queued; one tick runs at
   a time as `node pr_monitor.mjs --pr owner/repo#123 --json-report`.
4. The tick report carries `next_check_at` per PR and the Listener arms it. If
   no Delivery arrives first, it runs a **Fallback tick** — the only fallback,
   there is no periodic sweep. `next_check_at: null` means the PR is quiescent.
5. A Flow closes at `notify_ready` (All-clear) or when the PR is closed or
   merged; `needs-human` keeps its weekly retry. When no open PR is left to
   watch, the Listener exits (`--keep-alive` keeps it up under a supervisor).
   Pending Expectations and Hook ids persist in the Listener state file and
   survive restarts.

Events subscribed (all filtered by watched repo): `pull_request` `opened` /
`synchronize` / `reopened` / `ready_for_review` / `converted_to_draft` /
`closed`; `pull_request_review` `submitted` / `dismissed`;
`pull_request_review_comment` `created`; `issue_comment` `created` / `edited`.

Security: `X-Hub-Signature-256` (HMAC-SHA256 over the raw body, constant-time
compare) with `PR_MONITOR_WEBHOOK_SECRET`; the Listener refuses to start
without it. `PR_MONITOR_LOGIN` (default from `gh api user`) filters the loop's
own comments.

Serving and management:

- `POST /github/webhook`, `GET /healthz` (liveness + last Delivery);
  `PR_MONITOR_WEBHOOK_HOST`/`PORT` (default `127.0.0.1:8787`), JSONL log to
  stdout (`PR_MONITOR_WEBHOOK_LOG` optional).
- `--setup-hooks [--rotate-secret]`, `--list-hooks`, `--teardown`: manage the
  GitHub-side Hook. Setup verifies `PR_MONITOR_PUBLIC_URL` reaches the
  Listener and waits for GitHub's `ping` before reporting success; it refuses
  to create a Hook it cannot verify.
- `PR_MONITOR_NOTIFY_CMD`: owner notifications (`notify_ready`,
  `needs-human`, escalation) as JSON on stdin, 30s timeout, failures logged
  only.
- `--tunnel ngrok|cloudflared`: spawn a tunnel, use its public URL for setup,
  clean it up on exit (dev convenience; the Hook is updated by id).
- `PR_MONITOR_TICK_TIMEOUT` (5 min) kills a hung tick; failed ticks re-arm
  their Expectation with backoff (1 → 5 → 15 min, then hourly).
- Ingress is external to the skill: GitHub must reach a public HTTPS URL —
  Tailscale Funnel (stable `https://<host>.<tailnet>.ts.net`), ngrok or
  cloudflared. Recipes and platform-agnostic deploy files in
  `resources/deploy/`.

Cron remains the alternate mode for Hosts that cannot expose a public
endpoint; everything below applies unchanged.

## Observability API (read-only)

A separate loopback process projects the persisted state — it is not part of
the Listener (which is ephemeral and absent under tick and cron), so it
answers in every mode and whether or not the watchdog is running. It holds no
state of its own and never writes; GET only, no version prefix:

```bash
node pr_monitor_observability.mjs            # http://127.0.0.1:8788 by default
curl -s http://127.0.0.1:8788/flows | jq
```

Routes: `/health` (watchdog liveness, in the Listener's health shape),
`/timeline` (executed, in-flight and scheduled ticks), `/flows` (one row per
watched PR with its Stage sequence) and `/flows/:owner/:repo/:num` (one Flow
in full; 404 when unknown). Stage statuses, outcomes and terminal words use
`GLOSSARY.md`; the projection derivation is documented in
`observability/README.md`. The TUI is a client of this contract.

Settings (flags override env): `--host` /
`PR_MONITOR_OBSERVABILITY_HOST` (loopback only; default `127.0.0.1`),
`--port` / `PR_MONITOR_OBSERVABILITY_PORT` (default `8788`), `--state` /
`PR_MONITOR_STATE_PATH` (Tick state, default `~/.cache/pr-monitor/state.json`),
`--listener-state` / `PR_MONITOR_WEBHOOK_STATE_PATH` (default
`~/.cache/pr-monitor/listener-state.json`) and `--pid` /
`PR_MONITOR_WEBHOOK_PID_PATH` (default `~/.cache/pr-monitor/listener.pid`).
The implementation is the private `observability/` package
(`@skillbook/pr-monitor-observability`, zero dependencies).

## Decision flow (deterministic gates first, LLM last)

```
for each open PR:
  draft or WIP-titled?            → SKIP (record skip_wip, no LLM, no ping)
  mergeable_state == "dirty"?     → REBASE-POLICY (below)
  mergeable == None?              → per-PR fetch; still None → wait
  signature unchanged?            → reuse cached decision (no LLM call)
  else → LLM decides: request_review | request_fix | notify_ready | wait
```

Rebase policy (for `dirty` PRs, evaluated BEFORE the LLM):

```
newest non-Copilot conflict-resolution request on this head sha:
  none                        → request_rebase (ask Copilot to resolve conflicts)
  < 6h old                    → wait (give Copilot its window)
  >= 6h, pings < 3            → request_rebase again (retry)
  >= 6h, pings >= 3           → notify owner ONCE per sha; retry weekly
```

### `next_check_at` derivation policy (the Expectation contract)

The tick derives each PR's `next_check_at` from state, not from the LLM, so a
reused cached decision carries the same deadline a fresh one would. This table
is the complete policy — every arm in the derivation corresponds to a row here,
and a deadline is never anchored at `now`: a stale anchor advances by whole
weeks instead of collapsing into an immediate re-arm (a Fallback tick storm).
Weekly retries anchor at the escalation moment recorded in state
(`stuck_notified_ts`, `review_fix_exhausted_ts`), not at the last ping.

| State (first match wins) | `next_check_at` |
|---|---|
| `notify_ready` / `skip_wip` (draft/WIP) | `null` — quiescent; only a Delivery wakes it |
| Recurring LLM failure (`llm_failed`) | now + 1h |
| Review/fix budget exhausted (needs-human) | exhaustion moment + 168h (weekly, whole weeks) |
| Review/fix exhausted with no recorded exhaustion ts (legacy state) | last ping + 168h (weekly, whole weeks) |
| Stuck PR, owner escalated (conflicts + pings >= 3) | escalation moment + 168h (weekly, whole weeks) |
| Stuck PR with no recorded escalation ts (legacy state) | last ping + 168h (weekly, whole weeks) |
| Active work (last commit < 3h) | last commit + 3h |
| A Ping just posted this run | ping + 12h (review/fix) or + 6h (rebase) |
| Review/fix Ping pending a response | last ping + 12h |
| Rebase Ping inside its 6h same-sha throttle | last rebase ping + 6h (never the older request's deadline) |
| Mergeability unknown | now + 1h |
| Conflicts with a pending resolution request | request + 6h |
| Newest Copilot review < 6h old | review + 6h |
| Otherwise | `null` — quiescent |

### Actions and their messages

| Action | When (decided by) | Message |
|---|---|---|
| `request_rebase` | dirty PR (HARD gate, deterministic) | `@copilot resolve the merge conflicts between this branch and origin/main. Be wise with the strategy: …` (see script — wisdom policy: preserve BOTH branches, drop only what belongs to the new features; on doubt consult spec/tickets/docs, then ask the user) |
| `request_review` | new commits unseen by Copilot (LLM) | `@copilot code review` |
| `request_fix` | unaddressed review comments (LLM) | `@copilot work on the issues mentioned in these comments <urls>` |
| `notify_ready` | review transcript reached an All-clear on the current head (LLM) | owner notification only — NEVER pings GitHub |
| `wait` | not enough info / too soon (LLM or gates) | silence |

### Decision source (what an invoking agent defines or exports)

A Tick resolves one decider per invocation, first match wins:

**decision command → model+credential pair → auto → none**

1. **Decision command** — `PR_MONITOR_LLM_CMD`: the request goes to the
   command on stdin, a `{"action","reason"}` JSON decision comes back on
   stdout. Timeout `PR_MONITOR_LLM_CMD_TIMEOUT_MS` (default 60000 ms). The
   universal adapter — any agent CLI that answers a prompt non-interactively
   fits. Non-zero exit, timeout and unparseable output are real decision
   failures: they consume the three-attempt-per-head budget and can escalate
   to Needs-human.
2. **Model + credential pair** — `PR_MONITOR_LLM_API_KEY` (default
   `OPENROUTER_API_KEY`) with `PR_MONITOR_MODEL` (default
   `deepseek/deepseek-v4-flash-0731`) and `PR_MONITOR_LLM_ENDPOINT` (default
   `https://openrouter.ai/api/v1/chat/completions`). This is exactly the
   deployed OpenRouter cron path, and the defaults keep it unchanged. The key
   selects this layer — a model without a key does not.
3. **Auto — the invoking agent session** — export nothing: the Tick finds the
   agent surrounding it (the session's marker variables plus the agent CLI on
   `PATH`) and synthesizes that CLI as the decision command, pinning the
   session's model where the host exposes one. Registered adapters, in match
   order:

   | Agent | Session markers | Session model pinned | Synthesized command |
   |---|---|---|---|
   | `pi` | `PI_CODING_AGENT=true` or `AI_AGENT=pi` | `PI_PROVIDER` / `PI_MODEL` | `pi --print [--provider …] [--model …] …` |
   | `claude` | `CLAUDECODE=1` or `AI_AGENT=claude-code…` | `ANTHROPIC_MODEL` | `claude --print [--model …] …` |
   | `opencode` | `OPENCODE=1` or `OPENCODE_CLIENT` | `OPENCODE_CONFIG_CONTENT.model` | `opencode run [--model …] …` |

   Each adapter authenticates through its own CLI; the skill never reads or
   prints another tool's credential store. Claude Code authentication through
   a Teams seat is not confirmed — see the caveat on that unit in `agents.mjs`
   and confirm it in the Teams-seat environment before relying on the adapter.
4. **None** — the handled case, not a failure: action `wait`,
   `decision_source: "none"`, no owner notification, and the
   three-attempt-per-head budget untouched. The reason is the operator's
   checklist — it starts `No LLM decision source is configured:` and names
   the setup paths: define `PR_MONITOR_LLM_CMD`, or define a
   chat-completions provider with `PR_MONITOR_LLM_API_KEY` (default
   `OPENROUTER_API_KEY`) and optionally `PR_MONITOR_LLM_ENDPOINT` /
   `PR_MONITOR_MODEL`.

Settings are read from the invoking agent's environment first, then from the
skill's env files (`~/.pr-monitor.env`, then `~/.hermes/.env`, the legacy
deployed cron location), and never printed:

| Setting | Meaning | Where it may be set |
|---|---|---|
| `PR_MONITOR_LLM_CMD` | decision command (stdin request, stdout JSON) | process env, then either env file |
| `PR_MONITOR_LLM_CMD_TIMEOUT_MS` | decision-command timeout (default 60000) | process env, then either env file |
| `PR_MONITOR_LLM_API_KEY` | credential for the chat-completions provider | process env, then either env file |
| `OPENROUTER_API_KEY` | credential fallback when `PR_MONITOR_LLM_API_KEY` is unset | process env, then either env file |
| `PR_MONITOR_LLM_ENDPOINT` | provider endpoint (default `https://openrouter.ai/api/v1/chat/completions`) | process env, then either env file |
| `PR_MONITOR_MODEL` | provider model (default `deepseek/deepseek-v4-flash-0731`) | process env only — read once at startup |

Traceability: every LLM decision carries `decision_source` in the Tick's JSON
report — `decision_command`, `model_credential`,
`auto:<agent>` or `auto:<agent>:<provider>/<model>` (the provider part only
when the host exposes one) or `none` (deterministic gate decisions carry
none). The same value persists into the per-PR Tick history
(`tick_history` in the state file), so a decision can be traced after the
fact; the observability API projects it (see "Observability API" above).

Launch examples — one per explicit form, then the auto default:

```bash
# decision command: request on stdin, {"action","reason"} on stdout.
PR_MONITOR_REPOS="your-org/your-repo" \
PR_MONITOR_LLM_CMD='claude --print "Reply with only one JSON decision object."' \
PR_MONITOR_LLM_CMD_TIMEOUT_MS=90000 \
node pr_monitor.mjs --json-report

# model + credential pair: the deployed OpenRouter path, defaults unchanged.
PR_MONITOR_REPOS="your-org/your-repo" \
PR_MONITOR_MODEL="deepseek/deepseek-v4-flash-0731" \
PR_MONITOR_LLM_API_KEY="$OPENROUTER_API_KEY" \
node pr_monitor.mjs --json-report
# custom provider: add PR_MONITOR_LLM_ENDPOINT="https://your-provider.example/v1/chat/completions"

# auto default: export nothing; launch from the agent session.
PR_MONITOR_REPOS="your-org/your-repo" node pr_monitor.mjs --json-report
```

## Guardrails (the anti-spam core)

- **WIP/active-work guard**: draft PRs and WIP/[WIP]/DNM-titled PRs skip the
  loop entirely — a bot ping derails the assigned agent (it drops its task to
  answer and never resumes; real incident: bitsimp#262). A branch whose last
  commit is < 3h old is likely being actively worked on — hold ALL pings
  until it goes quiet (`notify_ready` is exempt). The LLM also receives an
  `agent_still_working` flag with a prefer-WAIT note.
- **Merge-conflict gate (HARD, deterministic)**: never review a conflicted PR.
  `mergeable_state == "dirty"` or `mergeable is False` triggers the rebase
  policy above. "behind"/"blocked"/"unstable" are NOT conflicts. If
  mergeability is null → per-PR fetch; still null → wait.
- **Transcript-first**: before deciding, read the FULL comment transcript (any
  author, human/Copilot/bots, all pages). Never re-ask what a
  human already asked.
- **Copilot's ack is not a request and not work**: its replies QUOTE the
  request (`> @copilot …`). Strip quote-lines and ignore Copilot-authored
  comments when detecting pending requests — an ack must never renew a
  request or count as progress.
- **Copilot cannot rebase** (no force-push in its environment; it says so in
  every ack). Ask it to RESOLVE the merge conflicts without prescribing
  strategy — it merges. The request detector accepts both wordings ("rebase"
  / "resolve the merge conflicts").
- **Signature cache**: hash(head_sha + Copilot feedback timestamps + review
  state + unresolved-count + approved-flag + mergeable + transcript digest).
  Unchanged ⇒ reuse the cached decision, no LLM call (idle tick ≈ 2.7s).
  ANY new comment invalidates it (transcript digest).
- **Throttles**: 12h same-sha ping interval for review/fix requests; 6h
  same-sha interval for conflict-resolution pings; 6h cooldown after the newest
  Copilot review; 6h rebase-retry window; 3 rebase pings per sha, then owner
  escalation + weekly retry anchored at the escalation moment (origins and
  rationale in `resources/docs/adr/0005-anti-spam-throttle-numbers.md`; the
  full `next_check_at` derivation table above is the contract).
- **`seen_ready` shas**: `notify_ready` fires ONCE per head sha — never
  re-message the owner.
- **Silent output**: nothing to report ⇒ print NOTHING (in `no_agent` cron
  mode, empty stdout = silent). Agent-facing runs opt into JSON lines; cron does not.

## GitHub endpoints the script reads (paginated, per_page=100&page=N)

- `repos/{r}/pulls?state=open` → the watched PRs (list; mergeability often
  null here — do a per-PR fetch `repos/{r}/pulls/{n}` when null).
- `repos/{r}/pulls/{n}/reviews` → formal reviews (filter `user.login`
  contains `copilot`); state + `submitted_at`.
- `repos/{r}/pulls/{n}/comments` → inline review comments (inline transcript).
- `repos/{r}/issues/{n}/comments` → the FULL transcript (any author).
- `repos/{r}/pulls/{n}/commits` → last commit ts (oldest-first; take
  `max(author.date)`).

LLM: a chat-completions provider (OpenRouter by default), temperature 0,
`response_format: json_object`, four-action prompt (`request_rebase` is
deterministic — the LLM never picks it; English reasoning, see `callLlm` in
the script). The endpoint, credential and model are the decision-source
settings above.

Decision architecture and policy intent are documented in ADRs:
- `resources/docs/adr/0003-llm-decision-maker-behind-deterministic-gates.md`
- `resources/docs/adr/0004-transcript-truth-over-thread-resolution-state.md`
- `resources/docs/adr/0005-anti-spam-throttle-numbers.md`

Decision seam:
- `decision.mjs` exposes a pure deterministic gate function and an LLM boundary
  with injectable dependency, so gate behavior is testable without network and
  LLM failure/escalation paths can be validated with stubs.

## Cron setup

Cron is the alternate mode (Hosts with no public endpoint); the webhook
Listener is the primary path — see "Webhook mode" above.

- Hourly is fine — the signature cache makes idle ticks cheap. Point the
  cron at `node pr_monitor.mjs` with `PR_MONITOR_REPOS` set; stdout must be
  delivered verbatim and empty stdout = silent.
- Hermes example: `no_agent: true`, `deliver: origin`, deployed as
  - Deployed cron: **Smart PR Loop** (`3f51bedf15cd`, hourly, no_agent,
    deliver origin). It runs **`pr_monitor.sh`** — a wrapper that exports
    `PR_MONITOR_REPOS="dyegolara/monitor,dyegolara/bitsimp"` and the legacy
    state path, then `exec node pr_monitor.mjs`. The wrapper exists because the
    Hermes cron runner executes non-`.sh` scripts with Python (a bare `.mjs`
    script would never run as Node).
  - Migration history (2026-09-07, skillbook PR #1): python → .mjs. State path
    kept at the legacy location to preserve throttle/seen-ready bookkeeping
    (the .mjs default `~/.cache/pr-monitor/state.json` is for fresh installs).
  - REST API does NOT expose review-thread resolution state — every top-level
    Copilot inline comment counts as unaddressed; the decision LLM judges from
    transcripts. LLM/API failures notify the owner once per head sha.

## Pitfalls

- **Copilot posts `COMMENTED`, not `APPROVED`** — never key the "done" check
  on an APPROVED state alone (this exact bug made the naive loop ping daily
  forever: `review_sha == head_sha` never held, and Copilot had confirmed
  "21/21 tests passing" for days).
- **Fragile SHA-pointer bookkeeping** (`review_sha`/`fix_sha`) made the
  green-check never fire. Prefer timestamp comparisons + a decision LLM.
- **The anti-duplicate gate can deadlock**: "a rebase was already requested →
  wait forever" froze 4 real PRs when Copilot ignored the request (head sha
  never moves). The retry loop (6h window, max 3 pings, owner escalation)
  exists for exactly this.
- **Unpaginated transcripts silently lose the newest comments** (GitHub
  returns 30 by default). A 32-comment PR lost the bot's OWN rebase ping from
  minutes earlier, corrupting duplicate-detection.
- **A ping on a draft derails the working agent** (bitsimp#262: the agent
  abandoned its feature to answer a `code review` and never resumed).
- **`gh` exit 0 ≠ Copilot acted.** Always re-read real GitHub state; don't
  report success on a 200 response.
- **A human may have already asked for the rebase** — the bot once duplicated
  a human's request 34 seconds after it was posted. Read the transcript
  before pinging.
- **The REST API never exposes review-thread resolution state** — there is no
  `resolved` field on `pulls/{n}/comments`. Count every top-level Copilot
  inline comment as unaddressed and let the decision LLM read the transcript
  to judge whether the feedback was really handled. (The Python v2.0.0
  "checked" a `resolved` field that never exists — always-true bug.)
- **A recurring LLM/API outage must not spam the owner** — notify once per
  head sha, then stay quiet until state changes and the decision retries.
- **Token economy**: the LLM call is the only expensive step — keep it behind
  the signature cache so idle ticks hit GitHub APIs only.
- **Never touch a PR's DB/prod or post manually while testing** — use
  `DRY_RUN=1`, which prints would-be comments and never posts or persists.
