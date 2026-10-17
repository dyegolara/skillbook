import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createObservabilityServer } from "../src/server.mjs";

// ---------------------------------------------------------------------------
// fixtures: state files on disk are the only input to the server
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-08T00:00:00.000Z");
const HOUR = 3600_000;

function record(ts, action, reason, terminal = null, extra = {}) {
  return { ts: new Date(ts).toISOString(), action, reason, terminal, ...extra };
}

function defaultTickState() {
  return {
    "acme/widgets#7": {
      last_head_sha: "sha-7",
      next_check_at: new Date(NOW + 6 * HOUR).toISOString(),
      tick_history: [
        record(NOW - 13 * HOUR, "request_fix", "unaddressed inline comments", null, { decision_source: "decision_command" }),
        record(NOW - 1 * HOUR, "request_fix", "pending fix older than 12h with no new feedback; retrying.", null, {
          decision_source: "decision_command",
        }),
      ],
    },
    "acme/widgets#9": {
      last_head_sha: "sha-9",
      rebase_pings: 3,
      rebase_pings_sha: "sha-9",
      stuck_notified_sha: "sha-9",
      next_check_at: new Date(NOW + 168 * HOUR).toISOString(),
      tick_history: [
        record(
          NOW - 1 * HOUR,
          "wait",
          "Rebase retry budget exhausted (3 pings on this sha) and PR is still conflicted: owner escalated; weekly retry only.",
          "needs-human"
        ),
      ],
    },
    "acme/widgets#11": {
      last_head_sha: "sha-11",
      next_check_at: null,
      tick_history: [
        record(NOW - 2 * HOUR, "notify_ready", "The review transcript reached an All-clear.", "done"),
      ],
    },
    "acme/gadgets#3": {
      last_head_sha: "sha-3",
      next_check_at: new Date(NOW + 1 * HOUR).toISOString(),
      tick_history: [record(NOW - 1 * HOUR, "wait", "GitHub has not computed PR mergeability yet; wait for next tick.", null)],
    },
    tick_in_flight: {
      pid: process.pid,
      token: "tok",
      started_at: new Date(NOW - 30_000).toISOString(),
      heartbeat_at: new Date(NOW - 10_000).toISOString(),
    },
  };
}

function defaultListenerState() {
  return {
    version: 1,
    expectations: {
      "acme/widgets#7": {
        repo: "acme/widgets",
        num: 7,
        deadline_ms: NOW + 7 * HOUR,
        backoff_index: 0,
        origin: "tick_report",
      },
      "acme/widgets#9": {
        repo: "acme/widgets",
        num: 9,
        deadline_ms: NOW + 168 * HOUR,
        backoff_index: 0,
        origin: "tick_report",
      },
    },
    hooks: {},
  };
}

class Fixture {
  constructor({ state = defaultTickState(), listenerState = defaultListenerState(), pid = process.pid } = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-monitor-observability-"));
    this.statePath = path.join(this.dir, "state.json");
    this.listenerStatePath = path.join(this.dir, "listener-state.json");
    this.pidPath = path.join(this.dir, "listener.pid");
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    fs.writeFileSync(this.listenerStatePath, JSON.stringify(listenerState, null, 2));
    if (pid !== null) fs.writeFileSync(this.pidPath, `${pid}\n`);
    this.tickState = state;
    this.listenerState = listenerState;
  }

  hashFiles() {
    return [this.statePath, this.listenerStatePath, this.pidPath]
      .filter((file) => fs.existsSync(file))
      .map((file) => `${path.basename(file)}:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`);
  }

  async start() {
    this.server = createObservabilityServer({
      statePath: this.statePath,
      listenerStatePath: this.listenerStatePath,
      pidPath: this.pidPath,
      now: () => NOW,
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.port = this.server.address().port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    return this;
  }

  async get(pathname, { method = "GET" } = {}) {
    const response = await fetch(`${this.baseUrl}${pathname}`, { method });
    const body = await response.json().catch(() => null);
    return { status: response.status, body, headers: response.headers };
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

function firstLine(stream, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for CLI output")), timeoutMs);
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (predicate(line)) {
          clearTimeout(timer);
          resolve(line);
          return;
        }
      }
    });
    stream.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Stop a spawned CLI whether it is still running or exited early. */
async function reapChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => {});
  child.kill("SIGTERM");
  await exited;
}

// ---------------------------------------------------------------------------
// GET /health — the Listener's health shape, driven by the pid file
// ---------------------------------------------------------------------------

test("GET /health reads a live watchdog from the pid file", async () => {
  const fixture = new Fixture();
  await fixture.start();
  try {
    const { status, body } = await fixture.get("/health");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.pid, process.pid);
    assert.equal(body.last_delivery, null);
    assert.match(body.started_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.tracked_flows, ["acme/gadgets#3", "acme/widgets#11", "acme/widgets#7", "acme/widgets#9"]);
    assert.deepEqual(body.pending_expectations, ["acme/widgets#7", "acme/widgets#9"]);
  } finally {
    await fixture.stop();
  }
});

test("GET /health reads a dead or absent watchdog", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await once(child, "exit");

  const dead = new Fixture({ pid: child.pid });
  await dead.start();
  try {
    const { body } = await dead.get("/health");
    assert.equal(body.status, "dead");
    assert.equal(body.pid, child.pid);
  } finally {
    await dead.stop();
  }

  const absent = new Fixture({ pid: null });
  await absent.start();
  try {
    const { body } = await absent.get("/health");
    assert.equal(body.status, "absent");
    assert.equal(body.pid, null);
    assert.equal(body.started_at, null);
  } finally {
    await absent.stop();
  }
});

// ---------------------------------------------------------------------------
// GET /timeline — executed, in-flight and scheduled ticks
// ---------------------------------------------------------------------------

test("GET /timeline projects executed, in-flight and scheduled ticks", async () => {
  const fixture = new Fixture();
  await fixture.start();
  try {
    const { status, body } = await fixture.get("/timeline");
    assert.equal(status, 200);
    assert.equal(body.now, new Date(NOW).toISOString());

    assert.deepEqual(
      body.executed.map((tick) => [tick.key, tick.ts, tick.action]),
      [
        ["acme/widgets#7", new Date(NOW - 13 * HOUR).toISOString(), "request_fix"],
        ["acme/widgets#11", new Date(NOW - 2 * HOUR).toISOString(), "notify_ready"],
        ["acme/gadgets#3", new Date(NOW - 1 * HOUR).toISOString(), "wait"],
        ["acme/widgets#7", new Date(NOW - 1 * HOUR).toISOString(), "request_fix"],
        ["acme/widgets#9", new Date(NOW - 1 * HOUR).toISOString(), "wait"],
      ]
    );
    assert.equal(body.executed[0].repo, "acme/widgets");
    assert.equal(body.executed[0].pr, 7);
    assert.equal(body.executed[0].terminal, null);
    assert.equal(body.executed[0].decision_source, "decision_command");

    assert.deepEqual(body.in_flight, {
      pid: process.pid,
      started_at: new Date(NOW - 30_000).toISOString(),
      heartbeat_at: new Date(NOW - 10_000).toISOString(),
      alive: true,
    });

    // Armed Expectations win over the persisted next_check_at; a persisted
    // next check with no Expectation is still scheduled. Sorted by deadline.
    assert.deepEqual(
      body.scheduled.map((tick) => [tick.key, tick.deadline_at, tick.source]),
      [
        ["acme/gadgets#3", new Date(NOW + 1 * HOUR).toISOString(), "next_check_at"],
        ["acme/widgets#7", new Date(NOW + 7 * HOUR).toISOString(), "expectation"],
        ["acme/widgets#9", new Date(NOW + 168 * HOUR).toISOString(), "expectation"],
      ]
    );
    assert.equal(body.scheduled[0].overdue, false);
    assert.equal(body.scheduled[1].origin, "tick_report");
    assert.equal(body.scheduled[1].backoff_index, 0);
  } finally {
    await fixture.stop();
  }
});

test("an in-flight marker whose Tick died reads as not running", async () => {
  const state = defaultTickState();
  state.tick_in_flight.heartbeat_at = new Date(NOW - 11 * 60_000).toISOString();
  const fixture = new Fixture({ state });
  await fixture.start();
  try {
    const { body } = await fixture.get("/timeline");
    assert.equal(body.in_flight.alive, false);
  } finally {
    await fixture.stop();
  }
});

// ---------------------------------------------------------------------------
// GET /flows and GET /flows/:owner/:repo/:num — the Stage projection
// ---------------------------------------------------------------------------

const statusesOf = (flow) => Object.fromEntries(flow.stages.map((stage) => [stage.stage, stage.status]));
const stageOf = (flow, name) => flow.stages.find((stage) => stage.stage === name);
const ALL_PAST = { collect: "past", check: "past", reuse: "past", decide: "past", act: "past", schedule: "past" };

test("GET /flows returns one row per watched PR in the glossary's Stage words", async () => {
  const fixture = new Fixture();
  await fixture.start();
  try {
    const { status, body } = await fixture.get("/flows");
    assert.equal(status, 200);
    assert.deepEqual(
      body.map((flow) => flow.key),
      ["acme/gadgets#3", "acme/widgets#11", "acme/widgets#7", "acme/widgets#9"]
    );

    const widgets7 = body.find((flow) => flow.key === "acme/widgets#7");
    assert.deepEqual(Object.keys(widgets7).sort(), [
      "action", "head_sha", "key", "next_check_at", "pr", "reason", "repo", "stage", "stages", "terminal",
    ]);
    assert.equal(widgets7.head_sha, "sha-7");
    assert.equal(widgets7.stage, "schedule");
    assert.equal(widgets7.action, "request_fix");
    assert.equal(widgets7.reason, "pending fix older than 12h with no new feedback; retrying.");
    assert.equal(widgets7.next_check_at, new Date(NOW + 7 * HOUR).toISOString());
    assert.equal(widgets7.terminal, null);
    assert.deepEqual(statusesOf(widgets7), {
      collect: "past",
      check: "past",
      reuse: "past",
      decide: "past",
      act: "past",
      schedule: "current",
    });
    assert.equal(stageOf(widgets7, "decide").outcome, "decision made by decision_command");
    assert.equal(stageOf(widgets7, "act").outcome, "asked Copilot to fix review comments");
    assert.match(stageOf(widgets7, "schedule").outcome, /^next check at /);
    assert.equal(stageOf(widgets7, "collect").at, new Date(NOW - 1 * HOUR).toISOString());

    // A Stuck PR keeps its weekly retry: Needs-human-flavoured outcome, but
    // the armed Expectation means it is not done.
    const widgets9 = body.find((flow) => flow.key === "acme/widgets#9");
    assert.equal(widgets9.terminal, "Stuck PR");
    assert.deepEqual(statusesOf(widgets9), {
      collect: "past",
      check: "past",
      reuse: "next",
      decide: "next",
      act: "past",
      schedule: "current",
    });
    assert.equal(stageOf(widgets9, "reuse").outcome, null);
    assert.equal(stageOf(widgets9, "reuse").at, null);

    // All-clear closes the Flow: the whole sequence is past.
    const widgets11 = body.find((flow) => flow.key === "acme/widgets#11");
    assert.equal(widgets11.terminal, "All-clear / Notify-ready");
    assert.equal(widgets11.stage, null);
    assert.deepEqual(statusesOf(widgets11), ALL_PAST);

    // A waiting Flow is never terminal, and a persisted next check alone
    // still shows the schedule Stage.
    const gadgets3 = body.find((flow) => flow.key === "acme/gadgets#3");
    assert.equal(gadgets3.terminal, null);
    assert.equal(gadgets3.next_check_at, new Date(NOW + 1 * HOUR).toISOString());
    assert.match(
      stageOf(gadgets3, "check").outcome,
      /^gate held: GitHub has not computed PR mergeability/
    );
    assert.deepEqual(statusesOf(gadgets3), {
      collect: "past",
      check: "past",
      reuse: "next",
      decide: "next",
      act: "next",
      schedule: "current",
    });
    assert.match(stageOf(gadgets3, "schedule").outcome, /^next check at /);
  } finally {
    await fixture.stop();
  }
});

test("closed Flow evidence clears stale schedules in list, detail and timeline routes", async () => {
  const state = defaultTickState();
  state["acme/widgets#20"] = {
    last_head_sha: "sha-20",
    next_check_at: new Date(NOW + HOUR).toISOString(),
    tick_history: [record(NOW - HOUR, "wait", "still open")],
  };
  state["acme/widgets#21"] = {
    last_head_sha: "sha-21",
    next_check_at: new Date(NOW + HOUR).toISOString(),
    tick_history: [record(NOW - HOUR, "closed", "PR is no longer open", "done")],
  };
  const listenerState = defaultListenerState();
  listenerState.expectations["acme/widgets#20"] = {
    repo: "acme/widgets",
    num: 20,
    deadline_ms: NOW - HOUR,
    origin: "tick_report",
    backoff_index: 0,
  };
  listenerState.closed_flows = {
    "acme/widgets#20": {
      closed_at: new Date(NOW - 30 * 60_000).toISOString(),
      reason: "PR acme/widgets#20 closed or merged",
    },
  };
  const fixture = new Fixture({ state, listenerState });
  await fixture.start();
  try {
    const { body: timeline } = await fixture.get("/timeline");
    assert.ok(!timeline.scheduled.some((tick) => tick.key === "acme/widgets#20"));
    assert.ok(!timeline.scheduled.some((tick) => tick.key === "acme/widgets#21"));

    const { body: rows } = await fixture.get("/flows");
    for (const num of [20, 21]) {
      const row = rows.find((flow) => flow.key === `acme/widgets#${num}`);
      assert.equal(row.action, "closed");
      assert.equal(row.next_check_at, null);
      assert.equal(row.terminal, null);
    }
    assert.equal(rows.find((flow) => flow.key === "acme/widgets#20").reason, "PR acme/widgets#20 closed or merged");
    const { status, body: detail } = await fixture.get("/flows/acme/widgets/20");
    assert.equal(status, 200);
    assert.equal(detail.done, true);
    assert.equal(detail.next_check_at, null);
    assert.equal(detail.expectation, null);
    assert.deepEqual(statusesOf(detail), {
      collect: "past",
      check: "past",
      reuse: "next",
      decide: "next",
      act: "next",
      schedule: "past",
    });
  } finally {
    await fixture.stop();
  }
});

test("a needs-human Flow keeps its glossary outcome and is not done", async () => {
  const state = defaultTickState();
  state["acme/widgets#12"] = {
    last_head_sha: "sha-12",
    review_fix_exhausted_sha: "sha-12",
    next_check_at: new Date(NOW + 168 * HOUR).toISOString(),
    tick_history: [
      record(NOW - 1 * HOUR, "wait", "Review/fix retry budget exhausted (3 pings on this sha): owner escalated; stop retrying until new commits land.", "needs-human"),
    ],
  };
  const fixture = new Fixture({ state });
  await fixture.start();
  try {
    const { body } = await fixture.get("/flows");
    const flow = body.find((row) => row.key === "acme/widgets#12");
    assert.equal(flow.terminal, "Needs-human");
    assert.equal(stageOf(flow, "act").status, "past");
    assert.equal("done" in flow, false);
  } finally {
    await fixture.stop();
  }
});

test("a Flow with decision_source none reads as a configuration gap, not a decision made", async () => {
  const state = defaultTickState();
  state["acme/widgets#14"] = {
    last_head_sha: "sha-14",
    next_check_at: new Date(NOW + 1 * HOUR).toISOString(),
    tick_history: [
      record(
        NOW - 1 * HOUR,
        "wait",
        "No LLM decision source is configured: define the PR_MONITOR_LLM_CMD environment " +
          "variable or a chat-completions provider with PR_MONITOR_LLM_API_KEY.",
        null,
        { decision_source: "none" }
      ),
    ],
  };
  const fixture = new Fixture({ state });
  await fixture.start();
  try {
    const { body: rows } = await fixture.get("/flows");
    const row = rows.find((flow) => flow.key === "acme/widgets#14");
    const { status, body } = await fixture.get("/flows/acme/widgets/14");
    assert.equal(status, 200);
    // The decide Stage is current — the Flow waits on a configuration gap —
    // not past, and it must never read as an adapter that ran.
    assert.equal(stageOf(body, "decide").status, "current");
    assert.equal(body.stage, "decide");
    assert.match(stageOf(body, "decide").outcome, /no decision source configured/);
    assert.match(stageOf(body, "decide").outcome, /PR_MONITOR_LLM_CMD|PR_MONITOR_LLM_API_KEY/);
    assert.doesNotMatch(JSON.stringify(body.stages), /decision made by none/);
    assert.equal(stageOf(row, "decide").status, "current");
    assert.match(stageOf(row, "decide").outcome, /no decision source configured/);
  } finally {
    await fixture.stop();
  }
});

test("LLM prose without a decision source is not evidence of a decision on either Flow route", async () => {
  const state = defaultTickState();
  state["acme/widgets#15"] = {
    last_head_sha: "sha-15",
    next_check_at: new Date(NOW + HOUR).toISOString(),
    tick_history: [record(NOW - HOUR, "wait", "LLM is still checking whether CI logs are available.")],
  };
  const fixture = new Fixture({ state });
  await fixture.start();
  try {
    const { body: rows } = await fixture.get("/flows");
    const row = rows.find((flow) => flow.key === "acme/widgets#15");
    const { body: detail } = await fixture.get("/flows/acme/widgets/15");
    for (const flow of [row, detail]) {
      assert.equal(stageOf(flow, "reuse").status, "past");
      assert.equal(stageOf(flow, "decide").status, "next");
    }
  } finally {
    await fixture.stop();
  }
});

test("failed and retrying LLM attempts are not projected as successful decisions", async () => {
  const state = defaultTickState();
  state["acme/widgets#16"] = {
    last_head_sha: "sha-16",
    next_check_at: new Date(NOW + HOUR).toISOString(),
    tick_history: [
      record(NOW - HOUR, "wait", "Could not decide with LLM (temporary outage); retrying (1/3).", null, {
        decision_source: "decision_command",
      }),
    ],
  };
  state["acme/widgets#17"] = {
    last_head_sha: "sha-17",
    next_check_at: new Date(NOW + HOUR).toISOString(),
    tick_history: [
      record(NOW - HOUR, "llm_failed", "Could not decide with LLM after 3 attempts.", "needs-human", {
        decision_source: "decision_command",
      }),
    ],
  };
  const fixture = new Fixture({ state });
  await fixture.start();
  try {
    const { body: rows } = await fixture.get("/flows");
    const retryRow = rows.find((flow) => flow.key === "acme/widgets#16");
    const { body: failedDetail } = await fixture.get("/flows/acme/widgets/17");
    assert.equal(stageOf(retryRow, "decide").status, "past");
    assert.equal(stageOf(retryRow, "decide").outcome, "LLM decision failed; retry scheduled");
    assert.equal(stageOf(failedDetail, "decide").status, "past");
    assert.equal(stageOf(failedDetail, "decide").outcome, "LLM decision failed");
  } finally {
    await fixture.stop();
  }
});

test("successful decision prose about an unavailable CI log is not a collection failure", async () => {
  const state = defaultTickState();
  state["acme/widgets#18"] = {
    last_head_sha: "sha-18",
    next_check_at: new Date(NOW + HOUR).toISOString(),
    tick_history: [
      record(NOW - HOUR, "wait", "CI logs could not fetch from the provider; waiting.", null, {
        decision_source: "decision_command",
      }),
    ],
  };
  const fixture = new Fixture({ state });
  await fixture.start();
  try {
    const { body: rows } = await fixture.get("/flows");
    const row = rows.find((flow) => flow.key === "acme/widgets#18");
    const { body: detail } = await fixture.get("/flows/acme/widgets/18");
    for (const flow of [row, detail]) {
      assert.equal(stageOf(flow, "collect").outcome, "PR state collected");
      assert.equal(stageOf(flow, "decide").status, "past");
    }
  } finally {
    await fixture.stop();
  }
});

test("a fetch-failed Tick stops the Stage sequence at collect", async () => {
  const state = defaultTickState();
  state["acme/widgets#13"] = {
    last_head_sha: "sha-13",
    next_check_at: null,
    tick_history: [record(NOW - 1 * HOUR, "wait", "Could not fetch inline review comments for acme/widgets#13: gh failed", null)],
  };
  const fixture = new Fixture({ state });
  await fixture.start();
  try {
    const { status, body } = await fixture.get("/flows/acme/widgets/13");
    assert.equal(status, 200);
    assert.deepEqual(statusesOf(body), {
      collect: "past",
      check: "next",
      reuse: "next",
      decide: "next",
      act: "next",
      schedule: "current",
    });
    assert.equal(stageOf(body, "collect").outcome, "PR state collection failed");
    assert.equal(stageOf(body, "check").outcome, null);
    assert.equal(stageOf(body, "check").at, null);
  } finally {
    await fixture.stop();
  }
});

test("GET /flows/:owner/:repo/:num returns the Flow in full and 404s an unknown PR", async () => {
  const fixture = new Fixture();
  await fixture.start();
  try {
    const { status, body } = await fixture.get("/flows/acme/widgets/7");
    assert.equal(status, 200);
    assert.equal(body.key, "acme/widgets#7");
    assert.equal(body.done, false);
    assert.deepEqual(body.stages.map((stage) => stage.stage), ["collect", "check", "reuse", "decide", "act", "schedule"]);
    assert.equal(body.tick_history.length, 2);
    assert.deepEqual(body.tick_history[0], {
      ts: new Date(NOW - 13 * HOUR).toISOString(),
      action: "request_fix",
      reason: "unaddressed inline comments",
      terminal: null,
      decision_source: "decision_command",
    });
    assert.deepEqual(body.expectation, {
      repo: "acme/widgets",
      num: 7,
      deadline_at: new Date(NOW + 7 * HOUR).toISOString(),
      origin: "tick_report",
      backoff_index: 0,
      overdue: false,
    });

    const unknown = await fixture.get("/flows/acme/widgets/999");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "unknown flow");
  } finally {
    await fixture.stop();
  }
});

// ---------------------------------------------------------------------------
// GET only, loopback only, read-only
// ---------------------------------------------------------------------------

test("any verb other than GET and any unknown path is refused", async () => {
  const fixture = new Fixture();
  await fixture.start();
  try {
    for (const pathname of ["/health", "/timeline", "/flows", "/flows/acme/widgets/7"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const { status, headers } = await fixture.get(pathname, { method });
        assert.equal(status, 405, `${method} ${pathname}`);
        assert.equal(headers.get("allow"), "GET");
      }
    }
    assert.equal((await fixture.get("/nope")).status, 404);
    assert.equal((await fixture.get("/flows/acme/widgets/7/nope")).status, 404);
    assert.equal((await fixture.get("/flows/acme/widgets/seven")).status, 404);
  } finally {
    await fixture.stop();
  }
});

test("the server never writes to the state files", async () => {
  const fixture = new Fixture();
  await fixture.start();
  try {
    const before = fixture.hashFiles();
    for (const pathname of ["/health", "/timeline", "/flows", "/flows/acme/widgets/7", "/flows/acme/widgets/9"]) {
      const { status } = await fixture.get(pathname);
      assert.equal(status, 200);
    }
    assert.deepEqual(fixture.hashFiles(), before);
  } finally {
    await fixture.stop();
  }
});

test("the server answers from fixtures with no watchdog process running", async () => {
  const fixture = new Fixture({ pid: null });
  await fixture.start();
  try {
    assert.equal((await fixture.get("/health")).body.status, "absent");
    assert.equal((await fixture.get("/timeline")).status, 200);
    const flows = await fixture.get("/flows");
    assert.equal(flows.status, 200);
    assert.equal(flows.body.length, 4);
    assert.equal((await fixture.get("/flows/acme/widgets/7")).status, 200);
  } finally {
    await fixture.stop();
  }
});

test("the server binds loopback only", async () => {
  const fixture = new Fixture();
  await fixture.start();
  try {
    assert.equal(fixture.server.address().address, "127.0.0.1");
  } finally {
    await fixture.stop();
  }
});

// ---------------------------------------------------------------------------
// the package boundary: a projection must not load the writer
// ---------------------------------------------------------------------------

test("the observability package never imports the watchdog's writer script", () => {
  const srcDir = new URL("../src/", import.meta.url).pathname;
  for (const file of fs.readdirSync(srcDir)) {
    const source = fs.readFileSync(path.join(srcDir, file), "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*pr_monitor\.mjs["']/,
      `${file} must not import the writer; shared liveness lives in ../../tick_liveness.mjs`
    );
  }
});

// ---------------------------------------------------------------------------
// the documented one-command start
// ---------------------------------------------------------------------------

const SHIM = new URL("../../pr_monitor_observability.mjs", import.meta.url).pathname;

/** The entry the package's own script names, so the suite fails if the
 * documented `npm start` is a dead script. */
function packageStartScript() {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const command = pkg.scripts?.start;
  assert.ok(command, "package.json must define a start script");
  const match = /^node\s+(.+)$/.exec(command);
  assert.ok(match, `the start script must run a Node entry: ${command}`);
  return new URL(`../${match[1]}`, import.meta.url).pathname;
}

test("the package's start script runs the observability server", async () => {
  const fixture = new Fixture({ pid: null });
  const child = spawn(
    process.execPath,
    [
      packageStartScript(),
      "--port",
      "0",
      "--state",
      fixture.statePath,
      "--listener-state",
      fixture.listenerStatePath,
      "--pid",
      fixture.pidPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  try {
    const line = await firstLine(child.stdout, (l) => l.includes("observability listening"));
    const url = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(url, `no loopback URL in: ${line}`);
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "absent");
  } finally {
    await reapChild(child);
    await fixture.stop();
  }
});

test("the CLI starts the server with one command and honours port and state paths", async () => {
  const fixture = new Fixture({ pid: null });
  const child = spawn(
    process.execPath,
    [
      SHIM,
      "--port",
      "0",
      "--state",
      fixture.statePath,
      "--listener-state",
      fixture.listenerStatePath,
      "--pid",
      fixture.pidPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  try {
    const line = await firstLine(child.stdout, (l) => l.includes("observability listening"));
    const url = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(url, `no loopback URL in: ${line}`);
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "absent");
    assert.deepEqual(body.tracked_flows, ["acme/gadgets#3", "acme/widgets#11", "acme/widgets#7", "acme/widgets#9"]);
    assert.deepEqual(body.pending_expectations, ["acme/widgets#7", "acme/widgets#9"]);
  } finally {
    await reapChild(child);
    await fixture.stop();
  }
});

test("the CLI refuses a non-loopback bind", async () => {
  const child = spawn(process.execPath, [SHIM, "--host", "0.0.0.0", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(stderr, /loopback only/);
});
