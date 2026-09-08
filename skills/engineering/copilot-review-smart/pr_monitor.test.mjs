import test from "node:test";
import assert from "node:assert/strict";
import { runMonitorOnce } from "./pr_monitor.mjs";

const REPO = "dyegolara/skillbook";

function makePr(headSha = "abc123") {
  return {
    number: 7,
    draft: false,
    title: "Integration test PR",
    head: { sha: headSha },
  };
}

function makeCtx({
  headSha = "abc123",
  issueTranscript = [],
  reviewTranscript = [],
} = {}) {
  return {
    num: 7,
    title: "Integration test PR",
    draft: false,
    headSha,
    approved: false,
    commented: false,
    latestReviewState: null,
    latestReviewTs: null,
    reviewTranscript,
    nInlineUnresolved: 0,
    latestInlineTs: null,
    commentUrls: [],
    lastCopilotComment: "",
    lastCopilotCommentTs: null,
    issueTranscript,
    inlineTranscript: [],
    lastCommitTs: null,
    mergeable: true,
    mergeableState: "clean",
    hasConflicts: false,
    mergeUnknown: false,
  };
}

test("LLM failure notifies once per sha, retries on state change, and re-notifies on new sha", async () => {
  const contexts = [
    makeCtx(),
    makeCtx(),
    makeCtx({
      issueTranscript: [
        { author: "alice", ts: "2026-09-08T01:00:00.000Z", body: "new comment" },
      ],
    }),
    makeCtx({ headSha: "def456" }),
  ];
  let collectCalls = 0;
  let llmCalls = 0;
  const posts = [];

  const runGhFn = async (args) => {
    if (args[0] === `repos/${REPO}/pulls?state=open`) return [makePr(contexts[collectCalls]?.headSha)];
    if (args.includes("POST")) posts.push(args);
    return [];
  };
  const collectPrStateFn = async () => contexts[collectCalls++];
  const llmDecider = async () => {
    llmCalls++;
    throw new Error("simulated llm outage");
  };

  const tick1 = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    runGhFn,
    collectPrStateFn,
    llmDecider,
  });
  assert.equal(tick1.notifications.length, 1);
  assert.match(tick1.output, /could not decide with LLM/i);

  const tick2 = await runMonitorOnce({
    repos: [REPO],
    state: tick1.state,
    nowMs: Date.parse("2026-09-08T00:10:00.000Z"),
    dryRun: true,
    runGhFn,
    collectPrStateFn,
    llmDecider,
  });
  assert.equal(tick2.notifications.length, 0);

  const tick3 = await runMonitorOnce({
    repos: [REPO],
    state: tick2.state,
    nowMs: Date.parse("2026-09-08T00:20:00.000Z"),
    dryRun: true,
    runGhFn,
    collectPrStateFn,
    llmDecider,
  });
  assert.equal(tick3.notifications.length, 0);

  const tick4 = await runMonitorOnce({
    repos: [REPO],
    state: tick3.state,
    nowMs: Date.parse("2026-09-08T00:30:00.000Z"),
    dryRun: true,
    runGhFn,
    collectPrStateFn,
    llmDecider,
  });
  assert.equal(tick4.notifications.length, 1);
  assert.equal(llmCalls, 3);
  assert.equal(posts.length, 0);
});

test("dry run does not mutate provided state object and does not post to GitHub", async () => {
  const inputState = {
    seen_ready_shas: ["dyegolara/skillbook:aaa111"],
    [`${REPO}#7`]: {
      _sig: "cached",
      _action: "notify_ready",
      _reason: "cached",
      last_ping_sha: "aaa111",
      last_ping_ts: "2026-09-07T00:00:00.000Z",
    },
  };
  const snapshot = JSON.parse(JSON.stringify(inputState));
  const postCalls = [];

  const out = await runMonitorOnce({
    repos: [REPO],
    state: inputState,
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    runGhFn: async (args) => {
      if (args[0] === `repos/${REPO}/pulls?state=open`) return [makePr("abc123")];
      if (args.includes("POST")) postCalls.push(args);
      return [];
    },
    collectPrStateFn: async () => makeCtx(),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "request_review",
      reason: "please review",
      reused: false,
      stateEntry: {
        ...stateEntry,
        _sig: "new-sig",
        _action: "request_review",
        _reason: "please review",
      },
      notifications: [],
    }),
  });

  assert.deepEqual(inputState, snapshot);
  assert.equal(postCalls.length, 0);
  assert.match(out.output, /^\[DRY-RUN\] /);
});

test("nothing-to-report path is fully silent (empty output)", async () => {
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    runGhFn: async (args) => {
      if (args[0] === `repos/${REPO}/pulls?state=open`) return [makePr("abc123")];
      return [];
    },
    collectPrStateFn: async () => makeCtx(),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "wait",
      reason: "wait",
      reused: false,
      stateEntry,
      notifications: [],
    }),
  });

  assert.equal(out.output, "");
});

test("single-PR scope fetches only that PR and emits JSON lines in agent mode", async () => {
  const ghCalls = [];
  const out = await runMonitorOnce({
    state: {},
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    targetPr: { repo: REPO, num: 42 },
    emitJsonReport: true,
    runGhFn: async (args) => {
      ghCalls.push(args[0]);
      if (args[0] === `repos/${REPO}/pulls/42`) {
        return {
          number: 42,
          state: "open",
          draft: false,
          title: "Single PR scope",
          head: { sha: "scope123" },
        };
      }
      throw new Error(`unexpected gh call: ${args[0]}`);
    },
    collectPrStateFn: async (pr, num, repo) => ({
      ...makeCtx({ headSha: pr.head.sha }),
      num,
      title: pr.title,
    }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "wait",
      reason: "nothing to do right now",
      reused: false,
      stateEntry,
      notifications: [],
    }),
  });

  assert.deepEqual(ghCalls, [`repos/${REPO}/pulls/42`]);
  const lines = out.output.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    type: "pr",
    repo: REPO,
    pr: 42,
    head_sha: "scope123",
    action: "wait",
    reason: "nothing to do right now",
    reused_cached_decision: false,
    github_action_posted: false,
    done: false,
    terminal: null,
    skipped: false,
  });
  assert.equal(lines[1].type, "overall");
  assert.equal(lines[1].scope, "single-pr");
  assert.equal(lines[1].repo, REPO);
  assert.equal(lines[1].pr, 42);
  assert.equal(lines[1].done, false);
});

test("agent-facing JSON report marks notify_ready as terminal done", async () => {
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    emitJsonReport: true,
    runGhFn: async (args) => {
      if (args[0] === `repos/${REPO}/pulls?state=open`) return [makePr("ready123")];
      return [];
    },
    collectPrStateFn: async () => makeCtx({ headSha: "ready123" }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "notify_ready",
      reason: "human reviewer left no further requests on this head",
      reused: false,
      stateEntry,
      notifications: [],
    }),
  });

  const jsonLines = out.output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.equal(jsonLines[0].terminal, "done");
  assert.equal(jsonLines[0].done, true);
  assert.equal(jsonLines[1].done, true);
});

test("LLM context includes formal review transcript for All-clear decisions", async () => {
  let seenReviewTranscript = null;
  await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    runGhFn: async (args) => {
      if (args[0] === `repos/${REPO}/pulls?state=open`) return [makePr("review123")];
      return [];
    },
    collectPrStateFn: async () =>
      makeCtx({
        headSha: "review123",
        reviewTranscript: [
          {
            author: "reviewer",
            ts: "2026-09-08T00:00:00.000Z",
            state: "COMMENTED",
            body: "Looks good to me, nothing else to add.",
          },
        ],
      }),
    decideFn: async ({ llmContext, stateEntry }) => {
      seenReviewTranscript = llmContext.review_transcript;
      return {
        handled: true,
        action: "wait",
        reason: "captured context",
        reused: false,
        stateEntry,
        notifications: [],
      };
    },
  });

  assert.deepEqual(seenReviewTranscript, [
    {
      author: "reviewer",
      ts: "2026-09-08T00:00:00.000Z",
      state: "COMMENTED",
      body: "Looks good to me, nothing else to add.",
    },
  ]);
});
