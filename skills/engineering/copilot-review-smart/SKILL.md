---
name: copilot-review-smart
description: "Smart Copilot PR-review watchdog (multi-repo) that reads review state + timestamps, checks merge conflicts first, and lets an LLM decide (rebase/review/fix/notify/wait) instead of pinging daily. Use for cron/agent PR monitors that kept spamming '@copilot code review'."
version: 2.2.0
author: Hermes Agent (Marcus)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [GitHub, Copilot, PR-monitor, Code-Review, Cron, LLM-decision]
---

# Copilot Review — Smart (LLM-decided) watchdog

A cron/agent loop that drives open PRs toward a Copilot clean bill of health
without spamming: it pings `@copilot code review` only when a review is
actually useful, asks Copilot to resolve merge conflicts when needed, and
tells the OWNER when a PR is ready for human review — staying silent the rest
of the time.

Triggers:

- "Stop spamming @copilot on that PR, it's already clean."
- "Watch PRs and tell ME when one is ready, not ping Copilot forever."
- Building a PR-monitor cron that should be quiet when there's nothing to do.

## Reference implementation

`pr_monitor.mjs` (next to this file) is the portable reference script:
plain ESM JavaScript, no build step, runs on Node >= 18 with an
authenticated `gh` CLI (see `docs/adr/0002` for the repo's script standard).
It is env-driven and **the repos to watch are passed as context, never
defaulted** — an installed skill must not silently watch someone else's
repos:

```bash
DRY_RUN=1 PR_MONITOR_REPOS="your-org/your-repo" node pr_monitor.mjs
```

Other env: `PR_MONITOR_STATE_PATH` (default `~/.cache/pr-monitor/state.json`),
`PR_MONITOR_MODEL` (OpenRouter model), `OPENROUTER_API_KEY` (env or
`~/.pr-monitor.env` / `~/.hermes/.env`), `DRY_RUN=1` (print would-be
comments, never post, never persist state).

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

### Actions and their messages

| Action | When (decided by) | Message |
|---|---|---|
| `request_rebase` | dirty PR (HARD gate, deterministic) | `@copilot resolve the merge conflicts between this branch and origin/main. Be wise with the strategy: …` (see script — wisdom policy: preserve BOTH branches, drop only what belongs to the new features; on doubt consult spec/tickets/docs, then ask the user) |
| `request_review` | new commits unseen by Copilot (LLM) | `@copilot code review` |
| `request_fix` | unaddressed review comments (LLM) | `@copilot work on the issues mentioned in these comments <urls>` |
| `notify_ready` | Copilot confirmed current head clean (LLM) | owner notification only — NEVER pings GitHub |
| `wait` | not enough info / too soon (LLM or gates) | silence |

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
  author, human/Copilot/bots, last 40 each, paginated). Never re-ask what a
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
- **Throttles**: 12h same-sha ping interval; 6h cooldown after the newest
  Copilot review; 6h rebase-retry window; 3 rebase pings per sha, then owner
  escalation + weekly retry (origins and rationale in
  `docs/adr/0005-anti-spam-throttle-numbers.md`).
- **`seen_ready` shas**: `notify_ready` fires ONCE per head sha — never
  re-message the owner.
- **Silent output**: nothing to report ⇒ print NOTHING (in `no_agent` cron
  mode, empty stdout = silent).

## GitHub endpoints the script reads (paginated, per_page=100&page=N)

- `repos/{r}/pulls?state=open` → the watched PRs (list; mergeability often
  null here — do a per-PR fetch `repos/{r}/pulls/{n}` when null).
- `repos/{r}/pulls/{n}/reviews` → formal reviews (filter `user.login`
  contains `copilot`); state + `submitted_at`.
- `repos/{r}/pulls/{n}/comments` → inline review comments (inline transcript).
- `repos/{r}/issues/{n}/comments` → the FULL transcript (any author).
- `repos/{r}/pulls/{n}/commits` → last commit ts (oldest-first; take
  `max(author.date)`).

LLM: OpenRouter `chat/completions`, temperature 0, `response_format:
json_object`, four-action prompt (`request_rebase` is deterministic — the
LLM never picks it; English reasoning, see `callLlm` in the script). Key
from `OPENROUTER_API_KEY` (env, `~/.pr-monitor.env`, or `~/.hermes/.env`).

Decision architecture and policy intent are documented in ADRs:
- `docs/adr/0003-llm-decision-maker-behind-deterministic-gates.md`
- `docs/adr/0004-transcript-truth-over-thread-resolution-state.md`
- `docs/adr/0005-anti-spam-throttle-numbers.md`

## Cron setup

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
