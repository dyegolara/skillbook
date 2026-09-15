# pstack pack

A port of [pstack](https://github.com/cursor/plugins/tree/main/pstack) by
[Lauren Tan](https://x.com/poteto) (MIT, © 2026), adapted to the standard
[Agent Skills](https://agentskills.io) format with capability fallbacks so it
runs on any harness. This repo is the canonical source for the port; see
[`_upstream/PROVENANCE.md`](_upstream/PROVENANCE.md) for the pin (commit, date,
version), the changes applied, and what was not ported (`automations/benny`).

Start here:

1. `setup-pstack` detects the models your harness offers and writes a
   per-role config, or skips the config when your harness has no model choice.
2. `poteto-mode` is the entry point. It matches a task to one of its 23
   playbooks and routes the other skills as steps need them.

## Skills

### Mode

| Skill | Use it when |
|---|---|
| `poteto-mode` | Default entry point for any non-trivial task. Routes to a playbook, keeps the principles in reach, and stays on across turns until the task is done or the operator opts out. |

### Playbooks (nested under `poteto-mode/playbooks/`)

| Playbook | For |
|---|---|
| `investigation.md` | A read-only question: how does X work, why was Y built this way, are we sure. |
| `bug-fix.md` | Reproduce a defect, root-cause it, fix it with runtime evidence. |
| `perf-issue.md` | Trace a measured slowness and improve it against a baseline. |
| `hillclimb.md` | Sustained scientific improvement of one metric against a target. |
| `runtime-forensics.md` | Diagnose a live symptom from instrumentation. |
| `trace-forensics.md` | Diagnose a captured profiling artifact. |
| `feature.md` | New or changed behavior, built from a named data shape. |
| `refactoring.md` | A behavior-preserving change to structure or shape. |
| `prototype.md` | A throwaway sketch that settles a design or behavioral fork. |
| `visual-parity.md` | Pixel-exact UI equivalence between two implementations. |
| `authoring-a-skill.md` | Writing or editing a `SKILL.md`. |
| `eval.md` | Test how a skill or prompt change affects agent behavior, blinded. |
| `babysit.md` | Drive a PR or a stack to merge-ready: conflicts, review threads, CI. |
| `shipping.md` | Independently verify a green stack, then land the verified run. |
| `autonomous-run.md` | Drive a long task to completion without stopping. |
| `orchestrate.md` | A standing project handed to one coordinator chat. |
| `autopilot-full.md` | Independent PRs run to merged with one owner per PR. |
| `autopilot-stack.md` | Build one linear stack for the operator to land. |
| `session-pickup.md` | Resume or take over a prior agent's in-flight work. |
| `pause-safely.md` | Suspend in-flight work cleanly so it can resume later. |
| `multi-phase-plan.md` | Work that spans phases or stacked PRs. |
| `worktree-cleanup.md` | Reclaim disk from merged or abandoned worktrees, safety-gated. |
| `opening-a-pr.md` | Open a ready PR from small ordered commits. Invoked by every other playbook. |

### Standalone skills

| Skill | Use it when |
|---|---|
| `how` | You want a walkthrough of how a subsystem works. |
| `why` | You want to know why something was built this way, from the evidence. |
| `recall` | You are starting or resuming work and want your recent context rebuilt. |
| `blast-radius` | A small-looking change may break something else; prove the safety fact by running code. |
| `architect` | Code crosses a function boundary and the types and module shape should be settled first. |
| `arena` | N parallel attempts at the same thing, then graft the best parts into one base. |
| `swarm` | N parallel workers across slices, races, or a coverage matrix; one report. |
| `interrogate` | Several models challenge a diff from independent angles. |
| `automate-me` | Draft or revise your own `-mode` skill from how you have actually worked. |
| `make-bot-ui` | A page or dashboard whose buttons wake a bot over a webhook. |
| `setup-pstack` | Pick which models pstack uses per role. |
| `reflect` | A long task landed and you want the recipe captured as a skill edit. |
| `teach` | Actually understand a change or subsystem; runs `how` and `why`, then weaves one explanation. |
| `tdd` | A bug has a cheap local test path; write the failing test first. |
| `no-comments` | Strip comments before review with the Comment Sicko lens. |
| `typescript-best-practices` | Reading or editing TypeScript. |
| `figure-it-out` | No bundled playbook fits; design a rigorous, auditable one. |
| `show-me-your-work` | Keep a reviewable decision trail as a TSV log. |
| `create-verification-skill` | The project has no scripted way to prove app behavior; generate one. |
| `maintain-verification-skill` | The verification skill and feature map drifted from the app. |
| `unslop` | Remove AI tells from writing. |
| `bro` | Restate the last message in plain human language. |
| `technical-writing` | Layered doc standard for docs, RFCs, readmes, PR descriptions, commits. |

### Principles (23)

Each principle is an individually installable skill, citable by name.

| Principle | Group | Rule |
|---|---|---|
| `principle-laziness-protocol` | core | Bias toward deletion and the smallest change that solves the problem. |
| `principle-foundational-thinking` | core | Get core types and data structures right so downstream code becomes obvious. |
| `principle-redesign-from-first-principles` | core | Redesign as if the requirement had been foundational from day one. |
| `principle-attack-the-premise` | core | When fixes sharing a premise keep failing, question the premise. |
| `principle-subtract-before-you-add` | core | Remove dead weight first, then build on the simpler base. |
| `principle-minimize-reader-load` | core | Collapse layers and hidden state between question and answer. |
| `principle-outcome-oriented-execution` | core | Converge on the target architecture; no throwaway compatibility states. |
| `principle-experience-first` | core | Choose user delight over implementation convenience. |
| `principle-exhaust-the-design-space` | core | Compare competing prototypes before committing. |
| `principle-build-the-lever` | core | Build the tool that does the work or proves it; the tool is the artifact. |
| `principle-model-the-domain` | architecture | Encode the domain in a structure instead of scattered conditionals. |
| `principle-boundary-discipline` | architecture | Guards at system boundaries; trust internal types. |
| `principle-type-system-discipline` | architecture | Make illegal states unrepresentable; parse at boundaries. |
| `principle-make-operations-idempotent` | architecture | Converge to the same end state regardless of partial prior runs. |
| `principle-migrate-callers-then-delete-legacy-apis` | architecture | Migrate callers and delete the old API in the same wave. |
| `principle-separate-before-serializing-shared-state` | architecture | Eliminate sharing first; serialize only real invariants. |
| `principle-prove-it-works` | verification | Verify against the real artifact before declaring done. |
| `principle-fix-root-causes` | verification | Trace each symptom to its root cause and fix it there. |
| `principle-sequence-verifiable-units` | verification | Small units that each end in a verifiable state, in a proving order. |
| `principle-test-behavior-not-implementation` | verification | Call the code like its users do and assert what they observe. |
| `principle-guard-the-context-window` | delegation | Route bulk to subagents; keep summaries in the main thread. |
| `principle-never-block-on-the-human` | delegation | Proceed on reversible work; reserve confirmation for irreversible acts. |
| `principle-encode-lessons-in-structure` | meta | Encode recurring rules as lint, metadata, checks, or scripts. |

## Agents

`agents/poteto-agent.md` and `agents/comment-sicko.md` are optional, non-skill
files for harnesses that support named agents. Every skill that uses them also
defines an inline fallback, so no harness is blocked; see `no-comments` and the
Subagents section of `poteto-mode`.

## Tooling

The pack ships pstack's tooling under `poteto-mode/scripts/`:

| Tool | What it does |
|---|---|
| `watch-pr/watch-pr` | Watches a PR, a connected stack, or a queued stack (GitHub only by design). |
| `orch/orch.ts` | Plain-file orchestrate bookkeeping for long-running programs. |
| `check-plan.mjs` | Validates a multi-phase plan against its required shape. |
| `worktree-audit.sh` | Read-only worktree prune audit (macOS flags; needs `rg` and `jq`). |
| `show-me-your-work/scripts/log.sh` | Appends a well-formed row to a decision log (from that skill). |

Runtime requirements:

- **Node >= 22.18.0** runs the tooling directly through native TypeScript type
  stripping, with no build step and no Bun at runtime.
- The tooling installs its production dependencies with `npm` on first use
  (`bootstrap.ts`); entry-point shebangs point at Node.
- **Bun is a dev dependency only**, used to run the upstream `bun:test` suite
  (`npm run test:pstack`). Nothing requires Bun at run time.
- The watcher's review-bot detection is configurable:
  `PR_REVIEW_BOT_AUTHORS`, `PR_REVIEW_BOT_BODY_TOKENS`,
  `PR_REVIEW_BOT_IDENTITY`, and `PR_REVIEW_BOT_PASS_KEYS`. The defaults match
  the Bugbot/Cursor automation tokens upstream expected (for example, `bugbot`
  as an author and `CURSOR_AUTOMATION_ID` as a pass key).
- The orchestrator resolves the forge as `gt` -> `gh` -> `git`, with a clear
  error when stack discovery is impossible.
- The plan validator reads the `multi-phase lanes` role from the model config
  and accepts `inherit-parent` and `auto`.

## Harness notes

- **Models.** Concrete model slugs are gone. Skills read roles (`how explorer`,
  `judgment and prose`, ...) from `~/.agents/rules/pstack-models.md` (the
  legacy `~/.cursor/rules/pstack-models.mdc` path works as a fallback) and fall
  back to the parent model when a role is unset or the harness offers no model
  choice. Configure with `setup-pstack`.
- **Subagents.** Named client agents and `Task` calls became "use your
  harness's subagent mechanism if it has one; otherwise do the work inline".
- **Cloud/background runs.** Where upstream defaulted to a cloud environment,
  the port prefers a cloud or background run when the harness offers one and
  falls back to local.
- **Loops and wakeups.** `/loop`-style scheduling is an optional capability;
  otherwise skills poll or run a one-shot check.
- **Structured questions.** Use the harness's structured question tool if it
  has one; otherwise ask in plain text.
- **Paths.** Cursor paths map to `~/.agents/*` (`rules/`, `skills/`,
  `projects/<slug>/agent-transcripts/`); the Cursor locations are named only as
  fallbacks. Repo-persistent instructions go to `AGENTS.md`.
- **Built-ins.** `create-skill`, `/deslop`, `control-ui`, `control-cli`, and
  Cursor's built-in babysit are treated as optional capabilities with manual or
  inline fallbacks. `cursor-team-kit` is not ported.
- **Review bots.** Bugbot is the default example of a review automation; the
  watcher tokens above make other bots work without code changes.

## Provenance and verification

- [`_upstream/PROVENANCE.md`](_upstream/PROVENANCE.md) — upstream repo, pin,
  structural changes, exclusions.
- [`_upstream/THIRD_PARTY_NOTICES.md`](_upstream/THIRD_PARTY_NOTICES.md) — the
  upstream MIT notice.
- [`_upstream/upstream-manifest.json`](_upstream/upstream-manifest.json) — a
  map from every ported file to its upstream path and blob SHA at the pin.
- `npm run verify:pstack` — the pack contract (frontmatter, cross-references,
  registration, provenance, no required client couplings, Node smoke of the
  tooling). Offline except the tooling smoke, which may install tooling
  dependencies on first run; pass `--skip-smoke` for a fully offline run.
- `npm run verify:upstream` — network drift check against the pin. It fails on
  drift; `npm run verify` runs it with `--report-only` so upstream movement is
  reported without breaking the book's health check.
- `npm run test:pstack` — the upstream tooling test suite.
- `npm run verify` — all checks, including the publishing references.
