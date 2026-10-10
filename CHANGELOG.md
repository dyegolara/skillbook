# Changelog

## 1.2.0

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
  grilling session on the task. grill-with-spec keeps a live
  `chain #<spec>: status` terminal (a plain bash loop refreshed every
  30 seconds).
- Add the Matt Pocock pack as referenced skills (published from skills.sh):
  one install command in the book's skills:install script, two
  published-channel checks in the publishing verify, and referenced-skills
  rows in the book's tables.
- Add verify:software-factory, the pack-contract check for chain frontmatter
  and model pins, plugin registration, table rows, and dependency references,
  wired into npm run verify. It also checks that both pack helpers exist and
  are referenced, that both pin tables match their records, that every launch
  snippet carries the exact `<stage> <spec> '<thin pointers>'` arity, and that
  every spawn snippet carries an explicit --model — checked separately from
  the launch snippets.
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