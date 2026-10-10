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
branch log, fix tickets, chain terminals — refreshed every 30 seconds. The
fresh form launches it when the chain starts; the re-entry form makes sure it
is alive when the chain resumes. The check reuses an existing live terminal on
the worktree and never creates a duplicate.

The repo/worktree/task ids come from this grilling session's own Kepler
metadata: `GET /agent/sessions` filtered by the worktree exposes `repoId`,
`worktreeId` and `taskId`. With `SPEC` set to the spec issue number, run:

```bash
SPEC=<spec>             # the chain's spec issue number
WORKTREE=$(pwd)         # the shared worktree of this session
API="http://$(cat ~/.kepler-server/data/server.host):$(cat ~/.kepler-server/data/server.port)"

# Reuse an existing live status terminal; never create a duplicate.
EXISTING=$(curl -s "$API/terminal/list" | jq -r --arg wt "$WORKTREE" --arg want "chain #$SPEC: status" \
  '.[] | select(.worktreePath == $wt and .label == $want and (.exited == false)) | .id')
if [ -z "$EXISTING" ]; then
  # The ids: this session's own metadata on the same worktree.
  ids=$(curl -s "$API/agent/sessions" | jq -r --arg wt "$WORKTREE" \
    '.[] | select(.worktreePath == $wt) | "\(.repoId) \(.worktreeId) \(.taskId)"' | head -n1)
  read -r REPO_ID WORKTREE_ID TASK_ID <<<"$ids"

  # Start the labeled terminal, then run the loop in it.
  TERMINAL_ID=$(curl -s -X POST "$API/terminal/start" -H 'content-type: application/json' \
    -d "$(jq -n --arg repoId "$REPO_ID" --arg worktreeId "$WORKTREE_ID" --arg taskId "$TASK_ID" \
      --arg worktreePath "$WORKTREE" --arg label "chain #$SPEC: status" \
      '{repoId: $repoId, worktreeId: $worktreeId, taskId: $taskId, worktreePath: $worktreePath, label: $label}')" \
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

## Fresh form

### 1. Status terminal

Launch the `chain #<spec>: status` terminal per [Status terminal](#status-terminal)
when the chain starts; it is the live view of the headless stages.

### 2. Grill

Call the Skill tool for `grill-with-docs`. It runs `grilling` and
`domain-modeling`, so glossary terms and ADRs are written down as decisions
land, not after. Work the design tree in rounds until the frontier is empty
and the user confirms shared understanding.

### 3. Spec

Call the Skill tool for `to-spec`. The chain removes to-spec's seam
confirmation question — grilling already settled it. Accept the seams and
document them in the spec's Testing Decisions: prefer existing seams, test at
the highest one that observes the behavior, and propose a new seam only when
none exists. Say what each seam catches and what it misses.

Publish the spec to the project issue tracker with the `ready-for-agent`
label. Do not ask questions after grilling. A question at this point means a
decision was missed, and its answer is another grilling round, not a spec
comment thread.

### 4. Hand off

Call the Skill tool for `handoff`, compacting this conversation for the
dev-flow stage. The doc carries pointers only: the spec issue, the ADRs,
`GLOSSARY.md`, the worktree.

Start dev-flow in a new session. It is a pi stage, so launch it through the
pack helper from the shared worktree, per [ADR-0006](../../../docs/adr/0006-chain-skills-cross-model-handoffs.md):

```bash
node "<skill-dir>/scripts/launch-stage.mjs" dev-flow <spec> 'Run the dev-flow skill on spec issue #<spec> in this worktree: load the dev-flow skill and follow it. Read the handoff doc at <path> first.'
```

## Re-entry form

Entered from `code-review-loop` when a decision-forcing finding arrives: the
fix is not obvious, or the needed decision cannot be derived from the code,
the task or the spec. The chain is paused while you work — the maintainer is
the only actor who can settle the decision, and this form exists so the
decision gets settled before an implementation guesses at it.

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
dev-flow exactly as in the fresh form. The loop pause ends when this hands off
to dev-flow.

## Handoff rules

Both forms follow the same rules, and so does every later stage:

- Run the `handoff` skill before launching the next stage. It writes the
  compacted doc to the OS temp directory; the next session reads it by pointer.
- Context travels as pointers to durable artifacts — the spec issue, tickets,
  ADRs, `GLOSSARY.md`, the review report — never as conversation.
- Every stage is a new session. No stage inherits this session's context.
- The pi stages launch through the pack helper from the shared worktree:
  `node "<skill-dir>/scripts/launch-stage.mjs" <stage> <spec> '<thin pointers>'`.
  The helper starts a visible `chain #<spec>: <stage>` Kepler terminal, injects
  the stage's pinned command and prints the terminal id. When the terminal API
  is unreachable it falls back to the detached `nohup pi` launch and reports
  which path it took.
- Every spawned `pi` command — the stage launch and each sub-agent — carries
  an explicit `--provider`, `--model` and `--thinking`; never rely on pi's
  ambient default (the kimi-k3 incident: three un-pinned spawns burned the
  most expensive model in the account — the ambient default is an environment
  fact, not a chain decision).
- Sub-agents run headless inside their stage's terminal — one terminal per
  stage, none per sub-agent — carrying the stage's pin.
- Every stage shares one git worktree. The worktree outlives this session;
  the context does not.
