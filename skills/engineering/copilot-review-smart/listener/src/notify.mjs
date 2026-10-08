import { spawn } from "node:child_process";
import { DEFAULT_NOTIFY_TIMEOUT_MS } from "./paths.mjs";
import { iso } from "./signature.mjs";
import { terminateProcessTree } from "./tick-runner.mjs";

export function runNotifyCmd({
  cmd,
  note,
  spawnFn = spawn,
  killProcessTree = terminateProcessTree,
  timeoutMs = DEFAULT_NOTIFY_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let stdinError = null;
    let treeTermination = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timeoutResult = { ok: false, error: "notification command timed out" };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        treeTermination = Promise.resolve(killProcessTree(child, "SIGKILL")).catch(() => {});
      } catch {
        treeTermination = Promise.resolve();
      }
      void treeTermination.then(() => finish(timeoutResult));
    }, timeoutMs);
    const isWindows = process.platform === "win32";
    const shell = isWindows ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
    const shellArgs = isWindows ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
    try {
      child = spawnFn(shell, shellArgs, {
        stdio: ["pipe", "ignore", "pipe"],
        detached: !isWindows,
      });
    } catch (e) {
      finish({ ok: false, error: String(e?.message || e) });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on?.("error", (e) => {
      const result = { ok: false, error: String(e?.message || e) };
      if (timedOut) void treeTermination?.then(() => finish(timeoutResult));
      else finish(result);
    });
    child.on?.("close", (code) => {
      if (timedOut) {
        void treeTermination?.then(() => finish(timeoutResult));
        return;
      }
      finish({
        ok: code === 0 && !stdinError,
        code,
        stderr: stderr.slice(0, 500),
        ...(stdinError ? { error: stdinError } : {}),
      });
    });
    child.stdin?.on("error", (e) => { stdinError = String(e?.message || e); });
    try {
      child.stdin.write(JSON.stringify(note));
      child.stdin.end();
    } catch (e) {
      stdinError = String(e?.message || e);
    }
  });
}



/** Serialized owner-notification dispatch. Notifications never block the tick
 * queue: they chain onto a promise, and the Listener only drains the chain at
 * shutdown. */
export function createOwnerNotifier({ notifyCmd, notifier, now, logger }) {
  let chain = Promise.resolve();
  let pending = 0;
  return {
    dispatch(notes, context) {
      for (const note of notes || []) {
        logger({ event: "owner_notification", notification_event: note.event, message: note.message });
        if (!notifyCmd || !notifier) continue;
        const payload = {
          event: note.event,
          repo: context.repo ?? null,
          pr: context.pr ?? null,
          head_sha: context.headSha ?? null,
          url: context.repo && context.pr
            ? `https://github.com/${context.repo}/pull/${context.pr}`
            : null,
          title: context.title ?? null,
          message: note.message,
          ts: iso(now()),
        };
        pending++;
        chain = chain
          .then(() => notifier(payload))
          .then((result) => {
            if (!result?.ok) {
              logger({
                event: "owner_notification_failed",
                notification_event: note.event,
                code: result?.code ?? null,
                error: result?.error ?? null,
              });
            }
          })
          .catch((e) => {
            logger({
              event: "owner_notification_failed",
              notification_event: note.event,
              error: String(e?.message || e),
            });
          })
          .finally(() => {
            pending--;
          });
      }
    },
    get pending() { return pending; },
    drain() { return chain; },
  };
}
