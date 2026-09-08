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
