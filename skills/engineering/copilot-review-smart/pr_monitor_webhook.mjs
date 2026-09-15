#!/usr/bin/env node
/**
 * pr_monitor_webhook.mjs — webhook-first Listener for the copilot-review-smart
 * skill. Plain ESM JavaScript, no build step, Node >= 18, `node:http` only.
 *
 * The Listener is transport only: it verifies GitHub Deliveries, filters and
 * coalesces them, spawns one Tick at a time scoped to the affected PR, and
 * arms the Expectation the Tick report hands back. It never decides actions.
 * Cron mode (`pr_monitor.mjs`) stays the alternate mode for Hosts without a
 * public HTTPS endpoint. See docs/adr/0006.
 *
 * Env config:
 *   PR_MONITOR_REPOS              (required) watched repos "owner/repo,..."
 *   PR_MONITOR_WEBHOOK_SECRET     (required) HMAC secret of the Hook
 *   PR_MONITOR_PUBLIC_URL         public base URL of this Listener (Hook setup)
 *   PR_MONITOR_LOGIN              own login for the Echo filter (default: gh api user)
 *   PR_MONITOR_WEBHOOK_HOST       bind host (default 127.0.0.1)
 *   PR_MONITOR_WEBHOOK_PORT       bind port (default 8787)
 *   PR_MONITOR_DEBOUNCE_MS        per-PR debounce (default 30000)
 *   PR_MONITOR_TICK_TIMEOUT       kill a hung Tick after this many ms (default 300000)
 *   PR_MONITOR_STARTUP_TICK       "0" disables the Startup tick
 *   PR_MONITOR_WEBHOOK_STATE_PATH Listener state (default ~/.cache/pr-monitor/listener-state.json)
 *   PR_MONITOR_WEBHOOK_PID_PATH   pid file (default ~/.cache/pr-monitor/listener.pid)
 *   PR_MONITOR_WEBHOOK_LOG        optional JSONL log file (stdout always logs)
 *   PR_MONITOR_NOTIFY_CMD         owner notifications: command, JSON on stdin
 *
 * CLI flags:
 *   --serve                    run the Listener in the foreground
 *   --daemon                   detach the Listener (writes pid + log file)
 *   --stop                     stop the detached Listener
 *   --status                   report pid + health
 *   --keep-alive               keep serving when no active Flow remains
 *   --setup-hooks              create/update the GitHub Hook(s), then ping them
 *   --list-hooks               list our Hook(s) and recent deliveries
 *   --teardown                 remove our Hook(s)
 *   --rotate-secret            generate a new Hook secret and print the env line
 *   --tunnel ngrok|cloudflared start a tunnel and use its URL for Hook setup
 */

import { execFile, spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PR_MONITOR_SCRIPT = path.join(SCRIPT_DIR, "pr_monitor.mjs");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_DEBOUNCE_MS = 30_000;
const DEFAULT_TICK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_NOTIFY_TIMEOUT_MS = 30_000;
const DEFAULT_PING_WAIT_MS = 30_000;
const DEFAULT_TUNNEL_TIMEOUT_MS = 30_000;
const TICK_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const DELIVERY_LRU_SIZE = 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const HOOK_NAME = "copilot-review-smart (pr-monitor)";
const HOOK_PATH = "/github/webhook";

const SUBSCRIBED_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
];

const SUBSCRIBED_ACTIONS = {
  pull_request: new Set([
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
    "converted_to_draft",
    "closed",
  ]),
  pull_request_review: new Set(["submitted", "dismissed"]),
  pull_request_review_comment: new Set(["created"]),
  issue_comment: new Set(["created", "edited"]),
};

const iso = (ms) => new Date(ms).toISOString();

function splitRepos(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function keyOf(repo, num) {
  return `${repo}#${num}`;
}

function parseKey(key) {
  const match = String(key).match(/^([^#]+)#(\d+)$/);
  if (!match) throw new Error(`Invalid listener key: ${key}`);
  return { repo: match[1], num: Number(match[2]) };
}

function isCopilotLogin(login) {
  return String(login || "").toLowerCase().includes("copilot");
}

// ---------------------------------------------------------------------------
// signatures and delivery filters (pure — unit-testable without a server)
// ---------------------------------------------------------------------------

/** HMAC-SHA256 over the raw body, constant-time compare. */
export function verifySignature(rawBody, signatureHeader, secret) {
  const header = String(signatureHeader || "");
  if (!header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", String(secret || ""))
    .update(rawBody)
    .digest("hex");
  const provided = header.slice("sha256=".length).trim();
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/** Which Deliveries wake the loop, which are acknowledged and dropped. */
export function classifyDelivery({ event, payload = {}, repos = [], login = "" }) {
  if (event === "ping") {
    return { accepted: true, kind: "ping", repo: payload.repository?.full_name || null, num: null };
  }
  if (!SUBSCRIBED_EVENTS.includes(event)) {
    return { accepted: false, reason: `event ${event} is not subscribed` };
  }
  const action = payload.action || "";
  if (!SUBSCRIBED_ACTIONS[event]?.has(action)) {
    return { accepted: false, reason: `${event}.${action || "?"} is not subscribed` };
  }
  const repo = payload.repository?.full_name || "";
  if (!repo) return { accepted: false, reason: "delivery carries no repository" };
  if (event === "issue_comment" && !payload.issue?.pull_request) {
    return { accepted: false, reason: "issue_comment is not on a pull request" };
  }
  const num = payload.pull_request?.number ?? payload.issue?.number ?? null;
  if (!Number.isInteger(num)) return { accepted: false, reason: "delivery carries no PR number" };
  if (repos.length && !repos.includes(repo)) {
    return { accepted: false, reason: `repo ${repo} is not watched` };
  }
  const sender = payload.sender?.login || "";
  // Copilot is never filtered: Copilot's own deliveries are progress, and a
  // Copilot login could in principle collide with the loop's own login.
  if (login && sender === login && !isCopilotLogin(sender)) {
    return { accepted: false, echo: true, repo, num, reason: "Echo: delivery was caused by our own login" };
  }
  return {
    accepted: true,
    kind: "delivery",
    event,
    action,
    repo,
    num,
    sender,
    closesFlow: event === "pull_request" && action === "closed",
  };
}

// ---------------------------------------------------------------------------
// Listener state (Expectations + Hook ids) — separate from the Tick state
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tick child process
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Listener factory
// ---------------------------------------------------------------------------

/**
 * The Listener. All side effects are injectable: tests pass a stub tick
 * runner, clock, gh runner and logger, and drive Deliveries through
 * `ingest()`; production passes the real ones (see `main()`).
 */
export function createListener({
  config = {},
  now = () => Date.now(),
  clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
  tickRunner = null,
  gh = null,
  notifier = null,
  logger = () => {},
  onExit = null,
  persistState = null,
  state = emptyListenerState(),
} = {}) {
  const repos = [...(config.repos || [])];
  if (!config.secret) {
    throw new Error("PR_MONITOR_WEBHOOK_SECRET is required: refusing to serve an unauthenticated webhook.");
  }
  if (repos.length === 0) {
    throw new Error("PR_MONITOR_REPOS is required: refusing to serve without a watched-repo filter.");
  }

  const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const tickTimeoutMs = config.tickTimeoutMs ?? DEFAULT_TICK_TIMEOUT_MS;
  let effectiveLogin = config.login || "";
  const startedAt = now();

  // Flows and Expectations (see CONTEXT.md).
  const flows = new Set();
  const closedFlows = new Set();
  const expectations = new Map(); // key -> { timer, deadlineMs, backoffIndex }
  const tickFailures = new Map(); // key -> consecutive failed-Tick index
  const debounces = new Map(); // key -> timer
  const queue = [];
  const queuedKeys = new Set();
  let running = false;
  let activeTickPromise = null;
  let pendingStarts = 0;
  let notificationChain = Promise.resolve();
  let pendingNotifications = 0;
  const seenDeliveries = new Map(); // delivery id -> insertion order (LRU)
  let lastDelivery = null;
  let pingWaiters = [];
  let exitRequested = false;
  let server = null;
  let boundPort = null;

  const runTick = tickRunner || ((args) => spawnTick({ ...args, timeoutMs: tickTimeoutMs }));

  function persist() {
    if (!persistState) return;
    try {
      persistState(state);
    } catch (e) {
      logger({ event: "state_persist_failed", error: String(e?.message || e) });
    }
  }

  function rememberDelivery(id) {
    seenDeliveries.set(id, true);
    if (seenDeliveries.size > DELIVERY_LRU_SIZE) {
      const oldest = seenDeliveries.keys().next().value;
      seenDeliveries.delete(oldest);
    }
  }

  function cancelTimer(map, key) {
    const timer = map.get(key);
    if (timer !== undefined) {
      clock.clearTimeout(timer);
      map.delete(key);
    }
  }

  // --- Expectations ---------------------------------------------------------

  function armExpectation(key, deadlineMs, backoffIndex = 0, origin = "tick") {
    cancelTimer(expectations, key);
    const deadline = Number(deadlineMs);
    if (!Number.isFinite(deadline)) return;
    const delay = Math.max(0, deadline - now());
    const timer = clock.setTimeout(() => fireFallback(key), delay);
    expectations.set(key, { timer, deadlineMs: deadline, backoffIndex });
    const { repo, num } = parseKey(key);
    state.expectations[key] = { repo, num, deadline_ms: deadline, backoff_index: backoffIndex, origin };
    persist();
    logger({
      event: "expectation_armed",
      key,
      deadline_at: iso(deadline),
      delay_ms: delay,
      backoff_index: backoffIndex,
      origin,
    });
  }

  function disarmExpectation(key, reason = "disarmed") {
    cancelTimer(expectations, key);
    if (state.expectations[key]) {
      delete state.expectations[key];
      persist();
    }
    logger({ event: "expectation_disarmed", key, reason });
  }

  function fireFallback(key) {
    if (!expectations.has(key)) return;
    cancelTimer(expectations, key);
    delete state.expectations[key];
    persist();
    if (closedFlows.has(key) || !flows.has(key)) return;
    logger({ event: "fallback_tick", key });
    enqueueTick(key, "fallback");
  }

  // --- Flows ----------------------------------------------------------------

  function trackFlow(key) {
    if (closedFlows.has(key)) return false;
    if (!flows.has(key)) {
      flows.add(key);
      logger({ event: "flow_tracked", key });
    }
    return true;
  }

  function closeFlow(key, reason) {
    flows.delete(key);
    closedFlows.add(key);
    tickFailures.delete(key);
    disarmExpectation(key, reason);
    cancelTimer(debounces, key);
    logger({ event: "flow_closed", key, reason });
    maybeExit();
  }

  function maybeExit() {
    if (exitRequested || config.keepAlive) return;
    if (flows.size === 0) {
      exitRequested = true;
      logger({ event: "listener_idle", reason: "no tracked Flow remains" });
      if (onExit) onExit();
    }
  }

  // --- Tick queue: one at a time, one re-tick per PR ------------------------

  function scheduleDeliveryTick(key, delayMs = debounceMs) {
    cancelTimer(debounces, key);
    const timer = clock.setTimeout(() => {
      debounces.delete(key);
      enqueueTick(key, "delivery");
    }, delayMs);
    debounces.set(key, timer);
  }

  function enqueueTick(key, reason) {
    if (!flows.has(key) || closedFlows.has(key)) return;
    if (queuedKeys.has(key)) return;
    queuedKeys.add(key);
    queue.push({ key, reason });
    pump();
  }

  async function pump() {
    if (running) return;
    const item = queue.shift();
    if (!item) return;
    queuedKeys.delete(item.key);
    const { repo, num } = parseKey(item.key);
    running = true;
    pendingStarts++;
    activeTickPromise = (async () => {
      const result = await runTick({ repo, num, reason: item.reason, timeoutMs: tickTimeoutMs });
      await handleTickResult(item.key, result);
      logger({
        event: "tick_finished",
        key: item.key,
        reason: item.reason,
        ok: Boolean(result?.ok),
        action: result?.reports?.[0]?.action ?? null,
      });
    })()
      .catch((e) => {
        logger({ event: "tick_crashed", key: item.key, error: String(e?.message || e) });
        armTickBackoff(item.key);
      })
      .finally(() => {
        running = false;
        pendingStarts--;
        activeTickPromise = null;
        pump();
      });
  }

  function armTickBackoff(key) {
    const previous = tickFailures.has(key) ? tickFailures.get(key) : -1;
    const index = Math.min(previous + 1, TICK_BACKOFF_MS.length - 1);
    tickFailures.set(key, index);
    armExpectation(key, now() + TICK_BACKOFF_MS[index], index, "tick_failure");
  }

  async function notifyOwner(notes, context) {
    for (const note of notes || []) {
      logger({ event: "owner_notification", notification_event: note.event, message: note.message });
      if (!config.notifyCmd || !notifier) continue;
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
      pendingNotifications++;
      notificationChain = notificationChain
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
          pendingNotifications--;
        });
    }
  }

  async function handleTickResult(key, result) {
    if (!result?.ok) {
      logger({ event: "tick_failed", key, error: result?.error || "unknown", timed_out: Boolean(result?.timedOut) });
      if (flows.has(key) && !closedFlows.has(key)) armTickBackoff(key);
      return;
    }
    const { reports = [] } = result;
    const { repo, num } = parseKey(key);
    const report = reports.find((r) => r.repo === repo && r.pr === num) || reports[0];
    if (!report) {
      logger({ event: "tick_report_missing", key });
      armTickBackoff(key);
      return;
    }
    // Notifications are serialized but never block the tick queue.
    await notifyOwner(report.owner_notifications, {
      repo: report.repo,
      pr: report.pr,
      headSha: report.head_sha,
      title: report.title,
    });
    applyPrReport(key, report);
  }

  /** Apply one Tick report to the Flow: close, quiesce, arm or disarm. */
  function applyPrReport(key, report) {
    tickFailures.delete(key);
    if (report.terminal === "done") {
      closeFlow(key, "flow completed (Notify-ready or PR closed)");
      return;
    }
    if (report.skipped) {
      trackFlow(key);
      disarmExpectation(key, "draft/WIP is quiescent");
      return;
    }
    trackFlow(key);
    if (report.next_check_at) {
      armExpectation(key, Date.parse(report.next_check_at), 0, "tick_report");
    } else {
      disarmExpectation(key, "tick report is quiescent (next_check_at null)");
    }
  }

  // --- Delivery ingest ------------------------------------------------------

  function ingest({ event, deliveryId = "", payload = null, rawBody = "", signature = null, verify = true } = {}) {
    if (deliveryId && seenDeliveries.has(deliveryId)) {
      logger({ event: "delivery_ignored", delivery_id: deliveryId, reason: "duplicate" });
      return { status: 200, accepted: false, reason: "duplicate delivery" };
    }
    if (verify) {
      const body = typeof rawBody === "string" ? rawBody : String(rawBody ?? "");
      if (!verifySignature(body, signature, config.secret)) {
        logger({ event: "delivery_rejected", delivery_id: deliveryId, reason: "bad signature" });
        return { status: 401, accepted: false, reason: "bad signature" };
      }
    }
    if (deliveryId) rememberDelivery(deliveryId);

    const info = classifyDelivery({ event, payload: payload || {}, repos, login: effectiveLogin });
    lastDelivery = {
      event,
      action: info.action || null,
      repo: info.repo || null,
      pr: info.num ?? null,
      at: iso(now()),
      delivery_id: deliveryId || null,
      accepted: Boolean(info.accepted),
    };

    if (!info.accepted) {
      logger({ event: "delivery_ignored", delivery_id: deliveryId, reason: info.reason });
      return { status: 200, accepted: false, reason: info.reason, echo: Boolean(info.echo) };
    }

    if (info.kind === "ping") {
      logger({ event: "ping_received", delivery_id: deliveryId, repo: info.repo });
      const waiters = pingWaiters;
      pingWaiters = [];
      for (const waiter of waiters) waiter.resolve({ repo: info.repo, at: iso(now()) });
      return { status: 202, accepted: true, kind: "ping", repo: info.repo };
    }

    const key = keyOf(info.repo, info.num);
    logger({
      event: "delivery_accepted",
      delivery_id: deliveryId,
      event_name: event,
      action: info.action,
      key,
      closes_flow: Boolean(info.closesFlow),
    });

    if (info.closesFlow) {
      closeFlow(key, `PR ${info.repo}#${info.num} closed or merged`);
      return { status: 202, accepted: true, key, closesFlow: true };
    }
    if (closedFlows.has(key)) {
      logger({ event: "delivery_ignored", delivery_id: deliveryId, key, reason: "Flow is closed for this run" });
      return { status: 202, accepted: true, key, ignored: "flow closed" };
    }
    trackFlow(key);
    disarmExpectation(key, "a Delivery superseded the pending Expectation");
    scheduleDeliveryTick(key);
    return { status: 202, accepted: true, key };
  }

  // --- HTTP transport -------------------------------------------------------

  function health() {
    return {
      status: "ok",
      pid: process.pid,
      started_at: iso(startedAt),
      last_delivery: lastDelivery,
      tracked_flows: [...flows],
      pending_expectations: [...expectations.keys()],
    };
  }

  function handleRequest(req, res) {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/healthz/")) {
      const body = JSON.stringify(health());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    if (req.method === "POST" && (req.url === HOOK_PATH || req.url === `${HOOK_PATH}/`)) {
      let chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) tooLarge = true;
        else chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooLarge) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "body too large" }));
          return;
        }
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const event = String(req.headers["x-github-event"] || "");
        const deliveryId = String(req.headers["x-github-delivery"] || "");
        const signature = req.headers["x-hub-signature-256"] || "";
        if (!verifySignature(rawBody, signature, config.secret)) {
          logger({ event: "delivery_rejected", delivery_id: deliveryId, reason: "bad signature" });
          lastDelivery = { event, at: iso(now()), delivery_id: deliveryId, accepted: false, reason: "bad signature" };
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad signature" }));
          return;
        }
        let payload = null;
        if (rawBody) {
          try {
            payload = JSON.parse(rawBody);
          } catch {
            logger({ event: "delivery_rejected", delivery_id: deliveryId, reason: "malformed JSON" });
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "malformed JSON body" }));
            return;
          }
        }
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        setImmediate(() => {
          try {
            ingest({ event, deliveryId, payload, rawBody, signature, verify: false });
          } catch (e) {
            logger({ event: "delivery_failed", delivery_id: deliveryId, error: String(e?.message || e) });
          }
        });
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  async function start() {
    if (!effectiveLogin && gh) {
      try {
        const user = await gh(["user"]);
        if (user?.login) effectiveLogin = user.login;
      } catch (e) {
        logger({ event: "login_unresolved", error: String(e?.message || e) });
      }
    }
    if (!effectiveLogin) {
      logger({
        event: "echo_filter_disabled",
        message: "set PR_MONITOR_LOGIN or authenticate gh so the Listener can filter its own comments.",
      });
    }
    await new Promise((resolve, reject) => {
      server = http.createServer(handleRequest);
      server.on("error", (e) => {
        if (e?.code === "EADDRINUSE") {
          reject(new Error(`port ${config.port ?? DEFAULT_PORT} is already in use: another Listener is likely running (use --status/--stop).`));
        } else {
          reject(e);
        }
      });
      const host = config.host || DEFAULT_HOST;
      const port = config.port ?? DEFAULT_PORT;
      server.listen(port, host, () => {
        boundPort = server.address().port;
        logger({ event: "listener_started", host, port: boundPort });
        resolve();
      });
    });
    const seeded = await runStartupTick();
    if (seeded) maybeExit();
    return { host: config.host || DEFAULT_HOST, port: boundPort };
  }

  /** Runs the one Startup tick. Returns whether the tracked-Flow set is now
   * authoritative (a disabled or failed Startup tick means it is not, so the
   * Listener must stay up instead of exiting on an empty set). */
  async function runStartupTick() {
    if (config.startupTick === false) {
      logger({ event: "startup_tick_skipped" });
      restoreExpectations(new Set());
      return false;
    }
    logger({ event: "startup_tick_started", repos });
    const result = await runTick({ repos, reason: "startup", timeoutMs: tickTimeoutMs });
    if (!result?.ok) {
      logger({ event: "startup_tick_failed", error: result?.error || "unknown" });
      restoreExpectations(new Set());
      return false;
    }
    const touched = new Set();
    for (const report of result.reports || []) {
      if (!report.repo || !report.pr) continue;
      const key = keyOf(report.repo, report.pr);
      touched.add(key);
      if (report.terminal === "done") {
        closeFlow(key, "flow completed at startup");
      } else if (report.skipped) {
        trackFlow(key);
        disarmExpectation(key, "draft/WIP is quiescent");
      } else {
        trackFlow(key);
        if (report.next_check_at) armExpectation(key, Date.parse(report.next_check_at), 0, "startup_report");
        else disarmExpectation(key, "quiescent at startup");
      }
    }
    logger({ event: "startup_tick_finished", prs: (result.reports || []).length });
    restoreExpectations(touched, { authoritative: result.overall?.scope_fetch_failures === 0 });
    return true;
  }

  /** Re-arm Expectations that survived a restart. Keys the Startup tick just
   * reported are already fresh (fresh data wins) and are skipped. When the
   * Startup tick enumerated every open PR (no scope fetch failures), an
   * untouched key means its PR is no longer open: close the dead Flow. */
  function restoreExpectations(touched = new Set(), { authoritative = false } = {}) {
    for (const [key, entry] of Object.entries(state.expectations)) {
      if (touched.has(key) || closedFlows.has(key)) continue;
      if (authoritative) {
        closeFlow(key, "PR is no longer open (reconciled by the Startup tick)");
        continue;
      }
      const deadlineMs = Number(entry?.deadline_ms);
      if (!Number.isFinite(deadlineMs)) continue;
      const overdue = deadlineMs <= now();
      logger({ event: "expectation_restored", key, deadline_at: iso(deadlineMs), overdue });
      const { repo, num } = entry.repo && entry.num ? entry : parseKey(key);
      trackFlow(keyOf(repo, num));
      tickFailures.set(key, Number(entry.backoff_index) || 0);
      armExpectation(key, overdue ? now() : deadlineMs, Number(entry.backoff_index) || 0, "restored");
    }
  }

  function waitForPings(expectRepos, timeoutMs = DEFAULT_PING_WAIT_MS) {
    const pending = new Set(expectRepos);
    return new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => {
        pingWaiters = pingWaiters.filter((w) => w.resolve !== onPing);
        reject(new Error(`timed out waiting for GitHub ping Delivery from: ${[...pending].join(", ")}`));
      }, timeoutMs);
      const onPing = (info) => {
        if (info.repo) pending.delete(info.repo);
        if (pending.size > 0) return;
        clock.clearTimeout(timer);
        resolve([...expectRepos]);
      };
      pingWaiters.push({ resolve: onPing, reject });
    });
  }

  async function stop() {
    for (const [, timer] of debounces) clock.clearTimeout(timer);
    debounces.clear();
    for (const [, entry] of expectations) clock.clearTimeout(entry.timer);
    expectations.clear();
    // Pending Expectations stay in the state file on purpose: they must
    // survive a restart (only a Flow closing removes them).
    if (activeTickPromise) await activeTickPromise.catch(() => {});
    await notificationChain;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  }

  async function drain() {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!running && queue.length === 0 && pendingStarts === 0 && pendingNotifications === 0) {
        return;
      }
      if (activeTickPromise) await activeTickPromise.catch(() => {});
      await notificationChain;
    }
  }

  return {
    config: { host: config.host || DEFAULT_HOST, port: config.port ?? DEFAULT_PORT },
    ingest,
    start,
    stop,
    drain,
    health,
    waitForPings,
    handleRequest,
    get port() { return boundPort; },
    state,
    trackedFlows: () => [...flows],
    pendingExpectations: () => [...expectations.keys()],
    closeFlow,
    armExpectation,
    disarmExpectation,
  };
}

// ---------------------------------------------------------------------------
// GitHub Hook management
// ---------------------------------------------------------------------------

async function runGh(args) {
  try {
    const { stdout } = await execFileP("gh", ["api", ...args]);
    try {
      return JSON.parse(stdout);
    } catch {
      return stdout;
    }
  } catch (e) {
    throw new Error(`gh failed: ${args.join(" ")}\n${String(e.stderr || e.message).trim()}`);
  }
}

export function hookPayload({ publicUrl, secret }) {
  return {
    name: HOOK_NAME,
    active: true,
    events: [...SUBSCRIBED_EVENTS],
    config: {
      url: `${String(publicUrl).replace(/\/+$/, "")}${HOOK_PATH}`,
      content_type: "json",
      secret,
      insecure_ssl: "0",
    },
  };
}

export function findOurHook(hooks) {
  if (!Array.isArray(hooks)) return null;
  return hooks.find(
    (h) =>
      String(h?.name || "").startsWith(HOOK_NAME) &&
      String(h?.config?.url || "").includes(HOOK_PATH)
  ) || hooks.find((h) => String(h?.config?.url || "").includes(HOOK_PATH)) || null;
}

function ghHookArgs(payload) {
  return [
    "-f", `name=${payload.name}`,
    "-F", "active=true",
    "-f", `config[url]=${payload.config.url}`,
    "-f", `config[content_type]=${payload.config.content_type}`,
    "-f", `config[secret]=${payload.config.secret}`,
    "-f", `config[insecure_ssl]=${payload.config.insecure_ssl}`,
    ...payload.events.flatMap((event) => ["-f", `events[]=${event}`]),
  ];
}

export async function setupHook({
  repo,
  publicUrl,
  secret,
  state = emptyListenerState(),
  gh = runGh,
  fetchFn = globalThis.fetch,
  now = () => Date.now(),
  persistState = null,
  requireHealth = true,
} = {}) {
  if (!secret) throw new Error("PR_MONITOR_WEBHOOK_SECRET is required to set up a Hook.");
  if (!publicUrl) throw new Error("PR_MONITOR_PUBLIC_URL is required to set up a Hook.");
  const healthUrl = `${String(publicUrl).replace(/\/+$/, "")}/healthz`;
  if (requireHealth) {
    let response;
    try {
      response = await fetchFn(healthUrl);
    } catch (e) {
      throw new Error(
        `${healthUrl} is not reachable (${e?.message || e}). Fix public ingress or use cron mode ` +
          "(node pr_monitor.mjs) instead of the webhook Listener."
      );
    }
    if (!response?.ok) {
      throw new Error(
        `${healthUrl} answered ${response?.status ?? "no response"}: refusing to create a Hook GitHub ` +
          "cannot verify. Fix public ingress or use cron mode instead."
      );
    }
  }
  let id = state.hooks?.[repo]?.id || null;
  let created = false;
  if (!id) {
    const hooks = await gh([`repos/${repo}/hooks?per_page=100`]);
    const found = findOurHook(hooks);
    if (found) id = found.id;
  }
  const payload = hookPayload({ publicUrl, secret });
  if (id) {
    await gh([`repos/${repo}/hooks/${id}`, "-X", "PATCH", ...ghHookArgs(payload)]);
  } else {
    const hook = await gh([`repos/${repo}/hooks`, "-X", "POST", ...ghHookArgs(payload)]);
    id = hook?.id ?? null;
    created = true;
  }
  if (!id) throw new Error(`GitHub did not return a Hook id for ${repo}.`);
  state.hooks = state.hooks || {};
  state.hooks[repo] = { id, url: payload.config.url, updated_at: iso(now()) };
  if (persistState) persistState(state);
  await gh([`repos/${repo}/hooks/${id}/pings`, "-X", "POST"]);
  return { repo, id, created, url: payload.config.url };
}

export async function listHooks({ repos, gh = runGh, state = emptyListenerState() }) {
  const result = [];
  for (const repo of repos) {
    let hooks;
    try {
      hooks = await gh([`repos/${repo}/hooks?per_page=100`]);
    } catch (e) {
      result.push({ repo, error: String(e?.message || e) });
      continue;
    }
    const ours = (Array.isArray(hooks) ? hooks : []).filter(
      (h) => h.id === state.hooks?.[repo]?.id || findOurHook([h])
    );
    for (const hook of ours) {
      let deliveries = [];
      try {
        deliveries = await gh([`repos/${repo}/hooks/${hook.id}/deliveries?per_page=5`]);
      } catch {
        deliveries = [];
      }
      result.push({
        repo,
        id: hook.id,
        url: hook.config?.url || null,
        active: hook.active !== false,
        events: hook.events || [],
        recent_deliveries: (Array.isArray(deliveries) ? deliveries : []).map((d) => ({
          event: d.event || null,
          action: d.action || null,
          status: d.status || null,
          status_code: d.status_code ?? null,
          delivered_at: d.delivered_at || null,
        })),
      });
    }
  }
  return result;
}

export async function teardownHooks({ repos, gh = runGh, state = emptyListenerState(), persistState = null }) {
  const removed = [];
  for (const repo of repos) {
    let id = state.hooks?.[repo]?.id || null;
    if (!id) {
      try {
        id = findOurHook(await gh([`repos/${repo}/hooks?per_page=100`]))?.id || null;
      } catch {
        id = null;
      }
    }
    if (!id) continue;
    await gh([`repos/${repo}/hooks/${id}`, "-X", "DELETE"]);
    removed.push({ repo, id });
    if (state.hooks) delete state.hooks[repo];
  }
  if (persistState) persistState(state);
  return removed;
}

export function generateWebhookSecret() {
  return randomBytes(32).toString("hex");
}

export async function rotateSecret({
  repos,
  gh = runGh,
  state = emptyListenerState(),
  persistState = null,
  now = () => Date.now(),
} = {}) {
  const secret = generateWebhookSecret();
  const updated = [];
  for (const repo of repos) {
    let id = state.hooks?.[repo]?.id || null;
    if (!id) {
      try {
        id = findOurHook(await gh([`repos/${repo}/hooks?per_page=100`]))?.id || null;
      } catch {
        id = null;
      }
    }
    if (!id) continue;
    await gh([`repos/${repo}/hooks/${id}`, "-X", "PATCH", "-f", `config[secret]=${secret}`]);
    state.hooks = state.hooks || {};
    state.hooks[repo] = { ...(state.hooks[repo] || {}), id, updated_at: iso(now()) };
    updated.push({ repo, id });
  }
  if (persistState) persistState(state);
  return { secret, updated };
}

// ---------------------------------------------------------------------------
// Tunnel (dev convenience)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Owner notifications
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

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
  const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node pr_monitor_webhook.mjs <command> [options]

Commands:
  --serve            run the Listener in the foreground
  --daemon           detach the Listener (pid + log files)
  --stop             stop the detached Listener
  --status           report pid + health
  --setup-hooks      create/update the GitHub Hook(s) and ping them
  --list-hooks       list our Hook(s) and recent deliveries
  --teardown         remove our Hook(s)
  --rotate-secret    generate a new Hook secret and print the env line

Options:
  --keep-alive       keep serving when no active Flow remains
  --setup-hooks      with --serve: verify Hooks by waiting for GitHub's ping
  --tunnel <kind>    ngrok | cloudflared (dev convenience)
`;

export function parseListenerArgs(argv = []) {
  const flags = {
    command: null,
    setupHooks: false,
    keepAlive: false,
    rotateSecret: false,
    listHooks: false,
    teardown: false,
    tunnel: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--serve") flags.command = flags.command || "serve";
    else if (arg === "--daemon") flags.command = "daemon";
    else if (arg === "--stop") flags.command = "stop";
    else if (arg === "--status") flags.command = "status";
    else if (arg === "--setup-hooks") flags.setupHooks = true;
    else if (arg === "--rotate-secret") flags.rotateSecret = true;
    else if (arg === "--list-hooks") flags.listHooks = true;
    else if (arg === "--teardown") flags.teardown = true;
    else if (arg === "--keep-alive") flags.keepAlive = true;
    else if (arg === "--tunnel") {
      flags.tunnel = argv[++i];
      if (!flags.tunnel) throw new Error("--tunnel requires a value: ngrok or cloudflared");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return flags;
}

function resolveCommand(flags) {
  if (flags.command) return flags.command;
  if (flags.teardown) return "teardown";
  if (flags.listHooks) return "list-hooks";
  if (flags.rotateSecret) return "rotate-secret";
  if (flags.setupHooks) return "setup-hooks";
  return "help";
}

export function resolveListenerConfig({ env = process.env, flags = {} } = {}) {
  return {
    repos: splitRepos(env.PR_MONITOR_REPOS || ""),
    secret: env.PR_MONITOR_WEBHOOK_SECRET || "",
    host: env.PR_MONITOR_WEBHOOK_HOST || DEFAULT_HOST,
    port: Number(env.PR_MONITOR_WEBHOOK_PORT || DEFAULT_PORT),
    debounceMs: Number(env.PR_MONITOR_DEBOUNCE_MS || DEFAULT_DEBOUNCE_MS),
    tickTimeoutMs: Number(env.PR_MONITOR_TICK_TIMEOUT || DEFAULT_TICK_TIMEOUT_MS),
    publicUrl: env.PR_MONITOR_PUBLIC_URL || "",
    login: env.PR_MONITOR_LOGIN || "",
    notifyCmd: env.PR_MONITOR_NOTIFY_CMD || "",
    startupTick: env.PR_MONITOR_STARTUP_TICK !== "0",
    keepAlive: Boolean(flags.keepAlive),
    statePath: env.PR_MONITOR_WEBHOOK_STATE_PATH || defaultListenerStatePath(),
    pidPath: env.PR_MONITOR_WEBHOOK_PID_PATH || defaultPidPath(),
    logPath: defaultLogPath(),
    tunnel: flags.tunnel || null,
  };
}

function createJsonlLogger({ logPath = null } = {}) {
  let stream = null;
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    stream = fs.createWriteStream(logPath, { flags: "a" });
  }
  return {
    log: (entry) => {
      const line = JSON.stringify({ ts: iso(Date.now()), ...entry });
      process.stdout.write(`${line}\n`);
      stream?.write(`${line}\n`);
    },
    close: () => {
      try {
        stream?.end();
      } catch {
        // already closed
      }
    },
  };
}

function requireServeConfig(config) {
  if (!config.secret) {
    throw new Error(
      "PR_MONITOR_WEBHOOK_SECRET is required: refusing to serve an unauthenticated webhook. " +
        "Use --rotate-secret (or --setup-hooks) to generate/register one."
    );
  }
  if (config.repos.length === 0) {
    throw new Error("PR_MONITOR_REPOS is required: refusing to serve without a watched-repo filter.");
  }
}

async function commandServe({ flags, env = process.env }) {
  const config = resolveListenerConfig({ env, flags });
  requireServeConfig(config);
  claimPidFile(config.pidPath);
  const { log, close } = createJsonlLogger({ logPath: config.logPath });
  const state = loadListenerState(config.statePath);
  const persistState = (next) => saveListenerState(next, config.statePath);
  let tunnel = null;
  let listener = null;
  let shuttingDown = false;
  let resolveShutdown;
  const shutdownRequest = new Promise((resolve) => { resolveShutdown = resolve; });

  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ event: "shutdown", reason });
    tunnel?.stop?.();
    try {
      await listener?.stop();
    } catch (e) {
      log({ event: "shutdown_error", error: String(e?.message || e) });
    }
    removePidFile(config.pidPath, process.pid);
    close();
    resolveShutdown();
  }

  process.once("SIGINT", () => { shutdown("SIGINT"); });
  process.once("SIGTERM", () => { shutdown("SIGTERM"); });

  listener = createListener({
    config,
    state,
    persistState,
    logger: log,
    gh: runGh,
    notifier: (note) => runNotifyCmd({ cmd: config.notifyCmd, note }),
    onExit: () => { shutdown("idle"); },
  });

  const { port } = await listener.start();
  config.port = port;
  if (config.tunnel) {
    tunnel = await startTunnel({ kind: config.tunnel, port, logger: log });
    config.publicUrl = tunnel.url;
    log({ event: "tunnel_started", kind: config.tunnel, url: tunnel.url });
  }

  try {
    if (flags.setupHooks) {
      // Register the ping wait before setup POSTs the pings: GitHub can
      // deliver a ping before the HTTP round-trip returns.
      const pingsPromise = listener.waitForPings(config.repos);
      void pingsPromise.catch(() => {});
      for (const repo of config.repos) {
        const hook = await setupHook({
          repo,
          publicUrl: config.publicUrl,
          secret: config.secret,
          state,
          gh: runGh,
          persistState,
          now: Date.now,
        });
        log({ event: "hook_ready", ...hook });
        console.log(`hook ${hook.created ? "created" : "updated"} id=${hook.id} repo=${hook.repo} url=${hook.url}`);
      }
      const verified = await pingsPromise;
      log({ event: "hooks_verified", repos: verified });
      console.log(`✅ Hooks verified by GitHub ping: ${verified.join(", ")}`);
    } else if (!config.publicUrl) {
      log({
        event: "public_url_missing",
        message: "set PR_MONITOR_PUBLIC_URL (or use --tunnel) to manage the GitHub Hook",
      });
    }
    await shutdownRequest;
  } catch (e) {
    await shutdown("error");
    throw e;
  }
}

async function commandDaemon({ flags, env = process.env }) {
  const config = resolveListenerConfig({ env, flags });
  requireServeConfig(config);
  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error("PR_MONITOR_WEBHOOK_PORT must be a fixed port (not 0) for --daemon.");
  }
  const args = ["--serve"];
  if (flags.keepAlive) args.push("--keep-alive");
  if (flags.setupHooks) args.push("--setup-hooks");
  if (config.tunnel) args.push("--tunnel", config.tunnel);
  const result = await startDaemon({
    args,
    env,
    logPath: config.logPath,
    pidPath: config.pidPath,
    host: config.host,
    port: config.port,
  });
  if (!result.started) {
    console.error(result.error);
    process.exitCode = 1;
    return;
  }
  console.log(`Listener daemon started pid=${result.pid} log=${result.logPath}`);
}

async function commandStatus({ flags, env = process.env }) {
  const config = resolveListenerConfig({ env, flags });
  const status = await listenerStatus({ host: config.host, port: config.port, pidPath: config.pidPath });
  if (status.running) {
    console.log(`running pid=${status.pid} healthy=${status.healthy}`);
    if (status.health && !status.health.healthy) console.log(`health: ${JSON.stringify(status.health)}`);
  } else {
    console.log("not running");
    process.exitCode = 1;
  }
}

async function commandStop({ flags, env = process.env }) {
  const config = resolveListenerConfig({ env, flags });
  const result = await stopListenerProcess({ pidPath: config.pidPath });
  if (result.stopped) {
    console.log(`stopped pid=${result.pid}`);
    return;
  }
  console.log(`not stopped: ${result.reason}`);
  if (result.reason && !/^not running|^stale/.test(result.reason)) process.exitCode = 1;
}

async function commandSetupHooks({ flags, env = process.env }) {
  const config = resolveListenerConfig({ env, flags });
  requireServeConfig(config);
  if (!config.publicUrl) {
    throw new Error(
      "PR_MONITOR_PUBLIC_URL is required to set up Hooks (or start the Listener with --tunnel)."
    );
  }
  const state = loadListenerState(config.statePath);
  const persistState = (next) => saveListenerState(next, config.statePath);
  for (const repo of config.repos) {
    const hook = await setupHook({
      repo,
      publicUrl: config.publicUrl,
      secret: config.secret,
      state,
      gh: runGh,
      persistState,
      now: Date.now,
    });
    console.log(`hook ${hook.created ? "created" : "updated"} id=${hook.id} repo=${hook.repo} url=${hook.url}`);
  }
  console.log("Hooks set up. Start the Listener (--serve or --daemon); its /healthz will show the ping Delivery.");
}

async function commandListHooks({ env = process.env }) {
  const config = resolveListenerConfig({ env });
  requireServeConfig(config);
  const state = loadListenerState(config.statePath);
  const rows = await listHooks({ repos: config.repos, gh: runGh, state });
  console.log(JSON.stringify(rows, null, 2));
}

async function commandTeardown({ env = process.env }) {
  const config = resolveListenerConfig({ env });
  requireServeConfig(config);
  const state = loadListenerState(config.statePath);
  const removed = await teardownHooks({
    repos: config.repos,
    gh: runGh,
    state,
    persistState: (next) => saveListenerState(next, config.statePath),
  });
  if (removed.length === 0) console.log("no Hooks to remove");
  for (const hook of removed) console.log(`hook removed id=${hook.id} repo=${hook.repo}`);
}

async function commandRotateSecret({ env = process.env }) {
  const config = resolveListenerConfig({ env });
  requireServeConfig(config);
  const state = loadListenerState(config.statePath);
  const { secret, updated } = await rotateSecret({
    repos: config.repos,
    gh: runGh,
    state,
    persistState: (next) => saveListenerState(next, config.statePath),
    now: Date.now,
  });
  if (updated.length === 0) {
    console.log("no Hooks found to rotate; nothing to do");
    return;
  }
  for (const hook of updated) console.log(`hook secret rotated id=${hook.id} repo=${hook.repo}`);
  console.log("");
  console.log("Update the Host env and RESTART the Listener (it keeps the old secret in memory):");
  console.log(`PR_MONITOR_WEBHOOK_SECRET=${secret}`);
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseListenerArgs(argv);
  const command = resolveCommand(flags);
  switch (command) {
    case "serve":
      return commandServe({ flags });
    case "daemon":
      return commandDaemon({ flags });
    case "stop":
      return commandStop({ flags });
    case "status":
      return commandStatus({ flags });
    case "setup-hooks":
      return commandSetupHooks({ flags });
    case "list-hooks":
      return commandListHooks({ flags });
    case "teardown":
      return commandTeardown({ flags });
    case "rotate-secret":
      return commandRotateSecret({ flags });
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`⚠️ listener crashed: ${e.stack || e}`);
    process.exit(1);
  });
}
