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
 * verified-inject polls `GET /terminal/buffer` for it (the bare JSON string,
 * ANSI escapes stripped, on its own line — the PTY echo of the injected
 * command carries the same text mid-line and is not proof of execution)
 * every 250 ms for up to 5000 ms. A timed-out wait is a wedge: the helper
 * re-injects the same input into the same terminal once and re-verifies; a
 * second timeout is a hard error carrying `error.message`. On exhaustion the
 * wrapper prints the FAILED marker (stage, spec, the exact resume command)
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
 *   node skills/software-factory/scripts/launch-stage.mjs <stage> <spec> '<thin pointers>'
 *     [--repo-id <id> --worktree-id <id> --task-id <id>]
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const KEPLER_DATA_DIR = join(homedir(), ".kepler-server", "data");

// Pins per ADR-0006: the three own pi stages are mirrored from their SKILL.md
// frontmatter; implement-spec is referenced and its pin is recorded in ADR-0006.
export const STAGE_PINS = {
  "dev-flow": { provider: "opencode-go", model: "opencode-go/glm-5.3", thinking: "max" },
  "implement-spec": { provider: "opencode-go", model: "opencode-go/deepseek-v4.1-flash", thinking: "max" },
  "code-review-loop": { provider: "opencode-go", model: "opencode-go/mimo-v2.6-pro", thinking: "high" },
  "create-pr": { provider: "opencode-go", model: "opencode-go/muse-spark-1.3-contributor", thinking: "xhigh" },
};

export function stagePin(stage) {
  const pin = STAGE_PINS[stage];
  if (!pin) {
    throw new Error(`unknown stage "${stage}" — expected one of ${Object.keys(STAGE_PINS).join(", ")}`);
  }
  return pin;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function buildPiCommand(stage, pointers) {
  const pin = stagePin(stage);
  return `pi --print --provider ${pin.provider} --model ${pin.model} --thinking ${pin.thinking} ${shellQuote(pointers)}`;
}

/**
 * The retry wrapper's parameters: five attempts with a doubling backoff whose
 * four sleeps sum to 600 seconds — a ten-minute give-up window. Explicit, not
 * jittered, so a stage launch is deterministic.
 */
export const RETRY_ATTEMPTS = 5;
export const RETRY_SLEEPS_SECONDS = [40, 80, 160, 320];

/**
 * verified-inject's parameters: the wrapper prints the sentinel as its first
 * action, and the helper polls the terminal buffer every 250 ms for up to
 * 5000 ms before calling the launch wedged. A timed-out wait re-injects the
 * same input into the same terminal exactly once; a second timeout is a hard
 * error. Explicit, like the retry schedule, so the behaviour is deterministic.
 */
export const SENTINEL_PREFIX = "CHAIN-STAGE-START:";
export const VERIFY_POLL_INTERVAL_MS = 250;
export const VERIFY_TIMEOUT_MS = 5000;
export const VERIFY_MAX_REINJECTS = 1;

/**
 * The execution sentinel the wrapper prints before attempt 1. It is the
 * stable string the helper greps the terminal buffer for; the PTY's echo of
 * the injected command contains it too, so only a standalone line counts as
 * execution (see `sentinelSeen`).
 */
export function stageSentinel(spec, stage) {
  return `${SENTINEL_PREFIX} chain #${specNumber(spec)} ${stage}`;
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

/** The wedge signal: the sentinel wait timed out, so verified-inject re-injects once. */
export class SentinelTimeoutError extends Error {
  constructor({ terminalId, sentinel, timeoutMs, reinjected }) {
    super(
      `terminal ${terminalId} did not show "${sentinel}" within ${timeoutMs}ms` +
        (reinjected ? " after one re-inject" : "") +
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
 * re-inject against a terminal the helper cannot actually see.
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
 * `SentinelTimeoutError` — the one failure verified-inject treats as a wedge.
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
  reinjected = false,
}) {
  const polls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let poll = 0; poll < polls; poll += 1) {
    if (poll > 0) await sleepImpl(pollIntervalMs);
    const buffer = await readTerminalBuffer({ apiBase, fetchImpl, terminalId });
    if (sentinelSeen(buffer, sentinel)) return buffer;
  }
  throw new SentinelTimeoutError({ terminalId, sentinel, timeoutMs, reinjected });
}

/** The sibling wake helper, resolved from this module's own installed location. */
export function wakeHelperPath() {
  return fileURLToPath(new URL("./open-wake-session.mjs", import.meta.url));
}

/**
 * The retry wrapper injected into the stage terminal: the sentinel's line
 * before attempt 1, then the pinned command, whatever the harness, attempted
 * up to `RETRY_ATTEMPTS` times with exponential backoff. On exhaustion it
 * prints the FAILED marker — stage, spec and the exact resume command, one
 * greppable line each — into the terminal buffer (the stage log), then
 * actuates the wake by running the sibling helper; the wake's output and
 * exit status are never swallowed.
 */
export function buildRetryWrapper(stage, spec, pointers) {
  const command = buildPiCommand(stage, pointers); // the stage's pinned command, unchanged inside
  const sentinel = stageSentinel(spec, stage); // the first action, before attempt 1
  const marker = [
    `FAILED: chain #${spec} ${stage} gave up after ${RETRY_ATTEMPTS} attempts`,
    `FAILED: resume with: ${command}`,
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
    `node ${shellQuote(wakeHelperPath())} ${stage} ${spec} ${shellQuote(command)}; fi`
  );
}

export function buildTerminalInput(stage, spec, pointers) {
  return `${buildRetryWrapper(stage, spec, pointers)}\n`;
}

export function stageLabel(spec, stage) {
  return `chain #${specNumber(spec)}: ${stage}`;
}

/** The one spec-number guard: both the label and the sentinel carry it. */
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
// `toTaskIds` reads them from this table to construct the named triple.
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
 * Every triple is built by `toTaskIds`; a resolved triple is fully populated
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
function toTaskIds(source) {
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
  const ids = toTaskIds(flags);
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
  const explicit = toTaskIds(flags);
  assertCompleteIdFlags(explicit);
  if (Object.values(explicit).some((value) => value !== undefined)) return explicit;

  const terminals = await requestJson(fetchImpl, `${apiBase}/terminal/list`);
  const anchor = pickAnchor(terminals, worktreePath);
  if (!anchor) {
    throw new Error(`no terminal on ${worktreePath} and no ${ID_FLAG_HINT} flags — cannot derive ids`);
  }
  // The anchor is an external `GET /terminal/list` entry: construct it like
  // every other triple.
  return toTaskIds(anchor);
}

/**
 * The reachable-API path: start the labeled terminal with the resolved ids,
 * then inject the pinned command. Any failure here is a hard error — once
 * `POST /terminal/start` may have created a terminal, the caller must never
 * fall back to `nohup` (that would double-launch the stage).
 *
 * @param {{ stage: string, spec: number|string, label: string, pointers: string, ids: TaskIds, worktreePath: string, apiBase: string, fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void> }} options
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
}) {
  const started = await requestJson(fetchImpl, `${apiBase}/terminal/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...ids, worktreePath, label }),
  });
  const terminalId = started?.terminalId;
  if (!terminalId) throw new Error("Kepler terminal start returned no terminalId");

  const sentinel = stageSentinel(spec, stage);
  const input = buildTerminalInput(stage, spec, pointers);
  const postInput = () =>
    requestJson(fetchImpl, `${apiBase}/terminal/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminalId, input }),
    });

  await postInput();
  for (let reinjects = 0; ; reinjects += 1) {
    try {
      // The wrapper prints the sentinel immediately on execution, so a wait
      // that times out means the command never started: re-inject the same
      // input into the same terminal, bounded to VERIFY_MAX_REINJECTS, and
      // re-verify. Once the sentinel is seen the helper returns without
      // touching the terminal's input again — no double-launch.
      await waitForSentinel({ apiBase, fetchImpl, terminalId, sentinel, sleepImpl, reinjected: reinjects > 0 });
      return { terminalId, label };
    } catch (error) {
      // A non-wedge failure (buffer read HTTP error, connection failure,
      // malformed body) is a hard error, never a silent pass.
      if (!isSentinelTimeout(error) || reinjects >= VERIFY_MAX_REINJECTS) throw error;
      await postInput();
    }
  }
}

/**
 * The fallback path: the detached `nohup pi` launch, stdout/stderr in
 * /tmp/skillbook-<stage>-pi.log.
 */
export function launchDetached({ stage, pointers, spawnImpl = spawn }) {
  const command = buildPiCommand(stage, pointers);
  const log = `/tmp/skillbook-${stage}-pi.log`;
  const child = spawnImpl("sh", ["-c", `nohup ${command} > ${log} 2>&1 &`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref?.();
  return { path: "nohup", command, log };
}

export async function launchStage({ stage, spec, pointers, flags, deps = {} }) {
  const { fetchImpl = fetch, spawnImpl = spawn, worktreePath = process.cwd() } = deps;
  stagePin(stage); // unknown stage is a hard error, before any launch path
  const label = stageLabel(spec, stage); // spec comes from the argument, never a label

  const fallback = (error) => ({ ...launchDetached({ stage, pointers, spawnImpl }), reason: error.message });

  let apiBase;
  try {
    apiBase = deps.apiBase ?? readKeplerApiBase({ dataDir: deps.dataDir });
  } catch (error) {
    return fallback(error); // the API location is unknown: connection-level
  }

  let ids;
  try {
    ids = await resolveIds({ apiBase, fetchImpl, worktreePath, flags });
  } catch (error) {
    if (!isConnectionError(error)) throw error; // reachable API, bad response: hard error
    return fallback(error);
  }

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
    sleepImpl: deps.verifySleep,
  });
  return { path: "api", ...launched };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const [stage, spec, pointers] = argv;
  if (!stage || spec === undefined || pointers === undefined) {
    throw new Error(
      "usage: launch-stage.mjs <stage> <spec> '<thin pointers>' [--repo-id <id> --worktree-id <id> --task-id <id>]"
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`launch-stage: ${error.message}`);
    process.exitCode = 1;
  });
}
