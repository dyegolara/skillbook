import { spawn } from "node:child_process";
import { PR_MONITOR_SCRIPT, DEFAULT_TICK_TIMEOUT_MS } from "./paths.mjs";
import { keyOf } from "./signature.mjs";

export function parseTickOutput(stdout) {
  const reports = [];
  let overall = null;
  for (const line of String(stdout || "").split("\n")) {
    if (!line.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.type === "pr") reports.push(parsed);
    if (parsed?.type === "overall") overall = parsed;
  }
  return { reports, overall };
}

/** Spawn one Tick. Single-PR scope when repo/num are given, repo scope for a
 * Startup tick. Never inherits the Listener's own scope env (the child must
 * use the scope we pass). */
export function spawnTick({
  repo = null,
  num = null,
  repos = null,
  reason = "tick",
  timeoutMs = DEFAULT_TICK_TIMEOUT_MS,
  spawnFn = spawn,
  nodePath = process.execPath,
  scriptPath = PR_MONITOR_SCRIPT,
  env = process.env,
  clock = { setTimeout, clearTimeout },
} = {}) {
  const args = [scriptPath];
  if (repo && num) args.push("--pr", keyOf(repo, num));
  else if (repos?.length) args.push("--repos", repos.join(","));
  args.push("--json-report");

  const childEnv = { ...env, PR_MONITOR_REPOS: "", PR_MONITOR_PR: "", PR_MONITOR_REPORT: "" };
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawnFn(nodePath, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, reason, error: String(e?.message || e), stdout, stderr, reports: [], overall: null });
      return;
    }
    const timer = clock.setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on?.("error", (e) => {
      finish({ ok: false, reason, error: `spawn failed: ${e?.message || e}`, stdout, stderr, reports: [], overall: null });
    });
    child.on?.("close", (code) => {
      const { reports, overall } = parseTickOutput(stdout);
      const ok = !timedOut && code === 0 && overall !== null && reports.length > 0;
      finish({
        ok,
        reason,
        code,
        timedOut,
        stdout,
        stderr,
        reports,
        overall,
        error: ok ? null : timedOut ? `tick timed out after ${timeoutMs}ms` : `tick failed (exit ${code})`,
      });
    });
  });
}
