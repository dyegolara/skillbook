import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STAGE_PINS,
  buildPiCommand,
  buildTerminalInput,
  main,
  readKeplerApiBase,
  shellQuote,
  stagePin,
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

test("buildTerminalInput terminates the injected command with a newline", () => {
  assert.equal(buildTerminalInput("dev-flow", "pointers"), `${buildPiCommand("dev-flow", "pointers")}\n`);
});

test("the nohup fallback launches the pinned command when the API is unreachable", async () => {
  const spawnCalls = [];
  const spawnImpl = (...args) => {
    spawnCalls.push(args);
    return { unref() {} };
  };
  const lines = [];

  const result = await main(["dev-flow", "pointers"], {
    apiBase: "http://127.0.0.1:1",
    fetchImpl: async () => {
      throw new Error("fetch failed");
    },
    spawnImpl,
    write: (line) => lines.push(line),
    worktreePath: "/work/tree",
  });

  assert.equal(result.path, "nohup");
  assert.deepEqual(lines, ["launch-stage: terminal API unreachable — used nohup fallback"]);
  assert.equal(spawnCalls.length, 1);
  const [command, args, options] = spawnCalls[0];
  assert.equal(command, "sh");
  assert.equal(args[0], "-c");
  assert.equal(args[1], `nohup ${buildPiCommand("dev-flow", "pointers")} > /tmp/skillbook-dev-flow-pi.log 2>&1 &`);
  assert.equal(options.detached, true);
});

test("an unknown stage fails hard before any launch path is taken", async () => {
  let spawned = false;
  await assert.rejects(
    main(["grill-with-spec", "pointers"], {
      apiBase: "http://127.0.0.1:1",
      fetchImpl: async () => {
        throw new Error("fetch failed");
      },
      spawnImpl: () => {
        spawned = true;
        return { unref() {} };
      },
      write: () => {},
    }),
    /unknown stage/i
  );
  assert.equal(spawned, false);
});

function okResponse(value) {
  return { ok: true, status: 200, text: async () => (value === null ? "" : JSON.stringify(value)) };
}

function mockKeplerApi({ terminals, terminalId = "term-new" }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
    if (method === "GET" && url.endsWith("/terminal/list")) return okResponse(terminals);
    if (method === "POST" && url.endsWith("/terminal/start")) return okResponse({ terminalId });
    if (method === "POST" && url.endsWith("/terminal/input")) return okResponse(null);
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

test("the API path derives ids by worktree, labels the terminal and injects the pinned command", async () => {
  const worktreePath = "/work/tree";
  const terminals = [
    {
      worktreePath: "/somewhere/else",
      label: "chain #41: dev-flow",
      repoId: "repo-other",
      worktreeId: "worktree-other",
      taskId: "task-other",
    },
    { worktreePath, label: "Terminal 1", repoId: "repo-plain", worktreeId: "worktree-plain", taskId: "task-plain" },
    {
      worktreePath,
      label: "chain #55: implement-spec",
      repoId: "repo-55",
      worktreeId: "worktree-55",
      taskId: "task-55",
    },
  ];
  const { fetchImpl, calls } = mockKeplerApi({ terminals });
  const lines = [];

  const result = await main(["code-review-loop", "the maintainer's pointers"], {
    apiBase: "http://api.test",
    fetchImpl,
    worktreePath,
    write: (line) => lines.push(line),
  });

  assert.equal(result.path, "api");
  assert.equal(result.terminalId, "term-new");
  assert.equal(result.label, "chain #55: code-review-loop");
  assert.deepEqual(lines, ["launch-stage: launched chain #55: code-review-loop in Kepler terminal term-new"]);

  const [list, start, input] = calls;
  assert.deepEqual(list, { url: "http://api.test/terminal/list", method: "GET", body: undefined });
  assert.equal(start.url, "http://api.test/terminal/start");
  assert.equal(start.method, "POST");
  assert.deepEqual(start.body, {
    repoId: "repo-55",
    worktreeId: "worktree-55",
    taskId: "task-55",
    label: "chain #55: code-review-loop",
  });
  assert.equal(input.url, "http://api.test/terminal/input");
  assert.deepEqual(input.body, {
    terminalId: "term-new",
    input: buildTerminalInput("code-review-loop", "the maintainer's pointers"),
  });
});

test("a reachable API with no chain terminal on the worktree still falls back", async () => {
  const { fetchImpl } = mockKeplerApi({
    terminals: [{ worktreePath: "/work/tree", label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
  });
  const spawnCalls = [];
  const lines = [];

  const result = await main(["create-pr", "pointers"], {
    apiBase: "http://api.test",
    fetchImpl,
    worktreePath: "/work/tree",
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return { unref() {} };
    },
    write: (line) => lines.push(line),
  });

  assert.equal(result.path, "nohup");
  assert.equal(spawnCalls.length, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no chain terminal/);
  assert.match(lines[0], /used nohup fallback/);
});

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
