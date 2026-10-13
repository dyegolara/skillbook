import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fetchFrame, renderApiError, renderFrame } from "../src/tui.mjs";
import { createObservabilityServer } from "../src/server.mjs";

// ---------------------------------------------------------------------------
// The TUI is a client of the observability API (ADR-0009). Its frame is a
// pure render of the `/timeline` and `/flows` payloads plus the terminal's
// width and colour capability, so the suite asserts the frame without a real
// TTY and the live loop stays thin. It never reads the state files.
// ---------------------------------------------------------------------------

const SHIM = new URL("../../pr_monitor_tui.mjs", import.meta.url).pathname;
const AUDIT = new URL("./audit-fs.mjs", import.meta.url);

/** The entry the package's own script names, so the suite fails if the
 * documented `npm run tui` is a dead script. */
function packageTuiScript() {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const command = pkg.scripts?.tui;
  assert.ok(command, "package.json must define a tui script");
  const match = /^node\s+(.+)$/.exec(command);
  assert.ok(match, `the tui script must run a Node entry: ${command}`);
  return new URL(`../${match[1]}`, import.meta.url).pathname;
}

const NOW = Date.parse("2026-09-08T00:00:00.000Z");
const HOUR = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
const STAGE_ORDER = ["collect", "check", "reuse", "decide", "act", "schedule"];

function stagesFor(statuses) {
  return STAGE_ORDER.map((stage) =>
    statuses[stage] === "next"
      ? { stage, status: "next", outcome: null, at: null }
      : { stage, status: statuses[stage], outcome: `${stage} outcome`, at: iso(NOW - HOUR) }
  );
}

const PAST = Object.fromEntries(STAGE_ORDER.map((stage) => [stage, "past"]));

// API payload fixtures — exactly the shapes `GET /timeline` and `GET /flows`
// return, so the render tests need no server.
const timeline = {
  now: iso(NOW),
  executed: Array.from({ length: 5 }, (_, i) => ({
    key: "acme/widgets#7",
    repo: "acme/widgets",
    pr: 7,
    ts: iso(NOW - (5 - i) * HOUR),
    action: "wait",
    reason: "nothing to do",
    terminal: null,
  })),
  in_flight: {
    pid: 12345,
    started_at: iso(NOW - 30_000),
    heartbeat_at: iso(NOW - 5_000),
    alive: true,
  },
  scheduled: [
    { key: "acme/gadgets#3", repo: "acme/gadgets", pr: 3, deadline_at: iso(NOW + HOUR), source: "next_check_at", overdue: false },
    { key: "acme/widgets#7", repo: "acme/widgets", pr: 7, deadline_at: iso(NOW + 3 * HOUR), source: "expectation", overdue: false },
    { key: "acme/widgets#9", repo: "acme/widgets", pr: 9, deadline_at: iso(NOW + 168 * HOUR), source: "expectation", overdue: false },
  ],
};

const flows = [
  {
    key: "acme/gadgets#3",
    stages: stagesFor({ ...PAST, reuse: "next", decide: "next", act: "next", schedule: "current" }),
    action: "wait",
    terminal: null,
    done: false,
  },
  {
    key: "acme/widgets#7",
    stages: stagesFor({ ...PAST, schedule: "current" }),
    action: "request_fix",
    terminal: null,
    done: false,
  },
  {
    key: "acme/widgets#9",
    stages: stagesFor({ ...PAST, reuse: "next", decide: "next", schedule: "current" }),
    action: "wait",
    terminal: "Stuck PR",
    done: false,
  },
  {
    key: "acme/widgets#11",
    stages: stagesFor(PAST),
    action: "notify_ready",
    terminal: "All-clear / Notify-ready",
    done: true,
  },
  {
    key: "acme/widgets#12",
    stages: stagesFor({ ...PAST, act: "past", schedule: "current" }),
    action: "wait",
    terminal: "Needs-human",
    done: false,
  },
];

const lineFor = (frame, key) => frame.split("\n").find((line) => line.includes(key));
const visible = (line) => line.replace(/\u001b\[[0-9;]*m/g, "");

// ---------------------------------------------------------------------------
// the rendered frame: header timeline, Stage sequences, terminal words
// ---------------------------------------------------------------------------

test("the frame header shows the tick timeline — done, in-flight, scheduled — and the next check", () => {
  const frame = renderFrame({ timeline, flows, color: false });
  assert.match(frame, /done 5/);
  assert.match(frame, /in-flight pid 12345/);
  assert.match(frame, /scheduled 3/);
  assert.match(frame, new RegExp(`next check ${iso(NOW + HOUR)}`));
});

test("each PR line renders its Stage sequence in order with past, current and next in distinct colours", () => {
  const frame = renderFrame({ timeline, flows, color: true });

  const line = lineFor(frame, "acme/gadgets#3");
  const positions = STAGE_ORDER.map((stage) => line.indexOf(stage));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], `${STAGE_ORDER[i]} must render after ${STAGE_ORDER[i - 1]}`);
  }

  // past green, current bold yellow, next grey — asserted as ANSI sequences.
  assert.ok(line.includes("\u001b[32mcollect\u001b[0m"), line);
  assert.ok(line.includes("\u001b[32mcheck\u001b[0m"), line);
  assert.ok(line.includes("\u001b[90mreuse\u001b[0m"), line);
  assert.ok(line.includes("\u001b[90mdecide\u001b[0m"), line);
  assert.ok(line.includes("\u001b[90mact\u001b[0m"), line);
  assert.ok(line.includes("\u001b[1;33mschedule\u001b[0m"), line);

  const allPast = lineFor(frame, "acme/widgets#7");
  for (const stage of ["collect", "check", "reuse", "decide", "act"]) {
    assert.ok(allPast.includes(`\u001b[32m${stage}\u001b[0m`), allPast);
  }
  assert.ok(allPast.includes("\u001b[1;33mschedule\u001b[0m"), allPast);
});

test("terminal outcomes render in the glossary's words and waiting is never terminal", () => {
  const frame = renderFrame({ timeline, flows, color: true });
  assert.ok(frame.includes("\u001b[32mAll-clear / Notify-ready\u001b[0m"), frame);
  assert.ok(frame.includes("\u001b[1;31mStuck PR\u001b[0m"), frame);
  assert.ok(frame.includes("\u001b[1;31mNeeds-human\u001b[0m"), frame);

  for (const key of ["acme/gadgets#3", "acme/widgets#7"]) {
    const line = lineFor(frame, key);
    assert.doesNotMatch(visible(line), /All-clear|Notify-ready|Stuck PR|Needs-human/);
    assert.ok(visible(line).includes("—"), line);
  }
  assert.doesNotMatch(visible(frame), /waiting/i);
});

test("a colourless render emits no ANSI escapes", () => {
  const frame = renderFrame({ timeline, flows, color: false });
  assert.ok(!frame.includes("\u001b["));
});

test("a narrow terminal truncates every line to the available width", () => {
  const frame = renderFrame({ timeline, flows, color: true, columns: 24 });
  for (const line of frame.split("\n")) {
    assert.ok(visible(line).length <= 24, `too wide: ${visible(line)}`);
  }
  assert.ok(frame.includes("…"));
});

test("an unreachable API renders an actionable message instead of crashing", () => {
  const text = renderApiError({
    url: "http://127.0.0.1:8788",
    message: "GET http://127.0.0.1:8788/timeline: fetch failed (ECONNREFUSED)",
    intervalMs: 2000,
    color: false,
  });
  assert.match(text, /unreachable/);
  assert.match(text, /http:\/\/127\.0\.0\.1:8788/);
  assert.match(text, /pr_monitor_observability\.mjs/);
  assert.match(text, /retrying every 2000 ms/);
  assert.ok(!text.includes("\u001b["));
});

// ---------------------------------------------------------------------------
// integration: the API is the only seam
// ---------------------------------------------------------------------------

class Fixture {
  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-monitor-tui-"));
    this.statePath = path.join(this.dir, "state.json");
    this.listenerStatePath = path.join(this.dir, "listener-state.json");
    this.pidPath = path.join(this.dir, "listener.pid");
    fs.writeFileSync(
      this.statePath,
      JSON.stringify({
        "acme/widgets#7": {
          last_head_sha: "sha-7",
          next_check_at: iso(NOW + 2 * HOUR),
          tick_history: [
            { ts: iso(NOW - HOUR), action: "request_fix", reason: "unaddressed inline comments", terminal: null, decision_source: "decision_command" },
          ],
        },
        "acme/widgets#9": {
          last_head_sha: "sha-9",
          rebase_pings: 3,
          rebase_pings_sha: "sha-9",
          next_check_at: iso(NOW + 168 * HOUR),
          tick_history: [
            {
              ts: iso(NOW - HOUR),
              action: "wait",
              reason: "Rebase retry budget exhausted (3 pings on this sha) and PR is still conflicted: owner escalated; weekly retry only.",
              terminal: "needs-human",
            },
          ],
        },
        tick_in_flight: {
          pid: process.pid,
          token: "tok",
          started_at: iso(NOW - 30_000),
          heartbeat_at: iso(NOW - 5_000),
        },
      })
    );
    fs.writeFileSync(
      this.listenerStatePath,
      JSON.stringify({
        version: 1,
        expectations: {
          "acme/widgets#7": { repo: "acme/widgets", num: 7, deadline_ms: NOW + 3 * HOUR, origin: "tick_report", backoff_index: 0 },
        },
        hooks: {},
      })
    );
    fs.writeFileSync(this.pidPath, `${process.pid}\n`);
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

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

function collectOutput(stream) {
  const state = { text: "" };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    state.text += chunk;
  });
  return state;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for TUI output");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stopWithSigint(child) {
  child.kill("SIGINT");
  const [code] = await once(child, "exit");
  return code;
}

test("the package's tui script renders a frame against the API", async () => {
  const fixture = new Fixture();
  await fixture.start();
  try {
    const child = spawn(
      process.execPath,
      [packageTuiScript(), "--url", fixture.baseUrl, "--once", "--no-color"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const out = collectOutput(child.stdout);
    const [code] = await once(child, "exit");
    assert.equal(code, 0, out.text);
    assert.match(out.text, /acme\/widgets#7/);
    assert.match(out.text, /Stuck PR/);
  } finally {
    await fixture.stop();
  }
});

test("the TUI frame is built from the API payloads", async () => {
  const fixture = new Fixture();
  await fixture.start();
  try {
    const { timeline: apiTimeline, flows: apiFlows } = await fetchFrame(fixture.baseUrl);
    assert.equal(apiTimeline.now, iso(NOW));
    assert.equal(apiTimeline.executed.length, 2);
    assert.deepEqual(
      apiFlows.map((flow) => flow.key),
      ["acme/widgets#7", "acme/widgets#9"]
    );
    const frame = renderFrame({ timeline: apiTimeline, flows: apiFlows, color: false });
    assert.match(frame, /acme\/widgets#7/);
    assert.match(frame, /acme\/widgets#9/);
    assert.match(frame, /Stuck PR/);
  } finally {
    await fixture.stop();
  }
});

test("the TUI never opens the watchdog's state files", async () => {
  const fixture = new Fixture();
  await fixture.start();
  try {
    const auditPath = path.join(fixture.dir, "fs-audit.json");
    const child = spawn(
      process.execPath,
      ["--import", AUDIT.href, SHIM, "--url", fixture.baseUrl, "--once", "--color"],
      {
        env: {
          ...process.env,
          TUI_FS_AUDIT: auditPath,
          PR_MONITOR_STATE_PATH: fixture.statePath,
          PR_MONITOR_WEBHOOK_STATE_PATH: fixture.listenerStatePath,
          PR_MONITOR_WEBHOOK_PID_PATH: fixture.pidPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const out = collectOutput(child.stdout);
    const [code] = await once(child, "exit");
    assert.equal(code, 0, out.text);
    assert.match(out.text, /acme\/widgets#7/);
    assert.ok(out.text.includes("\u001b[32mcollect\u001b[0m"), out.text);

    const opened = JSON.parse(fs.readFileSync(auditPath, "utf8"));
    const stateReads = opened.filter(
      (file) =>
        String(file).startsWith(fixture.dir) ||
        /pr-monitor|listener-state|state\.json|\.json$/i.test(String(file))
    );
    assert.deepEqual(stateReads, [], `the TUI opened state files directly: ${stateReads.join(", ")}`);
  } finally {
    await fixture.stop();
  }
});

test("the state-file audit records a deliberate read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-monitor-tui-audit-"));
  try {
    const target = path.join(dir, "state.json");
    fs.writeFileSync(target, "{}");
    const auditPath = path.join(dir, "fs-audit.json");
    const child = spawn(
      process.execPath,
      ["--import", AUDIT.href, "-e", "require('node:fs').readFileSync(process.env.AUDIT_TARGET, 'utf8')"],
      { env: { ...process.env, TUI_FS_AUDIT: auditPath, AUDIT_TARGET: target }, stdio: "ignore" }
    );
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    const opened = JSON.parse(fs.readFileSync(auditPath, "utf8"));
    assert.ok(opened.includes(target), `audit missed the deliberate read: ${opened.join(", ")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the live TUI refreshes against the API and exits cleanly on Ctrl-C", async () => {
  const fixture = new Fixture();
  await fixture.start();
  let child = null;
  try {
    child = spawn(process.execPath, [SHIM, "--url", fixture.baseUrl, "--interval", "60000", "--color"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = collectOutput(child.stdout);
    await waitFor(() => out.text.includes("acme/widgets#7"));
    assert.ok(out.text.includes("\u001b[32mcollect\u001b[0m"), out.text);
    assert.equal(child.exitCode, null);
    const code = await stopWithSigint(child);
    assert.equal(code, 0);
    child = null;
  } finally {
    if (child) child.kill("SIGKILL");
    await fixture.stop();
  }
});

test("an unreachable API keeps the live TUI retrying instead of crashing", async () => {
  const port = await closedPort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SHIM, "--url", url, "--interval", "3000", "--no-color"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = collectOutput(child.stdout);
  try {
    await waitFor(() => out.text.includes("unreachable"));
    assert.ok(out.text.includes(url), out.text);
    assert.ok(out.text.includes("pr_monitor_observability.mjs"), out.text);
    assert.match(out.text, /retrying every 3000 ms/);
    assert.equal(child.exitCode, null);
    assert.equal(await stopWithSigint(child), 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("--once against an unreachable API prints the actionable message and exits 1", async () => {
  const port = await closedPort();
  const child = spawn(process.execPath, [SHIM, "--url", `http://127.0.0.1:${port}`, "--once", "--no-color"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = collectOutput(child.stdout);
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.ok(out.text.includes(`http://127.0.0.1:${port}`), out.text);
  assert.ok(out.text.includes("pr_monitor_observability.mjs"), out.text);
});
