import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  KEPLER_DATA_DIR,
  RETRY_ATTEMPTS,
  RETRY_SLEEPS_SECONDS,
  STAGE_PINS,
  buildPiCommand,
  buildRetryWrapper,
  buildTerminalInput,
  main,
  parseIdFlags,
  pickAnchor,
  readKeplerApiBase,
  resolveIds,
  shellQuote,
  stageLabel,
  stagePin,
  wakeHelperPath,
} from "./launch-stage.mjs";

// Independent source of truth: ADR-0006's pi-stage pins.
const ADR_0006_PINS = {
  "dev-flow": { provider: "opencode-go", model: "opencode-go/glm-5.3", thinking: "max" },
  "implement-spec": { provider: "opencode-go", model: "opencode-go/deepseek-v4.1-flash", thinking: "max" },
  "code-review-loop": { provider: "opencode-go", model: "opencode-go/mimo-v2.6-pro", thinking: "high" },
  "create-pr": { provider: "opencode-go", model: "opencode-go/muse-spark-1.3-contributor", thinking: "xhigh" },
};

test("pins table carries the four ADR-0006 pi-stage pins", () => {
  assert.deepEqual(STAGE_PINS, ADR_0006_PINS);
});

test("stagePin returns the pin for a chain stage", () => {
  assert.deepEqual(stagePin("code-review-loop"), ADR_0006_PINS["code-review-loop"]);
});

test("an unknown stage is a hard error", () => {
  assert.throws(() => stagePin("grill-with-spec"), /unknown stage/i);
  assert.throws(() => stagePin("made-up"), /unknown stage/i);
});

test("buildPiCommand pins provider, model, thinking and quotes the pointers", () => {
  assert.equal(
    buildPiCommand(
      "code-review-loop",
      "Run the code-review-loop skill for spec #55: read skills/software-factory/code-review-loop/SKILL.md."
    ),
    "pi --print --provider opencode-go --model opencode-go/mimo-v2.6-pro --thinking high " +
      "'Run the code-review-loop skill for spec #55: read skills/software-factory/code-review-loop/SKILL.md.'"
  );
});

test("pointers with an embedded single quote are shell-quoted safely", () => {
  assert.equal(shellQuote("it's #55"), "'it'\\''s #55'");
  assert.equal(
    buildPiCommand("create-pr", "the maintainer's pointers"),
    "pi --print --provider opencode-go --model opencode-go/muse-spark-1.3-contributor --thinking xhigh 'the maintainer'\\''s pointers'"
  );
});

test("buildTerminalInput terminates the injected retry wrapper with a newline", () => {
  assert.equal(buildTerminalInput("dev-flow", "55", "pointers"), `${buildRetryWrapper("dev-flow", "55", "pointers")}\n`);
});

// --- the retry wrapper ---

test("the retry wrapper attempts the command 5 times with doubling sleeps over a 10-minute window", () => {
  const wrapper = buildRetryWrapper("dev-flow", "55", "pointers");
  assert.equal(RETRY_ATTEMPTS, 5);
  assert.deepEqual(RETRY_SLEEPS_SECONDS, [40, 80, 160, 320]);
  assert.equal(RETRY_SLEEPS_SECONDS.reduce((total, seconds) => total + seconds, 0), 600);
  assert.ok(wrapper.includes('chain_attempt=1; chain_status=0; while [ "$chain_attempt" -le 5 ]; do '));
  assert.ok(
    wrapper.includes('case "$chain_attempt" in 1) sleep 40;; 2) sleep 80;; 3) sleep 160;; 4) sleep 320;; esac;')
  );
});

test("the pinned command sits inside the wrapper unchanged", () => {
  const wrapper = buildRetryWrapper("dev-flow", "55", "pointers");
  assert.ok(wrapper.includes(`do ${buildPiCommand("dev-flow", "pointers")}; chain_status=$?;`));
});

test("the give-up marker names the spec, the stage and the exact resume command on one line each", () => {
  const wrapper = buildRetryWrapper("code-review-loop", "55", "pointers");
  assert.ok(wrapper.includes(shellQuote("FAILED: chain #55 code-review-loop gave up after 5 attempts")));
  assert.ok(
    wrapper.includes(
      shellQuote("FAILED: resume with: pi --print --provider opencode-go --model opencode-go/mimo-v2.6-pro --thinking high 'pointers'")
    )
  );
});

test("the wrapper actuates the wake through the sibling helper's absolute path", () => {
  const wrapper = buildRetryWrapper("dev-flow", "55", "pointers");
  const wakePath = wakeHelperPath();
  assert.equal(wakePath, fileURLToPath(new URL("./open-wake-session.mjs", import.meta.url)));
  assert.ok(
    wrapper.includes(`node ${shellQuote(wakePath)} dev-flow 55 ${shellQuote(buildPiCommand("dev-flow", "pointers"))};`)
  );
});

test("each launching skill runs its helpers from an isolated installed folder", async () => {
  const installed = mkdtempSync(join(tmpdir(), "software-factory-installed-"));
  try {
    for (const skill of ["grill-with-spec", "dev-flow", "code-review-loop"]) {
      const folder = join(installed, skill);
      cpSync(new URL(`../${skill}/`, import.meta.url), folder, { recursive: true });
      const { main: installedMain } = await import(pathToFileURL(join(folder, "scripts/launch-stage.mjs")));
      const { fetchImpl, calls } = mockKeplerApi({ terminals: [] });
      await installedMain(
        ["dev-flow", "55", "pointers", "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"],
        { apiBase: "http://api.test", fetchImpl, worktreePath: "/work/tree", write: () => {} }
      );
      assert.equal(calls[0].body.worktreePath, "/work/tree");
      const wake = await import(pathToFileURL(join(folder, "scripts/open-wake-session.mjs")));
      assert.equal(typeof wake.main, "function");
      if (skill === "code-review-loop") {
        const grill = await import(pathToFileURL(join(folder, "scripts/open-grill-session.mjs")));
        assert.equal(typeof grill.main, "function");
      }
    }
  } finally {
    rmSync(installed, { recursive: true, force: true });
  }
});

test("the shared fresh/re-entry status request encodes all required fields safely", () => {
  const text = readFileSync(new URL("../grill-with-spec/SKILL.md", import.meta.url), "utf8");
  const command = /-d "\$\((jq -n[\s\S]*?)\)" \\/.exec(text)?.[1];
  assert.ok(command, "the status terminal body must be constructed with jq");
  const worktreePath = '/work/a "quoted"\\tree';
  const result = spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, REPO_ID: "r", WORKTREE_ID: "w", TASK_ID: "t", WORKTREE: worktreePath, SPEC: "55" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    repoId: "r", worktreeId: "w", taskId: "t", worktreePath, label: "chain #55: status",
  });
});

test("stageLabel builds chain #<spec>: <stage> from the explicit spec argument", () => {
  assert.equal(stageLabel(77, "code-review-loop"), "chain #77: code-review-loop");
  assert.equal(stageLabel("55", "dev-flow"), "chain #55: dev-flow");
  assert.throws(() => stageLabel("not-a-number", "dev-flow"), /spec/i);
});

// --- the four-piece contract: explicit id flags ---

test("parseIdFlags returns undefined fields when no id flags are given", () => {
  assert.deepEqual(parseIdFlags(["dev-flow", "55", "pointers"]), {
    repoId: undefined,
    worktreeId: undefined,
    taskId: undefined,
  });
});

test("parseIdFlags reads the three id flags", () => {
  assert.deepEqual(
    parseIdFlags(["dev-flow", "55", "pointers", "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"]),
    { repoId: "r", worktreeId: "w", taskId: "t" }
  );
});

test("parseIdFlags throws on a partial id set", () => {
  assert.throws(() => parseIdFlags(["dev-flow", "55", "pointers", "--repo-id", "r"]), /--repo-id/);
  assert.throws(() => parseIdFlags(["--worktree-id", "w"]), /--repo-id/);
});

test("parseIdFlags throws when a flag value is missing", () => {
  assert.throws(() => parseIdFlags(["dev-flow", "55", "pointers", "--task-id"]), /--task-id/);
});

// --- the four-piece contract: anchor preference ---

test("pickAnchor prefers a chain-labeled terminal on the worktree", () => {
  const worktreePath = "/work/tree";
  const terminals = [
    { worktreePath, label: "Terminal 1", repoId: "plain", worktreeId: "plain", taskId: "plain" },
    { worktreePath, label: "chain #55: implement-spec", repoId: "chain", worktreeId: "chain", taskId: "chain" },
  ];
  assert.equal(pickAnchor(terminals, worktreePath).repoId, "chain");
});

test("pickAnchor accepts any terminal on the worktree when none is chain-labeled", () => {
  const worktreePath = "/work/tree";
  const terminals = [
    { worktreePath: "/somewhere/else", label: "chain #41: dev-flow" },
    { worktreePath, label: "Terminal 1", repoId: "plain", worktreeId: "plain", taskId: "plain" },
  ];
  assert.equal(pickAnchor(terminals, worktreePath).repoId, "plain");
});

test("pickAnchor returns null when the worktree has no terminal", () => {
  assert.equal(pickAnchor([{ worktreePath: "/elsewhere", label: "chain #41: dev-flow" }], "/work/tree"), null);
  assert.equal(pickAnchor([], "/work/tree"), null);
  assert.equal(pickAnchor(undefined, "/work/tree"), null);
});

test("resolveIds returns the explicit flags without touching the API", async () => {
  const ids = await resolveIds({
    apiBase: "http://api.test",
    fetchImpl: async () => {
      throw new Error("the API must not be called");
    },
    worktreePath: "/work/tree",
    flags: { repoId: "r", worktreeId: "w", taskId: "t" },
  });
  assert.deepEqual(ids, { repoId: "r", worktreeId: "w", taskId: "t" });
});

test("resolveIds derives ids from a terminal on the worktree when no flags are given", async () => {
  const { fetchImpl } = mockKeplerApi({
    terminals: [{ worktreePath: "/work/tree", label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
  });
  const ids = await resolveIds({ apiBase: "http://api.test", fetchImpl, worktreePath: "/work/tree" });
  assert.deepEqual(ids, { repoId: "r", worktreeId: "w", taskId: "t" });
});

test("resolveIds throws when there are no flags and no anchor", async () => {
  const { fetchImpl } = mockKeplerApi({ terminals: [] });
  await assert.rejects(
    resolveIds({ apiBase: "http://api.test", fetchImpl, worktreePath: "/work/tree" }),
    /no terminal on/
  );
});

// --- the API path ---

test("the spec argument builds the label — never the anchor terminal's label", async () => {
  const worktreePath = "/work/tree";
  const terminals = [
    {
      worktreePath,
      label: "chain #55: implement-spec",
      repoId: "repo-55",
      worktreeId: "worktree-55",
      taskId: "task-55",
    },
  ];
  const { fetchImpl, calls } = mockKeplerApi({ terminals, terminalId: "term-new" });
  const lines = [];

  const result = await main(["code-review-loop", "77", "the maintainer's pointers"], {
    apiBase: "http://api.test",
    fetchImpl,
    worktreePath,
    write: (line) => lines.push(line),
  });

  assert.equal(result.path, "api");
  assert.equal(result.terminalId, "term-new");
  assert.equal(result.label, "chain #77: code-review-loop");
  assert.deepEqual(lines, ["launch-stage: launched chain #77: code-review-loop in Kepler terminal term-new"]);

  const [list, start, input] = calls;
  assert.deepEqual(list, { url: "http://api.test/terminal/list", method: "GET", body: undefined });
  assert.equal(start.url, "http://api.test/terminal/start");
  assert.equal(start.method, "POST");
  assert.deepEqual(start.body, {
    repoId: "repo-55",
    worktreeId: "worktree-55",
    taskId: "task-55",
    worktreePath,
    label: "chain #77: code-review-loop",
  });
  assert.equal(input.url, "http://api.test/terminal/input");
  assert.deepEqual(input.body, {
    terminalId: "term-new",
    input: buildTerminalInput("code-review-loop", "77", "the maintainer's pointers"),
  });
});

test("the API path prefers the chain-labeled terminal on the worktree", async () => {
  const worktreePath = "/work/tree";
  const terminals = [
    { worktreePath, label: "Terminal 1", repoId: "repo-plain", worktreeId: "worktree-plain", taskId: "task-plain" },
    {
      worktreePath,
      label: "chain #55: dev-flow",
      repoId: "repo-chain",
      worktreeId: "worktree-chain",
      taskId: "task-chain",
    },
    {
      worktreePath: "/somewhere/else",
      label: "chain #41: dev-flow",
      repoId: "repo-other",
      worktreeId: "worktree-other",
      taskId: "task-other",
    },
  ];
  const { fetchImpl, calls } = mockKeplerApi({ terminals });
  const lines = [];

  const result = await main(["create-pr", "55", "pointers"], {
    apiBase: "http://api.test",
    fetchImpl,
    worktreePath,
    write: (line) => lines.push(line),
  });

  assert.equal(result.path, "api");
  assert.equal(result.label, "chain #55: create-pr");
  const start = calls.find((call) => call.url.endsWith("/terminal/start"));
  assert.deepEqual(start.body, {
    repoId: "repo-chain",
    worktreeId: "worktree-chain",
    taskId: "task-chain",
    worktreePath,
    label: "chain #55: create-pr",
  });
});

test("a reachable API with a non-chain terminal on the worktree uses it as the anchor and launches", async () => {
  const { fetchImpl, calls } = mockKeplerApi({
    terminals: [{ worktreePath: "/work/tree", label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  const lines = [];

  const result = await main(["create-pr", "55", "pointers"], {
    apiBase: "http://api.test",
    fetchImpl,
    worktreePath: "/work/tree",
    spawnImpl,
    write: (line) => lines.push(line),
  });

  assert.equal(result.path, "api");
  assert.equal(result.label, "chain #55: create-pr");
  assert.equal(spawnCalls.length, 0);
  const start = calls.find((call) => call.url.endsWith("/terminal/start"));
  assert.deepEqual(start.body, { repoId: "r", worktreeId: "w", taskId: "t", worktreePath: "/work/tree", label: "chain #55: create-pr" });
});

test("a reachable API with no anchor and no flags is a hard error — no fallback", async () => {
  const { fetchImpl } = mockKeplerApi({
    terminals: [{ worktreePath: "/elsewhere", label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["create-pr", "55", "pointers"], {
      apiBase: "http://api.test",
      fetchImpl,
      worktreePath: "/work/tree",
      spawnImpl,
      write: () => {},
    }),
    /no terminal on/
  );
  assert.equal(spawnCalls.length, 0);
});

test("explicit id flags bootstrap a fresh run with no anchor and no list call", async () => {
  const { fetchImpl, calls } = mockKeplerApi({
    terminals: [],
    handlers: {
      list: () => {
        throw new Error("terminal/list must not be called with id flags");
      },
    },
    terminalId: "term-fresh",
  });
  const lines = [];

  const result = await main(
    ["dev-flow", "55", "pointers", "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"],
    { apiBase: "http://api.test", fetchImpl, worktreePath: '/work/a "quoted"\\tree', write: (line) => lines.push(line) }
  );

  assert.equal(result.path, "api");
  assert.equal(result.label, "chain #55: dev-flow");
  assert.equal(result.terminalId, "term-fresh");
  assert.deepEqual(
    calls.map((call) => call.url),
    ["http://api.test/terminal/start", "http://api.test/terminal/input"]
  );
  assert.deepEqual(calls[0].body, { repoId: "r", worktreeId: "w", taskId: "t", worktreePath: '/work/a "quoted"\\tree', label: "chain #55: dev-flow" });
});

test("a partial id set is a hard usage error before any fetch or spawn", async () => {
  let fetched = false;
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["dev-flow", "55", "pointers", "--repo-id", "r"], {
      apiBase: "http://api.test",
      fetchImpl: async () => {
        fetched = true;
        return okResponse([]);
      },
      spawnImpl,
      write: () => {},
    }),
    /--repo-id/
  );
  assert.equal(fetched, false);
  assert.equal(spawnCalls.length, 0);
});

test("an unknown stage fails hard before any launch path is taken", async () => {
  let fetched = false;
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  await assert.rejects(
    main(["grill-with-spec", "55", "pointers"], {
      apiBase: "http://127.0.0.1:1",
      fetchImpl: async () => {
        fetched = true;
        throw new Error("fetch failed");
      },
      spawnImpl,
      write: () => {},
    }),
    /unknown stage/i
  );
  assert.equal(fetched, false);
  assert.equal(spawnCalls.length, 0);
});

test("an invalid spec argument fails hard before any launch path is taken", async () => {
  let fetched = false;
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  await assert.rejects(
    main(["dev-flow", "spec-55", "pointers"], {
      apiBase: "http://api.test",
      fetchImpl: async () => {
        fetched = true;
        return okResponse([]);
      },
      spawnImpl,
      write: () => {},
    }),
    /spec/i
  );
  assert.equal(fetched, false);
  assert.equal(spawnCalls.length, 0);
});

test("missing positional arguments are a hard usage error", async () => {
  await assert.rejects(main(["dev-flow", "55"]), /usage/i);
  await assert.rejects(main(["dev-flow"]), /usage/i);
});

// --- connection-level fallback only ---

test("a connection-level fetch rejection falls back to nohup and preserves error.message", async () => {
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  const lines = [];

  const result = await main(["dev-flow", "55", "pointers"], {
    apiBase: "http://127.0.0.1:1",
    fetchImpl: async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    },
    spawnImpl,
    write: (line) => lines.push(line),
    worktreePath: "/work/tree",
  });

  assert.equal(result.path, "nohup");
  assert.equal(result.reason, "fetch failed: ECONNREFUSED");
  assert.deepEqual(lines, ["launch-stage: fetch failed: ECONNREFUSED — used nohup fallback"]);
  assert.equal(spawnCalls.length, 1);
  const [command, args, options] = spawnCalls[0];
  assert.equal(command, "sh");
  assert.equal(args[0], "-c");
  assert.equal(args[1], `nohup ${buildPiCommand("dev-flow", "pointers")} > /tmp/skillbook-dev-flow-pi.log 2>&1 &`);
  assert.equal(options.detached, true);
});

test("a missing Kepler data dir falls back to nohup with the read error's message", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "launch-stage-missing-"));
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  const lines = [];
  try {
    const result = await main(["dev-flow", "55", "pointers"], {
      dataDir,
      spawnImpl,
      write: (line) => lines.push(line),
    });

    assert.equal(result.path, "nohup");
    assert.match(result.reason, /ENOENT/);
    assert.deepEqual(lines, [`launch-stage: ${result.reason} — used nohup fallback`]);
    assert.equal(spawnCalls.length, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an HTTP error from a reachable API is a hard error with zero spawns", async () => {
  const { fetchImpl } = mockKeplerApi({ handlers: { list: () => errorResponse(500) } });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["dev-flow", "55", "pointers"], {
      apiBase: "http://api.test",
      fetchImpl,
      spawnImpl,
      write: () => {},
    }),
    /HTTP 500/
  );
  assert.equal(spawnCalls.length, 0);
});

test("an HTTP error from terminal/start is a hard error with zero spawns", async () => {
  const { fetchImpl } = mockKeplerApi({
    terminals: [{ worktreePath: process.cwd(), label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
    handlers: { start: () => errorResponse(500) },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["dev-flow", "55", "pointers"], {
      apiBase: "http://api.test",
      fetchImpl,
      spawnImpl,
      write: () => {},
    }),
    /HTTP 500/
  );
  assert.equal(spawnCalls.length, 0);
});

test("a malformed terminal list response is a hard error with zero spawns", async () => {
  const { fetchImpl } = mockKeplerApi({
    handlers: { list: () => ({ ok: true, status: 200, text: async () => "{not json" }) },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["dev-flow", "55", "pointers"], {
      apiBase: "http://api.test",
      fetchImpl,
      spawnImpl,
      write: () => {},
    })
  );
  assert.equal(spawnCalls.length, 0);
});

test("a failure after terminal/start succeeded is a hard error with zero spawns — never double-launch", async () => {
  const worktreePath = "/work/tree";
  const { fetchImpl, calls: apiCalls } = mockKeplerApi({
    terminals: [{ worktreePath, label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
    handlers: { input: () => errorResponse(500) },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["dev-flow", "55", "pointers"], {
      apiBase: "http://api.test",
      fetchImpl,
      worktreePath,
      spawnImpl,
      write: () => {},
    }),
    /HTTP 500/
  );
  assert.equal(spawnCalls.length, 0);
  assert.equal(apiCalls.filter((call) => call.url.endsWith("/terminal/start")).length, 1);
});

test("a connection-level failure on terminal/input after start is still a hard error", async () => {
  const worktreePath = "/work/tree";
  const { fetchImpl } = mockKeplerApi({
    terminals: [{ worktreePath, label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
    handlers: {
      input: () => {
        throw new Error("socket hang up");
      },
    },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["dev-flow", "55", "pointers"], {
      apiBase: "http://api.test",
      fetchImpl,
      worktreePath,
      spawnImpl,
      write: () => {},
    }),
    /socket hang up/
  );
  assert.equal(spawnCalls.length, 0);
});

// --- the data dir ---

test("readKeplerApiBase reads the host and port files instead of hardcoding them", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "launch-stage-api-"));
  try {
    writeFileSync(join(dataDir, "server.host"), "127.0.0.1\n");
    writeFileSync(join(dataDir, "server.port"), "36325\n");
    assert.equal(readKeplerApiBase({ dataDir }), "http://127.0.0.1:36325");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the Kepler data dir is derived home-relative, not hardcoded", () => {
  assert.equal(KEPLER_DATA_DIR, join(homedir(), ".kepler-server", "data"));
  const source = readFileSync(new URL("./launch-stage.mjs", import.meta.url), "utf8");
  assert.match(source, /homedir\(\)/);
  assert.ok(!source.includes('"/config/.kepler-server'));
});

// --- the wrapper executes: the give-up path against a stubbed environment ---

function writeStub(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

/**
 * A PATH whose `pi`, `sleep` and `node` are stubs: every invocation lands in
 * one event log, sleeps return immediately, and `pi` fails its first
 * `failTimes` calls. `node` (the wake helper) is stubbed too, so the wrapper's
 * wake line is observable without creating a Kepler session.
 */
function stubEnvironment({ failTimes = 0, wakeStatus = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "launch-stage-stub-"));
  const log = join(dir, "events.log");
  const count = join(dir, "pi.count");
  writeStub(
    dir,
    "pi",
    `#!/bin/sh\nn=0\n[ -f ${shellQuote(count)} ] && n=$(cat ${shellQuote(count)})\nn=$((n + 1))\necho "$n" > ${shellQuote(count)}\necho "pi attempt $n" >> ${shellQuote(log)}\n[ "$n" -le ${failTimes} ] && exit 1\nexit 0\n`
  );
  writeStub(dir, "sleep", `#!/bin/sh\necho "sleep $1" >> ${shellQuote(log)}\nexit 0\n`);
  writeStub(
    dir,
    "node",
    `#!/bin/sh\necho "wake $*" >> ${shellQuote(log)}\necho "wake-stub" >&2\nexit ${wakeStatus}\n`
  );
  return {
    dir,
    log,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  };
}

function runWrapper(stage, spec, pointers, env) {
  return spawnSync("bash", ["-c", buildRetryWrapper(stage, spec, pointers)], { encoding: "utf8", env });
}

test("after 5 failed attempts the wrapper prints the marker and actuates the wake", () => {
  const { dir, log, env } = stubEnvironment({ failTimes: 5 });
  try {
    const result = runWrapper("dev-flow", "55", "pointers", env);
    const resume = buildPiCommand("dev-flow", "pointers");
    assert.equal(result.status, 0);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "pi attempt 1",
      "sleep 40",
      "pi attempt 2",
      "sleep 80",
      "pi attempt 3",
      "sleep 160",
      "pi attempt 4",
      "sleep 320",
      "pi attempt 5",
      `wake ${wakeHelperPath()} dev-flow 55 ${resume}`,
    ]);
    assert.equal(
      result.stdout,
      `FAILED: chain #55 dev-flow gave up after 5 attempts\nFAILED: resume with: ${resume}\n`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an attempt that succeeds stops the retries and leaves no marker", () => {
  const { dir, log, env } = stubEnvironment({ failTimes: 2 });
  try {
    const result = runWrapper("dev-flow", "55", "pointers", env);
    assert.equal(result.status, 0);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "pi attempt 1",
      "sleep 40",
      "pi attempt 2",
      "sleep 80",
      "pi attempt 3",
    ]);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed wake leaves the marker printed and the helper's failure visible", () => {
  const { dir, log, env } = stubEnvironment({ failTimes: 5, wakeStatus: 7 });
  try {
    const result = runWrapper("dev-flow", "55", "pointers", env);
    assert.equal(result.status, 7);
    assert.match(result.stdout, /FAILED: chain #55 dev-flow gave up after 5 attempts\n/);
    assert.match(result.stdout, /FAILED: resume with: pi --print /);
    assert.match(result.stderr, /wake-stub/);
    assert.match(readFileSync(log, "utf8"), /wake .*open-wake-session\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- helpers ---

function okResponse(value) {
  return { ok: true, status: 200, text: async () => (value === null ? "" : JSON.stringify(value)) };
}

function errorResponse(status) {
  return { ok: false, status, text: async () => "" };
}

function mockKeplerApi({ terminals, terminalId = "term-new", handlers = {} }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const call = { url, method, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (method === "GET" && url.endsWith("/terminal/list")) {
      return handlers.list ? handlers.list(call) : okResponse(terminals);
    }
    if (method === "POST" && url.endsWith("/terminal/start")) {
      return handlers.start ? handlers.start(call) : okResponse({ terminalId });
    }
    if (method === "POST" && url.endsWith("/terminal/input")) {
      return handlers.input ? handlers.input(call) : okResponse(null);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

function spawnRecorder() {
  const calls = [];
  return {
    calls,
    spawnImpl: (...args) => {
      calls.push(args);
      return { unref() {} };
    },
  };
}
