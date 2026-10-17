import http from "node:http";
import { readListenerPid, readListenerState, readTickState } from "./state.mjs";
import { projectFlow, projectFlows, projectHealth, projectTimeline } from "./project.mjs";

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * The read-only observability server (ADR-0009). It holds no state of its
 * own: every request reloads the persisted state files, so it answers with
 * the last known state whether or not a watchdog process is running, and it
 * never writes. GET only; loopback only by default.
 */
export function createObservabilityServer({
  statePath,
  listenerStatePath,
  pidPath,
  now = Date.now,
  isAliveFn,
} = {}) {
  function project() {
    return {
      tickState: readTickState(statePath),
      listenerState: readListenerState(listenerStatePath),
      listenerPid: readListenerPid(pidPath, { isAliveFn }),
      nowMs: now(),
      isAliveFn,
    };
  }

  function handleRequest(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    } catch {
      send(res, 400, { error: "bad request" });
      return;
    }
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed: the observability API is GET only" }, { allow: "GET" });
      return;
    }
    try {
      const projection = project();
      if (pathname === "/health" || pathname === "/health/") {
        send(res, 200, projectHealth(projection));
        return;
      }
      if (pathname === "/timeline" || pathname === "/timeline/") {
        send(res, 200, projectTimeline(projection));
        return;
      }
      if (pathname === "/flows" || pathname === "/flows/") {
        send(res, 200, projectFlows(projection));
        return;
      }
      const flowMatch = /^\/flows\/([^/]+)\/([^/]+)\/(\d+)\/?$/.exec(pathname);
      if (flowMatch) {
        const owner = decodeURIComponent(flowMatch[1]);
        const repo = decodeURIComponent(flowMatch[2]);
        const key = `${owner}/${repo}#${Number(flowMatch[3])}`;
        const flow = projectFlow({ key, ...projection });
        if (!flow) {
          send(res, 404, { error: "unknown flow" });
          return;
        }
        send(res, 200, flow);
        return;
      }
      send(res, 404, { error: "not found" });
    } catch (error) {
      send(res, 500, { error: String(error?.message || error) });
    }
  }

  return http.createServer(handleRequest);
}
