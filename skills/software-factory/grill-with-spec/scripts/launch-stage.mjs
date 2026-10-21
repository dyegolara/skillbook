#!/usr/bin/env node
/**
 * launch-stage.mjs — launch a software-factory chain stage.
 *
 * Per ADR-0006 (amended 2026-10-10) a finishing stage launches the next one
 * in a visible Kepler terminal: the helper derives the terminal's
 * repo/worktree/task ids from an existing terminal on the same worktree
 * (`GET /terminal/list`, preferring a chain-labeled one) or from explicit
 * `--repo-id/--worktree-id/--task-id` flags — the fresh-run bootstrap, where
 * grill-with-spec is the one stage holding the ids. It creates a terminal
 * labeled `chain #<spec>: <stage>` with the spec number taken from the
 * explicit argument (never parsed from another label), injects the stage's
 * pinned command under the retry wrapper — 5 attempts with doubling backoff
 * (40s/80s/160s/320s, a 10-minute give-up window), the pinned command
 * unchanged inside — and prints the terminal id. The wrapper's first action
 * is a stable sentinel line, `CHAIN-STAGE-START: chain #<spec> <stage>`;
 * the helper's post-injection check polls `GET /terminal/buffer` for it (the
 * bare JSON string, ANSI escapes stripped, on its own line — the PTY echo of
 * the injected command carries the same text mid-line and is not proof of
 * execution)
 * every 250 ms for up to 5000 ms. A timed-out wait is a wedge: the helper
 * closes the wedged terminal, relaunches it with the same ids/worktree/label
 * and injects the same input into the new terminal, then re-verifies; a
 * second timeout, a close failure or a start failure is a hard error carrying
 * `error.message`. Closing the wedged terminal is what makes the
 * no-double-launch guarantee structural — a late first injection cannot run
 * a second stage command in a closed terminal. On exhaustion the
 * wrapper prints the FAILED marker (stage, spec, the exact resume command —
 * the launch-helper invocation, so a resume re-enters the retry wrapper and
 * the helper's post-injection check, never the bare pinned command)
 * into the buffer and actuates the sibling wake helper; the terminal stays
 * open after the stage exits, and its buffer is the stage log. The detached
 * `nohup` fallback fires only on a connection-level failure to the terminal
 * API — never after `POST /terminal/start` succeeded, so a reachable API
 * never silently degrades — and it preserves `error.message` while reporting
 * which path it took; it launches the pinned command unwrapped.
 *
 * Plain ESM per ADR-0002, zero dependencies beyond Node.
 *
 * Usage:
 *   node skills/software-factory/scripts/launch-stage.mjs <stage> <spec> '<pointers>'
 *     [--repo-id <id> --worktree-id <id> --task-id <id>]
 */
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentCommand,
  resolveAgent,
  resolveEffort,
  resolveKey,
  resolveModel,
  resolveProvider,
  stageKey,
} from "./env-defaults.mjs";

export const KEPLER_DATA_DIR = join(homedir(), ".kepler-server", "data");

/**
 * The stage's resolved pins: `DEV_ENV_PROVIDER` (global) plus the stage's
 * `DEV_ENV_MODEL_<STAGE>`, `DEV_ENV_EFFORT_<STAGE>` and `DEV_ENV_AGENT_<STAGE>`,
 * each falling back to `env-defaults.mjs`'s `DEFAULTS`. With no `DEV_ENV_*`
 * set every value is today's pin. An unknown stage is a hard error before any
 * environment is read.
 */
export function stagePin(stage, env = process.env) {
  const key = stageKey(stage);
  return {
    provider: resolveProvider(env),
    model: resolveModel(key, env),
    effort: resolveEffort(key, env),
    agent: resolveAgent(key, env),
  };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// The shell-safe token set: command names and flag values (model ids, effort
// levels, `key=value` configs) stay unquoted in the injected command; anything
// else — pointers above all — is single-quoted. The default pins all pass, so
// their command is byte-identical to the old fixed-pin string.
const SHELL_SAFE_TOKEN = /^[\w@%+=:,./-]+$/;

function shellToken(value) {
  const text = String(value);
  return SHELL_SAFE_TOKEN.test(text) ? text : shellQuote(text);
}

/** Join an agent argv into the shell command, always quoting the pointers. */
function argvCommand(argv) {
  return [...argv.slice(0, -1).map(shellToken), shellQuote(argv.at(-1))].join(" ");
}

/**
 * The stage's provider key, resolved as the launch preflight: the provider's
 * own variable, set and non-empty after trim, is the key; a missing key is
 * `resolveKey`'s hard error naming the provider and the variable to set. The
 * check is unconditional — no opt-in gate — and happens before any fetch or
 * spawn. Nothing is injected: the environment carries the key under the
 * provider's own variable, so the launched stage inherits it already paired
 * with the resolved provider (ADR-0006, amended 2026-10-21).
 *
 * The named seam is kept deliberately, not as an accidental delegate: the
 * stage-level preflight reads as "resolve the stage's key", and this docblock
 * is the one place the unconditional-before-any-fetch/spawn contract lives.
 * `resolveKey` is the provider-key primitive; inlining it would move that
 * contract back into the launch path.
 */
export function resolveStageKey(provider, env = process.env) {
  return resolveKey(provider, env);
}

/**
 * The stage's pinned command, built through the resolved agent's
 * `AGENT_COMMANDS` row (`buildAgentCommand`) and shell-quoted for injection.
 * With no `DEV_ENV_*` set the resolved pins are today's defaults, so the
 * string is byte-identical to the old fixed-pin command. The command never
 * carries a key or a variable prefix: whether the provider's key resolves or
 * not, the string is the same — the key check is `resolveStageKey`'s preflight
 * and the environment passes the key to the launched stage.
 */
export function buildStageCommand(stage, pointers, env = process.env) {
  const pin = stagePin(stage, env);
  return argvCommand(
    buildAgentCommand(pin.agent, {
      provider: pin.provider,
      model: pin.model,
      effort: pin.effort,
      pointers,
    })
  );
}

/**
 * The retry wrapper's parameters: five attempts with a doubling backoff whose
 * four sleeps sum to 600 seconds — a ten-minute give-up window. Explicit, not
 * jittered, so a stage launch is deterministic.
 */
export const RETRY_ATTEMPTS = 5;
export const RETRY_SLEEPS_SECONDS = [40, 80, 160, 320];

/**
 * The post-injection check's parameters: the wrapper prints the sentinel as
 * its first action, and the helper polls the terminal buffer every 250 ms for
 * up to 5000 ms before calling the launch wedged. A timed-out wait closes the
 * wedged terminal and relaunches it with the same input exactly once; a
 * second timeout is a hard error. Explicit, like the retry schedule, so the
 * behaviour is deterministic.
 */
export const SENTINEL_PREFIX = "CHAIN-STAGE-START:";
export const VERIFY_POLL_INTERVAL_MS = 250;
export const VERIFY_TIMEOUT_MS = 5000;
export const VERIFY_MAX_RELAUNCHES = 1;

/**
 * The `chain #<spec> <stage>` core, built by the two emitted shapes that use
 * it: the sentinel (`CHAIN-STAGE-START: chain #N S`) and the FAILED marker
 * (`FAILED: chain #N S gave up after N attempts`).
 */
export function chainCore(spec, stage) {
  return `chain #${specNumber(spec)} ${stage}`;
}

/** The `chain #<spec>: <stage>` terminal label — the second named shape. */
export function chainLabel(spec, stage) {
  return `chain #${specNumber(spec)}: ${stage}`;
}

/**
 * The execution sentinel the wrapper prints before attempt 1. It is the
 * stable string the helper greps the terminal buffer for; the PTY's echo of
 * the injected command contains it too, so only a standalone line counts as
 * execution (see `sentinelSeen`).
 */
export function stageSentinel(spec, stage) {
  return `${SENTINEL_PREFIX} ${chainCore(spec, stage)}`;
}

/**
 * The sentinel line, as the wrapper prints it. The injected command itself
 * carries the sentinel text mid-line and the PTY echoes it, so a substring
 * match would read a wedged injection as a started stage; only a line that is
 * exactly the sentinel (after ANSI stripping and carriage-return trimming)
 * proves the wrapper executed.
 */
export function sentinelSeen(buffer, sentinel) {
  return String(buffer)
    .split("\n")
    .some((line) => line.replace(/\r$/, "").trim() === sentinel);
}

// CSI sequences (colors, cursor movement) and OSC sequences (terminal title).
const ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/g;

/** Strip the terminal's ANSI escapes so buffer lines can be matched as text. */
export function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, "");
}

/**
 * The wedge signal: the sentinel wait timed out, so the helper's
 * post-injection check relaunches once.
 */
export class SentinelTimeoutError extends Error {
  constructor({ terminalId, sentinel, timeoutMs, relaunched }) {
    super(
      `terminal ${terminalId} did not show "${sentinel}" within ${timeoutMs}ms` +
        (relaunched ? " after one relaunch" : "") +
        " — the stage launch is wedged"
    );
    this.name = "SentinelTimeoutError";
    this.code = "STAGE_SENTINEL_TIMEOUT";
  }
}

export function isSentinelTimeout(error) {
  return error?.code === "STAGE_SENTINEL_TIMEOUT";
}

/** The real poll interval; tests inject a no-op sleep to run the loop instantly. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the terminal's scrollback: `GET /terminal/buffer` returns the text as a
 * bare JSON string with ANSI escapes. A non-string body is a hard error — an
 * empty or malformed read must never pass as "sentinel absent" and trigger a
 * relaunch against a terminal the helper cannot actually see.
 */
export async function readTerminalBuffer({ apiBase, fetchImpl = fetch, terminalId }) {
  const body = await requestJson(
    fetchImpl,
    `${apiBase}/terminal/buffer?terminalId=${encodeURIComponent(terminalId)}`
  );
  if (typeof body !== "string") {
    throw new Error(`Kepler terminal buffer for ${terminalId} was not a JSON string`);
  }
  return stripAnsi(body);
}

/**
 * Poll the terminal buffer until the executed sentinel appears, then return.
 * The first read is immediate; each later read follows one poll interval, up
 * to the timeout's worth of polls. A timed-out wait throws
 * `SentinelTimeoutError` — the one failure the helper's post-injection check
 * treats as a wedge.
 * Every other failure (HTTP error, connection failure, malformed body) is a
 * hard error and propagates.
 */
export async function waitForSentinel({
  apiBase,
  fetchImpl = fetch,
  terminalId,
  sentinel,
  timeoutMs = VERIFY_TIMEOUT_MS,
  pollIntervalMs = VERIFY_POLL_INTERVAL_MS,
  sleepImpl = sleep,
  relaunched = false,
}) {
  const polls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let poll = 0; poll < polls; poll += 1) {
    if (poll > 0) await sleepImpl(pollIntervalMs);
    const buffer = await readTerminalBuffer({ apiBase, fetchImpl, terminalId });
    if (sentinelSeen(buffer, sentinel)) return buffer;
  }
  throw new SentinelTimeoutError({ terminalId, sentinel, timeoutMs, relaunched });
}

/** The sibling wake helper, resolved from this module's own installed location. */
export function wakeHelperPath() {
  return fileURLToPath(new URL("./open-wake-session.mjs", import.meta.url));
}

/** This launch helper's installed path — the resume command re-enters through it. */
export function launchHelperPath() {
  return fileURLToPath(new URL("./launch-stage.mjs", import.meta.url));
}

/**
 * The resume command the give-up marker and the wake carry: re-enter this
 * protected route — the launch helper from the stage's worktree — so a resume
 * runs under the retry wrapper and the helper's post-injection check, never
 * the bare pinned command.
 */
export function buildResumeCommand({ stage, spec, pointers, worktreePath }) {
  return `cd ${shellQuote(worktreePath)} && node ${shellQuote(launchHelperPath())} ${stage} ${spec} ${shellQuote(pointers)}`;
}

/**
 * The retry wrapper injected into the stage terminal: the sentinel's line
 * before attempt 1, then the pinned command, whatever the harness, attempted
 * up to `RETRY_ATTEMPTS` times with exponential backoff. On exhaustion it
 * prints the FAILED marker — stage, spec and the exact resume command, one
 * greppable line each — into the terminal buffer (the stage log), then
 * actuates the wake by running the sibling helper; the wake's output and
 * exit status are never swallowed. The pinned command inside stays unchanged;
 * the resume command is the launch-helper invocation, so a resume re-enters
 * the retry wrapper and the helper's post-injection check. The command is
 * the stage's resolved pins, whatever its agent, because every pin resolves
 * from `env-defaults.mjs` plus `DEV_ENV_*`.
 */
export function buildRetryWrapper(stage, spec, pointers, worktreePath, env = process.env) {
  const command = buildStageCommand(stage, pointers, env); // the stage's pinned command, unchanged inside
  const sentinel = stageSentinel(spec, stage); // the first action, before attempt 1
  const resumeCommand = buildResumeCommand({ stage, spec, pointers, worktreePath });
  const marker = [
    `FAILED: ${chainCore(spec, stage)} gave up after ${RETRY_ATTEMPTS} attempts`,
    `FAILED: resume with: ${resumeCommand}`,
  ];
  const sleepCases = RETRY_SLEEPS_SECONDS.map((seconds, index) => `${index + 1}) sleep ${seconds};;`).join(" ");
  return (
    `printf '%s\\n' ${shellQuote(sentinel)}; ` +
    `chain_attempt=1; chain_status=0; while [ "$chain_attempt" -le ${RETRY_ATTEMPTS} ]; do ` +
    `${command}; chain_status=$?; [ "$chain_status" -eq 0 ] && break; ` +
    `case "$chain_attempt" in ${sleepCases} esac; ` +
    "chain_attempt=$((chain_attempt+1)); done; " +
    `if [ "$chain_status" -ne 0 ]; then ` +
    `printf '%s\\n' ${marker.map(shellQuote).join(" ")}; ` +
    `node ${shellQuote(wakeHelperPath())} ${stage} ${spec} ${shellQuote(resumeCommand)}; fi`
  );
}

export function buildTerminalInput(stage, spec, pointers, worktreePath, env = process.env) {
  return `${buildRetryWrapper(stage, spec, pointers, worktreePath, env)}\n`;
}

/** The packaged helpers' name for the label shape; delegates to `chainLabel`. */
export function stageLabel(spec, stage) {
  return chainLabel(spec, stage);
}

/** The one spec-number guard: the label, the sentinel and the FAILED marker all carry it. */
function specNumber(spec) {
  const text = String(spec ?? "");
  if (!/^\d+$/.test(text)) {
    throw new Error(`spec must be a number — got "${spec}"`);
  }
  return text;
}

export function readKeplerApiBase({ dataDir = KEPLER_DATA_DIR } = {}) {
  const host = readFileSync(join(dataDir, "server.host"), "utf8").trim();
  const port = readFileSync(join(dataDir, "server.port"), "utf8").trim();
  if (host === "" || port === "") {
    throw new Error(`Kepler server host/port missing in ${dataDir}`);
  }
  return `http://${host}:${port}`;
}

const CHAIN_LABEL = /^chain #\d+: /;
const ID_FLAG_HINT = "--repo-id/--worktree-id/--task-id";

// The bootstrap flags, and the one place the three field names are spelled:
// `toIdFlags` reads them from this table to construct the named triple.
const ID_FIELD_BY_FLAG = {
  "--repo-id": "repoId",
  "--worktree-id": "worktreeId",
  "--task-id": "taskId",
};

/**
 * The bootstrap flags as given: the three named fields travel together, so
 * each is `undefined` only when no flags were passed at all.
 *
 * @typedef {Object} IdFlags
 * @property {string|undefined} repoId
 * @property {string|undefined} worktreeId
 * @property {string|undefined} taskId
 */

/**
 * The repo/worktree/task id triple identifying the task a stage acts on.
 * Every triple is built by `toIdFlags`; a resolved triple is fully populated
 * before any launch.
 *
 * @typedef {Object} TaskIds
 * @property {string} repoId
 * @property {string} worktreeId
 * @property {string} taskId
 */

/**
 * Construct the named triple from a bootstrap flags object or an anchor
 * terminal entry: exactly the three fields, strangers discarded. A missing
 * field stays `undefined`.
 *
 * @param {IdFlags|TaskIds|Object} source
 * @returns {IdFlags}
 */
function toIdFlags(source) {
  return Object.fromEntries(Object.values(ID_FIELD_BY_FLAG).map((field) => [field, source?.[field]]));
}

/**
 * The 0-or-3 rule: all three bootstrap flags together, or none. A partial
 * set is a hard usage error. `parseIdFlags` and `resolveIds` share this one
 * guard, so the rule and its message live in one place.
 *
 * @param {IdFlags} ids
 */
function assertCompleteIdFlags(ids) {
  const present = Object.values(ids).filter((value) => value !== undefined);
  if (present.length !== 0 && present.length !== 3) {
    throw new Error(`id flags must be given together: ${ID_FLAG_HINT}`);
  }
}

/**
 * Pick the terminal whose repo/worktree/task ids the new terminal reuses: a
 * chain-labeled entry on the same worktree is preferred (task-correctness),
 * any other entry on that worktree is accepted, and an unrelated worktree is
 * ignored. Returns the chosen entry or null.
 */
export function pickAnchor(terminals, worktreePath) {
  const onWorktree = (terminals ?? []).filter((entry) => entry && entry.worktreePath === worktreePath);
  const chain = onWorktree.find((entry) => CHAIN_LABEL.test(String(entry.label ?? "")));
  return chain ?? onWorktree[0] ?? null;
}

/**
 * Parse the fresh-run bootstrap ids from argv. All three flags together or
 * none: a partial set is a hard usage error. Returns an `IdFlags` value with
 * the three keys present — undefined when no flags were given.
 *
 * @returns {IdFlags}
 */
export function parseIdFlags(argv = []) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const field = ID_FIELD_BY_FLAG[argv[i]];
    if (!field) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${argv[i]}`);
    }
    if (flags[field] !== undefined) {
      throw new Error(`duplicate ${argv[i]}`);
    }
    flags[field] = value;
    i += 1;
  }
  const ids = toIdFlags(flags);
  assertCompleteIdFlags(ids);
  return ids;
}

/** A failure to reach the terminal API at the connection level. */
export class ConnectionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ConnectionError";
    this.code = "TERMINAL_API_UNREACHABLE";
  }
}

export function isConnectionError(error) {
  return error?.code === "TERMINAL_API_UNREACHABLE";
}

export async function requestJson(fetchImpl, url, init) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (cause) {
    throw new ConnectionError(cause?.message ?? String(cause), { cause });
  }
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} -> HTTP ${response.status}`);
  }
  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw new ConnectionError(cause?.message ?? String(cause), { cause });
  }
  return text === "" ? null : JSON.parse(text);
}

/**
 * Resolve the repo/worktree/task ids: explicit flags win, otherwise derive
 * them from an anchor terminal on the worktree. Throws a clear error when
 * neither yields ids. Connection-level failures are tagged so callers can
 * classify them; every other failure is a hard error.
 *
 * @param {{ apiBase: string, fetchImpl?: typeof fetch, worktreePath: string, flags?: IdFlags }} options
 * @returns {Promise<TaskIds>}
 */
export async function resolveIds({ apiBase, fetchImpl = fetch, worktreePath, flags = {} }) {
  const explicit = toIdFlags(flags);
  assertCompleteIdFlags(explicit);
  if (Object.values(explicit).some((value) => value !== undefined)) return explicit;

  const terminals = await requestJson(fetchImpl, `${apiBase}/terminal/list`);
  const anchor = pickAnchor(terminals, worktreePath);
  if (!anchor) {
    throw new Error(`no terminal on ${worktreePath} and no ${ID_FLAG_HINT} flags — cannot derive ids`);
  }
  // The anchor is an external `GET /terminal/list` entry: construct it like
  // every other triple.
  return toIdFlags(anchor);
}

/**
 * Reach the API: resolve the base location, then the ids, classifying only
 * connection-level failures. Returns `{ ok: true, apiBase, ids }` on the
 * resolved path, or `{ ok: false, error }` when the API is unreachable — the
 * caller maps that to its own fallback. A reachable API with a bad response
 * (HTTP error, malformed body, anchorless hard error) is a hard error and
 * propagates, so no caller degrades silently against a live server.
 *
 * @param {{ apiBase?: string, dataDir?: string, fetchImpl?: typeof fetch, worktreePath: string, flags?: IdFlags }} options
 * @returns {Promise<{ ok: true, apiBase: string, ids: TaskIds } | { ok: false, error: Error }>}
 */
export async function reachApi({ apiBase, dataDir, fetchImpl = fetch, worktreePath, flags }) {
  let resolvedBase;
  try {
    resolvedBase = apiBase ?? readKeplerApiBase({ dataDir });
  } catch (error) {
    return { ok: false, error }; // the API location is unknown: connection-level
  }

  let ids;
  try {
    ids = await resolveIds({ apiBase: resolvedBase, fetchImpl, worktreePath, flags });
  } catch (error) {
    if (!isConnectionError(error)) throw error; // reachable API, bad response: hard error
    return { ok: false, error };
  }

  return { ok: true, apiBase: resolvedBase, ids };
}

/**
 * The shared hard-error report for the two session routes (`open-grill-session`
 * and `open-wake-session`): the route's tool name and the error's message,
 * plus the created session's id when the failure happened after the session
 * existed — so nothing is lost silently. The tool name is the routes' one
 * difference; the shape lives here once.
 */
export function failureLines(toolName, error) {
  const lines = [`${toolName}: ${error.message}`];
  if (error.sessionId) {
    lines.push(`${toolName}: session ${error.sessionId} was already created — terminate it or reuse it`);
  }
  return lines;
}

/**
 * The shared session-create orchestration for the two session routes (the
 * grill's pin step and the wake's plain create): create an opencode session on
 * the task, rename it to the route's label, run the route's optional pre-send
 * step, then send the route's prompt. The route-specific pieces are exactly
 * the label, the prompt and `beforeSend` — the routes keep those in their own
 * modules (ADR-0006's route separation). A create response without a
 * sessionId is a hard error before any session exists; every failure after
 * creation carries the session's id (`error.sessionId`) and is a hard error,
 * so a caller must never fall back once a session exists.
 *
 * @param {{ label: string, prompt: string, beforeSend?: (sessionId: string) => Promise<void>, ids: TaskIds, worktreePath: string, apiBase: string, fetchImpl?: typeof fetch, adapterId?: string }} options
 * @returns {Promise<{ sessionId: string, label: string }>}
 */
export async function createLabeledSession({
  label,
  prompt,
  beforeSend,
  ids,
  worktreePath,
  apiBase,
  fetchImpl = fetch,
  adapterId = "opencode",
}) {
  const created = await requestJson(fetchImpl, `${apiBase}/agent/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adapterId, worktreePath, ...ids }),
  });
  const sessionId = created?.sessionId;
  if (!sessionId) throw new Error("Kepler agent session start returned no sessionId");

  try {
    await requestJson(fetchImpl, `${apiBase}/agent/rename-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, name: label }),
    });
    if (beforeSend) await beforeSend(sessionId);
    await requestJson(fetchImpl, `${apiBase}/agent/send-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, prompt }),
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    error.sessionId = sessionId;
    throw error;
  }

  return { sessionId, label };
}

/**
 * The shared shell for the two session routes (`open-grill-session` and
 * `open-wake-session`): reach the agent API, create the route's labeled
 * session through its own `create` step, emit the route's success line or its
 * fallback lines, and never fall back once a session exists. The route keeps
 * its label, prompt, create step, fallback path/extra and line texts (the
 * route separation of ADR-0006); the twin `openXSession → reachApi → create →
 * fallback` shape lives here once. Emission goes through `deps.write`, like
 * the launch path's injection.
 *
 * @param {{
 *   label: string,
 *   prompt: string,
 *   create: (context: { label: string, prompt: string, ids: TaskIds, worktreePath: string, apiBase: string, fetchImpl: typeof fetch }) => Promise<{ sessionId: string, label: string }>,
 *   flags?: IdFlags,
 *   deps?: Object,
 *   fallbackPath?: string,
 *   fallbackExtra?: Object,
 *   successLine: (result: { label: string, sessionId: string }) => string,
 *   fallbackLines: (result: { label: string, reason: string }) => string[],
 * }} options
 * @returns {Promise<{ path: string, label: string, sessionId?: string, reason?: string }>}
 */
export async function runSessionHelper({
  label,
  prompt,
  create,
  flags,
  deps = {},
  fallbackPath = "fallback",
  fallbackExtra = {},
  successLine,
  fallbackLines,
}) {
  const { fetchImpl = fetch, worktreePath = process.cwd() } = deps;
  const write = deps.write ?? ((line) => process.stdout.write(`${line}\n`));
  const fallback = (error) => ({ path: fallbackPath, label, reason: error.message, ...fallbackExtra });
  const emit = (result) => {
    if (result.path === "api") write(successLine(result));
    else for (const line of fallbackLines(result)) write(line);
    return result;
  };

  const reached = await reachApi({ apiBase: deps.apiBase, dataDir: deps.dataDir, fetchImpl, worktreePath, flags });
  if (!reached.ok) return emit(fallback(reached.error));
  const { apiBase, ids } = reached;

  try {
    const created = await create({ label, prompt, ids, worktreePath, apiBase, fetchImpl });
    return emit({ path: "api", ...created });
  } catch (error) {
    // Never fall back once a session exists; failures after creation carry its id.
    if (isConnectionError(error) && !error.sessionId) return emit(fallback(error));
    throw error;
  }
}

/**
 * The shared CLI boot for the two session routes: when the route module is the
 * invoked script, run `main` and report a hard error through `failureLines`,
 * so the catch shape exists once. `moduleUrl` is the route's own
 * `import.meta.url` — this module's URL is never the invoked one.
 */
export function runSessionCli({ toolName, moduleUrl, main }) {
  if (
    process.argv[1] &&
    realpathSync(fileURLToPath(moduleUrl)) === realpathSync(process.argv[1])
  ) {
    main().catch((error) => {
      for (const line of failureLines(toolName, error)) console.error(line);
      process.exitCode = 1;
    });
  }
}

/**
 * The reachable-API path: start the labeled terminal with the resolved ids,
 * then inject the pinned command. Any failure here is a hard error — once
 * `POST /terminal/start` may have created a terminal, the caller must never
 * fall back to `nohup` (that would double-launch the stage).
 *
 * @param {{ stage: string, spec: number|string, label: string, pointers: string, ids: TaskIds, worktreePath: string, apiBase: string, fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void>, env?: Object }} options
 */
export async function launchInTerminal({
  stage,
  spec,
  label,
  pointers,
  ids,
  worktreePath,
  apiBase,
  fetchImpl = fetch,
  sleepImpl = sleep,
  env = process.env,
}) {
  const startTerminal = async () => {
    const started = await requestJson(fetchImpl, `${apiBase}/terminal/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ids, worktreePath, label }),
    });
    const terminalId = started?.terminalId;
    if (!terminalId) throw new Error("Kepler terminal start returned no terminalId");
    return terminalId;
  };

  let terminalId = await startTerminal();
  const sentinel = stageSentinel(spec, stage);
  const input = buildTerminalInput(stage, spec, pointers, worktreePath, env);
  const postInput = () =>
    requestJson(fetchImpl, `${apiBase}/terminal/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminalId, input }),
    });

  await postInput();
  for (let relaunches = 0; ; relaunches += 1) {
    try {
      // The wrapper prints the sentinel immediately on execution, so a wait
      // that times out means the command never started.
      await waitForSentinel({ apiBase, fetchImpl, terminalId, sentinel, sleepImpl, relaunched: relaunches > 0 });
      return { terminalId, label };
    } catch (error) {
      // A non-wedge failure (buffer read HTTP error, connection failure,
      // malformed body) is a hard error, never a silent pass. A second
      // timeout after the relaunch is a hard error too.
      if (!isSentinelTimeout(error) || relaunches >= VERIFY_MAX_RELAUNCHES) throw error;
      // The wedge: close the terminal before relaunching it. Closing, not
      // re-injecting, is what makes no-double-launch structural — a late
      // first injection can never run a second stage command. A close or
      // start failure here propagates as a hard error carrying its message.
      await requestJson(fetchImpl, `${apiBase}/terminal/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ terminalId }),
      });
      terminalId = await startTerminal();
      await postInput();
    }
  }
}

/**
 * The fallback path: the detached `nohup pi` launch, stdout/stderr in
 * /tmp/skillbook-<stage>-pi.log. The child inherits the resolved `env` — the
 * same environment the provider's key was resolved from — so the key travels
 * under the provider's own variable without appearing in the command. With
 * the default `process.env` the spawn options are identical to the default
 * (Node already inherits `process.env`).
 */
export function launchDetached({ stage, pointers, spawnImpl = spawn, env = process.env }) {
  const command = buildStageCommand(stage, pointers, env);
  const log = `/tmp/skillbook-${stage}-pi.log`;
  const child = spawnImpl("sh", ["-c", `nohup ${command} > ${log} 2>&1 &`], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref?.();
  return { path: "nohup", command, log };
}

export async function launchStage({ stage, spec, pointers, flags, deps = {} }) {
  const { fetchImpl = fetch, spawnImpl = spawn, worktreePath = process.cwd(), env = process.env } = deps;
  stageKey(stage); // unknown stage is a hard error, before any launch path
  const label = stageLabel(spec, stage); // spec comes from the argument, never a label
  // The key preflight is unconditional and runs before either launch path:
  // the environment must carry the resolved provider's own key variable. The
  // built command never carries it — the terminal child and the nohup child
  // both inherit the environment.
  resolveStageKey(resolveProvider(env), env);

  const fallback = (error) => ({ ...launchDetached({ stage, pointers, spawnImpl, env }), reason: error.message });

  const reached = await reachApi({ apiBase: deps.apiBase, dataDir: deps.dataDir, fetchImpl, worktreePath, flags });
  if (!reached.ok) return fallback(reached.error);
  const { apiBase, ids } = reached;

  // From here the terminal may already exist: every failure is a hard error.
  const launched = await launchInTerminal({
    stage,
    spec,
    label,
    pointers,
    ids,
    worktreePath,
    apiBase,
    fetchImpl,
    sleepImpl: deps.sleepImpl,
    env,
  });
  return { path: "api", ...launched };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const [stage, spec, pointers] = argv;
  if (!stage || spec === undefined || pointers === undefined) {
    throw new Error(
      "usage: launch-stage.mjs <stage> <spec> '<pointers>' [--repo-id <id> --worktree-id <id> --task-id <id>]"
    );
  }
  const flags = parseIdFlags(argv.slice(3));
  const write = deps.write ?? ((line) => process.stdout.write(`${line}\n`));
  const result = await launchStage({ stage, spec, pointers, flags, deps });
  if (result.path === "api") {
    write(`launch-stage: launched ${result.label} in Kepler terminal ${result.terminalId}`);
  } else {
    write(`launch-stage: ${result.reason} — used nohup fallback`);
  }
  return result;
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  main().catch((error) => {
    console.error(`launch-stage: ${error.message}`);
    process.exitCode = 1;
  });
}
