import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimPidFile,
  classifyDelivery,
  createListener,
  emptyListenerState,
  findOurHook,
  isPidAlive,
  listHooks,
  listenerStatus,
  loadListenerState,
  parseListenerArgs,
  parseTickOutput,
  readPidFile,
  removePidFile,
  resolveListenerConfig,
  rotateSecret,
  runNotifyCmd,
  saveListenerState,
  setupHook,
  spawnTick,
  startDaemon,
  startTunnel,
  stopListenerProcess,
  teardownHooks,
  verifySignature,
} from "../src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(__dirname, "..", "..");
const WEBHOOK_SCRIPT = path.join(SKILL_DIR, "pr_monitor_webhook.mjs");
const HARNESS_BIN = path.join(SKILL_DIR, "harness", "bin");
const REPO = "dyegolara/skillbook";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeClock(startMs = 1_700_000_000_000) {
  let nowMs = startMs;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, at: nowMs + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    advance: (ms) => {
      const target = nowMs + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        nowMs = Math.max(nowMs, timer.at);
        timer.fn();
      }
      nowMs = target;
    },
    pending: () => timers.size,
  };
}

function makeConfig(overrides = {}) {
  return {
    repos: [REPO],
    secret: "test-secret",
    host: "127.0.0.1",
    port: 0,
    debounceMs: 30_000,
    tickTimeoutMs: 5 * 60_000,
    startupTick: false,
    keepAlive: false,
    login: "own-bot",
    ...overrides,
  };
}

function prReport(num, overrides = {}) {
  return {
    type: "pr",
    repo: REPO,
    pr: num,
    title: "Test PR",
    head_sha: `sha-${num}`,
    action: "wait",
    reason: "wait",
    done: false,
    terminal: null,
    skipped: false,
    next_check_at: null,
    owner_notifications: [],
    ...overrides,
  };
}

function makeTickRunner(script = []) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const next = script.shift();
    if (typeof next === "function") return next(args);
    return next || {
      ok: true,
      reports: [prReport(args.num)],
      overall: { type: "overall", done: false },
    };
  };
  run.calls = calls;
  return run;
}

function signedBody(secret, payload, { event = "pull_request", deliveryId = "delivery-1" } = {}) {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
  };
}

async function postDelivery(port, secret, payload, options = {}) {
  const { body, headers } = signedBody(secret, payload, options);
  const response = await fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: "POST",
    headers,
    body,
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

function prOpenedPayload(num = 7, repo = REPO, sender = "alice") {
  return {
    action: "opened",
    number: num,
    pull_request: { number: num },
    repository: { full_name: repo },
    sender: { login: sender },
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitFor(predicate, timeoutMs = 10_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function writeStubGh(dir, { hooks = [], createdId = 42 } = {}) {
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const fs = require("node:fs");
const path = require("node:path");
const logPath = process.env.STUB_GH_LOG;
if (logPath) fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
const endpoint = args[1] || "";
const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
const send = (value) => { process.stdout.write(JSON.stringify(value) + "\\n"); };
if (endpoint === "user") { send({ login: "own-bot" }); process.exit(0); }
if (method === "DELETE") { send({}); process.exit(0); }
if (method === "POST" && /hooks$/.test(endpoint)) { send({ id: ${createdId} }); process.exit(0); }
if (method === "POST") { send({}); process.exit(0); }
if (/hooks\\?per_page=100$/.test(endpoint)) { send(${JSON.stringify(hooks)}); process.exit(0); }
if (/deliveries/.test(endpoint)) { send([{ event: "pull_request", action: "opened", status: "OK", status_code: 202, delivered_at: "2026-09-08T00:00:00Z" }]); process.exit(0); }
send({});
`;
  const bin = path.join(dir, "gh");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return bin;
}

// ---------------------------------------------------------------------------
// #30 — Listener tracer
// ---------------------------------------------------------------------------

test("listener refuses to start without secret or watched repos", () => {
  assert.throws(() => createListener({ config: makeConfig({ secret: "" }) }), /PR_MONITOR_WEBHOOK_SECRET/);
  assert.throws(() => createListener({ config: makeConfig({ repos: [] }) }), /PR_MONITOR_REPOS/);
});

test("verifySignature accepts only the correct HMAC-SHA256", () => {
  const body = '{"hello":"world"}';
  const good = createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(verifySignature(body, `sha256=${good}`, "s3cret"), true);
  assert.equal(verifySignature(body, `sha256=${good}`, "other"), false);
  assert.equal(verifySignature(body, "", "s3cret"), false);
  assert.equal(verifySignature(body, "sha256=deadbeef", "s3cret"), false);
  assert.equal(verifySignature(body, "sha1=whatever", "s3cret"), false);
});

test("classifyDelivery filters events, repos, PR-ness and Echo", () => {
  assert.equal(classifyDelivery({ event: "pull_request", payload: prOpenedPayload(), repos: [REPO] }).accepted, true);
  assert.match(
    classifyDelivery({ event: "pull_request", payload: prOpenedPayload(7, "other/repo"), repos: [REPO] }).reason,
    /not watched/
  );
  assert.match(classifyDelivery({ event: "ping", payload: {} }).kind, /ping/);
  const labeled = { ...prOpenedPayload(), action: "labeled" };
  assert.match(classifyDelivery({ event: "pull_request", payload: labeled, repos: [REPO] }).reason, /not subscribed/);
  const nonPrComment = classifyDelivery({
    event: "issue_comment",
    payload: { action: "created", issue: { number: 3 }, repository: { full_name: REPO }, sender: { login: "alice" } },
    repos: [REPO],
  });
  assert.equal(nonPrComment.accepted, false, "issue_comment on a non-PR is ignored");
  assert.match(nonPrComment.reason, /not on a pull request/);
  const echo = classifyDelivery({
    event: "pull_request",
    payload: prOpenedPayload(7, REPO, "own-bot"),
    repos: [REPO],
    login: "own-bot",
  });
  assert.equal(echo.accepted, false);
  assert.equal(echo.echo, true);
  const copilot = classifyDelivery({
    event: "pull_request",
    payload: prOpenedPayload(7, REPO, "copilot-swe-agent[bot]"),
    repos: [REPO],
    login: "own-bot",
  });
  assert.equal(copilot.accepted, true);
});

test("a valid signed Delivery gets 202 and wakes exactly one Tick scoped to its PR", async (t) => {
  const clock = makeClock();
  const tickRunner = makeTickRunner();
  const listener = createListener({ config: makeConfig(), now: clock.now, clock, tickRunner });

  await listener.start();
  t.after(() => listener.stop());
  const result = await postDelivery(listener.port, "test-secret", prOpenedPayload(7));
  assert.equal(result.status, 202);
  assert.equal(tickRunner.calls.length, 0, "processing happens after the response");

  clock.advance(30_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 1);
  assert.equal(tickRunner.calls[0].repo, REPO);
  assert.equal(tickRunner.calls[0].num, 7);
});

test("bad or missing signature gets 401 and never ticks; malformed JSON gets 400", async (t) => {
  const clock = makeClock();
  const tickRunner = makeTickRunner();
  const listener = createListener({ config: makeConfig(), now: clock.now, clock, tickRunner });
  await listener.start();
  t.after(() => listener.stop());

  const unsigned = await fetch(`http://127.0.0.1:${listener.port}/github/webhook`, {
    method: "POST",
    headers: { "x-github-event": "pull_request" },
    body: JSON.stringify(prOpenedPayload(7)),
  });
  assert.equal(unsigned.status, 401);

  const { body, headers } = signedBody("test-secret", prOpenedPayload(8));
  const bad = await fetch(`http://127.0.0.1:${listener.port}/github/webhook`, {
    method: "POST",
    headers: { ...headers, "x-hub-signature-256": "sha256=deadbeef" },
    body,
  });
  assert.equal(bad.status, 401);

  const malformedBody = "{not json";
  const malformed = await fetch(`http://127.0.0.1:${listener.port}/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "malformed-1",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret").update(malformedBody).digest("hex")}`,
    },
    body: malformedBody,
  });
  assert.equal(malformed.status, 400);

  clock.advance(60_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 0);
});

test("deliveries outside the watched repos or event set are acknowledged, ignored and logged", async (t) => {
  const clock = makeClock();
  const tickRunner = makeTickRunner();
  const logged = [];
  const listener = createListener({
    config: makeConfig(),
    now: clock.now,
    clock,
    tickRunner,
    logger: (entry) => logged.push(entry),
  });
  await listener.start();
  t.after(() => listener.stop());

  const otherRepo = await postDelivery(listener.port, "test-secret", prOpenedPayload(7, "other/repo"));
  assert.equal(otherRepo.status, 202);
  assert.equal(otherRepo.json.ok, true);

  const labeled = await postDelivery(listener.port, "test-secret", {
    ...prOpenedPayload(7),
    action: "labeled",
  }, { deliveryId: "labeled-1" });
  assert.equal(labeled.status, 202);

  clock.advance(60_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 0);
  assert.ok(logged.some((entry) => entry.event === "delivery_ignored" && /not watched/.test(entry.reason)));
  assert.ok(logged.some((entry) => entry.event === "delivery_ignored" && /not subscribed/.test(entry.reason)));
});

test("healthz reports liveness and the last Delivery without any secret", async (t) => {
  const clock = makeClock();
  const listener = createListener({ config: makeConfig(), now: clock.now, clock, tickRunner: makeTickRunner() });
  await listener.start();
  t.after(() => listener.stop());

  const empty = await (await fetch(`http://127.0.0.1:${listener.port}/healthz`)).json();
  assert.equal(empty.status, "ok");
  assert.equal(empty.last_delivery, null);

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7));
  clock.advance(30_000);
  await listener.drain();
  const health = await (await fetch(`http://127.0.0.1:${listener.port}/healthz`)).json();
  assert.equal(health.last_delivery.repo, REPO);
  assert.equal(health.last_delivery.pr, 7);
  assert.equal(health.last_delivery.accepted, true);
  assert.ok(!JSON.stringify(health).includes("test-secret"));
});

test("parseTickOutput reads the PR and overall JSON lines", () => {
  const stdout = [
    "human notification line",
    JSON.stringify(prReport(3)),
    JSON.stringify({ type: "overall", done: false }),
  ].join("\n");
  const { reports, overall } = parseTickOutput(stdout);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].pr, 3);
  assert.equal(overall.type, "overall");
});

test("spawnTick kills a child that exceeds PR_MONITOR_TICK_TIMEOUT and marks it failed", async () => {
  const clock = makeClock();
  const killed = [];
  const fakeChild = {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on(event, handler) {
      if (event === "close") this._close = handler;
      return this;
    },
    kill(signal) {
      killed.push(signal);
      this._close?.(-1);
    },
  };
  const resultPromise = spawnTick({
    repo: REPO,
    num: 7,
    timeoutMs: 1000,
    clock,
    spawnFn: () => fakeChild,
  });
  clock.advance(1000);
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.deepEqual(killed, ["SIGKILL"]);
});

// ---------------------------------------------------------------------------
// #32 — Delivery coalescing
// ---------------------------------------------------------------------------

test("a burst of deliveries within PR_MONITOR_DEBOUNCE_MS collapses into one Tick", async (t) => {
  const clock = makeClock();
  const tickRunner = makeTickRunner();
  const listener = createListener({ config: makeConfig({ debounceMs: 30_000 }), now: clock.now, clock, tickRunner });
  await listener.start();
  t.after(() => listener.stop());

  for (let i = 0; i < 3; i++) {
    await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: `burst-${i}` });
  }
  clock.advance(29_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 0);

  clock.advance(1_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 1);
});

test("while a Tick is in flight at most one re-Tick is queued per PR; ticks never overlap", async (t) => {
  const clock = makeClock();
  const calls = [];
  let release;
  let concurrent = 0;
  let maxConcurrent = 0;
  const tickRunner = async (args) => {
    calls.push(args);
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    try {
      if (calls.length === 1) {
        return await new Promise((resolve) => { release = resolve; });
      }
      return { ok: true, reports: [prReport(7)], overall: {} };
    } finally {
      concurrent--;
    }
  };
  const listener = createListener({ config: makeConfig(), now: clock.now, clock, tickRunner });
  await listener.start();
  t.after(() => listener.stop());

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "flight-1" });
  clock.advance(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, "first tick is in flight");

  for (const id of ["flight-2", "flight-3", "flight-4"]) {
    await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: id });
    clock.advance(30_000);
  }
  release({ ok: true, reports: [prReport(7)], overall: {} });
  await listener.drain();

  assert.equal(calls.length, 2);
  assert.equal(maxConcurrent, 1);
});

test("Echo deliveries from our own login are ignored; Copilot is never filtered", async (t) => {
  const clock = makeClock();
  const tickRunner = makeTickRunner();
  const listener = createListener({ config: makeConfig({ login: "own-bot" }), now: clock.now, clock, tickRunner });
  await listener.start();
  t.after(() => listener.stop());

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7, REPO, "own-bot"), { deliveryId: "echo-1" });
  clock.advance(30_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 0);

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7, REPO, "copilot-swe-agent[bot]"), {
    deliveryId: "copilot-1",
  });
  clock.advance(30_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 1);
});

test("duplicate X-GitHub-Delivery ids are dropped (in-memory LRU)", async (t) => {
  const clock = makeClock();
  const tickRunner = makeTickRunner();
  const listener = createListener({ config: makeConfig(), now: clock.now, clock, tickRunner });
  await listener.start();
  t.after(() => listener.stop());

  for (let i = 0; i < 2; i++) {
    await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "same-id" });
  }
  clock.advance(30_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 1);
});

// ---------------------------------------------------------------------------
// #34 — Expectations
// ---------------------------------------------------------------------------

test("tick report arms the Expectation, a Delivery cancels it, expiry runs exactly one Fallback tick", async (t) => {
  const clock = makeClock();
  const futureIso = () => new Date(clock.now() + 3_600_000).toISOString();
  const tickRunner = makeTickRunner([
    () => ({ ok: true, reports: [prReport(7, { next_check_at: futureIso() })], overall: {} }),
    () => ({ ok: true, reports: [prReport(7, { next_check_at: futureIso() })], overall: {} }),
    () => ({ ok: true, reports: [prReport(7, { next_check_at: null })], overall: {} }),
  ]);
  const listener = createListener({ config: makeConfig(), now: clock.now, clock, tickRunner });
  await listener.start();
  t.after(() => listener.stop());

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "exp-1" });
  clock.advance(30_000);
  await listener.drain();
  assert.deepEqual(listener.pendingExpectations(), [`${REPO}#7`]);

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "exp-2" });
  assert.deepEqual(listener.pendingExpectations(), [], "a Delivery cancels the pending Expectation");
  clock.advance(30_000);
  await listener.drain();
  assert.deepEqual(listener.pendingExpectations(), [`${REPO}#7`], "the following report re-arms");

  clock.advance(3_600_000);
  await listener.drain();
  assert.deepEqual(tickRunner.calls.map((call) => call.reason), ["delivery", "delivery", "fallback"]);
  assert.deepEqual(listener.pendingExpectations(), [], "a quiescent report disarms");

  clock.advance(24 * 3_600_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 3, "no periodic sweep after the Fallback tick");
});

test("failed ticks re-arm with 1 → 5 → 15 min, then hourly backoff", async (t) => {
  const clock = makeClock();
  const tickRunner = makeTickRunner([
    { ok: false, error: "boom 1" },
    { ok: false, error: "boom 2" },
    { ok: false, error: "boom 3" },
    { ok: false, error: "boom 4" },
    { ok: false, error: "boom 5" },
  ]);
  const logged = [];
  const listener = createListener({
    config: makeConfig(),
    now: clock.now,
    clock,
    tickRunner,
    logger: (entry) => logged.push(entry),
  });
  await listener.start();
  t.after(() => listener.stop());

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "fail-1" });
  clock.advance(30_000);
  await listener.drain();
  for (const delay of [60_000, 300_000, 900_000, 3_600_000]) {
    clock.advance(delay);
    await listener.drain();
  }
  const armed = logged.filter((entry) => entry.event === "expectation_armed");
  assert.deepEqual(
    armed.map((entry) => entry.delay_ms),
    [60_000, 300_000, 900_000, 3_600_000, 3_600_000]
  );
  assert.ok(armed.every((entry) => entry.origin === "tick_failure" || entry.origin === "restored"));
  assert.ok(logged.some((entry) => entry.event === "tick_failed"));
});

test("a pending Expectation never blocks the queue for other PRs", async (t) => {
  const clock = makeClock();
  const tickRunner = makeTickRunner([
    () => ({ ok: true, reports: [prReport(7, { next_check_at: new Date(clock.now() + 3_600_000).toISOString() })], overall: {} }),
    () => ({ ok: true, reports: [prReport(8)], overall: {} }),
  ]);
  const listener = createListener({ config: makeConfig(), now: clock.now, clock, tickRunner });
  await listener.start();
  t.after(() => listener.stop());

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "nb-1" });
  clock.advance(30_000);
  await listener.drain();

  await postDelivery(listener.port, "test-secret", prOpenedPayload(8), { deliveryId: "nb-2" });
  clock.advance(30_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 2);
  assert.equal(tickRunner.calls[1].num, 8);
  assert.deepEqual(listener.pendingExpectations(), [`${REPO}#7`]);
});

// ---------------------------------------------------------------------------
// #35 — Listener lifecycle
// ---------------------------------------------------------------------------

test("Startup tick seeds tracked Flows and arms their Expectations; done Flows do not track", async (t) => {
  const clock = makeClock();
  const futureIso = () => new Date(clock.now() + 3_600_000).toISOString();
  const tickRunner = makeTickRunner([
    () => ({
      ok: true,
      reports: [
        prReport(5, { next_check_at: futureIso() }),
        prReport(6, { action: "notify_ready", done: true, terminal: "done" }),
      ],
      overall: { type: "overall", done: false },
    }),
  ]);
  const listener = createListener({ config: makeConfig({ startupTick: true }), now: clock.now, clock, tickRunner });
  t.after(() => listener.stop());
  await listener.start();

  assert.deepEqual(tickRunner.calls[0].repos, [REPO]);
  assert.deepEqual(listener.trackedFlows(), [`${REPO}#5`]);
  assert.deepEqual(listener.pendingExpectations(), [`${REPO}#5`]);
});

test("a failed Startup tick is logged and does not prevent serving", async (t) => {
  const clock = makeClock();
  const logged = [];
  const tickRunner = makeTickRunner([{ ok: false, error: "gh exploded" }]);
  const exits = [];
  const listener = createListener({
    config: makeConfig({ startupTick: true }),
    now: clock.now,
    clock,
    tickRunner,
    logger: (entry) => logged.push(entry),
    onExit: () => exits.push("exit"),
  });
  await listener.start();
  t.after(() => listener.stop());

  assert.ok(logged.some((entry) => entry.event === "startup_tick_failed"));
  const health = await (await fetch(`http://127.0.0.1:${listener.port}/healthz`)).json();
  assert.equal(health.status, "ok");
  assert.equal(exits.length, 0, "a failed startup must not trigger an idle exit");
});

test("stop() is not held open by a keep-alive client connection", async (t) => {
  const clock = makeClock();
  const listener = createListener({ config: makeConfig(), now: clock.now, clock, tickRunner: makeTickRunner() });
  await listener.start();
  t.after(() => listener.stop());

  // postDelivery uses undici, whose keep-alive socket stays open after the
  // 202. An idle exit or --stop must not wait for it.
  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "ka-1" });

  let stopped = false;
  const stopPromise = listener.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(stopped, true, "a keep-alive client must not block shutdown");
  await stopPromise;
});

test("Notify-ready closes the Flow; with nothing left the Listener exits", async (t) => {
  const clock = makeClock();
  const tickRunner = makeTickRunner([
    { ok: true, reports: [prReport(7, { action: "notify_ready", done: true, terminal: "done" })], overall: {} },
  ]);
  const exits = [];
  const listener = createListener({
    config: makeConfig(),
    now: clock.now,
    clock,
    tickRunner,
    onExit: (reason) => exits.push(reason),
  });
  await listener.start();
  t.after(() => listener.stop());

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "done-1" });
  clock.advance(30_000);
  await listener.drain();
  assert.deepEqual(listener.trackedFlows(), []);
  assert.equal(exits.length, 1);
  assert.deepEqual(listener.pendingExpectations(), []);
});

test("needs-human keeps the Flow open with its weekly retry armed", async (t) => {
  const clock = makeClock();
  const futureIso = () => new Date(clock.now() + 168 * 3_600_000).toISOString();
  const tickRunner = makeTickRunner([
    () => ({
      ok: true,
      reports: [prReport(7, {
        action: "wait",
        done: true,
        terminal: "needs-human",
        next_check_at: futureIso(),
        owner_notifications: [{ event: "escalation", message: "stuck" }],
      })],
      overall: {},
    }),
  ]);
  const listener = createListener({ config: makeConfig(), now: clock.now, clock, tickRunner });
  await listener.start();
  t.after(() => listener.stop());

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "nh-1" });
  clock.advance(30_000);
  await listener.drain();
  assert.deepEqual(listener.trackedFlows(), [`${REPO}#7`]);
  assert.deepEqual(listener.pendingExpectations(), [`${REPO}#7`]);
});

test("drafts stay tracked and quiescent; ready_for_review wakes them", async (t) => {
  const clock = makeClock();
  const tickRunner = makeTickRunner([
    { ok: true, reports: [prReport(7, { action: "skip_wip", done: true, terminal: "skipped", skipped: true })], overall: {} },
    { ok: true, reports: [prReport(7, { next_check_at: new Date(clock.now() + 3_600_000).toISOString() })], overall: {} },
  ]);
  const listener = createListener({ config: makeConfig(), now: clock.now, clock, tickRunner });
  await listener.start();
  t.after(() => listener.stop());

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "draft-1" });
  clock.advance(30_000);
  await listener.drain();
  assert.deepEqual(listener.trackedFlows(), [`${REPO}#7`]);
  assert.deepEqual(listener.pendingExpectations(), []);

  const ready = { ...prOpenedPayload(7), action: "ready_for_review" };
  await postDelivery(listener.port, "test-secret", ready, { deliveryId: "draft-2" });
  clock.advance(30_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 2);
  assert.deepEqual(listener.pendingExpectations(), [`${REPO}#7`]);
});

test("a PR closed Delivery closes its Flow without a Tick, and later Deliveries are ignored", async (t) => {
  const clock = makeClock();
  const futureIso = () => new Date(clock.now() + 3_600_000).toISOString();
  const tickRunner = makeTickRunner([
    () => ({ ok: true, reports: [prReport(7, { next_check_at: futureIso() })], overall: {} }),
  ]);
  const exits = [];
  const listener = createListener({
    config: makeConfig(),
    now: clock.now,
    clock,
    tickRunner,
    onExit: () => exits.push("exit"),
  });
  await listener.start();
  t.after(() => listener.stop());

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "open-1" });
  clock.advance(30_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 1);

  const closed = { ...prOpenedPayload(7), action: "closed" };
  await postDelivery(listener.port, "test-secret", closed, { deliveryId: "closed-1" });
  clock.advance(30_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 1, "closing a PR must not tick");
  assert.deepEqual(listener.trackedFlows(), []);
  assert.equal(exits.length, 1);

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "open-2" });
  clock.advance(30_000);
  await listener.drain();
  assert.equal(tickRunner.calls.length, 1, "a closed Flow ignores later Deliveries");
});

test("--keep-alive keeps serving when no active Flow remains", async (t) => {
  const clock = makeClock();
  const tickRunner = makeTickRunner([
    { ok: true, reports: [prReport(7, { action: "notify_ready", done: true, terminal: "done" })], overall: {} },
  ]);
  const exits = [];
  const listener = createListener({
    config: makeConfig({ keepAlive: true }),
    now: clock.now,
    clock,
    tickRunner,
    onExit: () => exits.push("exit"),
  });
  await listener.start();
  t.after(() => listener.stop());

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "ka-1" });
  clock.advance(30_000);
  await listener.drain();
  assert.deepEqual(listener.trackedFlows(), []);
  assert.equal(exits.length, 0);
  const health = await (await fetch(`http://127.0.0.1:${listener.port}/healthz`)).json();
  assert.equal(health.status, "ok");
});

// ---------------------------------------------------------------------------
// #33 — Hook management
// ---------------------------------------------------------------------------

function makeHookGh({ hooks = [], createId = 77 } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const endpoint = args[0];
    if (/hooks\?per_page=100$/.test(endpoint)) return hooks;
    if (/\/pings$/.test(endpoint)) return {};
    if (args.includes("POST") && /hooks$/.test(endpoint)) return { id: createId };
    if (args.includes("DELETE")) return {};
    if (args.includes("PATCH")) return {};
    if (/deliveries/.test(endpoint)) {
      return [{ event: "pull_request", action: "opened", status: "OK", status_code: 202, delivered_at: "2026-09-08T00:00:00Z" }];
    }
    return {};
  };
  gh.calls = calls;
  return gh;
}

const PROBE_OK = async () => ({ ok: true, status: 200, json: async () => ({ status: "ok" }) });

test("setupHook creates by absent and binds the id; a URL change updates the same Hook", async () => {
  const state = emptyListenerState();
  const gh = makeHookGh({ hooks: [], createId: 77 });
  const first = await setupHook({
    repo: REPO,
    publicUrl: "https://old.example.com",
    secret: "s3cret",
    state,
    gh,
    fetchFn: PROBE_OK,
  });
  assert.equal(first.created, true);
  assert.equal(first.id, 77);
  assert.equal(state.hooks[REPO].id, 77);

  const createCall = gh.calls.find((args) => args.includes("POST") && /hooks$/.test(args[0]));
  const joined = createCall.join(" ");
  assert.match(joined, /config\[url\]=https:\/\/old\.example\.com\/github\/webhook/);
  assert.match(joined, /config\[content_type\]=json/);
  assert.match(joined, /config\[secret\]=s3cret/);
  assert.match(joined, /events\[\]=pull_request/);
  assert.ok(gh.calls.some((args) => /\/pings$/.test(args[0])), "setup pings the Hook");

  gh.calls.length = 0;
  const second = await setupHook({
    repo: REPO,
    publicUrl: "https://new.example.com",
    secret: "s3cret",
    state,
    gh,
    fetchFn: PROBE_OK,
  });
  assert.equal(second.created, false);
  assert.equal(second.id, 77);
  assert.ok(gh.calls.some((args) => /hooks\/77$/.test(args[0]) && args.includes("PATCH")), "updates by id");
  assert.ok(!gh.calls.some((args) => args.includes("POST") && /hooks$/.test(args[0])), "never creates a duplicate");
  assert.equal(state.hooks[REPO].url, "https://new.example.com/github/webhook");
});

test("setupHook adopts an existing Hook by name when state has no id", async () => {
  const state = emptyListenerState();
  const gh = makeHookGh({
    hooks: [{ id: 9, name: "copilot-review-smart (pr-monitor)", active: true, config: { url: "https://old/github/webhook" } }],
  });
  const result = await setupHook({
    repo: REPO,
    publicUrl: "https://new.example.com",
    secret: "s3cret",
    state,
    gh,
    fetchFn: PROBE_OK,
  });
  assert.equal(result.id, 9);
  assert.equal(result.created, false);
  assert.ok(gh.calls.some((args) => /hooks\/9$/.test(args[0]) && args.includes("PATCH")));
});

test("setupHook refuses to create a Hook when the public URL does not answer /healthz", async () => {
  const gh = makeHookGh();
  await assert.rejects(
    setupHook({
      repo: REPO,
      publicUrl: "https://down.example.com",
      secret: "s3cret",
      state: emptyListenerState(),
      gh,
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    }),
    /cron mode/i
  );
  await assert.rejects(
    setupHook({
      repo: REPO,
      publicUrl: "https://down.example.com",
      secret: "s3cret",
      state: emptyListenerState(),
      gh,
      fetchFn: async () => ({ ok: false, status: 502 }),
    }),
    /cron mode/i
  );
  assert.equal(gh.calls.length, 0, "no Hook is created when the URL cannot be verified");
});

test("listHooks shows our Hooks and their recent delivery status", async () => {
  const gh = makeHookGh({
    hooks: [
      { id: 77, name: "copilot-review-smart (pr-monitor)", active: true, events: ["pull_request"], config: { url: "https://x/github/webhook" } },
      { id: 78, name: "someone else", active: true, config: { url: "https://y/other" } },
    ],
  });
  const rows = await listHooks({ repos: [REPO], gh, state: emptyListenerState() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 77);
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].recent_deliveries[0].status, "OK");
});

test("teardownHooks removes by bound id and clears the state; rotateSecret replaces the secret", async () => {
  const state = emptyListenerState();
  state.hooks[REPO] = { id: 77 };
  const gh = makeHookGh();
  const removed = await teardownHooks({ repos: [REPO], gh, state });
  assert.deepEqual(removed, [{ repo: REPO, id: 77 }]);
  assert.equal(state.hooks[REPO], undefined);
  assert.ok(gh.calls.some((args) => /hooks\/77$/.test(args[0]) && args.includes("DELETE")));

  const rotateGh = makeHookGh();
  const rotateState = emptyListenerState();
  rotateState.hooks[REPO] = { id: 77 };
  const { secret, updated } = await rotateSecret({ repos: [REPO], gh: rotateGh, state: rotateState });
  assert.ok(secret.length >= 32);
  assert.deepEqual(updated, [{ repo: REPO, id: 77 }]);
  const patch = rotateGh.calls.find((args) => args.includes("PATCH") && /hooks\/77$/.test(args[0]));
  assert.ok(patch.join(" ").includes(`config[secret]=${secret}`));
});

test("--serve --setup-hooks verifies success only after GitHub's ping Delivery arrives", async (t) => {
  const clock = makeClock();
  const listener = createListener({
    config: makeConfig(),
    now: clock.now,
    clock,
    tickRunner: makeTickRunner(),
  });
  await listener.start();
  t.after(() => listener.stop());

  const waiting = listener.waitForPings([REPO], 5_000);
  await new Promise((resolve) => setImmediate(resolve));
  await postDelivery(listener.port, "test-secret", { zen: "Design for failure.", hook_id: 1, repository: { full_name: REPO } }, {
    event: "ping",
    deliveryId: "ping-1",
  });
  assert.deepEqual(await waiting, [REPO]);
});

// ---------------------------------------------------------------------------
// #36 — Persistence across restarts
// ---------------------------------------------------------------------------

function makeRuntimeDir(prefix = "webhook-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("pending Expectations survive a restart and fire at the original deadline", async (t) => {
  const clock = makeClock();
  const dir = makeRuntimeDir();
  const statePath = path.join(dir, "listener-state.json");
  const futureIso = new Date(clock.now() + 3_600_000).toISOString();
  const instances = [];
  t.after(async () => {
    for (const instance of instances) await instance.stop().catch(() => {});
  });

  const runnerA = makeTickRunner([
    () => ({ ok: true, reports: [prReport(7, { next_check_at: futureIso })], overall: {} }),
  ]);
  const a = createListener({
    config: makeConfig(),
    now: clock.now,
    clock,
    tickRunner: runnerA,
    state: emptyListenerState(),
    persistState: (state) => saveListenerState(state, statePath),
  });
  instances.push(a);
  await a.start();
  a.ingest({ event: "pull_request", deliveryId: "restart-1", payload: prOpenedPayload(7), verify: false });
  clock.advance(30_000);
  await a.drain();
  assert.equal(loadListenerState(statePath).expectations[`${REPO}#7`].deadline_ms, Date.parse(futureIso));
  await a.stop();

  const runnerB = makeTickRunner();
  const b = createListener({
    config: makeConfig(),
    now: clock.now,
    clock,
    tickRunner: runnerB,
    state: loadListenerState(statePath),
    persistState: (state) => saveListenerState(state, statePath),
  });
  instances.push(b);
  await b.start();
  assert.deepEqual(b.pendingExpectations(), [`${REPO}#7`]);
  assert.deepEqual(b.trackedFlows(), [`${REPO}#7`]);

  const remaining = Date.parse(futureIso) - clock.now();
  clock.advance(remaining - 1);
  await b.drain();
  assert.equal(runnerB.calls.length, 0);
  clock.advance(1);
  await b.drain();
  assert.equal(runnerB.calls.length, 1);
  assert.equal(runnerB.calls[0].reason, "fallback");
});

test("an overdue restored Expectation fires a Fallback tick right after startup", async () => {
  const clock = makeClock();
  const dir = makeRuntimeDir();
  const statePath = path.join(dir, "listener-state.json");
  const state = emptyListenerState();
  state.expectations[`${REPO}#7`] = {
    repo: REPO,
    num: 7,
    deadline_ms: clock.now() - 60_000,
    backoff_index: 0,
    origin: "tick_report",
  };
  saveListenerState(state, statePath);

  const runner = makeTickRunner();
  const listener = createListener({
    config: makeConfig(),
    now: clock.now,
    clock,
    tickRunner: runner,
    state: loadListenerState(statePath),
    persistState: (next) => saveListenerState(next, statePath),
  });
  await listener.start();
  clock.advance(0);
  await listener.drain();
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].reason, "fallback");
  await listener.stop();
});

test("Startup tick plus a restored Expectation do not double-tick the same PR", async () => {
  const clock = makeClock();
  const state = emptyListenerState();
  state.expectations[`${REPO}#5`] = {
    repo: REPO,
    num: 5,
    deadline_ms: clock.now() - 60_000,
    backoff_index: 0,
  };
  const futureIso = new Date(clock.now() + 3_600_000).toISOString();
  const runner = makeTickRunner([
    () => ({ ok: true, reports: [prReport(5, { next_check_at: futureIso })], overall: {} }),
  ]);
  const listener = createListener({
    config: makeConfig({ startupTick: true }),
    now: clock.now,
    clock,
    tickRunner: runner,
    state,
  });
  await listener.start();
  clock.advance(60_000);
  await listener.drain();
  assert.equal(runner.calls.length, 1, "startup tick only");
  assert.deepEqual(listener.pendingExpectations(), [`${REPO}#5`]);
  await listener.stop();
});

test("nothing re-arms for Flows already closed at shutdown", async () => {
  const clock = makeClock();
  const state = emptyListenerState();
  state.expectations[`${REPO}#5`] = {
    repo: REPO,
    num: 5,
    deadline_ms: clock.now() - 60_000,
    backoff_index: 0,
  };
  const runner = makeTickRunner([
    { ok: true, reports: [prReport(5, { action: "notify_ready", done: true, terminal: "done" })], overall: {} },
  ]);
  const listener = createListener({
    config: makeConfig({ startupTick: true }),
    now: clock.now,
    clock,
    tickRunner: runner,
    state,
    persistState: (next) => { Object.assign(state, next); },
  });
  await listener.start();
  clock.advance(60_000);
  await listener.drain();
  assert.deepEqual(listener.pendingExpectations(), []);
  assert.deepEqual(Object.keys(state.expectations), []);
  await listener.stop();
});

test("Hook ids persist across a restart through the listener state file", async () => {
  const dir = makeRuntimeDir();
  const statePath = path.join(dir, "listener-state.json");
  const state = emptyListenerState();
  await setupHook({
    repo: REPO,
    publicUrl: "https://listener.example.com",
    secret: "s3cret",
    state,
    gh: makeHookGh({ createId: 77 }),
    fetchFn: PROBE_OK,
    persistState: (next) => saveListenerState(next, statePath),
  });
  const loaded = loadListenerState(statePath);
  assert.equal(loaded.hooks[REPO].id, 77);

  const gh = makeHookGh();
  const removed = await teardownHooks({ repos: [REPO], gh, state: loaded });
  assert.deepEqual(removed, [{ repo: REPO, id: 77 }]);
  assert.ok(gh.calls.some((args) => /hooks\/77$/.test(args[0]) && args.includes("DELETE")));
});

test("listener state is written atomically and never shares the Tick state file", () => {
  const dir = makeRuntimeDir();
  const statePath = path.join(dir, "listener-state.json");
  saveListenerState(emptyListenerState(), statePath);
  assert.deepEqual(fs.readdirSync(dir), ["listener-state.json"]);
  assert.equal(loadListenerState(statePath).version, 1);
  assert.notEqual(statePath, path.join(os.homedir(), ".cache", "pr-monitor", "state.json"));
});

// ---------------------------------------------------------------------------
// #31 — Process management
// ---------------------------------------------------------------------------

test("a live pid file blocks a second instance; a stale one does not", async () => {
  const dir = makeRuntimeDir();
  const pidPath = path.join(dir, "listener.pid");
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"]);
  try {
    fs.writeFileSync(pidPath, `${sleeper.pid}\n`);
    assert.throws(() => claimPidFile(pidPath), /already running/);
  } finally {
    sleeper.kill("SIGKILL");
  }
  await waitFor(() => !isPidAlive(sleeper.pid));
  claimPidFile(pidPath);
  assert.equal(readPidFile(pidPath), process.pid);
  removePidFile(pidPath, process.pid);
  assert.equal(readPidFile(pidPath), null);
});

test("listenerStatus reports not running when there is no pid file", async () => {
  const dir = makeRuntimeDir();
  const status = await listenerStatus({ pidPath: path.join(dir, "missing.pid") });
  assert.deepEqual(status, { running: false, healthy: false, pid: null });
});

function runCli(args, env, { cwd = SKILL_DIR } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WEBHOOK_SCRIPT, ...args], { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("--daemon detaches, --status reports healthy, --stop shuts it down gracefully", async (t) => {
  const dir = makeRuntimeDir();
  const port = await freePort();
  const env = {
    ...process.env,
    PR_MONITOR_REPOS: REPO,
    PR_MONITOR_WEBHOOK_SECRET: "daemon-secret",
    PR_MONITOR_WEBHOOK_HOST: "127.0.0.1",
    PR_MONITOR_WEBHOOK_PORT: String(port),
    PR_MONITOR_WEBHOOK_PID_PATH: path.join(dir, "listener.pid"),
    PR_MONITOR_WEBHOOK_LOG: path.join(dir, "listener.log"),
    PR_MONITOR_WEBHOOK_STATE_PATH: path.join(dir, "listener-state.json"),
    PR_MONITOR_STARTUP_TICK: "0",
    PR_MONITOR_LOGIN: "own-bot",
  };
  t.after(async () => { await runCli(["--stop"], env).catch(() => {}); });

  const daemon = await runCli(["--daemon"], env);
  assert.equal(daemon.code, 0, daemon.stderr);
  assert.match(daemon.stdout, /Listener daemon started pid=\d+/);

  const status = await runCli(["--status"], env);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /running pid=\d+ healthy=true/);

  const stop = await runCli(["--stop"], env);
  assert.equal(stop.code, 0, stop.stderr);
  assert.match(stop.stdout, /stopped pid=\d+/);
  await waitFor(() => readPidFile(env.PR_MONITOR_WEBHOOK_PID_PATH) === null);
  assert.ok(fs.existsSync(env.PR_MONITOR_WEBHOOK_LOG));
});

// ---------------------------------------------------------------------------
// #37 — Tunnel
// ---------------------------------------------------------------------------

function makeFakeChild() {
  const stdoutHandlers = {};
  const stderrHandlers = {};
  const handlers = {};
  return {
    killed: [],
    stdout: { on: (event, handler) => { stdoutHandlers[event] = handler; } },
    stderr: { on: (event, handler) => { stderrHandlers[event] = handler; } },
    on(event, handler) { handlers[event] = handler; return this; },
    kill(signal) { this.killed.push(signal); },
    emitStderr(chunk) { stderrHandlers.data?.(chunk); },
    emitClose(code) { handlers.close?.(code); },
  };
}

test("cloudflared tunnel discovers the public URL from its output and is killed on stop", async () => {
  const child = makeFakeChild();
  const tunnelPromise = startTunnel({
    kind: "cloudflared",
    port: 8787,
    spawnFn: () => child,
    timeoutMs: 1_000,
  });
  child.emitStderr("Your quick Tunnel has been created! Visit it at https://brave-otter-123.trycloudflare.com");
  const resolved = await tunnelPromise;
  assert.equal(resolved.url, "https://brave-otter-123.trycloudflare.com");
  resolved.stop();
  assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("cloudflared that exits before publishing a URL fails fast", async () => {
  const child = makeFakeChild();
  const promise = startTunnel({ kind: "cloudflared", port: 8787, spawnFn: () => child, timeoutMs: 1_000 });
  child.emitClose(1);
  await assert.rejects(promise, /exited before publishing a URL/);
});

test("ngrok tunnel discovers the URL from the local API and cleans up on stop", async () => {
  const child = makeFakeChild();
  const tunnel = startTunnel({
    kind: "ngrok",
    port: 8787,
    spawnFn: () => child,
    timeoutMs: 1_000,
    fetchFn: async () => ({
      json: async () => ({ tunnels: [{ public_url: "https://ngrok-tunnel.ngrok-free.app" }] }),
    }),
  });
  const resolved = await tunnel;
  assert.equal(resolved.url, "https://ngrok-tunnel.ngrok-free.app");
  resolved.stop();
  assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("unknown tunnel kinds and spawn failures fail fast", async () => {
  await assert.rejects(startTunnel({ kind: "wireguard", port: 1 }), /Unknown tunnel/);
  await assert.rejects(
    startTunnel({
      kind: "ngrok",
      port: 1,
      spawnFn: () => { throw new Error("ENOENT"); },
      timeoutMs: 500,
    }),
    /could not start ngrok/
  );
});

// ---------------------------------------------------------------------------
// Owner notifications
// ---------------------------------------------------------------------------

test("runNotifyCmd passes the note as JSON on stdin and never throws on failure", async () => {
  const ok = await runNotifyCmd({ cmd: "cat > /dev/null", note: { event: "notify_ready" } });
  assert.equal(ok.ok, true);
  const failed = await runNotifyCmd({ cmd: "exit 3", note: {} });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 3);
});

test("runNotifyCmd kills a notify command that exceeds its timeout and reports the failure", async () => {
  const slow = await runNotifyCmd({ cmd: "sleep 5", note: {}, timeoutMs: 200 });
  assert.equal(slow.ok, false);
  assert.match(slow.error, /timed out/);
});

test("owner notifications from a Tick report are forwarded and failures are logged", async (t) => {
  const clock = makeClock();
  const noted = [];
  const logged = [];
  const tickRunner = makeTickRunner([
    {
      ok: true,
      reports: [prReport(7, {
        owner_notifications: [{ event: "escalation", message: "still conflicted" }],
      })],
      overall: {},
    },
  ]);
  const listener = createListener({
    config: makeConfig({ notifyCmd: "notify-me" }),
    now: clock.now,
    clock,
    tickRunner,
    logger: (entry) => logged.push(entry),
    notifier: async (note) => {
      noted.push(note);
      return { ok: false, code: 1 };
    },
  });
  await listener.start();
  t.after(() => listener.stop());

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "note-1" });
  clock.advance(30_000);
  await listener.drain();
  assert.equal(noted.length, 1);
  assert.equal(noted[0].event, "escalation");
  assert.equal(noted[0].repo, REPO);
  assert.equal(noted[0].pr, 7);
  assert.equal(noted[0].head_sha, "sha-7");
  assert.equal(noted[0].url, `https://github.com/${REPO}/pull/7`);
  assert.equal(noted[0].title, "Test PR");
  assert.ok(noted[0].ts);
  assert.equal(noted[0].key, undefined);
  assert.ok(logged.some((entry) => entry.event === "owner_notification"));
  assert.ok(logged.some((entry) => entry.event === "owner_notification_failed"));
});

// ---------------------------------------------------------------------------
// #30 — End-to-end with the fixture harness (fake gh on PATH)
// ---------------------------------------------------------------------------

test("e2e: a signed Delivery wakes one real Tick that pings Copilot (harness fake gh)", async (t) => {
  const dir = makeRuntimeDir("webhook-e2e-");
  const logDir = path.join(dir, "logs");
  const port = await freePort();
  const secret = "e2e-secret";
  const env = {
    ...process.env,
    PR_MONITOR_REPOS: REPO,
    PR_MONITOR_WEBHOOK_SECRET: secret,
    PR_MONITOR_WEBHOOK_HOST: "127.0.0.1",
    PR_MONITOR_WEBHOOK_PORT: String(port),
    PR_MONITOR_DEBOUNCE_MS: "20",
    PR_MONITOR_STARTUP_TICK: "0",
    PR_MONITOR_LOGIN: "own-bot",
    PR_MONITOR_WEBHOOK_STATE_PATH: path.join(dir, "listener-state.json"),
    PR_MONITOR_WEBHOOK_PID_PATH: path.join(dir, "listener.pid"),
    PR_MONITOR_WEBHOOK_LOG: path.join(dir, "listener.log"),
    PR_MONITOR_STATE_PATH: path.join(dir, "tick-state.json"),
    PR_MONITOR_FIXTURE_SCENARIO: "webhook-rebase-ping",
    PR_MONITOR_FIXTURE_TICK: "1",
    PR_MONITOR_FIXTURE_LOG_DIR: logDir,
    PATH: `${HARNESS_BIN}${path.delimiter}${process.env.PATH}`,
  };

  const child = spawn(process.execPath, [WEBHOOK_SCRIPT, "--serve"], { env });
  let stdout = "";
  let stderrBuf = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderrBuf += chunk; });
  t.after(() => { if (stderrBuf) console.error("CHILD STDERR:", stderrBuf); });
  t.after(async () => {
    await runCli(["--stop"], env).catch(() => {});
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  });

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
    return response?.ok;
  });

  const { body, headers } = signedBody(secret, {
    action: "opened",
    number: 99,
    pull_request: { number: 99 },
    repository: { full_name: REPO },
    sender: { login: "alice" },
  }, { deliveryId: "e2e-1" });
  const response = await fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: "POST",
    headers,
    body,
  });
  assert.equal(response.status, 202);

  const ghEntries = await waitFor(() => {
    const entries = readJsonLines(path.join(logDir, "gh.jsonl"));
    return entries.some((entry) => entry.method === "POST") ? entries : null;
  }, 10_000);
  const posts = ghEntries.filter((entry) => entry.method === "POST");
  assert.equal(posts.length, 1, "exactly one Tick ran");
  assert.match(posts[0].args.join(" "), /resolve the merge conflicts/);

  await waitFor(() => {
    const lines = readJsonLines(path.join(dir, "listener.log"));
    return lines.some((entry) => entry.event === "tick_finished" && entry.ok === true);
  }, 10_000);
  assert.match(stdout, /listener_started/);

  const stop = await runCli(["--stop"], env);
  assert.equal(stop.code, 0, stop.stderr);
  await waitFor(() => readPidFile(env.PR_MONITOR_WEBHOOK_PID_PATH) === null);
  assert.equal(readPidFile(env.PR_MONITOR_WEBHOOK_PID_PATH), null);
});

test("e2e: synchronize Deliveries drive a review ping then Notify-ready; healthz reflects the tick and the Listener exits when the Flow closes", async (t) => {
  const dir = makeRuntimeDir("webhook-e2e-ready-");
  const logDir = path.join(dir, "logs");
  const port = await freePort();
  const secret = "e2e-secret";
  const env = {
    ...process.env,
    PR_MONITOR_REPOS: REPO,
    PR_MONITOR_WEBHOOK_SECRET: secret,
    PR_MONITOR_WEBHOOK_HOST: "127.0.0.1",
    PR_MONITOR_WEBHOOK_PORT: String(port),
    PR_MONITOR_DEBOUNCE_MS: "20",
    PR_MONITOR_STARTUP_TICK: "0",
    PR_MONITOR_LOGIN: "own-bot",
    PR_MONITOR_WEBHOOK_STATE_PATH: path.join(dir, "listener-state.json"),
    PR_MONITOR_WEBHOOK_PID_PATH: path.join(dir, "listener.pid"),
    PR_MONITOR_WEBHOOK_LOG: path.join(dir, "listener.log"),
    PR_MONITOR_STATE_PATH: path.join(dir, "tick-state.json"),
    PR_MONITOR_FIXTURE_SCENARIO: "webhook-synchronize-to-ready",
    PR_MONITOR_FIXTURE_LOG_DIR: logDir,
    OPENROUTER_API_KEY: "fixture-key",
    PATH: `${HARNESS_BIN}${path.delimiter}${process.env.PATH}`,
    // Every spawned Tick must load the fixture fake OpenRouter.
    NODE_OPTIONS: `--import ${path.join(SKILL_DIR, "harness", "fake_openrouter.mjs")} ${process.env.NODE_OPTIONS || ""}`.trim(),
  };

  const child = spawn(process.execPath, [WEBHOOK_SCRIPT, "--serve"], { env });
  let stdout = "";
  let exited = null;
  let stderrBuf = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderrBuf += chunk; });
  child.on("close", (code) => { exited = code; });
  t.after(() => { if (stderrBuf) console.error("CHILD STDERR:", stderrBuf); });
  t.after(async () => {
    if (exited === null) await runCli(["--stop"], env).catch(() => {});
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  });

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
    return response?.ok;
  });
  // Tick 1: synchronize -> request_review (the fake gh must record the ping).
  const first = await postDelivery(port, secret, {
    action: "synchronize",
    number: 98,
    pull_request: { number: 98 },
    repository: { full_name: REPO },
    sender: { login: "alice" },
  }, { deliveryId: "e2e-sync-1" });
  assert.equal(first.status, 202);

  const ghEntries = await waitFor(() => {
    const entries = readJsonLines(path.join(logDir, "gh.jsonl"));
    return entries.some((entry) => entry.method === "POST") ? entries : null;
  }, 10_000);
  assert.match(
    ghEntries.filter((entry) => entry.method === "POST")[0].args.join(" "),
    /code review/
  );

  await waitFor(() => {
    const lines = readJsonLines(path.join(dir, "listener.log"));
    return lines.some((entry) => entry.event === "tick_finished" && entry.ok === true && entry.action === "request_review")
      ? lines : null;
  }, 10_000);

  // healthz reflects the Delivery and the armed Expectation.
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(health.last_delivery.accepted, true);
  assert.equal(health.last_delivery.pr, 98);
  assert.deepEqual(health.tracked_flows, [`${REPO}#98`]);
  assert.deepEqual(health.pending_expectations, [`${REPO}#98`]);

  // Tick 2: synchronize -> notify_ready closes the Flow...
  const second = await postDelivery(port, secret, {
    action: "synchronize",
    number: 98,
    pull_request: { number: 98 },
    repository: { full_name: REPO },
    sender: { login: "alice" },
  }, { deliveryId: "e2e-sync-2" });
  assert.equal(second.status, 202);

  // ...and with no Flow left the Listener exits on its own (no --stop).
  await waitFor(() => exited !== null, 15_000);
  assert.equal(exited, 0, "the Listener exits cleanly after the Flow closes");
  assert.match(stdout, /listener_idle/);
  assert.equal(readPidFile(env.PR_MONITOR_WEBHOOK_PID_PATH), null);
});

test("--serve --setup-hooks reports verified success only after GitHub's ping arrives", async (t) => {
  const dir = makeRuntimeDir("webhook-hooks-e2e-");
  const binDir = path.join(dir, "bin");
  const ghLog = path.join(dir, "gh.jsonl");
  writeStubGh(binDir, { hooks: [], createdId: 42 });
  const port = await freePort();
  const secret = "hooks-secret";
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    STUB_GH_LOG: ghLog,
    PR_MONITOR_REPOS: REPO,
    PR_MONITOR_WEBHOOK_SECRET: secret,
    PR_MONITOR_WEBHOOK_HOST: "127.0.0.1",
    PR_MONITOR_WEBHOOK_PORT: String(port),
    PR_MONITOR_WEBHOOK_PID_PATH: path.join(dir, "listener.pid"),
    PR_MONITOR_WEBHOOK_LOG: path.join(dir, "listener.log"),
    PR_MONITOR_WEBHOOK_STATE_PATH: path.join(dir, "listener-state.json"),
    PR_MONITOR_PUBLIC_URL: `http://127.0.0.1:${port}`,
    PR_MONITOR_STARTUP_TICK: "0",
    PR_MONITOR_LOGIN: "own-bot",
  };
  const child = spawn(process.execPath, [WEBHOOK_SCRIPT, "--serve", "--setup-hooks"], { env });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  t.after(async () => {
    await runCli(["--stop"], env).catch(() => {});
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  });

  await waitFor(async () => {
    const entries = readJsonLines(ghLog);
    return entries.some((args) => /\/pings$/.test(args[1] || ""));
  }, 10_000);
  assert.match(
    (await waitFor(() => (stdout.includes("hook updated") || stdout.includes("hook created")) ? stdout : null, 10_000)),
    /hook created id=42/
  );

  await postDelivery(port, secret, { zen: "Design for failure.", hook_id: 42, repository: { full_name: REPO } }, {
    event: "ping",
    deliveryId: "ping-e2e-1",
  });

  await waitFor(() => (stdout.includes("✅ Hooks verified by GitHub ping") ? stdout : null), 10_000);
  const state = loadListenerState(env.PR_MONITOR_WEBHOOK_STATE_PATH);
  assert.equal(state.hooks[REPO].id, 42);

  const stop = await runCli(["--stop"], env);
  assert.equal(stop.code, 0, stop.stderr);
});

test("owner notifications are serialized and never block the tick queue", async (t) => {
  const clock = makeClock();
  const order = [];
  let releaseFirst;
  const tickRunner = makeTickRunner([
    () => ({ ok: true, reports: [prReport(7, { owner_notifications: [{ event: "notify_ready", message: "a" }] })], overall: {} }),
    () => ({ ok: true, reports: [prReport(8, { owner_notifications: [{ event: "needs-human", message: "b" }] })], overall: {} }),
  ]);
  const notifier = async (note) => {
    order.push(`start-${note.pr}`);
    if (note.pr === 7) await new Promise((resolve) => { releaseFirst = resolve; });
    order.push(`end-${note.pr}`);
    return { ok: true };
  };
  const listener = createListener({
    config: makeConfig({ notifyCmd: "notify-me" }),
    now: clock.now,
    clock,
    tickRunner,
    notifier,
  });
  await listener.start();
  t.after(() => listener.stop());

  await postDelivery(listener.port, "test-secret", prOpenedPayload(7), { deliveryId: "serial-1" });
  clock.advance(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start-7"], "notification 7 is in flight");

  await postDelivery(listener.port, "test-secret", prOpenedPayload(8), { deliveryId: "serial-2" });
  clock.advance(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tickRunner.calls.length, 2, "a blocked notification must not stall the tick queue");

  releaseFirst();
  await listener.drain();
  assert.deepEqual(order, ["start-7", "end-7", "start-8", "end-8"]);
});

test("a restored Expectation for a PR that is no longer open is closed, not resurrected", async (t) => {
  const clock = makeClock();
  const state = emptyListenerState();
  state.expectations[`${REPO}#5`] = {
    repo: REPO,
    num: 5,
    deadline_ms: clock.now() + 7 * 24 * 3_600_000,
    backoff_index: 0,
  };
  const tickRunner = makeTickRunner([
    {
      ok: true,
      reports: [prReport(6, { next_check_at: new Date(clock.now() + 3_600_000).toISOString() })],
      overall: { type: "overall", done: false, scope_fetch_failures: 0 },
    },
  ]);
  const listener = createListener({
    config: makeConfig({ startupTick: true }),
    now: clock.now,
    clock,
    tickRunner,
    state,
    persistState: (next) => { Object.assign(state, next); },
  });
  await listener.start();
  t.after(() => listener.stop());

  assert.deepEqual(listener.trackedFlows(), [`${REPO}#6`]);
  assert.deepEqual(listener.pendingExpectations(), [`${REPO}#6`]);
  assert.equal(state.expectations[`${REPO}#5`], undefined);
});
