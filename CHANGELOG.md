# Changelog

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