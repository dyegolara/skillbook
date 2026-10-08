---
name: code-review-loop
description: "Software-factory chain stage: two-axis code review of the integration branch against the merge-base with origin/main, written to an untracked local report, then routed — normal findings to dev-flow, a clean review to create-pr, decision-forcing findings to grill-with-spec, which pauses the chain on the maintainer. Use for /code-review-loop or any independent review that must pick the next stage."
disable-model-invocation: true
license: MIT
metadata:
  model: opencode-go/mimo-2.6-pro
  thinking: none
---

# code-review-loop

Independent review of the integration branch, then route to the next stage.
You did not write this code. Read durable artifacts only; do not reconstruct
the implementer's reasoning from the handoff doc.

**Model pin**: `opencode-go/mimo-2.6-pro`, no thinking flag — the model
exposes no effort option. It runs as a background pi terminal session from the
shared worktree, launched at the end of the implement-spec session or
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
  `grill-with-spec`, which pauses the chain on the maintainer. Classify
  conservatively: if the resolution would overturn a decision the user
  already made, it is decision-forcing.

### 5. Hand off

Always call the Skill tool for `handoff` first, tailored to the chosen stage.
It points at the review report, the spec issue, the tickets and the PR.

- **dev-flow** — launch a new background pi session:

  ```bash
  nohup pi --print --provider opencode-go --model opencode-go/glm-5.3 --thinking max \
    'Run the dev-flow skill for spec #<n>: read skills/software-factory/dev-flow/SKILL.md and follow it. Read the handoff doc at <path> and the review report at <path>. Publish the findings as fix tickets.' \
    > /tmp/skillbook-dev-flow-pi.log 2>&1 &
  ```

- **create-pr** — launch a new background pi session:

  ```bash
  nohup pi --print --provider opencode-go --model opencode-go/muse-spark-1.3-contributor --thinking xhigh \
    'Run the create-pr skill for spec #<n>: read skills/software-factory/create-pr/SKILL.md and follow it. Read the handoff doc at <path> and the review report at <path>.' \
    > /tmp/skillbook-create-pr-pi.log 2>&1 &
  ```

- **grill-with-spec** — do not launch a session. The chain pauses on the
  maintainer, who re-enters with `/grill-with-spec` in Kepler. Print the pause
  clearly, with the handoff doc path, the review report path, the spec issue
  and the decision-forcing finding. The pause ends when grill-with-spec hands
  off to dev-flow.

Every route but the last starts the next stage as a new session; the route to
grill-with-spec spends its pause waiting on the maintainer, and the durable
report plus the handoff doc are the state it resumes from.
