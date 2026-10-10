# 0006 — Chain skills hand off across pinned agent/model sessions

**Status**: Accepted

**Context**: The software-factory chain (grill-with-spec, dev-flow, code-review-loop,
create-pr) wraps the referenced Matt Pocock skills and needs each stage on a
different model — reasoning on the grill/spec stage, a fast workhorse on
implementation, an independent reviewer, a cheap shipper. Within one session a
skill cannot change agent or model, and a reviewer sharing the implementer's
context is not independent.

**Decision**:

- Every stage runs as a new session; the finishing stage launches the next
  one. The pi stages (dev-flow, implement-spec, code-review-loop, create-pr)
  run inside a visible Kepler terminal, launched from the shared worktree
  with the pack helper: `node skills/software-factory/scripts/launch-stage.mjs
  <stage> <spec> '<thin pointers>'`. The helper calls Kepler's local
  terminal API (loopback HTTP, no auth), derives the terminal's
  repo/worktree/task ids from an existing terminal on the same worktree
  (`GET /terminal/list`, preferring a chain-labeled one so the terminal
  attaches to the chain's own task) or from explicit
  `--repo-id/--worktree-id/--task-id` arguments — the fresh-run bootstrap,
  where grill-with-spec is the one stage holding the ids — creates a
  terminal labeled `chain #<spec>: <stage>` with the spec number taken from
  the explicit argument, never parsed from another label, injects the
  stage's pinned command — `pi --print --provider opencode-go --model <pin>
  --thinking <flag> '<thin pointers>'` — and prints the terminal id. The
  terminal stays open after the stage exits; its buffer is the stage log.
  The `nohup` fallback fires only on a connection-level failure to the API
  and never after `POST /terminal/start` succeeded — a reachable API never
  silently degrades — and it preserves `error.message` while reporting which
  path it took. The opencode stage (grill-with-spec, the one interactive
  stage) runs as a Kepler session for rich input/output. Amended during the
  dogfood run: Kepler's `create_session` refuses model/effort pins on `pi`
  until its catalog is cached; pi is lighter and runs headless in the
  background. Amended 2026-10-08, maintainer decision after the Kepler
  terminal-API discovery: the detached `nohup` launch is replaced by
  visible Kepler terminals — the same pinned `pi` command and handoff doc,
  now live in the Kepler UI; `nohup` survives only as the helper's
  fallback. Amended 2026-10-10, maintainer decision after the first
  terminal-mechanism review: the spec number is an explicit helper
  argument, the id anchor prefers a chain-labeled terminal but accepts any
  terminal on the worktree, fresh runs bootstrap with explicit id flags,
  and the fallback is connection-level only.
- Each stage's `SKILL.md` pins its model, invoked at the model's highest
  available effort/thinking (whatever the model exposes — max, xhigh or
  high):
  - grill-with-spec — `opencode-go/glm-5.3` (effort max)
  - dev-flow — `opencode-go/glm-5.3` (`--thinking max`)
  - implement-spec — `opencode-go/deepseek-v4.1-flash` (`--thinking max`)
  - code-review-loop — `opencode-go/mimo-v2.6-pro` (`--thinking high` — the model's cap: `max` clamps to it)
  - create-pr — `opencode-go/muse-spark-1.3-contributor` (`--thinking xhigh`, provider cap)
- Every spawned `pi` command — the stage launch and each sub-agent —
  carries an explicit `--provider`, `--model` and `--thinking`; never rely
  on pi's ambient default (the kimi-k3 incident: three un-pinned spawns
  burned the most expensive model in the account — the ambient default is
  an environment fact, not a chain decision). Sub-agents run headless
  inside their stage's terminal — one terminal per stage, none per
  sub-agent — carrying the stage's pin.
- The pause path needs no MCP (pi has none configured): on a
  decision-forcing finding the terminal chain stops with a durable review
  report and handoff doc, and the pausing stage opens the grilling session
  itself. `open-grill-session.mjs` creates an opencode session on the task
  through Kepler's agent API (the same loopback server): create the
  session, label it `chain #<spec>: grill-with-spec`, pin its model to the
  grill pin, send the re-entry prompt — so a fresh grilling session sits
  waiting on the maintainer instead of waiting to be noticed. If the agent
  API is unreachable, the stage prints the pause and the maintainer
  re-enters via `/grill-with-spec` manually. Amended 2026-10-10, maintainer
  decision: the pause actuates the grilling session; a passive pause once
  left a settled chain stopped and unnoticed overnight.
- grill-with-spec launches a `chain #<spec>: status` terminal when it
  starts or resumes a chain: a plain bash loop (branch log, fix tickets,
  chain terminals) refreshed every 30 seconds — live progress in the
  Kepler UI, because `pi --print` is silent until a stage finishes. Each
  stage's transcript lives in the pi session files under
  `~/.pi/agent/sessions/<worktree>`.
- Context travels by pointers, never by conversation: each stage runs the
  `handoff` skill (compacted doc in the OS temp dir) and the next session reads
  durable artifacts — the spec issue, tickets, ADRs, `GLOSSARY.md`, the
  untracked review report. The git worktree is shared by every stage.
- grill-with-spec ends with `to-spec` and no post-grilling questions (seams
  auto-accepted, documented in the spec). On decision re-entry it takes a
  reduced form — new ADRs plus scope-refining comments on the original spec
  issue, no `to-spec`.
- code-review-loop routes: normal findings → dev-flow; clean → create-pr;
  decision-forcing findings (the fix is not obvious, or the needed decision
  cannot be derived from the code, task or spec) → grill-with-spec, which
  pauses the chain on the user.
- Pins are hardcoded in v1 — a deliberate opencode+kepler-specific exception
  to the book's model-agnostic stance; remote/dynamic pin configuration is
  deferred to #54.
- `GLOSSARY.md` replaces `CONTEXT.md`, adopting the referenced pack's glossary
  convention; ADRs keep living in `docs/adr/`.

Rejected options:

- **Same-session skill chaining**: a session cannot change agent or model per
  stage, and the reviewer would inherit the implementer's context.
- **Sub-agent fan-out per stage**: no fresh top-level context and no durable
  handoff artifacts between stages.
- **npm dependency on the Matt Pocock skills**: they are not on npm;
  skills.sh is their published channel, so they join as referenced skills —
  porting is reserved for skills with no published channel.

**Consequences**:

- Every stage starts with a clean context; the chain is resumable stage by
  stage.
- The terminal mechanism supersedes the "every hop is a new Kepler session
  (`create_session`)" phrasing in spec #55's Implementation Decisions —
  every stage is still a new session, now a visible terminal one; the
  scope-refining comment on the spec records the decision.
- A pause no longer waits to be noticed: the grilling session opens pinned
  and labeled, and sits `unread` on the task waiting for the maintainer.
- Kepler's `create_session` naming a model or effort for `pi` is refused
  until pi's catalog is cached — moot for the chain, whose pi stages launch
  via the terminal per the launch mechanism above.
- The four own skills must be Skill-tool-loadable in the running environment;
  local dev symlinks them into the user-level skills dir.
- Uncommitted glossary/ADR work sitting in the shared worktree is committed by
  the chain's first ticket.
