import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRILL_PIN, buildPauseLines, failureLines, grillSessionLabel, main } from "./open-grill-session.mjs";

// Independent source of truth: grill-with-spec/SKILL.md frontmatter and ADR-0006's grill pin.
const RECORDED_GRILL_PIN = { model: "opencode-go/glm-5.3", effort: "max" };
const RE_ENTRY_PROMPT =
  "Re-enter the grill for spec #55: read skills/software-factory/grill-with-spec/SKILL.md and the review report at /r/review.md.";

test("the grill pin matches the recorded grill-with-spec pin", () => {
  assert.deepEqual(GRILL_PIN, RECORDED_GRILL_PIN);
});

test("grillSessionLabel builds chain #<spec>: grill-with-spec from the explicit spec argument", () => {
  assert.equal(grillSessionLabel(55), "chain #55: grill-with-spec");
  assert.equal(grillSessionLabel("77"), "chain #77: grill-with-spec");
  assert.throws(() => grillSessionLabel("spec-55"), /spec/i);
});

test("the grill-session helper reuses the launch helper's id anchor and flags", () => {
  const source = readFileSync(new URL("./open-grill-session.mjs", import.meta.url), "utf8");
  assert.match(source, /from\s+"\.\/launch-stage\.mjs"/);
  assert.match(source, /\bparseIdFlags\b/);
  assert.match(source, /\bresolveIds\b/);
  assert.match(source, /\bisConnectionError\b/);
});

test("the full flow creates, renames, pins model and effort, and sends the prompt verbatim", async () => {
  const { fetchImpl, calls } = mockAgentApi({ sessionId: "sess-new" });
  const lines = [];

  const result = await main(
    ["55", RE_ENTRY_PROMPT, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"],
    { apiBase: "http://api.test", fetchImpl, worktreePath: "/work/tree", write: (line) => lines.push(line) }
  );

  assert.equal(result.path, "api");
  assert.equal(result.sessionId, "sess-new");
  assert.equal(result.label, "chain #55: grill-with-spec");
  assert.deepEqual(lines, ["open-grill-session: opened chain #55: grill-with-spec as Kepler session sess-new"]);

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
      body: { sessionId: "sess-new", name: "chain #55: grill-with-spec" },
    },
    {
      url: "http://api.test/agent/session-config-option",
      method: "POST",
      body: { sessionId: "sess-new", configId: "model", value: RECORDED_GRILL_PIN.model },
    },
    {
      url: "http://api.test/agent/session-config-option",
      method: "POST",
      body: { sessionId: "sess-new", configId: "effort", value: RECORDED_GRILL_PIN.effort },
    },
    {
      url: "http://api.test/agent/send-prompt",
      method: "POST",
      body: { sessionId: "sess-new", prompt: RE_ENTRY_PROMPT },
    },
  ]);
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

  const result = await main(["55", RE_ENTRY_PROMPT], {
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

  await main(["55", RE_ENTRY_PROMPT, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
    apiBase: "http://api.test",
    fetchImpl,
    write: () => {},
  });

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "http://api.test/agent/sessions",
      "http://api.test/agent/rename-session",
      "http://api.test/agent/session-config-option",
      "http://api.test/agent/session-config-option",
      "http://api.test/agent/send-prompt",
    ]
  );
});

test("a partial id set is a hard usage error before any fetch", async () => {
  let fetched = false;
  await assert.rejects(
    main(["55", RE_ENTRY_PROMPT, "--repo-id", "r"], {
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

test("an invalid spec argument is a hard error before any fetch", async () => {
  let fetched = false;
  await assert.rejects(
    main(["spec-55", RE_ENTRY_PROMPT], {
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

test("missing positional arguments are a hard usage error", async () => {
  await assert.rejects(main(["55"]), /usage/i);
  await assert.rejects(main([]), /usage/i);
});

test("a reachable API with no anchor and no flags is a hard error — no pause fallback", async () => {
  const { fetchImpl, calls } = mockAgentApi({ terminals: [] });
  await assert.rejects(
    main(["55", RE_ENTRY_PROMPT], { apiBase: "http://api.test", fetchImpl, worktreePath: "/work/tree", write: () => {} }),
    /no terminal on/
  );
  assert.equal(calls.length, 1);
});

// --- connection-level fallback only ---

test("a connection-level failure resolving ids falls back to the pause and preserves error.message", async () => {
  const lines = [];
  const { fetchImpl, calls } = mockAgentApi({
    handlers: {
      list: () => {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    },
  });

  const result = await main(["55", RE_ENTRY_PROMPT], {
    apiBase: "http://127.0.0.1:1",
    fetchImpl,
    worktreePath: "/work/tree",
    write: (line) => lines.push(line),
  });

  assert.equal(result.path, "pause");
  assert.equal(result.reason, "fetch failed: ECONNREFUSED");
  assert.deepEqual(
    lines,
    buildPauseLines({ label: "chain #55: grill-with-spec", prompt: RE_ENTRY_PROMPT, reason: "fetch failed: ECONNREFUSED" })
  );
  assert.deepEqual(lines, [
    "open-grill-session: fetch failed: ECONNREFUSED — grill session not opened",
    "open-grill-session: chain #55: grill-with-spec paused. Re-enter with /grill-with-spec and this re-entry prompt:",
    RE_ENTRY_PROMPT,
  ]);
  assert.equal(calls.filter((call) => call.url.endsWith("/agent/sessions")).length, 0);
});

test("a connection-level failure creating the session falls back to the pause with the message", async () => {
  const lines = [];
  const { fetchImpl } = mockAgentApi({
    handlers: {
      sessions: () => {
        throw new Error("fetch failed: socket hang up");
      },
    },
  });

  const result = await main(["55", RE_ENTRY_PROMPT, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
    apiBase: "http://api.test",
    fetchImpl,
    write: (line) => lines.push(line),
  });

  assert.equal(result.path, "pause");
  assert.equal(result.reason, "fetch failed: socket hang up");
  assert.deepEqual(lines, [
    "open-grill-session: fetch failed: socket hang up — grill session not opened",
    "open-grill-session: chain #55: grill-with-spec paused. Re-enter with /grill-with-spec and this re-entry prompt:",
    RE_ENTRY_PROMPT,
  ]);
});

test("a missing Kepler data dir falls back to the pause with the read error's message", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "open-grill-session-missing-"));
  const lines = [];
  try {
    const result = await main(["55", RE_ENTRY_PROMPT], {
      dataDir,
      write: (line) => lines.push(line),
    });

    assert.equal(result.path, "pause");
    assert.match(result.reason, /ENOENT/);
    assert.match(lines[0], /ENOENT/);
    assert.match(lines[1], /paused\. Re-enter with \/grill-with-spec/);
    assert.equal(lines[2], RE_ENTRY_PROMPT);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// --- non-connection failures are hard errors ---

test("an HTTP error creating the session is a hard error — no pause fallback", async () => {
  const lines = [];
  const { fetchImpl } = mockAgentApi({ handlers: { sessions: () => errorResponse(500) } });

  await assert.rejects(
    main(["55", RE_ENTRY_PROMPT, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
      apiBase: "http://api.test",
      fetchImpl,
      write: (line) => lines.push(line),
    }),
    /HTTP 500/
  );
  assert.deepEqual(lines, []);
});

test("a malformed create response is a hard error — no pause fallback", async () => {
  const { fetchImpl } = mockAgentApi({
    handlers: { sessions: () => ({ ok: true, status: 200, text: async () => "{not json" }) },
  });

  await assert.rejects(
    main(["55", RE_ENTRY_PROMPT, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
      apiBase: "http://api.test",
      fetchImpl,
      write: () => {},
    })
  );
});

test("a create response without a sessionId is a hard error", async () => {
  const { fetchImpl } = mockAgentApi({ handlers: { sessions: () => okResponse({}) } });

  await assert.rejects(
    main(["55", RE_ENTRY_PROMPT, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
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
    main(["55", RE_ENTRY_PROMPT, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
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
  assert.deepEqual(failureLines({ message: "HTTP 500", sessionId: "sess-created" }), [
    "open-grill-session: HTTP 500",
    "open-grill-session: session sess-created was already created — terminate it or reuse it",
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
    main(["55", RE_ENTRY_PROMPT, "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"], {
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
  assert.deepEqual(failureLines({ message: "fetch failed: socket hang up", sessionId: "sess-created" }), [
    "open-grill-session: fetch failed: socket hang up",
    "open-grill-session: session sess-created was already created — terminate it or reuse it",
  ]);
});

test("failureLines prints only the error when no session was created", () => {
  assert.deepEqual(failureLines({ message: "fetch failed: ECONNREFUSED" }), [
    "open-grill-session: fetch failed: ECONNREFUSED",
  ]);
});

// --- helpers ---

function okResponse(value) {
  return { ok: true, status: 200, text: async () => (value === null ? "" : JSON.stringify(value)) };
}

function errorResponse(status) {
  return { ok: false, status, text: async () => "" };
}

function mockAgentApi({ terminals = [], sessionId = "sess-new", handlers = {} } = {}) {
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
    if (method === "POST" && url.endsWith("/agent/session-config-option")) {
      return handlers.config ? handlers.config(call) : okResponse(null);
    }
    if (method === "POST" && url.endsWith("/agent/send-prompt")) {
      return handlers.send ? handlers.send(call) : okResponse(null);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetchImpl, calls };
}
