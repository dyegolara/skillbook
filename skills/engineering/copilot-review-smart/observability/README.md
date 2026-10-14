# @skillbook/pr-monitor-observability

The read-only observability API for the copilot-review-smart skill. It
projects the watchdog's persisted state on loopback, so other local processes
— the TUI, a cron health check, an agent — can read the loop without touching
the watchdog or its files.

It is a separate process on purpose (ADR 0009): the Listener is ephemeral and
absent entirely under tick and cron, so state routes inside it would vanish
exactly when the view is needed. This server reads `state.json` and
`listener-state.json` on every request, holds no state of its own and never
writes — no state-file writes, no Tick or Listener spawning. It answers with
the last known state whether or not any watchdog process is running.

## Start

```bash
node pr_monitor_observability.mjs
# or, from inside this package:
npm start
```

It prints the bound URL and listens on `http://127.0.0.1:8788` by default.

| Setting | Flag | Env | Default |
|---|---|---|---|
| Bind host | `--host` | `PR_MONITOR_OBSERVABILITY_HOST` | `127.0.0.1` (loopback only; a non-loopback host is refused) |
| Bind port | `--port` | `PR_MONITOR_OBSERVABILITY_PORT` | `8788` |
| Tick state | `--state` | `PR_MONITOR_STATE_PATH` | `~/.cache/pr-monitor/state.json` |
| Listener state | `--listener-state` | `PR_MONITOR_WEBHOOK_STATE_PATH` | `~/.cache/pr-monitor/listener-state.json` |
| Listener pid | `--pid` | `PR_MONITOR_WEBHOOK_PID_PATH` | `~/.cache/pr-monitor/listener.pid` |

Zero dependencies beyond Node (`node:http`); plain ESM. The watchdog core
imports nothing from this package; this package imports no watchdog module
that carries process state. The Tick's liveness rule (`tickInFlight`) and
`isPidAlive` live in the dependency-free `tick_liveness.mjs` at the skill
root, which both the Tick and this package import. The canonical
`decision_source` vocabulary comes from `decision_source.mjs`, another pure
constant module, and the gate-wait matcher from `decision.mjs` (pure: no
process state, no env reads).

## TUI

The coloured terminal client of the same contract ships in this package:

```bash
node pr_monitor_tui.mjs        # from the skill root
npm run tui                    # or, from inside this package
```

It polls `GET /timeline` and `GET /flows` every 2s by default and redraws one
frame: a header with the loop's tick timeline (done, in-flight, scheduled and
the next check) and one line per watched PR with its Stage sequence in
glossary order — past green, current bold yellow, next grey — then the
terminal outcome in the glossary's words. It never reads the state files: the
API is the only seam. With the API down it names the URL, says what to start
and keeps retrying; Ctrl-C exits cleanly.

| Setting | Flag | Env | Default |
|---|---|---|---|
| API base URL | `--url` | `PR_MONITOR_OBSERVABILITY_URL` | built from the host/port below |
| Refresh | `--interval` | `PR_MONITOR_TUI_INTERVAL_MS` | `2000` ms |
| One frame | `--once` | — | off |
| Colour | `--color` / `--no-color` | `NO_COLOR` | auto on a TTY |

Zero dependencies; ANSI colour is hand-rolled over `node:*`.

## Routes

GET only; any other verb answers `405` with `Allow: GET`, any unknown path or
unknown PR answers `404`. No version prefix.

### `GET /health`

The Listener's health shape, projected from disk:

```json
{
  "status": "ok",
  "pid": 12345,
  "started_at": "2026-09-08T00:00:00.000Z",
  "last_delivery": null,
  "tracked_flows": ["owner/repo#7"],
  "pending_expectations": ["owner/repo#7"]
}
```

Liveness evidence is the Listener pid file plus pid liveness — the one
on-disk artifact that survives a crash (`claimPidFile` writes it at start,
`removePidFile` removes it on a graceful exit):

- `status: "ok"` — a pid file names a live process.
- `status: "dead"` — a pid file names a process that is gone (crash or kill).
- `status: "absent"` — no usable pid file: the Listener never started here, or
  stopped gracefully.

`started_at` is the pid file's mtime, the closest on-disk evidence of the
Listener's start. `last_delivery` is in-memory in the live Listener and is not
persisted anywhere, so the projection reports `null`. `tracked_flows` is every
Flow either state file knows, and `pending_expectations` is the armed
Expectations persisted in `listener-state.json` — the last known set when the
Listener is not running.

### `GET /timeline`

```json
{
  "now": "2026-09-08T00:00:00.000Z",
  "executed": [
    { "key": "owner/repo#7", "repo": "owner/repo", "pr": 7, "ts": "…",
      "action": "request_review", "reason": "…", "terminal": null,
      "decision_source": "decision_command" }
  ],
  "in_flight": { "pid": 12345, "started_at": "…", "heartbeat_at": "…", "alive": true },
  "scheduled": [
    { "key": "owner/repo#7", "repo": "owner/repo", "pr": 7,
      "deadline_at": "…", "source": "expectation", "overdue": false,
      "origin": "tick_report", "backoff_index": 0 }
  ]
}
```

- `executed` is every persisted Tick outcome, oldest first, tagged with its
  Flow.
- `in_flight` is the run-level `tick_in_flight` marker filtered through the
  shared `tickInFlight` liveness rule (`tick_liveness.mjs`): `alive` is true only while the recorded pid
  exists and the heartbeat is fresh; a crashed Tick reads `alive: false`, and
  no marker reads `null`. The marker is run-level, so it names no Flow.
- `scheduled` is the armed Expectations with their deadlines, plus a persisted
  `next_check_at` only where no Expectation is armed for that Flow; sorted by
  deadline. `overdue` compares the deadline with the server's clock.

### `GET /flows`

One summary row per watched PR, sorted by key. Each row contains `key`, `head_sha`,
`stage`, `action`, `reason`, `next_check_at`, and `terminal`, plus `repo`, `pr`
and the shared `stages` projection:

```json
{
  "key": "owner/repo#7",
  "repo": "owner/repo",
  "pr": 7,
  "head_sha": "abc123",
  "stage": "schedule",
  "stages": [
    { "stage": "collect", "status": "past", "outcome": "PR state collected", "at": "…" },
    { "stage": "check", "status": "past", "outcome": "deterministic gates passed", "at": "…" },
    { "stage": "reuse", "status": "past", "outcome": "signature cache checked", "at": "…" },
    { "stage": "decide", "status": "past", "outcome": "decision made by decision_command", "at": "…" },
    { "stage": "act", "status": "past", "outcome": "asked Copilot to review", "at": "…" },
    { "stage": "schedule", "status": "current", "outcome": "next check at …", "at": "…" }
  ],
  "action": "request_review",
  "reason": "…",
  "next_check_at": "…",
  "terminal": null
}
```

### `GET /flows/:owner/:repo/:num`

The same summary row plus `done`, `tick_history` (the persisted records, oldest
first) and `expectation` (the armed Expectation with `deadline_at`, `origin`,
`backoff_index`, `overdue`; `null` when none). The detail route is the only Flow
route that includes those detail fields.
An unknown PR answers `404 {"error": "unknown flow"}`.

## Stage projection

The persisted state does not record per-Stage progress. The evidence is the
per-Flow `tick_history` (each record: `ts`, `action`, `reason`, `terminal`,
optional `decision_source`), `next_check_at`, and the armed Expectation's
deadline. The projection reports the six Stages in the glossary order
`collect → check → reuse → decide → act → schedule`, each `past`, `current` or
`next`, with an `outcome` and the latest Tick's `ts` as `at`. A Stage that has
not run (`next`) carries `null` for both.

A Stage is `past` when the latest Tick record proves it ran:

| Latest Tick record | Proven past, beyond `collect` and `check` |
|---|---|
| `action: skip_wip` | — (the draft/WIP gate decided) |
| `action: request_rebase` | `act` (the conflict gate decided; cache and LLM skipped) |
| `action: request_review`, `request_fix`, `notify_ready`, `llm_failed` | `reuse`, `decide`, `act` |
| `action: wait`, gate reason (conflict window, rebase budget, unknown mergeability) | — (the gate held before the cache) |
| `action: wait`, any other reason | `reuse`; plus `decide` only when a non-`none` `decision_source` proves a decision ran |
| `action: wait`, `decision_source: none` (no LLM configured) | `reuse`; `decide` stays `current` — a configuration gap waiting for setup, never a completed decision |
| `action: wait`, `terminal: needs-human` | plus `act` (the escalation notification) |
| recognized PR-state collection failure reason | `collect` only |

`collect` and `check` are past for every other persisted Tick: a record's
action could only be produced after the deterministic gates. Stages that the
latest Tick skipped stay `next` — the sequence can therefore alternate, which
is the honest reading of a deterministic-gate Tick.

The schedule Stage is handled separately because every persisted Tick writes
its `next_check_at`:

- `current` for any Flow that is not closed: the loop is between Ticks and
  holds the deadline. The outcome names the effective deadline (Expectation
  first, then persisted `next_check_at`) or reads "quiescent — only a Delivery
  wakes the Flow" when none is armed.
- `past` only when the Flow closed at All-clear (`notify_ready`, `terminal:
  done`) and no deadline is armed — in that case every Stage is `past` and the
  row's `stage` is `null`.

Stage outcomes are fixed strings: `collect` ("PR state collected" /
"PR state collection failed"), `check` ("deterministic gates passed",
"draft/WIP — skipped", the conflict-policy label, or "gate held: …"), `reuse`
("signature cache checked"), `decide` ("decision made by <adapter>",
"LLM decision made", "LLM decision failed" (or "LLM decision failed; retry
scheduled"), or "no decision source configured
— waiting for setup (PR_MONITOR_LLM_CMD or PR_MONITOR_LLM_API_KEY)"), `act` (the action taken, or
"escalated to owner", or "no action taken"), and `schedule` as above.

### Terminal outcomes

`/flows` and `/flows/:owner/:repo/:num` report only the glossary's words, and
never report `waiting` as terminal:

| Latest Tick record | `terminal` | `done` |
|---|---|---|
| `terminal: done`, `action: notify_ready` | `All-clear / Notify-ready` | `true` when no deadline is armed |
| `terminal: needs-human`, conflict pings exhausted for the current head | `Stuck PR` | `false` |
| `terminal: needs-human`, otherwise | `Needs-human` | `false` |
| `terminal: done` with any other action (PR closed or merged) | `null` — a Flow closure, not a decision outcome | `true` when no deadline is armed |
| `terminal: skipped`, `null`, or any other | `null` | `false` |

A Flow whose next check is armed is never `done`, because `done` requires the
last Tick to be `done` and no deadline to be armed.

## Tests

```bash
node --test test/     # or: npm test
```

`node --test` discovers the suite in this package; `test/package.json` is a
directory entry so `node --test test/` works on Node versions that do not
expand directory arguments. The suite writes fixture state files to a temp
dir and starts the server on an ephemeral loopback port; it asserts the four
routes and their payloads, the refusal of other verbs and paths, loopback
binding, byte-identical state files before and after a full pass (hashed),
answering with no watchdog process running, live versus dead/absent health,
and the one-command CLI start.

`test/tui.test.mjs` renders the TUI frame from the same fixture server —
Stage colours and ANSI sequences included, without a real TTY — runs the live
refresh loop against it, asserts Ctrl-C exits `0` and that an unreachable API
prints the actionable message and keeps retrying. A `node:fs` audit preloaded
into the TUI process proves it never opens the state files.
