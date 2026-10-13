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
  with the packaged helper: `node "<skill-dir>/scripts/launch-stage.mjs"
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
  --thinking <flag> '<thin pointers>'` — under the retry wrapper the
  error-route bullet records, and prints the terminal id. The terminal
  stays open after the stage exits; its buffer is the stage log.
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
  and the fallback is connection-level only. Amended 2026-10-13, after the
  wave-7 review (ticket #100): fresh launches — and the re-entry form,
  which launches dev-flow exactly as the fresh form — wire the decided
  bootstrap flags, whose values come from the grilling session's own Kepler
  metadata (`GET /agent/sessions` filtered by the worktree);
  grill-with-spec remains the one stage holding the ids.
- A stage that fails to run or dies mid-run does not stall the chain
  silently. The injected command is a retry wrapper around the stage's
  pinned agent command — whatever the harness, `pi` is not load-bearing —
  running 5 attempts with exponential backoff (~10 min), the pinned
  command inside unchanged with its explicit pins. The resume command is
  the launch invocation — `cd <worktree> && node "<skill-dir>/scripts/
  launch-stage.mjs" <stage> <spec> '<thin pointers>'` — so a resume
  re-enters the retry wrapper and verified-inject instead of running the
  bare pinned command. On exhaustion the
  wrapper leaves a loud FAILED marker in the terminal buffer (stage,
  spec, the exact resume command) and actuates a wake — an unread
  session on the task carrying that resume command — the same
  no-waiting-on-notice principle as the pause path. A launch that never
  executes is caught by verified-inject: the helper confirms the wrapper
  started after injection and recovers. Decided 2026-10-12, maintainer
  decision (fourth) from run experience: a provider 429 at stage launch
  left the chain parked with no route — the routes are decided by the
  review after it runs, so a stage that never runs fires none. Gaps (i)
  and (ii) are filled (#95, orchestrator steer): the
  execution-verification signal is the wrapper sentinel — the wrapper
  prints `CHAIN-STAGE-START: chain #<spec> <stage>` as its first action
  (before attempt 1), and the helper polls
  `GET /terminal/buffer?terminalId=…`, parsing the bare JSON string and
  stripping ANSI escapes, every 250 ms until the sentinel appears on its
  own line or a 5000 ms timeout elapses (the PTY echoes the injected
  command, so only a standalone line proves execution; a process probe
  has no verified endpoint). The wedge recovery closes the wedged
  terminal (`POST /terminal/close`), relaunches it with the same ids,
  worktree and label (`POST /terminal/start`) and injects the same input
  into the new terminal, bounded to one relaunch; a second timeout, a
  close failure or a start failure is a hard error carrying
  `error.message`. Closing the wedged terminal is what makes the
  no-double-launch guarantee structural: a late first injection cannot
  run a second stage command in a closed terminal. Any
  verification failure that is not a wedge — a buffer-read HTTP error, a
  connection failure to a reachable API, a malformed buffer body — is a
  hard error, not a silent pass. The wake gap is filled (#93): a new
  sibling helper,
  `open-wake-session.mjs`, packaged byte-identically beside
  `launch-stage.mjs` in every launching skill, actuated by the wrapper
  as `node "<skill-dir>/scripts/open-wake-session.mjs" <stage> <spec>
  '<resume command>'` — not a failure mode of `open-grill-session.mjs`,
  because the wake has its own label, prompt and session config and a
  mode flag would couple two routes in one module. It creates an
  opencode session on the task, labels it `chain #<spec>: wake —
  <stage>` (spec and stage are explicit arguments, never parsed from
  another label), and sends the wake prompt — `WAKE NOTICE — this session is
  a notice for the maintainer; do not run any command or tool. The chain
  parked: the <stage> stage gave up on spec #<spec> after its retries. The
  maintainer resumes it with this exact command:` plus the resume command
  verbatim. The notice wording is deliberate: send-prompt starts an agent
  turn, so the prompt forbids tools and names the maintainer as the actor,
  instead of inviting the wake session to resume the chain itself. It pins
  no model or effort: the wake is a notice on the task, not a stage, so
  the pin-every-spawn rule does not reach it. Ids reuse the launch
  helper's anchor and bootstrap flags. A connection-level failure
  before a session exists is the only fallback, and it prints
  `error.message` plus the resume command so it is never lost; every
  failure after the session exists is a hard error carrying its id.
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
  resumes a chain, and in the fresh form once the spec is published: a
  plain bash loop (branch log, fix tickets, chain terminals) refreshed
  every 30 seconds — live progress in the Kepler UI, because
  `pi --print` is silent until a stage finishes. Each stage's transcript
  lives in the pi session files under `~/.pi/agent/sessions/<worktree>`.
  Amended 2026-10-10, maintainer decision on the review of `52f6c84`
  (spec #55 finding S3): the timing was decided "when it starts or
  resumes a chain"; amended to the shipped timing — the label and the
  loop's fix-ticket filter both need the spec number, which exists only
  once `to-spec` publishes, and the fresh form's grilling phase is the
  one interactive stage (the maintainer in the conversation is its live
  view; the headless stages the terminal watches begin after
  publication). Open gaps, left undecided: mid-chain liveness — nothing
  re-launches an exited status terminal between the start/resume
  checkpoints — and the label key assumes one chain per worktree.
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
- **Helper-packaging registry (one source plus a sync step)**: every skill
  folder must ship its helpers runnable as-is in any agentic environment
  (AGENTS.md: "Skills are self-contained"), so the byte-identical copies
  stand and the pack verifier enforces byte identity against the shared
  sources instead — the accepted cost is a helper fix hand-applied across
  the copies, with drift caught only when `verify` runs.

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
