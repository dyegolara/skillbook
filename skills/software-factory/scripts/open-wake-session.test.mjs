import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWakePrompt, main, wakeLabel } from "./open-wake-session.mjs";
import { DEFAULTS } from "./env-defaults.mjs";
import { failureLines } from "./launch-stage.mjs";

// A realistic pinned resume command, expressed from the defaults module (the
// code-review-loop stage's resolved pin) — no pin literals.
const CODE_REVIEW_PIN = DEFAULTS.stages.CODE_REVIEW_LOOP;
const RESUME_COMMAND = `pi --print --provider ${DEFAULTS.provider} --model ${CODE_REVIEW_PIN.model} --thinking ${CODE_REVIEW_PIN.effort} 'Re-run the code-review-loop stage for spec #55: read the review report at /r/review.md.'`;

test("the wake label names the spec and the failed stage", () => {
  assert.equal(wakeLabel("55", "code-review-loop"), "chain #55: wake — code-review-loop");
  assert.equal(wakeLabel(7, "dev-flow"), "chain #7: wake — dev-flow");
  assert.throws(() => wakeLabel("not-a-number", "dev-flow"), /spec/i);
});

test("the wake prompt carries the stage, the spec and the exact resume command", () => {
  const prompt = buildWakePrompt({ stage: "code-review-loop", spec: "55", resumeCommand: RESUME_COMMAND });
  assert.equal(
    prompt,
    [
      "WAKE NOTICE — this session is a notice for the maintainer; do not run any command or tool.",
      "The chain parked: the code-review-loop stage gave up on spec #55 after its retries.",
      "The maintainer resumes it with this exact command:",
      "",
      RESUME_COMMAND,
    ].join("\n")
  );
});

test("the wake-session helper delegates to the shared runSessionHelper and pins nothing", () => {
  const source = readFileSync(new URL("./open-wake-session.mjs", import.meta.url), "utf8");
  assert.match(source, /from\s+"\.\/launch-stage\.mjs"/);
  assert.match(source, /\bparseIdFlags\b/);
  assert.match(source, /\brunSessionHelper\b/); // the one shared route shell
  assert.match(source, /\brunSessionCli\b/); // the one shared CLI boot
  assert.match(source, /\bcreateLabeledSession\b/); // the route's create step
  assert.match(source, /\bbuildWakePrompt\b/);
  assert.match(source, /\bbuildWakeFallbackLines\b/);
  assert.match(source, /\bstageKey\b/); // the stage guard, not a pin step
  assert.doesNotMatch(source, /\benv-defaults\b/); // the wake resolves no pins at all
  assert.doesNotMatch(source, /\bsession-config-option\b/); // the wake pins nothing, by decision
  assert.doesNotMatch(source, /\breachApi\b/); // the shared shell owns the reach step now
  assert.doesNotMatch(source, /\bisConnectionError\b/); // and the never-fallback guard
  assert.doesNotMatch(source, /\bresolveIds\b/);
  assert.doesNotMatch(source, /\breadKeplerApiBase\b/);
});

test("the full flow creates, renames, and sends the wake prompt verbatim", async () => {
  const { fetchImpl, calls } = mockAgentApi({ sessionId: "sess-wake" });
  const lines = [];

  const result = await main(
    ["code-review-loop", "55", RESUME_COMMAND, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"],
    { apiBase: "http://api.test", fetchImpl, worktreePath: "/work/tree", write: (line) => lines.push(line) }
  );

  assert.equal(result.path, "api");
  assert.equal(result.sessionId, "sess-wake");
  assert.equal(result.label, "chain #55: wake — code-review-loop");
  assert.deepEqual(lines, ["open-wake-session: woke chain #55: wake — code-review-loop as Kepler session sess-wake"]);

  assert.deepEqual(calls, [
    {
      url: "http://api.test/agent/sessions",
      method: "POST",
      body: {
        adapterId: "opencode",
        worktreePath: "/work/tree",
        repoId: "r",
        worktreeId: "w",
        taskId: "t",
      },
    },
    {
      url: "http://api.test/agent/rename-session",
      method: "POST",
      body: { sessionId: "sess-wake", name: "chain #55: wake — code-review-loop" },
    },
    {
      url: "http://api.test/agent/send-prompt",
      method: "POST",
      body: {
        sessionId: "sess-wake",
        prompt: buildWakePrompt({ stage: "code-review-loop", spec: "55", resumeCommand: RESUME_COMMAND }),
      },
    },
  ]);
});

test("an unknown stage is a hard error before any fetch", async () => {
  let fetched = false;
  await assert.rejects(
    main(["grill-with-spec", "55", RESUME_COMMAND], {
      apiBase: "http://api.test",
      fetchImpl: async () => {
        fetched = true;
      },
      write: () => {},
    }),
    /unknown stage/i
  );
  assert.equal(fetched, false);
});

test("an invalid spec argument is a hard error before any fetch", async () => {
  let fetched = false;
  await assert.rejects(
    main(["dev-flow", "spec-55", RESUME_COMMAND], {
      apiBase: "http://api.test",
      fetchImpl: async () => {
        fetched = true;
      },
      write: () => {},
    }),
    /spec/i
  );
  assert.equal(fetched, false);
});

test("a partial id set is a hard usage error before any fetch", async () => {
  let fetched = false;
  await assert.rejects(
    main(["dev-flow", "55", RESUME_COMMAND, "--repo-id", "r"], {
      apiBase: "http://api.test",
      fetchImpl: async () => {
        fetched = true;
      },
      write: () => {},
    }),
    /--repo-id/
  );
  assert.equal(fetched, false);
});

test("missing positional arguments are a hard usage error", async () => {
  await assert.rejects(main(["dev-flow", "55"]), /usage/i);
  await assert.rejects(main(["dev-flow"]), /usage/i);
  await assert.rejects(main([]), /usage/i);
});

test("with no id flags the create body reuses the chain-labeled anchor terminal's ids", async () => {
  const worktreePath = "/work/tree";
  const terminals = [
    { worktreePath, label: "Terminal 1", repoId: "plain", worktreeId: "plain", taskId: "plain" },
    {
      worktreePath,
      label: "chain #55: code-review-loop",
      repoId: "repo-chain",
      worktreeId: "worktree-chain",
      taskId: "task-chain",
    },
  ];
  const { fetchImpl, calls } = mockAgentApi({ terminals, sessionId: "sess-anchor" });

  const result = await main(["dev-flow", "55", RESUME_COMMAND], {
    apiBase: "http://api.test",
    fetchImpl,
    worktreePath,
    write: () => {},
  });

  assert.equal(result.path, "api");
  assert.equal(calls[0].url, "http://api.test/terminal/list");
  assert.equal(calls[0].method, "GET");
  const create = calls.find((call) => call.url.endsWith("/agent/sessions"));
  assert.deepEqual(create.body, {
    adapterId: "opencode",
    worktreePath,
    repoId: "repo-chain",
    worktreeId: "worktree-chain",
    taskId: "task-chain",
  });
});

test("explicit id flags bootstrap a fresh run with no terminal/list call", async () => {
  const { fetchImpl, calls } = mockAgentApi({
    handlers: {
      list: () => {
        throw new Error("terminal/list must not be called with id flags");
      },
    },
  });

  await main(["dev-flow", "55", RESUME_COMMAND, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
    apiBase: "http://api.test",
    fetchImpl,
    write: () => {},
  });

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "http://api.test/agent/sessions",
      "http://api.test/agent/rename-session",
      "http://api.test/agent/send-prompt",
    ]
  );
});

test("a reachable API with no anchor and no flags is a hard error — no fallback", async () => {
  const { fetchImpl, calls } = mockAgentApi({ terminals: [] });
  await assert.rejects(
    main(["dev-flow", "55", RESUME_COMMAND], { apiBase: "http://api.test", fetchImpl, worktreePath: "/work/tree", write: () => {} }),
    /no terminal on/
  );
  assert.equal(calls.length, 1);
});

// --- non-connection failures are hard errors ---

test("an HTTP error creating the session is a hard error — no fallback", async () => {
  const lines = [];
  const { fetchImpl } = mockAgentApi({ handlers: { sessions: () => errorResponse(500) } });

  await assert.rejects(
    main(["dev-flow", "55", RESUME_COMMAND, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
      apiBase: "http://api.test",
      fetchImpl,
      write: (line) => lines.push(line),
    }),
    /HTTP 500/
  );
  assert.deepEqual(lines, []);
});

test("a malformed create response is a hard error — no fallback", async () => {
  const { fetchImpl } = mockAgentApi({
    handlers: { sessions: () => ({ ok: true, status: 200, text: async () => "{not json" }) },
  });

  await assert.rejects(
    main(["dev-flow", "55", RESUME_COMMAND, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
      apiBase: "http://api.test",
      fetchImpl,
      write: () => {},
    })
  );
});

test("a create response without a sessionId is a hard error", async () => {
  const { fetchImpl } = mockAgentApi({ handlers: { sessions: () => okResponse({}) } });

  await assert.rejects(
    main(["dev-flow", "55", RESUME_COMMAND, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
      apiBase: "http://api.test",
      fetchImpl,
      write: () => {},
    }),
    /sessionId/
  );
});

test("a failure after the session exists is a hard error carrying the session id", async () => {
  const lines = [];
  const { fetchImpl } = mockAgentApi({
    sessionId: "sess-created",
    handlers: { rename: () => errorResponse(500) },
  });

  await assert.rejects(
    main(["dev-flow", "55", RESUME_COMMAND, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
      apiBase: "http://api.test",
      fetchImpl,
      write: (line) => lines.push(line),
    }),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.equal(error.sessionId, "sess-created");
      return true;
    }
  );
  assert.deepEqual(lines, []);
  assert.deepEqual(failureLines("open-wake-session", { message: "HTTP 500", sessionId: "sess-created" }), [
    "open-wake-session: HTTP 500",
    "open-wake-session: session sess-created was already created — terminate it or reuse it",
  ]);
});

test("a connection-level failure after the session exists is still a hard error — never a silent fallback", async () => {
  const lines = [];
  const { fetchImpl } = mockAgentApi({
    sessionId: "sess-created",
    handlers: {
      send: () => {
        throw new Error("fetch failed: socket hang up");
      },
    },
  });

  await assert.rejects(
    main(["dev-flow", "55", RESUME_COMMAND, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
      apiBase: "http://api.test",
      fetchImpl,
      write: (line) => lines.push(line),
    }),
    (error) => {
      assert.match(error.message, /socket hang up/);
      assert.equal(error.sessionId, "sess-created");
      return true;
    }
  );
  assert.deepEqual(lines, []);
  assert.deepEqual(failureLines("open-wake-session", { message: "fetch failed: socket hang up", sessionId: "sess-created" }), [
    "open-wake-session: fetch failed: socket hang up",
    "open-wake-session: session sess-created was already created — terminate it or reuse it",
  ]);
});

// --- connection-level fallback only ---

test("a connection-level failure resolving ids falls back and prints the resume command", async () => {
  const lines = [];
  const { fetchImpl, calls } = mockAgentApi({
    handlers: {
      list: () => {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    },
  });

  const result = await main(["dev-flow", "55", RESUME_COMMAND], {
    apiBase: "http://127.0.0.1:1",
    fetchImpl,
    worktreePath: "/work/tree",
    write: (line) => lines.push(line),
  });

  assert.equal(result.path, "fallback");
  assert.equal(result.reason, "fetch failed: ECONNREFUSED");
  assert.equal(result.resumeCommand, RESUME_COMMAND);
  assert.deepEqual(lines, [
    "open-wake-session: fetch failed: ECONNREFUSED — wake session not opened",
    "open-wake-session: resume the chain with this exact command:",
    RESUME_COMMAND,
  ]);
  assert.equal(calls.filter((call) => call.url.endsWith("/agent/sessions")).length, 0);
});

test("a connection-level failure creating the session falls back with the message and the resume command", async () => {
  const lines = [];
  const { fetchImpl } = mockAgentApi({
    handlers: {
      sessions: () => {
        throw new Error("fetch failed: socket hang up");
      },
    },
  });

  const result = await main(["dev-flow", "55", RESUME_COMMAND, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
    apiBase: "http://api.test",
    fetchImpl,
    write: (line) => lines.push(line),
  });

  assert.equal(result.path, "fallback");
  assert.equal(result.reason, "fetch failed: socket hang up");
  assert.deepEqual(lines, [
    "open-wake-session: fetch failed: socket hang up — wake session not opened",
    "open-wake-session: resume the chain with this exact command:",
    RESUME_COMMAND,
  ]);
});

test("a missing Kepler data dir falls back with the read error's message and the resume command", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "open-wake-session-missing-"));
  const lines = [];
  try {
    const result = await main(["dev-flow", "55", RESUME_COMMAND], {
      dataDir,
      write: (line) => lines.push(line),
    });

    assert.equal(result.path, "fallback");
    assert.match(result.reason, /ENOENT/);
    assert.match(lines[0], /ENOENT/);
    assert.equal(lines[1], "open-wake-session: resume the chain with this exact command:");
    assert.equal(lines[2], RESUME_COMMAND);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("failureLines prints only the error when no session was created", () => {
  assert.deepEqual(failureLines("open-wake-session", { message: "fetch failed: ECONNREFUSED" }), [
    "open-wake-session: fetch failed: ECONNREFUSED",
  ]);
});

// --- helpers ---

function okResponse(value) {
  return { ok: true, status: 200, text: async () => (value === null ? "" : JSON.stringify(value)) };
}

function errorResponse(status) {
  return { ok: false, status, text: async () => "" };
}

function mockAgentApi({ terminals = [], sessionId = "sess-wake", handlers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const call = { url, method, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (method === "GET" && url.endsWith("/terminal/list")) {
      return handlers.list ? handlers.list(call) : okResponse(terminals);
    }
    if (method === "POST" && url.endsWith("/agent/sessions")) {
      return handlers.sessions ? handlers.sessions(call) : okResponse({ sessionId });
    }
    if (method === "POST" && url.endsWith("/agent/rename-session")) {
      return handlers.rename ? handlers.rename(call) : okResponse(null);
    }
    if (method === "POST" && url.endsWith("/agent/send-prompt")) {
      return handlers.send ? handlers.send(call) : okResponse(null);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetchImpl, calls };
}
