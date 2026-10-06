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

function terminateProcessTree(child, signal) {
  if (Number.isInteger(child?.pid) && process.platform === "win32") {
    return new Promise((resolve) => {
      let killer;
      try {
        killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        child.kill(signal);
        resolve();
        return;
      }
      killer.once("error", () => {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
        resolve();
      });
      killer.once("close", () => resolve());
    });
  }
  if (Number.isInteger(child?.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to terminating the Tick process.
    }
  }
  try {
    child?.kill(signal);
  } catch {
    // already gone
  }
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
  killProcessTree = terminateProcessTree,
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
    let treeTermination = null;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawnFn(nodePath, args, {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (e) {
      resolve({ ok: false, reason, error: String(e?.message || e), stdout, stderr, reports: [], overall: null });
      return;
    }
    const timer = clock.setTimeout(() => {
      timedOut = true;
      try {
        treeTermination = Promise.resolve(killProcessTree(child, "SIGKILL")).catch(() => {});
      } catch {
        treeTermination = Promise.resolve();
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on?.("error", (e) => {
      finish({ ok: false, reason, error: `spawn failed: ${e?.message || e}`, stdout, stderr, reports: [], overall: null });
    });
    child.on?.("close", (code) => {
      const { reports, overall } = parseTickOutput(stdout);
      const successfulRepoScope =
        repos?.length > 0 && reports.length === 0 && overall?.scope_fetch_failures === 0;
      const scopedFetchFailed =
        Boolean(repo && num) && Number(overall?.scope_fetch_failures) > 0;
      const ok = !timedOut && code === 0 && overall !== null &&
        (reports.length > 0 || successfulRepoScope) && !scopedFetchFailed;
      const result = {
        ok,
        reason,
        code,
        timedOut,
        stdout,
        stderr,
        reports,
        overall,
        error: ok ? null : timedOut
          ? `tick timed out after ${timeoutMs}ms`
          : scopedFetchFailed
            ? "tick failed because a scoped API read failed"
            : `tick failed (exit ${code})`,
      };
      if (treeTermination) void treeTermination.then(() => finish(result));
      else finish(result);
    });
  });
}
