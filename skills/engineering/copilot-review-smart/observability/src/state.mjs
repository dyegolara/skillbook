import fs from "node:fs";
import { isPidAlive } from "../../tick_liveness.mjs";

/** Read-only loading of the watchdog's persisted state files. Nothing in this
 * module writes: the server is a projection of what the Tick and the Listener
 * already put on disk. */

function readJsonFile(file) {
  let contents;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cannot read state file ${file}: ${error.message}`, { cause: error });
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in state file ${file}: ${error.message}`, { cause: error });
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The Tick state file (`state.json`): per-PR Flow entries plus the run-level
 * `tick_in_flight` marker. A missing file reads as empty — the server answers
 * before the loop has ever run. */
export function readTickState(statePath) {
  const parsed = readJsonFile(statePath);
  return isPlainObject(parsed) ? parsed : {};
}

/** The Listener state file (`listener-state.json`): armed Expectations,
 * persistent closure evidence and Hook ids. */
export function readListenerState(listenerStatePath) {
  const parsed = readJsonFile(listenerStatePath);
  return {
    version: isPlainObject(parsed) && Number.isInteger(parsed.version) ? parsed.version : 1,
    expectations: isPlainObject(parsed?.expectations) ? parsed.expectations : {},
    closed_flows: isPlainObject(parsed?.closed_flows) ? parsed.closed_flows : {},
  };
}

/**
 * Liveness evidence for `/health`: the Listener pid file plus pid liveness.
 * The pid file is written when the Listener starts and removed on a graceful
 * exit, so it is the one on-disk artifact that survives a crash and can say
 * "the watchdog is no longer there":
 *
 *   status "ok"     — a pid file names a process that is still alive
 *   status "dead"   — a pid file names a process that is gone (crash/kill)
 *   status "absent" — no usable pid file: the Listener never started here,
 *                     or exited gracefully and removed it
 *
 * `started_at` is the pid file's mtime: `claimPidFile` writes it once at
 * start, so it approximates the Listener's start time from disk alone. The
 * live Listener's `/healthz` reports its in-process start time instead.
 */
export function readListenerPid(pidPath, { isAliveFn = isPidAlive } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(pidPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", pid: null, started_at: null };
    throw new Error(`Cannot read Listener pid file ${pidPath}: ${error.message}`, { cause: error });
  }
  const pid = Number(String(raw).trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: "absent", pid: null, started_at: null };
  }
  let startedAt = null;
  try {
    startedAt = fs.statSync(pidPath).mtime.toISOString();
  } catch {
    // The file vanished between the read and the stat; fall through with no
    // start time rather than failing the request.
  }
  return { status: isAliveFn(pid) ? "ok" : "dead", pid, started_at: startedAt };
}
