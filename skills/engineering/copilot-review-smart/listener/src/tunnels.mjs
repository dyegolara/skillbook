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
    try {
      child = spawnFn(kind, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new Error(`could not start ${kind}: ${e?.message || e}`));
      return;
    }
    child.on?.("error", (e) => fail(`could not start ${kind}: ${e?.message || e}`));
    child.on?.("close", (code) => fail(`${kind} exited before publishing a URL (exit ${code})`));

    if (kind === "cloudflared") {
      const onChunk = (chunk) => {
        const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) succeed(match[0]);
      };
      child.stderr?.on("data", onChunk);
      child.stdout?.on("data", onChunk);
    } else {
      let attempts = 0;
      const poll = async () => {
        attempts++;
        try {
          const response = await fetchFn(`${ngrokApiUrl}/api/tunnels`);
          const payload = await response.json();
          const publicUrl = (payload?.tunnels || [])
            .map((t) => t.public_url)
            .find((u) => typeof u === "string" && u.startsWith("https://"));
          if (publicUrl) {
            succeed(publicUrl);
            return;
          }
        } catch {
          // ngrok API not up yet
        }
        pollTimer = setTimeout(poll, retryMs);
      };
      poll();
    }

    timer = setTimeout(() => fail(`timed out waiting for ${kind} to publish a public URL`), timeoutMs);
  });
}
