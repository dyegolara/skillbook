# 0009 — The observability surface is a separate read-only server

**Status**: Accepted

**Context**: The operator needs to see what the watchdog is doing and what comes
next, and other local processes need to read the same view. The Listener already
speaks HTTP — `GET /healthz` and `POST /github/webhook` — so the state routes
look like they belong next to it.

**Decision**:

- The REST surface is a separate read-only process that reads the persisted
  state (`state.json`, `listener-state.json`) and serves `GET /health`,
  `GET /timeline`, `GET /flows` and `GET /flows/:owner/:repo/:num` on loopback.
- It holds no state of its own and issues no write: the watchdog stays the only
  writer. The view is a projection of what is already on disk.
- The TUI is a client of that same contract and ships in the same private
  package; it draws the Stage sequence with colour.

## Rejected options

- **Routes inside the Listener**: rejected — the Listener is ephemeral
  (`maybeExit()` closes it when no Flow is open) and absent entirely under tick
  and cron, so the view would vanish exactly when the operator most needs it.
- **A shared in-process state object**: rejected — a Tick is a one-shot
  process; there is nothing long-lived to share with.

## Consequences

- The view works under tick, cron, listener and daemon alike.
- `next_check_at` has to become persisted state. Today it only appears in the
  Tick report and the Listener turns it into an Expectation, so without
  persisting it the `schedule` Stage cannot show what comes next outside the
  Listener.
- One more process to run. It is optional: the watchdog works without it.
