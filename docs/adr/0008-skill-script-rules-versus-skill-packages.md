# 0008 — ADR-0002 governs skill scripts, not the packages a skill contains

**Status**: Accepted

**Context**: `docs/adr/0002` requires skill scripts to be plain ESM with zero
dependencies beyond Node, and says a script past ~500 lines of real logic moves
to its own npm package. Two facts already collide with a literal reading:
`skills/engineering/copilot-review-smart/listener/` is already a private npm
package (`@skillbook/pr-monitor-listener`, `private: true`) inside a skill
folder, and the skillbook root already carries `dependencies: {lnurl-auth,
nostr-auth}`. The observability surface now planned for the same skill — a
read-only REST API and a TUI client — wants minimal UI and HTTP dependencies,
and asking whether a single skill may carry them exposes that ADR-0002 never
stated its own scope.

**Decision**:

- ADR-0002 governs **skill scripts**: the `.mjs` files an agent runs directly
  from a skill folder. Those stay plain ESM and dependency-free, because "run
  as-is in any agentic environment" is the criterion that chose them.
- A skill folder may contain **npm packages** (`listener/` today, and the
  observability package next). Inside a package, dependencies are allowed when
  they are minimal, essential and necessary; the package installs on first use.
- The ~500-line threshold applies **per script or module**, not per skill.

## Rejected options

- **Keep everything dependency-free and split into packages as ADR-0002
  prescribes**: rejected as the only option — it forces hand-rolled ANSI and
  hand-rolled HTTP for a client and a server whose whole job is presentation
  and protocol, and it does not match what the repo already ships.
- **Amend ADR-0002 to allow dependencies anywhere**: rejected — the watchdog
  core is the part that must survive a clean container with no install step,
  and relaxing the rule globally would quietly spend that.

## Consequences

- The TUI client and the API server take their dependencies inside a private
  package of `copilot-review-smart`, without touching the watchdog core's
  portability.
- A fresh install of a skill that ships a package needs an install step, which
  that package documents.
- `pr_monitor.mjs` is 1331 lines and still breaches the size rule; that split
  is tracked in issue #52 and is not part of this decision.
