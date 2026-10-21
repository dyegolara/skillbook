# software-factory pack

Four own chain skills that wrap the referenced Matt Pocock skill pack into one
path from a rough idea to a ready PR. Every stage is a new session on its
pinned agent and model — the pins are defaults, overridable per run (see
Configuration); the chain pauses on the maintainer only for decision-forcing
findings.

Start with `grill-with-spec` and follow the map. The chain mechanism is
recorded in
[`docs/adr/0006`](../../docs/adr/0006-chain-skills-cross-model-handoffs.md);
the pins and their defaults live in
[`scripts/env-defaults.mjs`](scripts/env-defaults.mjs).

## Chain map

```text
grill-with-spec ──► dev-flow ──► implement-spec ──► code-review-loop
      ▲                                                    │
      │             decision-forcing findings              │ normal findings
      └────────────────────── (pause) ◄────────────────────┤
                                                           └──► create-pr ──► ready PR
```

| Stage | Skill | Harness | Model pin (default) | Effort (default) |
|---|---|---|---|---|
| Grill and spec | `grill-with-spec` | Kepler (interactive) | `opencode-go/glm-5.3` | max |
| Tickets | `dev-flow` | pi (Kepler terminal) | `opencode-go/glm-5.3` | `--thinking max` |
| Implement | `implement-spec` (referenced) | pi (Kepler terminal) | `opencode-go/deepseek-v4.1-flash` | `--thinking max` |
| Review | `code-review-loop` | pi (Kepler terminal) | `opencode-go/mimo-v2.6-pro` | `--thinking high` |
| PR | `create-pr` | pi (Kepler terminal) | `opencode-go/muse-spark-1.3-contributor` | `--thinking xhigh` |

Each `Model pin`/`Effort` above is the stage's default from
[`scripts/env-defaults.mjs`](scripts/env-defaults.mjs) — the pins are no
longer fixed in code. `DEV_ENV_MODEL_<STAGE>` and `DEV_ENV_EFFORT_<STAGE>`
retune one stage per run; `DEV_ENV_AGENT_<STAGE>` switches its agent.
The harness column documents the default agent's runtime.

Routes out of `code-review-loop`:

| Finding | Next stage |
|---|---|
| Normal — the fix is obvious and derivable from the code, task or spec | `dev-flow` (fix tickets) |
| Clean — nothing on either review axis | `create-pr` |
| Decision-forcing — the fix is not obvious, or the decision is not in the code, task or spec, or it would change the project's commitments instead of satisfying them | `grill-with-spec` (re-entry), which pauses the chain on the maintainer |

## Configuration

Every pin resolves from the environment; unset variables fall back to the
defaults in [`scripts/env-defaults.mjs`](scripts/env-defaults.mjs), so an
unset environment runs the chain with today's pins. The one exception is the
provider's key: it has no default, and the CLI-launched stages require it.
The repo root's [`.env.example`](../../.env.example) lists every variable and
its default (the provider's key is required by those stages, with no default).

The per-docker pattern is the provider-environment pattern: each docker sets
`DEV_ENV_PROVIDER` plus that provider's own key variable —
`OPENCODE_GO_API_KEY` for `opencode-go`, `OPENAI_API_KEY` for `openai`, and
so on for `openrouter`, `xai` and `anthropic` — carrying its own account for
that provider. The provider's key variable is the pattern's only key
mechanism: there is no generic key variable and no fallback chain. For the
CLI-launched stages — `dev-flow`, `implement-spec`, `code-review-loop` and
`create-pr` — the resolved provider's variable must be set and non-empty
after trim; a missing key is a hard error naming the provider and the
variable to set. The grill stage is the exception: it runs as an interactive
Kepler agent session on the agent's own configured auth, so it runs no key
preflight; its model, effort and agent pins still resolve from
`env-defaults.mjs` plus `DEV_ENV_*`. The key is never injected into the
launch command — the environment carries it, so a launched stage inherits it
already paired with the resolved provider (ADR-0006, amended 2026-10-21).
The shipped `.env.example` keeps the account block commented, so sourcing it
as-is sets no key.

| Scope | Variables | Default |
|---|---|---|
| Per-docker provider — one provider per docker and run; the CLI-launched stages resolve their provider from it | `DEV_ENV_PROVIDER` | `opencode-go` |
| Per-docker key — the provider's own variable, required by the CLI-launched stages; a missing key is a hard error naming the provider and the variable to set | `OPENROUTER_API_KEY`, `OPENCODE_GO_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY` | unset — no fallback |
| Stage pins — retune one stage at a time | `DEV_ENV_MODEL_<STAGE>`, `DEV_ENV_EFFORT_<STAGE>`, `DEV_ENV_AGENT_<STAGE>` | the chain map above |

An off-list provider, effort or agent value is a hard error naming the
variable and listing the allowed values. The model is a free non-empty
string, not cross-validated against the provider, so switching
`DEV_ENV_PROVIDER` also means setting that provider's models — the shipped
per-stage models name `opencode-go` ids.

## How context travels between stages

- Each stage runs the `handoff` skill before starting the next one. The
  compacted doc goes to the OS temp directory; the next session reads it by
  pointer.
- Context never travels as conversation. The durable artifacts are the spec
  issue, the tickets (sub-issues of the spec), the ADRs, `GLOSSARY.md`, the
  untracked review report, and the git worktree the whole chain shares.
- Every stage is a new session, so no stage inherits another stage's context.
  The reviewer in particular sees only pointers, never the implementer's
  reasoning.
- The pi stages launch through the pack helper from the shared worktree:
  `node "<skill-dir>/scripts/launch-stage.mjs" <stage> <spec> '<pointers>'`.
  `<skill-dir>` is the absolute directory of the loaded skill, not the shared
  worktree. Each launching skill ships its own standalone helper; the copies
  match the shared sources in `scripts/`, enforced by the pack verifier.
  The helper starts a visible `chain #<spec>: <stage>` Kepler terminal,
  injects the stage's pinned command under a retry wrapper and prints the
  terminal id. The wrapper is harness-agnostic — whatever the harness, `pi` is
  not load-bearing — and gives the pinned command 5 attempts with exponential
  backoff (a ~10-minute window). On exhaustion it leaves a loud FAILED marker
  in the terminal buffer (stage, spec, the exact resume command) and actuates
  a wake — an unread session on the task carrying that resume command. A
  launch that never executes is caught by the helper's post-injection check,
  which confirms the wrapper started after injection and recovers. The detached
  `nohup pi` fallback fires only on a connection-level failure to the terminal
  API and never after `POST /terminal/start` succeeded — a reachable API never
  silently degrades —
  and it preserves `error.message` while reporting which path it took.
  `grill-with-spec` is the one interactive stage and runs as a Kepler session.
  [ADR-0006](../../docs/adr/0006-chain-skills-cross-model-handoffs.md) is the
  canonical record of the shared chain rules and the pins they carry; this copy
  stays for self-containment.
- The local Kepler API behind the helpers — every verified endpoint of the
  terminal and agent APIs, its request/response shape, and the probe recipe
  that settles a new endpoint — is documented in
  [`docs/kepler-api.md`](docs/kepler-api.md); reach it before building a new
  chain capability on Kepler's surface.

## Where to watch a chain run

A `pi --print` stage prints nothing until it finishes, so a running chain is
watched in three places:

- **The terminal buffer.** A stage terminal stays open after the stage exits:
  its buffer holds the launch command plus the stage's final response.
- **The transcripts.** Each stage's full transcript lives in the pi session
  files under `~/.pi/agent/sessions/<worktree>`.
- **The live view.** Live progress is the artifacts — commits on the shared
  worktree and the spec's tickets — plus a status terminal
  `chain #<spec>: status`. `grill-with-spec` launches it once the spec is
  published in the Fresh start and makes sure it is alive when the chain
  resumes; the status terminal refreshes every 30 seconds.

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
deleted after merge. The links resolve as soon as the pack is on the shared
worktree's branch; re-point them at a canonical checkout when that worktree
is retired.

## Dependencies

The chain calls skills from the referenced Matt Pocock pack, installed from
skills.sh and never copied: `grill-with-docs` (`grilling` + `domain-modeling`),
`to-spec`, `to-tickets`, `handoff`, `implement-spec` (`tdd`), `code-review`,
and `pr`. The book's install command and publishing check cover the pack; see
the referenced-skills rows in the [root README](../../README.md).

What is own: the four chain skills in this folder. What is referenced:
everything else the chain calls.
