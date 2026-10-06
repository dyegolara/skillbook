import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const savedSnapshots = new WeakMap();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function emptyListenerState() {
  const state = { version: 1, expectations: {}, hooks: {} };
  savedSnapshots.set(state, clone(state));
  return state;
}

export function defaultListenerStatePath() {
  return process.env.PR_MONITOR_WEBHOOK_STATE_PATH ||
    path.join(os.homedir(), ".cache", "pr-monitor", "listener-state.json");
}

export function loadListenerState(statePath = defaultListenerStatePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const state = { ...emptyListenerState(), ...parsed, expectations: parsed.expectations || {}, hooks: parsed.hooks || {} };
    savedSnapshots.set(state, clone(state));
    return state;
  } catch {
    return emptyListenerState();
  }
}

export function saveListenerState(state, statePath = defaultListenerStatePath()) {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = `${statePath}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  let lockFd;
  for (;;) {
    try {
      lockFd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(lockFd, token);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = fs.readFileSync(lockPath, "utf8");
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      const ownerPid = Number(owner.split(":", 1)[0]);
      if (!owner) {
        try {
          const stat = fs.statSync(lockPath);
          if (stat.size === 0 && Date.now() - stat.mtimeMs < 5000) {
            Atomics.wait(waitCell, 0, 0, 10);
            continue;
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
          throw statError;
        }
      }
      if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !isPidAlive(ownerPid)) {
        try {
          if (fs.readFileSync(lockPath, "utf8") === owner) fs.unlinkSync(lockPath);
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }

  const previous = savedSnapshots.get(state) || { version: undefined, expectations: {}, hooks: {} };
  const next = clone(state);
  try {
    let current = { version: 1, expectations: {}, hooks: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      current = { ...current, ...parsed, expectations: parsed.expectations || {}, hooks: parsed.hooks || {} };
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    for (const field of Object.keys(next)) {
      if (field === "expectations" || field === "hooks") continue;
      if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) current[field] = next[field];
    }
    for (const field of ["expectations", "hooks"]) {
      const before = previous[field] || {};
      const after = next[field] || {};
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
        if (Object.hasOwn(after, key)) current[field][key] = after[key];
        else delete current[field][key];
      }
    }
    const tmp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
    fs.renameSync(tmp, statePath);
    savedSnapshots.set(state, next);
  } finally {
    fs.closeSync(lockFd);
    try {
      if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}
