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

The software-factory chain starts and resumes here. It is the only interactive
stage: every other stage runs headless and comes back when a finding cannot be
resolved from the code, the task or the spec.

**Model pin**: `opencode-go/glm-5.3`, effort max. Run this stage as a Kepler
session — rich input and output are the point.

**Chain position**: `grill-with-spec → dev-flow → implement-spec →
code-review-loop → (dev-flow | create-pr | this skill)`. The full map is in
[`../README.md`](../README.md).

## Fresh form

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

### 3. Hand off

Call the Skill tool for `handoff`, compacting this conversation for the
dev-flow stage. The doc carries pointers only: the spec issue, the ADRs,
`GLOSSARY.md`, the worktree.

Start dev-flow in a new session. It is a pi stage, so launch it in the
background from the shared worktree, per [ADR-0006](../../../docs/adr/0006-chain-skills-cross-model-handoffs.md):

```bash
nohup pi --print --provider opencode-go --model opencode-go/glm-5.3 --thinking max \
  'Run the dev-flow skill on spec issue #<n> in this worktree. Read the handoff doc at <path> first.' \
  > /tmp/skillbook-dev-flow-pi.log 2>&1 &
```

## Re-entry form

Entered from `code-review-loop` when a decision-forcing finding arrives: the
fix is not obvious, or the needed decision cannot be derived from the code,
the task or the spec. The chain is paused while you work — the maintainer is
the only actor who can settle the decision, and this form exists so the
decision gets settled before an implementation guesses at it.

The entry prompt carries the review report path, the original spec issue, the
tickets and the PR.

### 1. Grill the decision

Call the Skill tool for `grill-with-docs` on the decision-forcing finding, not
the whole design. Write new ADRs with `domain-modeling` as decisions land.

### 2. Refine scope

Refine the scope as comments on the original spec issue. Name the finding,
settle the decision, and say what changes in scope. Do not run `to-spec` and
do not write a new spec.

### 3. Resume

Call the Skill tool for `handoff` for a fresh dev-flow session, then launch
dev-flow exactly as in the fresh form. The loop pause ends when this hands off
to dev-flow.

## Handoff rules

Both forms follow the same rules, and so does every later stage:

- Run the `handoff` skill before the hop. It writes the compacted doc to the
  OS temp directory; the next session reads it by pointer.
- Context travels as pointers to durable artifacts — the spec issue, tickets,
  ADRs, `GLOSSARY.md`, the review report — never as conversation.
- Every hop is a new session. No stage inherits this session's context.
- The pi stages run as background terminal sessions from the shared worktree:
  `nohup pi --print --provider opencode-go --model <pin> --thinking <flag> '<thin pointers>' > /tmp/skillbook-<stage>-pi.log 2>&1 &`.
- Every stage shares one git worktree. The worktree outlives this session;
  the context does not.
