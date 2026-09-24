import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DEFAULT_HOST, DEFAULT_PORT, WEBHOOK_SCRIPT } from "./paths.mjs";

export function defaultPidPath() {
  return process.env.PR_MONITOR_WEBHOOK_PID_PATH ||
    path.join(os.homedir(), ".cache", "pr-monitor", "listener.pid");
}

export function defaultLogPath() {
  return process.env.PR_MONITOR_WEBHOOK_LOG ||
    path.join(os.homedir(), ".cache", "pr-monitor", "listener.log");
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== "ESRCH";
  }
}

export function readPidFile(pidPath = defaultPidPath()) {
  try {
    const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function claimPidFile(pidPath = defaultPidPath()) {
  const existing = readPidFile(pidPath);
  if (existing && isPidAlive(existing) && existing !== process.pid) {
    throw new Error(
      `another Listener is already running (pid ${existing}); use --status or --stop before starting a new one.`
    );
  }
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, `${process.pid}\n`);
}

export function removePidFile(pidPath = defaultPidPath(), pid = process.pid) {
  try {
    if (readPidFile(pidPath) === pid) fs.rmSync(pidPath, { force: true });
  } catch {
    // already gone
  }
}

export async function probeHealthz({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 1500 } = {}) {
  try {
    const response = await fetch(`http://${host}:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { healthy: false, status: response.status };
    const body = await response.json();
    return { healthy: true, status: response.status, body };
  } catch (e) {
    return { healthy: false, error: String(e?.message || e) };
  }
}

export async function listenerStatus({ host = DEFAULT_HOST, port = DEFAULT_PORT, pidPath = defaultPidPath() } = {}) {
  const pid = readPidFile(pidPath);
  const running = Boolean(pid && isPidAlive(pid));
  if (!running) {
    if (pid) removePidFile(pidPath, pid);
    return { running: false, healthy: false, pid: null };
  }
  const health = await probeHealthz({ host, port });
  return { running: true, healthy: health.healthy, pid, health };
}

export async function stopListenerProcess({
  pidPath = defaultPidPath(),
  timeoutMs = 10_000,
} = {}) {
  const pid = readPidFile(pidPath);
  if (!pid) return { stopped: false, reason: "not running" };
  if (!isPidAlive(pid)) {
    removePidFile(pidPath, pid);
    return { stopped: false, reason: "stale pid file removed" };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    return { stopped: false, reason: String(e?.message || e) };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      removePidFile(pidPath, pid);
      return { stopped: true, pid };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { stopped: false, pid, reason: "process did not exit after SIGTERM" };
}

/** Detach a `--serve` child, wait until it answers /healthz, and report. */
export async function startDaemon({
  args = ["--serve"],
  env = process.env,
  logPath = defaultLogPath(),
  pidPath = defaultPidPath(),
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  spawnFn = spawn,
  timeoutMs = 10_000,
} = {}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const child = spawnFn(process.execPath, [WEBHOOK_SCRIPT, ...args], {
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref?.();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeHealthz({ host, port, timeoutMs: 500 });
    if (health.healthy) {
      const pid = readPidFile(pidPath) || child.pid;
      return { started: true, pid, logPath, health: health.body };
    }
    if (child.exitCode !== null && child.exitCode !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  let tail = "";
  try {
    tail = fs.readFileSync(logPath, "utf8").split("\n").slice(-5).join("\n");
  } catch {
    // no log yet
  }
  return { started: false, error: `Listener did not become healthy; last log lines:\n${tail}` };
}
