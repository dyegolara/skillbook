import os from "node:os";
import path from "node:path";

/** Defaults for the read-only observability server. The state paths follow
 * the Listener's `~/.cache/pr-monitor/` convention; the env names are the
 * same ones the Tick and the Listener already read, so one deployment
 * configures all three processes alike. */
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8788;

export function defaultTickStatePath() {
  return process.env.PR_MONITOR_STATE_PATH ||
    path.join(os.homedir(), ".cache", "pr-monitor", "state.json");
}

export function defaultListenerStatePath() {
  return process.env.PR_MONITOR_WEBHOOK_STATE_PATH ||
    path.join(os.homedir(), ".cache", "pr-monitor", "listener-state.json");
}

export function defaultListenerPidPath() {
  return process.env.PR_MONITOR_WEBHOOK_PID_PATH ||
    path.join(os.homedir(), ".cache", "pr-monitor", "listener.pid");
}
