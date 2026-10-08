import { spawn } from "node:child_process";
import { DEFAULT_TUNNEL_TIMEOUT_MS } from "./paths.mjs";

export function startTunnel({
  kind,
  port,
  spawnFn = spawn,
  fetchFn = globalThis.fetch,
  timeoutMs = DEFAULT_TUNNEL_TIMEOUT_MS,
  retryMs = 250,
  ngrokApiUrl = process.env.PR_MONITOR_NGROK_API || "http://127.0.0.1:4040",
  logger = () => {},
  signal = null,
} = {}) {
  if (!["ngrok", "cloudflared"].includes(kind)) {
    return Promise.reject(new Error(`Unknown tunnel "${kind}": use ngrok or cloudflared.`));
  }
  const localUrl = `http://127.0.0.1:${port}`;
  const args = kind === "ngrok"
    ? ["http", localUrl, "--log", "stdout"]
    : ["tunnel", "--url", localUrl, "--no-autoupdate"];

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer = null;
    let pollTimer = null;
    const cleanupTimers = () => {
      if (timer) clearTimeout(timer);
      if (pollTimer) clearTimeout(pollTimer);
      timer = pollTimer = null;
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      try {
        child?.kill("SIGTERM");
      } catch {
        // already gone
      }
      reject(new Error(message));
    };
    const onAbort = () => fail(`starting ${kind} tunnel was aborted`);
    const succeed = (url) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      logger({ event: "tunnel_ready", kind, url });
      resolve({
        url,
        child,
        stop: () => {
          try {
            child?.kill("SIGTERM");
          } catch {
            // already gone
          }
        },
      });
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child = spawnFn(kind, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      fail(`could not start ${kind}: ${e?.message || e}`);
      return;
    }
    child.on?.("error", (e) => fail(`could not start ${kind}: ${e?.message || e}`));
    child.on?.("close", (code) => fail(`${kind} exited before publishing a URL (exit ${code})`));
    if (kind === "ngrok") {
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", () => {});
    }

    if (kind === "cloudflared") {
      let stdoutTail = "";
      let stderrTail = "";
      const onChunk = (stream) => (chunk) => {
        const tail = stream === "stdout" ? stdoutTail : stderrTail;
        const next = `${tail}${String(chunk)}`.slice(-512);
        if (stream === "stdout") stdoutTail = next;
        else stderrTail = next;
        const match = `${stdoutTail}\n${stderrTail}`.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) succeed(match[0]);
      };
      child.stderr?.on("data", onChunk("stderr"));
      child.stdout?.on("data", onChunk("stdout"));
    } else {
      let attempts = 0;
      const poll = async () => {
        attempts++;
        try {
          const response = await fetchFn(`${ngrokApiUrl}/api/tunnels`);
          const payload = await response.json();
          const publicUrl = (payload?.tunnels || [])
            .filter((t) => t?.config?.addr === localUrl)
            .map((t) => t.public_url)
            .find((u) => typeof u === "string" && u.startsWith("https://"));
          if (publicUrl) {
            succeed(publicUrl);
            return;
          }
        } catch {
          // ngrok API not up yet
        }
        if (settled) return;
        pollTimer = setTimeout(poll, retryMs);
      };
      poll();
    }

    timer = setTimeout(() => fail(`timed out waiting for ${kind} to publish a public URL`), timeoutMs);
  });
}
