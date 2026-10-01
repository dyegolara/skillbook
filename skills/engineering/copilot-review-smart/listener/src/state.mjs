import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function emptyListenerState() {
  return { version: 1, expectations: {}, hooks: {} };
}

export function defaultListenerStatePath() {
  return process.env.PR_MONITOR_WEBHOOK_STATE_PATH ||
    path.join(os.homedir(), ".cache", "pr-monitor", "listener-state.json");
}

export function loadListenerState(statePath = defaultListenerStatePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return { ...emptyListenerState(), ...parsed, expectations: parsed.expectations || {}, hooks: parsed.hooks || {} };
  } catch {
    return emptyListenerState();
  }
}

export function saveListenerState(state, statePath = defaultListenerStatePath()) {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}
