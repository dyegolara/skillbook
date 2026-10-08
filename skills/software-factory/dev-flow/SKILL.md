---
name: dev-flow
description: "Software-factory chain stage: break a published spec into tracer-bullet tickets with blocking edges, publish them as ready-for-agent sub-issues of the spec, then hand off to a fresh implement-spec session. No granularity quiz. Use for /dev-flow, spec-to-tickets work, or when code-review-loop routes findings back as new fix tickets."
disable-model-invocation: true
license: MIT
metadata:
  model: opencode-go/glm-5.3
  thinking: max
---

# dev-flow

Turn a published spec into tracer-bullet tickets and hand off to
implementation. The stage is non-interactive: the spec is the authority, the
blocking edges are the review, and there is no granularity quiz.

**Model pin**: `opencode-go/glm-5.3`, `--thinking max`. It runs as a
background pi terminal session from the shared worktree, launched by
`grill-with-spec` or directly with `/dev-flow` on a spec issue.

## Process

1. Read the spec issue, its comments and the handoff doc. The doc points at
   the spec, the ADRs and `GLOSSARY.md`; use the glossary's vocabulary in
   every ticket.

2. Call the Skill tool for `to-tickets` on the spec, with one change: skip
   step 4, "Quiz the user". Publish one ticket per vertical slice, in
   dependency order (blockers first), as a **sub-issue of the spec issue**.
   Set the tracker's native blocked-by edges and the `ready-for-agent` label,
   and give every ticket its acceptance criteria. Do not close or modify the
   parent spec.

3. Re-entry from `code-review-loop`: the process is the same, with the review
   report as the source. Its normal findings become fix tickets, each a
   sub-issue of the original spec, blocked by the tickets it depends on and
   blocking the fixes that follow. The spec keeps its scope; the report is the
   evidence.

4. Call the Skill tool for `handoff` for the implement-spec stage. Pointers
   only: the spec issue, the tickets, the ADRs, the worktree.

5. Launch implement-spec as a new background pi session:

   ```bash
   nohup pi --print --provider opencode-go --model opencode-go/deepseek-v4.1-flash --thinking max \
     'Run the implement-spec skill in this worktree for spec #<n>. Read the handoff doc at <path>. Work the ticket frontier. When it completes, run the handoff skill for code-review-loop, then launch it per the chain rules in skills/software-factory/code-review-loop/SKILL.md.' \
     > /tmp/skillbook-implement-spec-pi.log 2>&1 &
   ```

6. Report the ticket numbers and the log path, then stop. The implement-spec
   session owns the rest: it runs the full skill in this same worktree,
   including its inline review and the draft PR after the first merge, and at
   the end launches `code-review-loop` with a fresh context and pointers only.

## Handoff rules

The chain's rules apply at this hop and every later one:

- The `handoff` skill writes the compacted doc to the OS temp directory; the
  next session reads it by pointer.
- Context travels as pointers to durable artifacts — the spec issue, tickets,
  ADRs, `GLOSSARY.md`, the review report — never as conversation.
- Every hop is a new session. No stage inherits this session's context.
- The pi stages run as background terminal sessions from the shared worktree:
  `nohup pi --print --provider opencode-go --model <pin> --thinking <flag> '<thin pointers>' > /tmp/skillbook-<stage>-pi.log 2>&1 &`.
- Every stage shares one git worktree.
