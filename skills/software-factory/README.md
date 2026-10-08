# software-factory pack

Four own chain skills that wrap the referenced Matt Pocock skill pack into one
path from a rough idea to a ready PR. Every hop is a new session on its pinned
agent and model; the chain pauses on the maintainer only for decision-forcing
findings.

Start with `grill-with-spec` and follow the map. The chain mechanism and the
model pins are recorded in
[`docs/adr/0006`](../../docs/adr/0006-chain-skills-cross-model-handoffs.md).

## Chain map

```text
grill-with-spec ──► dev-flow ──► implement-spec ──► code-review-loop
      ▲                                                    │
      │             decision-forcing findings              │ normal findings
      └────────────────────── (pause) ◄────────────────────┤
                                                           └──► create-pr ──► ready PR
```

| Stage | Skill | Harness | Model pin | Effort |
|---|---|---|---|---|
| Grill and spec | `grill-with-spec` | Kepler (interactive) | `opencode-go/glm-5.3` | max |
| Tickets | `dev-flow` | pi (background) | `opencode-go/glm-5.3` | `--thinking max` |
| Implement | `implement-spec` (referenced) | pi (background) | `opencode-go/deepseek-v4.1-flash` | `--thinking max` |
| Review | `code-review-loop` | pi (background) | `opencode-go/mimo-2.6-pro` | none exposed |
| PR | `create-pr` | pi (background) | `opencode-go/muse-spark-1.3-contributor` | `--thinking xhigh` |

Routes out of `code-review-loop`:

| Finding | Next stage |
|---|---|
| Normal — the fix is obvious and derivable from the code, task or spec | `dev-flow` (fix tickets) |
| Clean — nothing on either review axis | `create-pr` |
| Decision-forcing — the fix is not obvious, or the decision is not in the code, task or spec | `grill-with-spec` (re-entry), which pauses the chain on the maintainer |

## How a hop travels

- Each stage runs the `handoff` skill before starting the next one. The
  compacted doc goes to the OS temp directory; the next session reads it by
  pointer.
- Context never travels as conversation. The durable artifacts are the spec
  issue, the tickets (sub-issues of the spec), the ADRs, `GLOSSARY.md`, the
  untracked review report, and the git worktree the whole chain shares.
- Every hop is a new session, so no stage inherits another stage's context.
  The reviewer in particular sees only pointers, never the implementer's
  reasoning.
- The pi stages launch as background terminal sessions from the shared
  worktree:
  `nohup pi --print --provider opencode-go --model <pin> --thinking <flag> '<thin pointers>' > /tmp/skillbook-<stage>-pi.log 2>&1 &`.
  `grill-with-spec` is the one interactive stage and runs as a Kepler session.

## Runtime availability

The four skills are registered in
[`.claude-plugin/plugin.json`](../../.claude-plugin/plugin.json), so a plugin
install gets them. In local development they must also load through the Skill
tool before that install path exists, so each skill folder is symlinked into
the user-level skills directory:

```bash
ln -s "$PWD/skills/software-factory/grill-with-spec"   ~/.agents/skills/grill-with-spec
ln -s "$PWD/skills/software-factory/dev-flow"          ~/.agents/skills/dev-flow
ln -s "$PWD/skills/software-factory/code-review-loop"  ~/.agents/skills/code-review-loop
ln -s "$PWD/skills/software-factory/create-pr"         ~/.agents/skills/create-pr
```

Point the links at the shared worktree's copy — per-ticket worktrees are
deleted after merge. The links dangle until the pack's PR lands on `main`;
after that they resolve to the canonical source.

## Dependencies

The chain calls skills from the referenced Matt Pocock pack, installed from
skills.sh and never copied: `grill-with-docs` (`grilling` + `domain-modeling`),
`to-spec`, `to-tickets`, `handoff`, `implement-spec`, `code-review`, `pr`, and
`tdd`. The book's install command and publishing check cover the pack; see the
referenced-skills rows in the [root README](../../README.md).

What is own: the four chain skills in this folder. What is referenced:
everything else the chain calls.
