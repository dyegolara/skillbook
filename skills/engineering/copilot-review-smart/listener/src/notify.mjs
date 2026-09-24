import { spawn } from "node:child_process";
import { DEFAULT_NOTIFY_TIMEOUT_MS } from "./paths.mjs";
import { iso } from "./signature.mjs";

export function runNotifyCmd({
  cmd,
  note,
  spawnFn = spawn,
  timeoutMs = DEFAULT_NOTIFY_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish({ ok: false, error: "notification command timed out" });
    }, timeoutMs);
    const isWindows = process.platform === "win32";
    const shell = isWindows ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
    const shellArgs = isWindows ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
    try {
      child = spawnFn(shell, shellArgs, { stdio: ["pipe", "ignore", "pipe"] });
    } catch (e) {
      finish({ ok: false, error: String(e?.message || e) });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on?.("error", (e) => finish({ ok: false, error: String(e?.message || e) }));
    child.on?.("close", (code) => finish({ ok: code === 0, code, stderr: stderr.slice(0, 500) }));
    try {
      child.stdin.write(JSON.stringify(note));
      child.stdin.end();
    } catch (e) {
      finish({ ok: false, error: String(e?.message || e) });
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
