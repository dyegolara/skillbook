# Kepler local API — the endpoints the pack wraps

The Kepler server exposes a plain HTTP API on loopback, no auth. The helpers
read its address from `~/.kepler-server/data/server.host` and `server.port`
(`readKeplerApiBase()` in
[`../scripts/launch-stage.mjs`](../scripts/launch-stage.mjs)). This surface
is internal to Kepler, not a published contract: everything below was verified
by probe (2026-10-08/10, build 0.12.0); re-verify with the probe
recipe when Kepler's build moves.

## Terminal API — `launch-stage.mjs`

- `GET /terminal/list` → array of terminals; each carries `id`, `label`,
  `worktreePath`, `repoId`, `worktreeId`, `taskId`, `exited`, `closing`,
  `lastActiveAt`. The id source for new terminals.
- `POST /terminal/start` — body: `repoId`, `worktreeId`, `taskId`,
  `worktreePath` (all four required) plus `label`, `shell`, `cols`, `rows`
  (optional) → `{terminalId}`. A missing id gives a SQLite binding error;
  inconsistent ids give "Worktree … does not belong to task …".
- `POST /terminal/input` — body `{terminalId, input}` — types into the
  terminal's bash (a real PTY). Append `\n` to run the line.
- `GET /terminal/buffer?terminalId=…` — the scrollback, returned as a **bare
  JSON string** (not an object): `JSON.parse(body)` yields the raw text with
  ANSI escapes; strip them before grepping.
- `POST /terminal/close` — body `{terminalId}`. (`/terminal/resize` also
  exists on the server surface — unverified here.)

## Agent API — `open-grill-session.mjs`

- `GET /agent/sessions` → sessions; each carries `id`, `adapterId`,
  `worktreePath`, `repoId`, `worktreeId`, `taskId`, `state` (`initialized`,
  `running`, `idle`, `unread`, …), `label`, and `configOptions` — the
  `id: "model"` option's `currentValue`/`options` are the selectable models.
- `POST /agent/sessions` — body: `adapterId` (`"opencode"`), `worktreePath`,
  `repoId`, `worktreeId`, and `taskId` (task sessions) → `{sessionId,
  promptDelivered: false}`. Extra body fields are **ignored** — the label and
  the model never come from this call; they need the two endpoints below.
- `POST /agent/rename-session` — body `{sessionId, name}` — sets the label
  the Kepler UI shows.
- `POST /agent/session-config-option` — body `{sessionId, configId, value}`
  — `configId: "model"` pins the model (verified with `opencode-go/glm-5.3`);
  `configId: "effort"` pins the thought level (verified 2026-10-10 with the
  helper's exact sequence: a fresh session defaults to `effort: "low"`; after
  `model` then `effort: "max"`, GET `/agent/sessions` reports
  `effort.currentValue: "max"` among `low`/`high`/`max`, category
  `thought_level`).
- `POST /agent/send-prompt` — body `{sessionId, prompt}` (also
  `attachments`, `promptId`) — delivers the first prompt; the session
  processes it and then sits waiting on the user.
- `DELETE /agent/session` — **JSON body** `{sessionId}`, not a query param —
  deletes the session row.
- `GET /agent/session-history?sessionId=…` — the session's update stream.

## Probe recipe

The API is not published; these steps verified everything above and will
settle a new endpoint:

1. Unknown paths outside `/api/` fall through to the web app (HTML); unknown
   paths under `/api/` return a JSON 404.
2. `POST` a minimal body and read the validation error — the errors name the
   required fields ("Unknown adapter: undefined" → `adapterId`; "requires
   non-empty worktreePath" → `worktreePath`).
3. The web app's JS bundle lists every REST route the UI knows:

   ```bash
   API="http://$(cat ~/.kepler-server/data/server.host):$(cat ~/.kepler-server/data/server.port)"
   for JS in $(curl -s "$API/" | grep -o 'src="[^"]*\.js"' | sed 's/src="//;s/"//'); do
     curl -s "$API$JS" | grep -oE 'path:`/[-a-z]+[/-a-z]*`' | sort -u
   done
   ```

4. Never assume a create-body field worked — extra fields are silently
   ignored (the label and model on `/agent/sessions`). Verify with the
   corresponding GET or set them through their own endpoint.

## Pinned-model effort caps — probed

Story 20 pins each stage's model at its highest available effort; two pins
carry a cap claim. Both were probed 2026-10-10 (pi 1.1.0, Kepler build
0.12.0) — each pin sits at its model's cap, so no re-pin moved.

**Probe A — pi RPC, the surface the pins run under.** The level is set at
startup, then read back (`--thinking max` asks for the highest; the harness
clamps to what the model exposes):

```bash
printf '{"id":"s1","type":"get_state"}\n{"id":"q1","type":"get_available_thinking_levels"}\n' \
  | pi --mode rpc --no-session --no-tools --provider opencode-go --model opencode-go/mimo-v2.6-pro --thinking max
printf '{"id":"s1","type":"get_state"}\n{"id":"q1","type":"get_available_thinking_levels"}\n' \
  | pi --mode rpc --no-session --no-tools --provider opencode-go --model opencode-go/muse-spark-1.3-contributor --thinking max
```

Observed:

- `mimo-v2.6-pro` (code-review-loop, `--thinking high`) — `get_state` reports
  `"thinkingLevel":"high"`; `get_available_thinking_levels` reports
  `{"levels":["off","minimal","low","medium","high"]}` → `high` is the cap;
  `max` clamps to it.
- `muse-spark-1.3-contributor` (create-pr, `--thinking xhigh`) — `get_state`
  reports `"thinkingLevel":"xhigh"` and the model's
  `"thinkingLevelMap":{"off":null,"minimal":"minimal","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":null}`;
  `get_available_thinking_levels` reports
  `{"levels":["minimal","low","medium","high","xhigh"]}` → `xhigh` is the cap;
  `max` is not exposed.
- Set-then-verify at the pins: the same command with `--thinking high`
  (mimo) and `--thinking xhigh` (muse) reports `"thinkingLevel":"high"` and
  `"thinkingLevel":"xhigh"` — the pinned level is accepted exactly.

**Probe B — Kepler config options (corroboration, recipe above).** A scratch
opencode session, model set, then deleted:

- `muse-spark-1.3-contributor` — after the model set, the `effort` option's
  `options` are `["minimal","low","medium","high","xhigh"]`; setting
  `effort: "xhigh"` verifies as `effort.currentValue: "xhigh"`; setting
  `"max"` returns `{"error":"Invalid params: effort not found: max"}` and
  leaves `xhigh` selected. Corroborates the cap.
- `mimo-v2.6-pro` — after the model set, `configOptions` carry `model` and
  `mode` only: no `effort` option appears, and setting it returns
  `{"error":"Invalid params: effort not found: high"}` (`max` likewise).
  This surface cannot read mimo's cap — probe B is a gap for mimo, recorded
  like `/terminal/resize`; probe A settles it.

Together the probes prove both pins invoke their models at the highest effort
those models expose (spec story 20), so no re-pin was needed.
