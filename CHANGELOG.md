# Changelog

## 1.3.0

- Add `skills/software-factory/scripts/env-defaults.mjs`: the single source of
  the chain's pins and resolution rules, so every pin resolves from the
  environment (`DEV_ENV_*`) and falls back to the current values (#161, #162).
- Route every launch helper pin through that resolver; the verifier follows the
  file and `.env.example` documents the provider-environment pattern (ADR-0006
  amendment, #163).
- API keys are provider-environment scoped: each docker sets
  `DEV_ENV_PROVIDER` plus that provider's own key variable; a missing key is a
  hard error naming the provider and the variable to set, and nothing is
  injected into the launch command (#167, #169). The key preflight is the
  CLI-launched stages' contract — the grill stage runs as an interactive
  Kepler agent session on its own configured auth.
- Rename the generic command builder to `buildStageCommand` and the pin field
  to `effort`; the GRILL-rejection and shell-quoting rationale is recorded in
  ADR-0006 (#168).
- The fixture harness proves the key design end to end: byte-identical
  commands, missing-key hard errors, and the `nohup` fallback carrying the
  environment (#170).
- Extend the fixture harness so a `DEV_ENV_` launch produces the resolved pinned
  command end to end (#164, #165).
- `create-pr` step 4 uses the branch's PR in whichever state it is — draft or
  ready — and never opens a second one (#171).

## 1.2.1

- `copilot-review-smart`: newer Tick observations supersede stale closure
  evidence, and Listener Tick timeouts allow decision-command process groups
  to clean up before forced termination.

## 1.2.0

- `copilot-review-smart`: agent-native LLM decider — the three-layer decision
  source (explicit decision command, model + credential pair, auto-discovery
  of the invoking agent session, or the handled none case) records
  `decision_source` on every decision and treats a missing decider as a
  configuration gap instead of burning the failure budget or escalating
  (ADR-0007).
- `copilot-review-smart`: read-only observability surface — a separate
  loopback REST API (`/health`, `/timeline`, `/flows`,
  `/flows/:owner/:repo/:num`) that projects the persisted Tick and Listener
  state, plus a coloured TUI client of the same contract (ADR-0009).
  `next_check_at` and the per-PR Tick history are persisted so the Stage
  sequence and the schedule survive the process.
- Add the software-factory pack: grill-with-spec, dev-flow, code-review-loop,
  and create-pr, four chain skills that wrap the referenced Matt Pocock pack
  into one path from a rough idea to a ready PR. Each stage is a new session on
  a pinned agent and model; the chain mechanism is recorded in ADR-0006.
- Add the chain's launch mechanism under the four-piece contract:
  `launch-stage.mjs` starts each pi stage in a visible
  `chain #<spec>: <stage>` Kepler terminal (explicit spec argument,
  chain-labeled anchor preference, explicit id flags for fresh runs,
  connection-level-only `nohup` fallback), and `open-grill-session.mjs`
  actuates the decision-forcing pause by opening and pinning a fresh
  grilling session on the task. The injected command runs under a retry
  wrapper around the pinned agent command — 5 attempts with exponential
  backoff (~10-minute window) — and the helper's post-injection check polls
  the terminal buffer for the wrapper's sentinel, closing and relaunching a
  wedged terminal once; on exhaustion the wrapper leaves a FAILED marker
  (stage, spec, the exact resume command) and actuates a sibling wake helper,
  `open-wake-session.mjs`, an unread notice session on the task carrying
  that resume command. grill-with-spec keeps a live `chain #<spec>: status`
  terminal (a plain bash loop refreshed every 30 seconds).
- Add the Matt Pocock pack as referenced skills (published from skills.sh):
  one install command in the book's skills:install script, two
  published-channel checks in the publishing verify, and referenced-skills
  rows in the book's tables.
- Add verify:software-factory, the pack-contract check for the four chain
  skills' frontmatter and ADR-0006 model pins, plugin registration, the pack
  README and the book's table rows, and the Matt Pocock dependency
  references, wired into npm run verify. It also checks that the three
  packaged helpers (`launch-stage.mjs`, `open-grill-session.mjs`, and
  `open-wake-session.mjs`) exist and are
  referenced — all three are packaged byte-identically to their shared
  sources, `open-grill-session.mjs` by code-review-loop's decision-forcing
  route — that both pin tables match their records, that every launch
  snippet carries the exact `<stage> <spec> '<pointers>'` arity and, on
  grill-with-spec's Fresh start, the three explicit
  `--repo-id/--worktree-id/--task-id` flags, that the launch construction
  wraps the pinned command in the bounded retry wrapper (the wrapper's
  give-up path carries the FAILED marker and references the wake helper,
  and the pinned command inside it keeps the explicit
  `--provider/--model/--thinking` flags), that every spawn snippet carries
  an explicit --model — checked separately from the launch snippets — and
  that the `## Handoff rules` blocks closing `dev-flow` and
  `code-review-loop` are byte-identical. Offline.
- Document the Kepler local API the helpers wrap in the pack's
  `docs/kepler-api.md`: verified terminal and agent endpoints, their
  request/response shapes, and the probe recipe that settles a new endpoint.
- Teach the grill-with-spec Re-entry to list a decision's open gaps in
  its scope comment, so the implementer fills them in-ticket and records them
  in the ADR instead of making its own design call.
- Extend the decision-forcing rule: a fix that would change one of the
  project's commitments — what the project *is* or *promises* — instead of
  satisfying them routes to `grill-with-spec`; a fix that satisfies them
  stays normal.
- Migrate the glossary to GLOSSARY.md, replacing CONTEXT.md.

## 1.1.0

- Add copilot-review-smart v2.3.0's webhook-first Listener, Expectation
  fallback, lifecycle management, and deployment resources.

## 1.0.0

- Baseline: repo versioning introduced (VERSION + CHANGELOG + version-bump CI
  check). Collection state: own skills, copilot-review-smart (single-PR
  invocation + JSON tick reporting), the ported pstack pack, and pointers to
  dyegolara's published auth skills.

### Prior history (pre-versioning, by date)

- **2026-09-02** — Initial skillbook: `copilot-review-smart` as an Agent Skill
  + Claude Code marketplace plugin; auth skills (`lnurl-auth`, `nostr-auth`)
  added by reference to their published channels (npm + skills.sh), never by
  copying repos.
- **2026-09-04** — `nostr-auth` goes official: published to npm (v1.0.0),
  skills.sh and ClawHub; `copilot-review-smart` v1.2.0 rebase-retry policy
  (anti-deadlock) and the WIP/active-work guard (never interrupt a working
  agent).
- **2026-09-07** — Engineering-skills infrastructure (CLAUDE.md, docs/agents,
  docs/adr); `copilot-review-smart` v2.0.0 portable reference script +
  restructure; v2.1.0 migrates `pr_monitor` to `.mjs` with the script-standard
  ADR; loop README with mermaid diagrams; deployed cron migration docs.
- **2026-09-08** — `copilot-review-smart` v2.2.0: 6h conflict-retry window,
  English operator output, deterministic decision seam + domain ADRs (#8);
  offline unit coverage for deterministic decision gates and cache
  invalidation (#9); single-PR invocation + JSON tick reporting (#15).
- **2026-09-15** — `pstack` ported into the book as ported skills, upstream
  provenance tracked (#27).