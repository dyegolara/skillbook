# Copilot Review — Smart (LLM-decided) watchdog

A cron/agent loop that drives open PRs toward a Copilot clean bill of health
without spamming: it pings `@copilot code review` only when a review is
actually useful, asks Copilot to resolve merge conflicts when needed, and
tells the **owner** when a PR is ready for human review — staying silent the
rest of the time.

The agent-facing instructions live in [`SKILL.md`](./SKILL.md); the reference
implementation is [`pr_monitor.mjs`](./pr_monitor.mjs) (Node >= 18, `gh` CLI,
OpenRouter for the decision LLM). This README is the human-readable picture of
what the loop does.

## Quick start

```bash
DRY_RUN=1 PR_MONITOR_REPOS="your-org/your-repo" node pr_monitor.mjs
```

Agent-facing one-shots can also use CLI scope flags plus JSON reporting:

```bash
DRY_RUN=1 node pr_monitor.mjs --repo your-org/your-repo --json-report
DRY_RUN=1 node pr_monitor.mjs --pr your-org/your-repo#123 --json-report
```

Other env: `PR_MONITOR_STATE_PATH`, `PR_MONITOR_MODEL`, `OPENROUTER_API_KEY`,
`PR_MONITOR_PR`, `PR_MONITOR_REPORT=jsonl`.

Fixture harness:

```bash
npm run harness:copilot-review-smart -- first-tick-wait
npm run harness:copilot-review-smart -- loop-repo-live-scope --loop
```

The harness runs the real `pr_monitor.mjs` process with a fake `gh` on `PATH`,
frozen LLM responses, and a temporary state file so one-shot and loop behavior
stay deterministic and network-free.

## 1. Main decision flow (per open PR)

Deterministic gates first, LLM last — the LLM call is the only expensive step,
so idle ticks hit GitHub APIs only.

Implementation seam: deterministic gates and the LLM boundary live in
`decision.mjs`, where the LLM dependency is injectable for network-free tests.

```mermaid
flowchart TD
    A["Fetch open PRs<br/>(repos/{r}/pulls?state=open)"] --> B{"Draft or WIP-titled?"}
    B -- yes --> SKIP["SKIP<br/>record skip_wip<br/>no LLM, no ping"]
    B -- no --> C{"mergeable_state<br/>== dirty?"}
    C -- yes --> REBASE["Rebase policy<br/>(see diagram 2)"]
    C -- no --> D{"mergeable == null?"}
    D -- yes --> D2["Per-PR fetch<br/>repos/{r}/pulls/{n}"]
    D2 --> D3{"still null?"}
    D3 -- yes --> WAIT1["wait"]
    D3 -- no --> E
    D -- no --> E{"Signature unchanged?"}
    E -- yes --> CACHED["Reuse cached decision<br/>(no LLM call)"]
    E -- no --> F["Read full comment transcript<br/>(all pages, any author)<br/>strip Copilot quote-acks"]
    F --> G["Decision LLM (OpenRouter)<br/>temperature 0, JSON output"]
    G --> H{"Decision"}
    H -- request_review --> R1["Post: @copilot code review"]
    H -- request_fix --> R2["Post: @copilot work on the issues<br/>mentioned in these comments"]
    H -- notify_ready --> R3["Notify OWNER only<br/>(never pings GitHub)<br/>once per head sha"]
    H -- wait --> R4["Silence"]
```

## 2. Rebase policy (dirty PRs — HARD deterministic gate)

Evaluated **before** the LLM; the LLM never picks `request_rebase`.

```mermaid
flowchart TD
    A["PR is conflicted<br/>(mergeable_state == dirty)"] --> B{"Newest non-Copilot<br/>conflict-resolution request<br/>on this head sha?"}
    B -- "none" --> C["request_rebase:<br/>@copilot resolve the merge<br/>conflicts between this branch<br/>and origin/main"]
    B -- "< 6h old" --> D["wait — give Copilot<br/>its window"]
    B -- ">= 6h, pings < 3" --> E["request_rebase again<br/>(retry)"]
    B -- ">= 6h, pings >= 3" --> F["Notify owner ONCE per sha;<br/>retry weekly"]
```

## 3. Sequence: one tick of the loop

Where the money is spent (the LLM call) and where it is avoided (the
signature cache).

```mermaid
sequenceDiagram
    participant Cron as Cron / agent tick
    participant M as pr_monitor.mjs
    participant GH as GitHub REST API
    participant S as state.json
    participant LLM as OpenRouter

    Cron->>M: run
    M->>GH: list open PRs (paginated)
    loop per open PR
        M->>GH: reviews, comments, issues comments, commits
        alt draft / WIP
            M->>S: record skip_wip (no ping)
        else conflicted
            M->>M: rebase policy (deterministic)
        else signature unchanged
            M->>S: reuse cached decision
        else signature changed
            M->>LLM: decision prompt (temp 0, JSON)
            LLM-->>M: request_review | request_fix | notify_ready | wait
        end
        opt action requires a post
            M->>GH: post comment / request review
        end
        opt owner notification
            M-->>Cron: stdout (empty = silent)
        end
    end
    M->>S: persist state
```

## Anti-spam guardrails (the core)

- **WIP/active-work guard**: drafts and WIP/[WIP]/DNM titles skip the loop; a
  branch whose last commit is < 3h old holds all pings (`notify_ready` exempt).
- **Merge-conflict gate**: never review a conflicted PR — the rebase policy
  above handles it deterministically.
- **Signature cache**: hash of head sha + Copilot feedback timestamps + review
  state + unresolved count + approved flag + mergeable + transcript digest.
  Unchanged ⇒ cached decision, no LLM call (idle tick ≈ 2.7s). Any new
  comment invalidates it.
- **Throttles**: 12h same-sha ping interval for review/fix requests; 6h
  same-sha interval for conflict-resolution pings; 6h cooldown after the newest
  Copilot review; 6h rebase-retry window; 3 rebase pings per sha, then owner
  escalation + weekly retry.
- **`seen_ready` shas**: `notify_ready` fires once per head sha.
- **Transcript-first**: never re-ask what a human already asked; Copilot acks
  (quote-replies) never count as new requests or progress.
- **Silent output**: nothing to report ⇒ print nothing in cron mode. Agent-facing
  runs opt into one JSON line per PR plus one overall line.

See [`SKILL.md`](./SKILL.md) for pitfalls, cron setup, and the full action
table.
