import http from "node:http";
import { DELIVERY_LRU_SIZE, DEFAULT_DEBOUNCE_MS, DEFAULT_PING_WAIT_MS, DEFAULT_TICK_TIMEOUT_MS, TICK_BACKOFF_MS } from "./paths.mjs";
import { iso, keyOf, parseKey, verifySignature, classifyDelivery } from "./signature.mjs";
import { emptyListenerState } from "./state.mjs";
import { spawnTick } from "./tick-runner.mjs";
import { createOwnerNotifier } from "./notify.mjs";
import { createHttpTransport } from "./http-transport.mjs";

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
  const seenDeliveries = new Map(); // delivery id -> insertion order (LRU)
  let lastDelivery = null;
  let pingWaiters = [];
  let exitRequested = false;
  let server = null;
  let boundPort = null;

  const runTick = tickRunner || ((args) => spawnTick({ ...args, timeoutMs: tickTimeoutMs }));

  const ownerNotifier = createOwnerNotifier({ notifyCmd: config.notifyCmd, notifier, now, logger });

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
    await ownerNotifier.dispatch(report.owner_notifications, {
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



  const transport = createHttpTransport({
    secret: config.secret,
    ingest,
    health,
    logger,
    now,
    recordRejectedDelivery: (info) => { lastDelivery = info; },
  });


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
      server = http.createServer(transport.handleRequest);
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
    await ownerNotifier.drain();
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
        // A keep-alive client (the owner's curl, a probe) must never hold an
        // idle exit or a --stop open: the Flow bookkeeping is done, close
        // whatever connections remain.
        server.closeAllConnections?.();
      });
      server = null;
    }
  }

  async function drain() {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!running && queue.length === 0 && pendingStarts === 0 && ownerNotifier.pending === 0) {
        return;
      }
      if (activeTickPromise) await activeTickPromise.catch(() => {});
      await ownerNotifier.drain();
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
    handleRequest: transport.handleRequest,
    get port() { return boundPort; },
    state,
    trackedFlows: () => [...flows],
    pendingExpectations: () => [...expectations.keys()],
    closeFlow,
    armExpectation,
    disarmExpectation,
  };
}
