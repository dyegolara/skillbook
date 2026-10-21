import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createObservabilityServer } from "../src/server.mjs";

// ---------------------------------------------------------------------------
// The TUI is tested through its CLI entry against the read-only API.
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
const visible = (line) => line.replace(/\u001b\[[0-9;]*m/g, "");

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
        "acme/widgets#11": {
          last_head_sha: "sha-11",
          next_check_at: null,
          tick_history: [
            { ts: iso(NOW - 2 * HOUR), action: "notify_ready", reason: "All-clear", terminal: "done" },
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

  async start(host = "127.0.0.1") {
    this.server = createObservabilityServer({
      statePath: this.statePath,
      listenerStatePath: this.listenerStatePath,
      pidPath: this.pidPath,
      now: () => NOW,
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, host, resolve);
    });
    this.port = this.server.address().port;
    this.baseUrl = host.includes(":") ? `http://[${host}]:${this.port}` : `http://${host}:${this.port}`;
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

async function runTui(args, env = {}) {
  const child = spawn(process.execPath, [packageTuiScript(), ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = collectOutput(child.stdout);
  const err = collectOutput(child.stderr);
  const [code] = await once(child, "close");
  return { code, stdout: out.text, stderr: err.text };
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
    const { code, stdout } = await runTui(["--url", fixture.baseUrl, "--once", "--color"]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /done 3/);
    assert.match(stdout, new RegExp(`in-flight pid ${process.pid}`));
    assert.match(stdout, /scheduled 2/);
    assert.match(stdout, /acme\/widgets#7/);
    assert.match(stdout, /acme\/widgets#9/);
    assert.ok(stdout.includes("\u001b[32mcollect\u001b[0m"), stdout);
    assert.ok(stdout.includes("\u001b[90mreuse\u001b[0m"), stdout);
    assert.ok(stdout.includes("\u001b[1;33mschedule\u001b[0m"), stdout);
    assert.ok(stdout.includes("\u001b[32mAll-clear / Notify-ready\u001b[0m"), stdout);
    const gateLine = stdout.split("\n").find((line) => line.includes("acme/widgets#9"));
    const positions = ["collect", "check", "reuse", "decide", "act", "schedule"].map((stage) =>
      gateLine.indexOf(stage)
    );
    for (let index = 1; index < positions.length; index++) {
      assert.ok(positions[index] > positions[index - 1], gateLine);
    }
    for (const stage of ["collect", "check"]) assert.ok(gateLine.includes(`\u001b[32m${stage}\u001b[0m`), gateLine);
    for (const stage of ["reuse", "decide"]) assert.ok(gateLine.includes(`\u001b[90m${stage}\u001b[0m`), gateLine);
    assert.ok(gateLine.includes("\u001b[32mact\u001b[0m"), gateLine);
    assert.ok(gateLine.includes("\u001b[1;33mschedule\u001b[0m"), gateLine);

    const plain = await runTui(["--url", fixture.baseUrl, "--once", "--no-color"]);
    assert.equal(plain.code, 0, plain.stdout);
    assert.ok(!plain.stdout.includes("\u001b["), plain.stdout);
  } finally {
    await fixture.stop();
  }
});

test("the TUI CLI truncates colored output to the configured terminal width", async () => {
  const fixture = new Fixture();
  await fixture.start();
  try {
    const { code, stdout } = await runTui(
      ["--url", fixture.baseUrl, "--once", "--color"],
      { COLUMNS: "24" }
    );
    assert.equal(code, 0, stdout);
    for (const line of stdout.split("\n")) {
      assert.ok(visible(line).length <= 24, `too wide: ${visible(line)}`);
    }
    assert.ok(stdout.includes("…"), stdout);

    const plain = await runTui(
      ["--url", fixture.baseUrl, "--once", "--no-color"],
      { COLUMNS: "24" }
    );
    assert.equal(plain.code, 0, plain.stdout);
    assert.ok(plain.stdout.includes("…"), plain.stdout);
    assert.ok(!plain.stdout.includes("\u001b["), plain.stdout);
  } finally {
    await fixture.stop();
  }
});

test("the TUI CLI brackets an IPv6 host when resolving its fallback URL", async () => {
  const fixture = new Fixture();
  await fixture.start("::1");
  try {
    const { code, stdout, stderr } = await runTui(
      ["--once", "--no-color"],
      {
        PR_MONITOR_OBSERVABILITY_HOST: "::1",
        PR_MONITOR_OBSERVABILITY_PORT: String(fixture.port),
        PR_MONITOR_OBSERVABILITY_URL: undefined,
      }
    );
    assert.equal(code, 0, stderr || stdout);
    assert.match(stdout, /acme\/widgets#7/);
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
    assert.ok(!out.text.includes("\u001b["), out.text);
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
  assert.match(out.text, /retrying every 2000 ms/);
  assert.ok(!out.text.includes("\u001b["), out.text);
});
