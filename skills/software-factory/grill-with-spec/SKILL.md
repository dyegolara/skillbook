---
name: grill-with-spec
description: "Software-factory chain entry: grill a design to shared understanding while writing ADRs and glossary terms, then synthesize and publish a ready-for-agent spec and hand off to dev-flow. Re-entry: refine a decision-forcing review finding into new ADRs and comments on the original spec, then resume the chain. Use for /grill-with-spec, starting the factory chain, or resuming it when the maintainer's decision is needed."
disable-model-invocation: true
license: MIT
metadata:
  model: opencode-go/glm-5.3
  thinking: max
---

# grill-with-spec

In helper commands, replace `<skill-dir>` with the absolute directory containing
this loaded `SKILL.md`; keep the shared worktree as the working directory.

The software-factory chain starts and resumes here. It is the only interactive
stage: every other stage runs headless and comes back when a finding cannot be
resolved from the code, the task or the spec.

**Model pin**: `opencode-go/glm-5.3`, effort max. Run this stage as a Kepler
session — rich input and output are the point.

**Chain position**: `grill-with-spec → dev-flow → implement-spec →
code-review-loop → (dev-flow | create-pr | this skill)`. The full map is in
[`../README.md`](../README.md).

## Status terminal

A pi stage prints nothing until it finishes, so the chain keeps a live view in
its own Kepler terminal: `chain #<spec>: status` runs a plain bash loop —
branch log, fix tickets, chain terminals, failed stages — refreshed every
30 seconds. The failed-stages check skips the status terminal itself and
matches the marker as printed, not the injected wrapper's quoted echo of it.
The Fresh start launches it once the spec is published; Re-entry makes sure
it is alive when the chain resumes. The check reuses an existing live
terminal on the worktree and never creates a duplicate.

The repo/worktree/task id triple has one resolution point: this snippet. On a
resume the check line lifts `repoId`, `worktreeId` and `taskId` from the
matched terminal's `GET /terminal/list` entry; on a fresh chain the ids resolve
from this grilling session's own Kepler metadata — `GET /agent/sessions`
filtered by the worktree exposes `repoId`, `worktreeId` and `taskId`. A single
echo prints the triple on one line in a stable order (`CHAIN-IDS <repoId>
<worktreeId> <taskId>`) before the fresh path attempts `POST /terminal/start`,
so the Fresh start's step 4 can pass the echoed values as the three explicit
`--repo-id/--worktree-id/--task-id` flags even if the start fails. A fresh
chain whose resolution comes back empty — no session on the worktree, or
empty id fields — stops loudly with a non-zero exit before the echo, so empty
values never reach the step-4 flags. With `SPEC` set to the spec issue number,
run:

```bash
SPEC=<spec>             # the chain's spec issue number
WORKTREE=$(pwd)         # the shared worktree of this session
API="http://$(cat ~/.kepler-server/data/server.host):$(cat ~/.kepler-server/data/server.port)"

# Reuse an existing live status terminal; never create a duplicate. The
# matched entry carries the id triple, so the reuse path needs no second
# source.
entry=$(curl -s "$API/terminal/list" | jq -r --arg wt "$WORKTREE" --arg want "chain #$SPEC: status" \
  '.[] | select(.worktreePath == $wt and .label == $want and (.exited == false)) | "\(.id) \(.repoId) \(.worktreeId) \(.taskId)"' | head -n1)
read -r EXISTING REPO_ID WORKTREE_ID TASK_ID <<<"$entry"

if [ -z "$EXISTING" ]; then
  # Fresh chain: this session's own metadata on the same worktree is the
  # only id source; the created terminal seeds the anchor.
  ids=$(curl -s "$API/agent/sessions" | jq -r --arg wt "$WORKTREE" \
    '.[] | select(.worktreePath == $wt) | "\(.repoId) \(.worktreeId) \(.taskId)"' | head -n1)
  read -r REPO_ID WORKTREE_ID TASK_ID <<<"$ids"

  # An empty resolution stops the run instead of guessing: the triple rides
  # the Fresh start's step-4 flags, and empty values must never reach them.
  if [ -z "$REPO_ID" ] || [ -z "$WORKTREE_ID" ] || [ -z "$TASK_ID" ]; then
    echo "STOP: chain #$SPEC — no id triple resolved on $WORKTREE; refusing to launch with empty --repo-id/--worktree-id/--task-id values" >&2
    exit 1
  fi
fi

# One echo closes both paths: the triple, repoId worktreeId taskId, on one
# line. It precedes the start attempt, so a failed start still leaves it
# standing for the Fresh start's step 4.
echo "CHAIN-IDS $REPO_ID $WORKTREE_ID $TASK_ID"

if [ -z "$EXISTING" ]; then
  # Start the labeled terminal, then run the loop in it.
  TERMINAL_ID=$(curl -s -X POST "$API/terminal/start" -H 'content-type: application/json' \
    -d "$(jq -n --arg repoId "$REPO_ID" --arg worktreeId "$WORKTREE_ID" --arg taskId "$TASK_ID" \
      --arg worktreePath "$WORKTREE" --arg terminalLabel "chain #$SPEC: status" \
      '{repoId: $repoId, worktreeId: $worktreeId, taskId: $taskId, worktreePath: $worktreePath, label: $terminalLabel}')" \
    | jq -r .terminalId)

  LOOP=$(cat <<'LOOP_BODY'
while true; do
  clear
  date
  echo "== chain #__SPEC__ (software-factory) =="
  echo "-- branch:"
  git -C "__WORKTREE__" log --oneline -6
  echo
  echo "-- fix tickets:"
  cd "__WORKTREE__"
  gh issue list --state open --limit 100 --json number,state,title,parent \
    --jq '.[] | select(.parent.number == __SPEC__) | "#\(.number) \(.state) \(.title[0:60])"'
  echo
  echo "-- chain terminals:"
  curl -s "__API__/terminal/list" | grep -o '"label":"chain[^"]*"'
  echo
  echo "-- failed stages:"
  failed=0
  while IFS=$'\t' read -r tid tlabel; do
    [ -z "$tid" ] && continue
    buffer=$(curl -s "__API__/terminal/buffer?terminalId=$tid" \
      | jq -r 'gsub("\u001b\\[[0-9;?]*[A-Za-z]"; "")' 2>/dev/null)
    if printf '%s\n' "$buffer" | grep -Eq "(^|[^'])FAILED: chain #__SPEC__ "; then
      echo "  $tlabel"
      failed=1
    fi
  done < <(curl -s "__API__/terminal/list" | jq -r --arg wt "__WORKTREE__" --arg status "chain #__SPEC__: status" \
    '.[] | select(.worktreePath == $wt and (.label | startswith("chain #")) and .label != $status) | "\(.id)\t\(.label)"')
  [ "$failed" -eq 0 ] && echo "  (none)"
  sleep 30
done
LOOP_BODY
)
  LOOP=${LOOP//__SPEC__/$SPEC}
  LOOP=${LOOP//__WORKTREE__/$WORKTREE}
  LOOP=${LOOP//__API__/$API}

  curl -s -X POST "$API/terminal/input" -H 'content-type: application/json' \
    -d "$(jq -n --arg id "$TERMINAL_ID" --arg input "$LOOP" '{terminalId: $id, input: ($input + "\n")}')"
fi
```

## Fresh start

### 1. Grill

Call the Skill tool for `grill-with-docs`. It runs `grilling` and
`domain-modeling`, so glossary terms and ADRs are written down as decisions
land, not after. Work the design tree in rounds until the frontier is empty
and the user confirms shared understanding.

### 2. Spec

Call the Skill tool for `to-spec`. The chain removes to-spec's seam
confirmation question — grilling already settled it. Accept the seams and
document them in the spec's Testing Decisions: prefer existing seams, test at
the highest one that observes the behavior, and propose a new seam only when
none exists. Say what each seam catches and what it misses.

Publish the spec to the project issue tracker with the `ready-for-agent`
label. Do not ask questions after grilling. A question at this point means a
decision was missed, and its answer is another grilling round, not a spec
comment thread.

### 3. Status terminal

Launch the `chain #<spec>: status` terminal per [Status terminal](#status-terminal)
once the spec is published; it is the live view of the headless stages.

### 4. Hand off

Call the Skill tool for `handoff`, compacting this conversation for the
dev-flow stage. The doc carries pointers only: the spec issue, the ADRs,
`GLOSSARY.md`, the worktree.

Start dev-flow in a new session. It is a pi stage, so launch it through the
pack helper from the shared worktree, per [ADR-0006](../../../docs/adr/0006-chain-skills-cross-model-handoffs.md).
The helper's bootstrap ids are the triple the [Status terminal](#status-terminal)
snippet echoed in step 3 — `CHAIN-IDS <repoId> <worktreeId> <taskId>` — so
substitute those echoed values for the placeholders and pass all three flags
together after the pointers:

```bash
node "<skill-dir>/scripts/launch-stage.mjs" dev-flow <spec> 'Run the dev-flow skill on spec issue #<spec> in this worktree: load the dev-flow skill and follow it. Read the handoff doc at <path> first.' --repo-id <repoId> --worktree-id <worktreeId> --task-id <taskId>
```

## Re-entry

Entered from `code-review-loop` when a decision-forcing finding arrives: the
fix is not obvious, or the needed decision cannot be derived from the code,
the task or the spec — or the fix would change one of the project's
commitments instead of satisfying them (the list in `code-review-loop` §4).
The chain is paused while you work — the maintainer is the only actor who can
settle the decision, and Re-entry exists so the decision gets settled before
an implementation guesses at it.

The entry prompt carries the review report path, the original spec issue, the
tickets and the PR.

### 1. Status terminal

Make sure the `chain #<spec>: status` terminal is alive on resume, per
[Status terminal](#status-terminal); the check reuses the live terminal and
starts one only if it has exited or is gone.

### 2. Grill the decision

Call the Skill tool for `grill-with-docs` on the decision-forcing finding, not
the whole design. Write new ADRs with `domain-modeling` as decisions land.

### 3. Refine scope

Refine the scope as comments on the original spec issue. Name the finding,
settle the decision, and say what changes in scope. List the decision's
**open gaps** — what it deliberately leaves undecided — so the implementer
fills them in-ticket and records them in the ADR; an unnamed gap becomes the
implementer's own design call, and a later review reads it as a deviation. Do
not run `to-spec` and do not write a new spec.

### 4. Resume

Call the Skill tool for `handoff` for a fresh dev-flow session, then launch
dev-flow through the pack helper from the shared worktree like every
mid-chain launch: no id flags — the stage launch anchors on the live
`chain #<spec>: status` terminal that step 1 guarantees. The loop pause ends
when this hands off to dev-flow.

## Handoff rules

Both entries follow the same rules, and so does every later stage:

- Run the `handoff` skill before launching the next stage. It writes the
  compacted doc to the OS temp directory; the next session reads it by pointer.
- Context travels as pointers to durable artifacts — the spec issue, tickets,
  ADRs, `GLOSSARY.md`, the review report — never as conversation.
- Every stage is a new session. No stage inherits this session's context.
- The pi stages launch through the pack helper from the shared worktree:
  `node "<skill-dir>/scripts/launch-stage.mjs" <stage> <spec> '<pointers>'`.
  The helper starts a visible `chain #<spec>: <stage>` Kepler terminal, injects
  the stage's pinned command under a retry wrapper and prints the terminal id.
  The wrapper is harness-agnostic — whatever the harness, `pi` is not
  load-bearing — and gives the pinned command 5 attempts with exponential
  backoff (a ~10-minute window). On exhaustion it leaves a loud FAILED marker
  in the terminal buffer (stage, spec, the exact resume command) and actuates a
  wake — an unread session on the task carrying that resume command. A launch
  that never executes is caught by the helper's post-injection check, which
  confirms the wrapper started after injection and recovers. The detached
  `nohup pi` fallback fires only on a connection-level failure to the terminal
  API and never after
  `POST /terminal/start` succeeded — a reachable API never silently degrades —
  and it preserves `error.message` while reporting which path it took.
- Every spawned `pi` command — the stage launch and each sub-agent — carries
  an explicit `--provider`, `--model` and `--thinking`; never rely on pi's
  ambient default (the kimi-k3 incident: three un-pinned spawns burned the
  most expensive model in the account — the ambient default is an environment
  fact, not a chain decision).
- Sub-agents run headless inside their stage's terminal — one terminal per
  stage, none per sub-agent — carrying the stage's pin.
- Every stage shares one git worktree. The worktree outlives this session;
  the context does not.

[ADR-0006](../../../docs/adr/0006-chain-skills-cross-model-handoffs.md) is the
canonical record of the shared chain rules and the pins they carry; this copy
stays for self-containment.
