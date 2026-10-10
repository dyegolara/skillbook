---
name: code-review-loop
description: "Software-factory chain stage: two-axis code review of the integration branch against the merge-base with origin/main, written to an untracked local report, then routed — normal findings to dev-flow, a clean review to create-pr, decision-forcing findings to grill-with-spec, which pauses the chain on the maintainer. Use for /code-review-loop or any independent review that must pick the next stage."
disable-model-invocation: true
license: MIT
metadata:
  model: opencode-go/mimo-v2.6-pro
  thinking: high
---

# code-review-loop

Independent review of the integration branch, then route to the next stage.
You did not write this code. Read durable artifacts only; do not reconstruct
the implementer's reasoning from the handoff doc.

**Model pin**: `opencode-go/mimo-v2.6-pro`, `--thinking high` — the model's
highest available effort (`max` clamps to it). It runs headless as a pi
session that the pack helper launches into a visible Kepler terminal from the
shared worktree, started at the end of the implement-spec session or
standalone with `/code-review-loop`.

## Process

### 1. Pin the fixed point

Read the handoff doc; it points at the spec issue, the tickets, the PR (when
one exists) and the worktree. The fixed point is the merge-base with
`origin/main`:

```bash
git fetch origin
git merge-base origin/main HEAD
```

When a PR exists, its base is the fixed point (`gh pr view --json baseRefName`).
Confirm the ref resolves and `git diff <fixed-point>...HEAD` is non-empty
before spawning reviewers.

### 2. Review

Call the Skill tool for `code-review` with the fixed point. It runs the
Standards and Spec axes as parallel sub-agents and reports them side by side.
Keep the axes separate: do not merge or rerank their findings.

### 3. Write the review report

Write the aggregated report to an untracked local markdown file in the shared
worktree, for example `.scratch/software-factory/review-<spec>-<short-sha>.md`
(create the parent directory; never `git add` the file and never commit it).
The report is the durable artifact every later stage reads. Include the fixed
point, the diff command, and every finding labelled `Standards` or `Spec`.

### 4. Route

Classify the findings, then take exactly one route:

- **Normal findings** — the fix is obvious and derivable from the code, the
  task or the spec. Route to `dev-flow`, which publishes them as fix tickets
  and hands off to implement-spec.
- **Clean review** — no findings on either axis. Route to `create-pr`, which
  ships the verified branch.
- **Decision-forcing findings** — the fix is not obvious, or the needed
  decision cannot be derived from the code, the task or the spec. Route to
  `grill-with-spec`, which opens the grilling session on the task and pauses
  the chain on the maintainer. Classify conservatively: if the resolution
  would overturn a decision the user already made, it is decision-forcing.

### 5. Hand off

Always call the Skill tool for `handoff` first, tailored to the chosen stage.
It points at the review report, the spec issue, the tickets and the PR.

Launch the next pi stage through the pack helper from the shared worktree:
`node skills/software-factory/scripts/launch-stage.mjs <stage> <spec> '<thin pointers>'`.
The helper starts a visible `chain #<spec>: <stage>` Kepler terminal, injects
the stage's pinned command and prints the terminal id. When the terminal API is
unreachable it falls back to the detached `nohup pi` launch and reports which
path it took.

Every spawned `pi` command — the stage launch and each sub-agent — carries an
explicit `--provider`, `--model` and `--thinking`; never rely on pi's ambient
default (the kimi-k3 incident: three un-pinned spawns burned the most
expensive model in the account — the ambient default is an environment fact,
not a chain decision). Sub-agents run headless inside their stage's terminal —
one terminal per stage, none per sub-agent — carrying the stage's pin.

- **dev-flow** — launch a new pi session:

  ```bash
  node skills/software-factory/scripts/launch-stage.mjs dev-flow 'Run the dev-flow skill for spec #<n>: read skills/software-factory/dev-flow/SKILL.md and follow it. Read the handoff doc at <path> and the review report at <path>. Publish the findings as fix tickets.'
  ```

- **create-pr** — launch a new pi session:

  ```bash
  node skills/software-factory/scripts/launch-stage.mjs create-pr 'Run the create-pr skill for spec #<n>: read skills/software-factory/create-pr/SKILL.md and follow it. Read the handoff doc at <path> and the review report at <path>.'
  ```

- **grill-with-spec** — actuate the pause instead of waiting to be noticed.
  Run:

  ```bash
  node skills/software-factory/scripts/open-grill-session.mjs <spec> '<re-entry prompt>'
  ```

  The helper creates the opencode session on the task, labels it `chain
  #<spec>: grill-with-spec`, pins its model and effort, and sends the re-entry
  prompt — so a fresh grilling session lands `unread` on the maintainer's
  task. The re-entry prompt carries the thin pointers: the handoff doc path,
  the review report path, the spec issue and the decision-forcing finding.
  When the helper reports a connection-level failure it prints the pause — the
  manual re-entry route — with those pointers in the prompt; the maintainer
  re-enters with `/grill-with-spec` in Kepler. The pause ends when
  grill-with-spec hands off to dev-flow.

Every route but the last starts the next stage as a new session. The route to
grill-with-spec opens the pause itself: the grilling session is created on the
task, and the durable report plus the handoff doc are the state it resumes
from. Only when the helper cannot reach the API does the pause fall back to a
printed notice waiting on a manual `/grill-with-spec` re-entry.
