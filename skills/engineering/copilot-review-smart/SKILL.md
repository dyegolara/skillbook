---
name: copilot-review-smart
description: "Smart Copilot PR-review watchdog (multi-repo) that reads review state + timestamps, checks merge conflicts first, and lets an LLM decide (rebase/review/fix/notify/wait) instead of pinging daily. Use for cron/agent PR monitors that kept spamming '@copilot code review'."
version: 1.1.0
author: Hermes Agent (Marcus)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [GitHub, Copilot, PR-monitor, Code-Review, Cron, LLM-decision]
    related_skills: [github-copilot-review-loop, github-pr-workflow, github-issues]
---

# Copilot Review — Smart (LLM-decided) watchdog

Canonical source: https://github.com/dyegolara/skillbook (skills/engineering/copilot-review-smart)

## When to use

A cron/agent that drives open PRs toward a Copilot clean bill of health, but
the naive "ping-pong" loop burns tokens by posting `@copilot code review` every
day even after Copilot already said everything passes. The reference
implementation lives at `~/.hermes/scripts/pr_monitor.py` (backed by this
skill). Triggers:

- "Stop spamming @copilot on that PR, it's already clean."
- "Watch PRs and tell ME when one is ready, not ping Copilot forever."
- Building a PR-monitor cron that should be quiet when there's nothing to do.

## The bug this fixes (root cause — read this)

The old loop marked a PR **DONE** only when:
```python
if copilot_approved(reviews) and (review_sha == head_sha):  # → DONE
```
Two silent failures:
1. `copilot_approved()` looks for a review with state `APPROVED`, but the
   GitHub Copilot reviewer bot often **only posts `COMMENTED`** — never APPROVED.
2. `review_sha` was never set to equal `head_sha`, so the second half of the
   condition never held either.

Net effect: the condition NEVER became true, so the cron re-posted
`@copilot code review` every cycle forever. Confirmed on PR #39 of
`dyegolara/monitor`: Copilot said "21/21 tests passing, no issues" for days
(with the same head SHA, no new commits) while the bot kept pinging daily.

## Design

Replace "is it green?" (impossible to know) with **what action is useful now?**
An LLM reads the GitHub state and returns one of five actions.

### Actions the loop returns
- `request_rebase`  → merge conflicts with main: ping `@copilot rebase this PR onto origin/main to resolve the merge conflicts, then push the result.` (HARD gate — decided deterministically, never by the LLM)
- `request_review`  → ping `@copilot code review` (new commits unseen by Copilot)
- `request_fix`     → ping `@copilot work on the issues... <urls>` (unaddressed comments)
- `notify_ready`    → Copilot confirmed current head is clean; do NOT ping — message the owner
- `wait`            → not enough info / too soon since last action / mergeability not computed yet

### Key guardrails (the anti-spam core)
- **Merge-conflict gate (HARD, runs before the LLM)**: read `mergeable`/`mergeable_state` from the PR. If `mergeable_state == "dirty"` or `mergeable is False`, FIRST read the full issue transcript (`repos/{r}/issues/{n}/comments`, ANY author): if a rebase was already requested (body contains `rebase` AND `@copilot`/`origin/main`/`rebase this PR`) NEWER than the last commit on the branch → `wait` (request already pending — do NOT duplicate). Only if no pending request exists → `request_rebase`. If both mergeability fields are None → `wait` (GitHub computes it async; the list endpoint often returns null — retry with a per-PR fetch `repos/{r}/pulls/{n}`). Rebase pings honor the same 12h same-sha throttle, but NOT the review cooldown.
- **Transcript-first context**: the LLM decision receives `issue_transcript` + `inline_transcript` (last 40 each, truncated, ANY author — human, Copilot, bots), and the signature cache includes transcript length + last-comment timestamp, so ANY new comment invalidates the cache and forces a fresh decision. The system prompt says CONTEXT FIRST: never re-ask what a human already asked (rebase, review, fix).
- **Signature cache**: hash (head_sha + all Copilot feedback timestamps + state +
  unresolved-count + approved-flag + transcript digest). If unchanged from last
  run, **reuse the cached decision instead of calling the LLM** → a no-op run
  is ~2.7s and costs ~nothing, vs the old daily LLM/api burn.
- **`seen_ready` shas**: once `notify_ready` is sent for a given head sha, never
  notify again for that same sha (don't re-message the owner every tick).
- **Throttle**: don't re-ping the same head sha more often than
  `PING_MIN_INTERVAL_HOURS` (12h), and give Copilot
  `COOLDOWN_AFTER_REVIEW_HOURS` (6h) before re-reviewing the same sha.
- **Silent output**: when there is nothing to report, print NOTHING. In
  `no_agent` cron mode, empty stdout = silent, so the owner gets zero spam.

## Implementation notes (what the script reads)

- **Multi-repo**: `REPOS = ["dyegolara/monitor", "dyegolara/bitsimp"]`; every
  open PR in each repo goes through the same loop. Per-repo state keys
  (`repo#num`) and `seen_ready` keys (`repo:sha`) avoid collisions between
  repos. Add a repo by appending to `REPOS`.
- `DRY_RUN=1` env: prints the would-be comments and never posts or persists
  state — safe to test against real PRs.

- `gh api repos/{owner}/{repo}/pulls/{n}/reviews` → Copilot formal reviews
  (filter `user.login` contains `copilot`), take state + `submitted_at`.
- `gh api repos/{owner}/{repo}/pulls/{n}/comments` → inline review comments
  (included in `inline_transcript`).
- `gh api repos/{owner}/{repo}/issues/{n}/comments` → the full transcript
  (ANY author) where the human asks for rebases/reviews and Copilot replies.
- `gh api repos/{owner}/{repo}/pulls/{n}/commits?per_page=100` → last commit ts.
- Compare timestamps: last commit NEWER than latest Copilot review/comment ⇒
  fixes pushed ⇒ still needs a fresh review.
- LLM call: OpenRouter `chat/completions`, model default
  `deepseek/deepseek-v4-flash-0731` (override `PR_MONITOR_MODEL`), temperature 0,
  `response_format: json_object`, API key read from `~/.hermes/.env` (masked,
  never logged).

## Cron setup

- Run periodically (every hour is fine — the signature cache makes idle ticks
  cheap). `no_agent: true` + `script: pr_monitor.py` so stdout is delivered
  verbatim and empty stdout = silent.
- `deliver: origin` so the `notify_ready` message reaches the owner's home channel.
- Today this runs as cron job **Smart PR Watchdog · Copilot loop (multi-repo)**
  (not "PR-monitor" — it watches rebase + review + notify across repos).

## Rebase retry policy (anti-deadlock)

A conflicted PR must never deadlock the loop. The v1.1 anti-duplicate gate
("a rebase was already requested → WAIT forever") deadlocked 4 real PRs: the
head sha never changed, so the pending-request condition held eternally even
after Copilot ignored the request or its merge attempt failed.

- **Copilot's ACK is not a request and not work.** Its replies QUOTE the
  request (`> @copilot rebase ...`). Strip quote-lines (`>`) and ignore
  Copilot-authored comments when detecting pending rebase requests — only a
  human/bot request counts, and Copilot's ack must never renew it.
- **Retry loop per head sha**: after a rebase request (ours or human's) give
  Copilot 24h; if still dirty, re-ping — max 3 pings per sha. After that,
  notify the owner ONCE (per sha) to decide manually and retry weekly.
- **Re-ping message should be explicit**: ask Copilot to rebase AND resolve
  conflicts (a bare "rebase" may produce a merge that leaves conflicts).
- **Transcripts must be PAGINATED** (`per_page=100&page=N`, GitHub returns 30
  by default). A 32-comment PR silently lost its newest comments — including
  the bot's own rebase ping from minutes earlier — corrupting the
  duplicate-detection and retry logic.

## Pitfalls

- **`mergeable`/`mergeable_state` are often null on the LIST endpoint** — GitHub computes mergeability asynchronously. Do a per-PR fetch before treating null as truth. If still null → WAIT, never ping.
- **`mergeable_state` "dirty" = conflicts, but "behind"/"blocked"/"unstable" are NOT** — behind means outdated-but-mergeable, blocked is branch protection, unstable is failing checks. Only dirty/`mergeable:false` triggers the rebase gate.
- **A human may have already asked for the rebase** — read the FULL transcript
  (any author) before pinging; the bot once duplicated a human's rebase request
  34 seconds after it was posted.
- **Copilot's reviewer bot posts `COMMENTED`, not `APPROVED`** — never key the
  "done" check on an `APPROVED` state alone. That's how the infinite loop starts.
- **`gh` exit 0 ≠ Copilot acted.** Always re-read real GitHub state; don't report
  success on a 200 response.
- **`gh api pulls/N/commits` returns oldest-first**; to get the newest commit time
  fetch `?per_page=100` and take `max(author.date)`.
- **Fragile `review_sha`/`fix_sha` pointer bookkeeping** caused the green-check
  to never fire. Prefer timestamp comparisons + a decision LLM over hand-tracked
  SHA pointers.
- **Token economy**: the ONLY expensive step is the LLM call. Gate it behind the
  signature cache so idle ticks hit GitHub APIs only (cheap, deterministic).