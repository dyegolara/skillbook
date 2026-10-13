import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  inlineTranscript = [],
  commentUrls = [],
  lastCopilotComment = "",
  lastCopilotCommentTs = null,
  draft = false,
  lastCommitTs = null,
  mergeable = true,
  mergeableState = "clean",
  hasConflicts = false,
  mergeUnknown = false,
  latestReviewTs = null,
  latestInlineTs = null,
} = {}) {
  return {
    num: 7,
    title: "Integration test PR",
    draft,
    headSha,
    approved: false,
    commented: false,
    latestReviewState: null,
    latestReviewTs,
    reviewTranscript,
    nInlineUnresolved: 0,
    latestInlineTs,
    commentUrls,
    lastCopilotComment,
    lastCopilotCommentTs,
    issueTranscript,
    inlineTranscript,
    lastCommitTs,
    mergeable,
    mergeableState,
    hasConflicts,
    mergeUnknown,
  };
}

test("LLM failure retries before terminalizing and resets retries on new sha", async () => {
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
    if (args[0] === `repos/${REPO}/pulls?state=open&per_page=100&page=1`) {
      return [makePr(contexts[collectCalls]?.headSha)];
    }
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
  assert.equal(tick1.notifications.length, 0);

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
  assert.equal(tick3.notifications.length, 1);
  assert.match(tick3.output, /could not decide with LLM after 3 attempts/i);

  const tick4 = await runMonitorOnce({
    repos: [REPO],
    state: tick3.state,
    nowMs: Date.parse("2026-09-08T00:30:00.000Z"),
    dryRun: true,
    runGhFn,
    collectPrStateFn,
    llmDecider,
  });
  assert.equal(tick4.notifications.length, 0);
  assert.equal(llmCalls, 4);
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
      if (args[0] === `repos/${REPO}/pulls?state=open&per_page=100&page=1`) return [makePr("abc123")];
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
      if (args[0] === `repos/${REPO}/pulls?state=open&per_page=100&page=1`) return [makePr("abc123")];
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
    title: "Single PR scope",
    head_sha: "scope123",
    action: "wait",
    reason: "nothing to do right now",
    reused_cached_decision: false,
    decision_adapter: null,
    github_action_posted: false,
    next_check_at: null,
    owner_notifications: [],
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
      if (args[0] === `repos/${REPO}/pulls?state=open&per_page=100&page=1`) return [makePr("ready123")];
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

test("agent-facing JSON report marks review/fix retry exhaustion as needs-human", async () => {
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {
      [`${REPO}#7`]: {
        review_fix_pings_sha: "stuck-review",
        review_fix_pings_action: "request_review",
        review_fix_pings: 3,
      },
    },
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: false,
    emitJsonReport: true,
    runGhFn: async (args) => {
      if (args[0] === `repos/${REPO}/pulls?state=open&per_page=100&page=1`) {
        return [makePr("stuck-review")];
      }
      if (args.includes("POST")) throw new Error("should not post when budget is exhausted");
      return [];
    },
    collectPrStateFn: async () => makeCtx({ headSha: "stuck-review" }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "request_review",
      reason: "still waiting for Copilot",
      reused: false,
      stateEntry,
      notifications: [],
    }),
  });

  const [prLine, overallLine] = out.output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.equal(prLine.terminal, "needs-human");
  assert.equal(prLine.done, true);
  assert.equal(overallLine.done, true);
});

test("overall report stays non-terminal when repo listing fails", async () => {
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    emitJsonReport: true,
    runGhFn: async () => {
      throw new Error("simulated listing failure");
    },
  });

  const overallLine = out.output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .at(-1);
  assert.equal(overallLine.type, "overall");
  assert.equal(overallLine.done, false);
  assert.equal(overallLine.scope_fetch_failures, 1);
});

test("single-PR scope stays non-terminal when inline transcript fetch fails", async () => {
  let decided = false;
  const out = await runMonitorOnce({
    state: {},
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    emitJsonReport: true,
    targetPr: { repo: REPO, num: 42 },
    runGhFn: async (args) => {
      if (args[0] === `repos/${REPO}/pulls/42`) {
        return {
          number: 42,
          state: "open",
          draft: false,
          title: "Inline failure PR",
          head: { sha: "inline-fail" },
        };
      }
      if (args[0] === `repos/${REPO}/pulls/42/reviews?per_page=100&page=1`) return [];
      if (args[0] === `repos/${REPO}/pulls/42/comments?per_page=100&page=1`) {
        throw new Error("simulated inline transcript failure");
      }
      if (
        args[0] === `repos/${REPO}/issues/42/comments?per_page=100&page=1` ||
        args[0] === `repos/${REPO}/pulls/42/commits?per_page=100&page=1`
      ) {
        return [];
      }
      throw new Error(`unexpected gh call: ${args[0]}`);
    },
    decideFn: async () => {
      decided = true;
      throw new Error("should not decide from partial transcript");
    },
  });

  const [prLine, overallLine] = out.output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.equal(decided, false);
  assert.equal(prLine.action, "wait");
  assert.equal(prLine.done, false);
  assert.match(prLine.reason, /could not fetch inline review comments/i);
  assert.equal(overallLine.done, false);
  assert.equal(overallLine.scope_fetch_failures, 1);
});

test("single-PR scope stays non-terminal when issue transcript fetch fails", async () => {
  let decided = false;
  const out = await runMonitorOnce({
    state: {},
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    emitJsonReport: true,
    targetPr: { repo: REPO, num: 42 },
    runGhFn: async (args) => {
      if (args[0] === `repos/${REPO}/pulls/42`) {
        return {
          number: 42,
          state: "open",
          draft: false,
          title: "Issue failure PR",
          head: { sha: "issue-fail" },
        };
      }
      if (
        args[0] === `repos/${REPO}/pulls/42/reviews?per_page=100&page=1` ||
        args[0] === `repos/${REPO}/pulls/42/comments?per_page=100&page=1` ||
        args[0] === `repos/${REPO}/pulls/42/commits?per_page=100&page=1`
      ) {
        return [];
      }
      if (args[0] === `repos/${REPO}/issues/42/comments?per_page=100&page=1`) {
        throw new Error("simulated issue transcript failure");
      }
      throw new Error(`unexpected gh call: ${args[0]}`);
    },
    decideFn: async () => {
      decided = true;
      throw new Error("should not decide from partial transcript");
    },
  });

  const [prLine, overallLine] = out.output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.equal(decided, false);
  assert.equal(prLine.action, "wait");
  assert.equal(prLine.done, false);
  assert.match(prLine.reason, /could not fetch issue comments/i);
  assert.equal(overallLine.done, false);
  assert.equal(overallLine.scope_fetch_failures, 1);
});

test("LLM context includes formal review transcript for All-clear decisions", async () => {
  let seenReviewTranscript = null;
  await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    runGhFn: async (args) => {
      if (args[0] === `repos/${REPO}/pulls?state=open&per_page=100&page=1`) return [makePr("review123")];
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
            commit_id: "abc123review",
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
      commit_id: "abc123review",
      body: "Looks good to me, nothing else to add.",
    },
  ]);
});

test("repo scope paginates open PR listings", async () => {
  const seenPrs = [];
  const page1 = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    state: "open",
    draft: false,
    title: `PR ${index + 1}`,
    head: { sha: `sha-${index + 1}` },
  }));
  const page2 = [{
    number: 101,
    state: "open",
    draft: false,
    title: "PR 101",
    head: { sha: "sha-101" },
  }];

  const out = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    runGhFn: async (args) => {
      if (args[0] === `repos/${REPO}/pulls?state=open&per_page=100&page=1`) return page1;
      if (args[0] === `repos/${REPO}/pulls?state=open&per_page=100&page=2`) return page2;
      throw new Error(`unexpected gh call: ${args[0]}`);
    },
    collectPrStateFn: async (pr) => {
      seenPrs.push(pr.number);
      return makeCtx({ headSha: pr.head.sha });
    },
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "wait",
      reason: "still waiting",
      reused: false,
      stateEntry,
      notifications: [],
    }),
  });

  assert.equal(seenPrs.length, 101);
  assert.equal(seenPrs.at(-1), 101);
  assert.equal(out.reports.length, 101);
});

test("single-PR scope emits an explicit terminal report for non-open PRs", async () => {
  const out = await runMonitorOnce({
    state: {},
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    targetPr: { repo: REPO, num: 42 },
    emitJsonReport: true,
    runGhFn: async (args) => {
      if (args[0] === `repos/${REPO}/pulls/42`) {
        return {
          number: 42,
          state: "closed",
          merged: true,
          draft: false,
          title: "Merged PR scope",
          head: { sha: "closed123" },
        };
      }
      throw new Error(`unexpected gh call: ${args[0]}`);
    },
  });

  const lines = out.output.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, "pr");
  assert.equal(lines[0].pr, 42);
  assert.equal(lines[0].done, true);
  assert.equal(lines[0].terminal, "done");
  assert.match(lines[0].reason, /not open \(merged\)/i);
  assert.equal(lines[1].done, true);
});

test("request_fix posts the provided feedback URLs instead of falling back to review", async () => {
  const posts = [];
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    runGhFn: async (args) => {
      if (args[0] === `repos/${REPO}/pulls?state=open&per_page=100&page=1`) return [makePr("fix-urls")];
      if (args.includes("POST")) posts.push(args);
      return [];
    },
    collectPrStateFn: async () => makeCtx({
      headSha: "fix-urls",
      commentUrls: [
        `http://github.com/${REPO}/pull/7#pullrequestreview-1`,
        `http://github.com/${REPO}/issues/7#issuecomment-2`,
      ],
    }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "request_fix",
      reason: "human feedback still needs a fix",
      reused: false,
      stateEntry,
      notifications: [],
    }),
  });

  assert.equal(posts.length, 0);
  assert.match(
    out.output,
    /@copilot work on the issues mentioned in these comments .*pullrequestreview-1 .*issuecomment-2/i
  );
});

test("review transcript edits invalidate the cached decision even without new timestamps", async () => {
  let decideCalls = 0;
  const reviewsByTick = [
    [{
      user: { login: "reviewer" },
      state: "COMMENTED",
      body: "please tighten this up",
      submitted_at: "2026-09-08T00:00:00.000Z",
      id: 5001,
    }],
    [{
      user: { login: "reviewer" },
      state: "DISMISSED",
      body: "dismissed after follow-up",
      submitted_at: "2026-09-08T00:00:00.000Z",
      id: 5001,
    }],
  ];
  let tick = 0;
  const runGhFn = async (args) => {
    if (args[0] === `repos/${REPO}/pulls/42`) {
      return {
        number: 42,
        state: "open",
        draft: false,
        title: "Review digest PR",
        head: { sha: "digest123" },
        mergeable: true,
        mergeable_state: "clean",
      };
    }
    if (args[0] === `repos/${REPO}/pulls/42/reviews?per_page=100&page=1`) return reviewsByTick[tick];
    if (
      args[0] === `repos/${REPO}/pulls/42/comments?per_page=100&page=1` ||
      args[0] === `repos/${REPO}/issues/42/comments?per_page=100&page=1` ||
      args[0] === `repos/${REPO}/pulls/42/commits?per_page=100&page=1`
    ) {
      return [];
    }
    throw new Error(`unexpected gh call: ${args[0]}`);
  };
  const decideFn = async ({ stateEntry }) => {
    decideCalls++;
    return {
      handled: true,
      action: "wait",
      reason: `decision ${decideCalls}`,
      reused: false,
      stateEntry,
      notifications: [],
    };
  };

  const first = await runMonitorOnce({
    state: {},
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: true,
    targetPr: { repo: REPO, num: 42 },
    runGhFn,
    decideFn,
  });
  tick = 1;
  await runMonitorOnce({
    state: first.state,
    nowMs: Date.parse("2026-09-08T01:00:00.000Z"),
    dryRun: true,
    targetPr: { repo: REPO, num: 42 },
    runGhFn,
    decideFn,
  });

  assert.equal(decideCalls, 2);
});

test("pending request_review retries after the throttle window and eventually exhausts", async () => {
  const decisions = [
    { action: "request_review", reason: "first review request" },
    { action: "wait", reason: "still waiting on the earlier request" },
    { action: "wait", reason: "still waiting on the earlier request" },
    { action: "wait", reason: "still waiting on the earlier request" },
  ];
  const postCalls = [];
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  let decisionIndex = 0;

  const runGhFn = async (args) => {
    if (args[0] === `repos/${REPO}/pulls?state=open&per_page=100&page=1`) return [makePr("retry123")];
    if (args.includes("POST")) postCalls.push(args);
    return [];
  };
  const decideFn = async ({ stateEntry }) => ({
    handled: true,
    ...decisions[Math.min(decisionIndex++, decisions.length - 1)],
    reused: false,
    stateEntry,
    notifications: [],
  });

  const tick1 = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: now,
    dryRun: false,
    emitJsonReport: true,
    runGhFn,
    collectPrStateFn: async () => makeCtx({ headSha: "retry123" }),
    decideFn,
  });
  const tick2 = await runMonitorOnce({
    repos: [REPO],
    state: tick1.state,
    nowMs: now + 1 * 3600_000,
    dryRun: false,
    emitJsonReport: true,
    runGhFn,
    collectPrStateFn: async () => makeCtx({ headSha: "retry123" }),
    decideFn,
  });
  const tick3 = await runMonitorOnce({
    repos: [REPO],
    state: tick2.state,
    nowMs: now + 13 * 3600_000,
    dryRun: false,
    emitJsonReport: true,
    runGhFn,
    collectPrStateFn: async () => makeCtx({ headSha: "retry123" }),
    decideFn,
  });
  const tick4 = await runMonitorOnce({
    repos: [REPO],
    state: tick3.state,
    nowMs: now + 26 * 3600_000,
    dryRun: false,
    emitJsonReport: true,
    runGhFn,
    collectPrStateFn: async () => makeCtx({ headSha: "retry123" }),
    decideFn,
  });
  const tick5 = await runMonitorOnce({
    repos: [REPO],
    state: tick4.state,
    nowMs: now + 39 * 3600_000,
    dryRun: false,
    emitJsonReport: true,
    runGhFn,
    collectPrStateFn: async () => makeCtx({ headSha: "retry123" }),
    decideFn,
  });

  const finalPrLine = tick5.output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))[0];
  assert.equal(postCalls.length, 3);
  assert.equal(tick2.githubActionsTaken, 0);
  assert.equal(tick3.githubActionsTaken, 1);
  assert.equal(tick4.githubActionsTaken, 1);
  assert.equal(finalPrLine.done, true);
  assert.equal(finalPrLine.terminal, "needs-human");
});

test("request_fix uses its own retry budget after review requests were answered", async () => {
  const posts = [];
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {
      [`${REPO}#7`]: {
        review_fix_pings_sha: "phase123",
        review_fix_pings_action: "request_review",
        review_fix_pings: 3,
      },
    },
    nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
    dryRun: false,
    emitJsonReport: true,
    runGhFn: async (args) => {
      if (args[0] === `repos/${REPO}/pulls?state=open&per_page=100&page=1`) return [makePr("phase123")];
      if (args.includes("POST")) posts.push(args);
      return [];
    },
    collectPrStateFn: async () => makeCtx({
      headSha: "phase123",
      commentUrls: [`http://github.com/${REPO}/pull/7#discussion_r123`],
    }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "request_fix",
      reason: "reviewer replied with actionable comments",
      reused: false,
      stateEntry,
      notifications: [],
    }),
  });

  const prLine = out.output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))[0];
  assert.equal(posts.length, 1);
  assert.equal(prLine.done, false);
  assert.equal(out.state[`${REPO}#7`].review_fix_pings_action, "request_fix");
  assert.equal(out.state[`${REPO}#7`].review_fix_pings, 1);
});

function prJsonLine(out) {
  return out.output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))[0];
}

function repoScopeGh(headSha = "abc123") {
  return async (args) => {
    if (args[0] === `repos/${REPO}/pulls?state=open&per_page=100&page=1`) return [makePr(headSha)];
    if (args.includes("POST")) return [];
    return [];
  };
}

test("review ping sets next_check_at to ping time + 12h", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("ping123"),
    collectPrStateFn: async () => makeCtx({ headSha: "ping123" }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "request_review",
      reason: "no review on this head yet",
      reused: false,
      stateEntry,
      notifications: [],
    }),
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "request_review");
  assert.equal(prLine.next_check_at, new Date(now + 12 * 3600_000).toISOString());
  assert.deepEqual(prLine.owner_notifications, []);
});

test("rebase ping sets next_check_at to ping time + 6h", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("dirty123"),
    collectPrStateFn: async () =>
      makeCtx({ headSha: "dirty123", hasConflicts: true, mergeable: false, mergeableState: "dirty" }),
    llmDecider: async () => {
      throw new Error("rebase is deterministic; the LLM must not be called");
    },
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "request_rebase");
  assert.equal(prLine.next_check_at, new Date(now + 6 * 3600_000).toISOString());
});

test("a stale pending review ping with new feedback waits for the remaining review cooldown", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const reviewTs = now - 1 * 3600_000;
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {
      [`${REPO}#7`]: {
        last_ping_sha: "feedback123",
        last_ping_ts: new Date(now - 13 * 3600_000).toISOString(),
        review_fix_pending_sha: "feedback123",
        review_fix_pending_action: "request_review",
        review_fix_pending_response_sig: "signature-before-feedback",
      },
    },
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("feedback123"),
    collectPrStateFn: async () => makeCtx({
      headSha: "feedback123",
      latestReviewTs: reviewTs,
      reviewTranscript: [{
        author: "reviewer",
        ts: new Date(reviewTs).toISOString(),
        state: "COMMENTED",
        body: "Please address this feedback.",
      }],
    }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "wait",
      reason: "new feedback arrived",
      reused: false,
      stateEntry,
      notifications: [],
    }),
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "wait");
  assert.equal(prLine.next_check_at, new Date(reviewTs + 6 * 3600_000).toISOString());
  assert.notEqual(prLine.next_check_at, new Date(now).toISOString());
});

test("a blocked review/fix action retains the remaining same-head ping throttle", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {
      [`${REPO}#7`]: {
        _action: "request_fix",
        last_ping_sha: "feedback123",
        last_ping_ts: new Date(now - 1 * 3600_000).toISOString(),
        review_fix_pending_sha: "feedback123",
        review_fix_pending_action: "request_review",
        review_fix_pending_response_sig: "signature-before-feedback",
      },
    },
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("feedback123"),
    collectPrStateFn: async () => makeCtx({
      headSha: "feedback123",
      latestReviewTs: now - 30 * 60_000,
      reviewTranscript: [{
        author: "reviewer",
        ts: new Date(now - 30 * 60_000).toISOString(),
        state: "COMMENTED",
        body: "Please address this feedback.",
      }],
    }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "request_fix",
      reason: "new feedback needs a fix",
      reused: false,
      stateEntry: { ...stateEntry, _action: "request_fix" },
      notifications: [],
    }),
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "wait");
  assert.equal(prLine.next_check_at, new Date(now + 11 * 3600_000).toISOString());
});

test("an old weekly escalation anchor does not override the fresh rebase-ping throttle", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {
      [`${REPO}#7`]: {
        rebase_pings_sha: "fresh-cycle",
        rebase_pings: 1,
        stuck_notified_sha: "fresh-cycle",
        stuck_notified_ts: new Date(now - 8 * 24 * 3600_000).toISOString(),
        last_ping_sha: "fresh-cycle",
        last_ping_ts: new Date(now - 7 * 3600_000).toISOString(),
      },
    },
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("fresh-cycle"),
    collectPrStateFn: async () => makeCtx({
      headSha: "fresh-cycle",
      hasConflicts: true,
      mergeable: false,
      mergeableState: "dirty",
      issueTranscript: [{
        author: "alice",
        ts: new Date(now - 7 * 3600_000).toISOString(),
        body: "@copilot resolve the merge conflicts with origin/main",
      }],
    }),
    llmDecider: async () => { throw new Error("conflict gate should be deterministic"); },
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "request_rebase");
  assert.equal(prLine.next_check_at, new Date(now + 6 * 3600_000).toISOString());
});

test("stuck PR after escalation arms the weekly retry (+168h) and escalates once", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const requestTs = new Date(now - 2 * 24 * 3600_000).toISOString();
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {
      [`${REPO}#7`]: {
        rebase_pings_sha: "stuck123",
        rebase_pings: 3,
        last_ping_ts: requestTs,
      },
    },
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("stuck123"),
    collectPrStateFn: async () =>
      makeCtx({
        headSha: "stuck123",
        hasConflicts: true,
        mergeable: false,
        mergeableState: "dirty",
        issueTranscript: [
          {
            author: "alice",
            ts: requestTs,
            body: "@copilot resolve the merge conflicts with origin/main",
          },
        ],
      }),
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "wait");
  assert.equal(prLine.next_check_at, new Date(now + 168 * 3600_000).toISOString());
  assert.equal(prLine.owner_notifications.length, 1);
  assert.equal(prLine.owner_notifications[0].event, "escalation");
  assert.match(prLine.owner_notifications[0].message, /STILL conflicted/);
});

test("stuck weekly retry advances by whole weeks from the escalation, never collapsing to now", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const escalatedTs = new Date(now - 8 * 24 * 3600_000).toISOString();
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {
      [`${REPO}#7`]: {
        stuck_notified_sha: "stuck123",
        stuck_notified_ts: escalatedTs,
        rebase_pings_sha: "stuck123",
        rebase_pings: 3,
        last_ping_ts: new Date(now - 9 * 24 * 3600_000).toISOString(),
      },
    },
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("stuck123"),
    collectPrStateFn: async () =>
      makeCtx({ headSha: "stuck123", hasConflicts: true, mergeable: false, mergeableState: "dirty" }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "wait",
      reason: "rebase retry budget exhausted; owner escalated",
      reused: true,
      stateEntry,
      notifications: [],
    }),
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "wait");
  // 8 days after escalation, the weekly slot at +168h is already stale: the
  // next one is escalation + 2 weeks = now + 6 days. Never `now`.
  assert.equal(
    prLine.next_check_at,
    new Date(now - 8 * 24 * 3600_000 + 2 * 168 * 3600_000).toISOString()
  );
});

test("legacy stuck state without an escalation ts anchors the weekly retry at the last ping, still not at now", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const lastPing = now - 8 * 24 * 3600_000;
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {
      [`${REPO}#7`]: {
        stuck_notified_sha: "stuck123",
        rebase_pings_sha: "stuck123",
        rebase_pings: 3,
        last_ping_ts: new Date(lastPing).toISOString(),
      },
    },
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("stuck123"),
    collectPrStateFn: async () =>
      makeCtx({ headSha: "stuck123", hasConflicts: true, mergeable: false, mergeableState: "dirty" }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "wait",
      reason: "rebase retry budget exhausted; owner escalated",
      reused: true,
      stateEntry,
      notifications: [],
    }),
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "wait");
  assert.equal(
    prLine.next_check_at,
    new Date(lastPing + 2 * 168 * 3600_000).toISOString()
  );
});

test("needs-human review/fix exhaustion anchors its weekly retry at the exhaustion, not the last ping", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const exhaustedTs = new Date(now - 8 * 24 * 3600_000).toISOString();
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {
      [`${REPO}#7`]: {
        review_fix_exhausted_sha: "review123",
        review_fix_exhausted_ts: exhaustedTs,
        review_fix_pending_sha: "review123",
        review_fix_pending_action: "request_fix",
        last_ping_ts: new Date(now - 10 * 24 * 3600_000).toISOString(),
      },
    },
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("review123"),
    collectPrStateFn: async () => makeCtx({ headSha: "review123" }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "wait",
      reason: "review/fix retry budget exhausted",
      reused: true,
      stateEntry,
      notifications: [],
    }),
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "wait");
  assert.equal(
    prLine.next_check_at,
    new Date(now - 8 * 24 * 3600_000 + 2 * 168 * 3600_000).toISOString()
  );
});

test("a rebase ping inside its throttle window arms the deadline at ping time + 6h, not at the older request", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const requestTs = new Date(now - 2 * 24 * 3600_000).toISOString();
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {
      [`${REPO}#7`]: {
        rebase_pings_sha: "dirty123",
        rebase_pings: 1,
        last_ping_sha: "dirty123",
        last_ping_ts: new Date(now - 3600_000).toISOString(),
      },
    },
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("dirty123"),
    collectPrStateFn: async () =>
      makeCtx({
        headSha: "dirty123",
        hasConflicts: true,
        mergeable: false,
        mergeableState: "dirty",
        issueTranscript: [
          { author: "alice", ts: requestTs, body: "@copilot resolve the merge conflicts with origin/main" },
        ],
      }),
    llmDecider: async () => {
      throw new Error("rebase is deterministic; the LLM must not be called");
    },
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "wait", "the 6h rebase throttle blocks an immediate re-ping");
  assert.equal(prLine.next_check_at, new Date(now - 3600_000 + 6 * 3600_000).toISOString());
  assert.notEqual(prLine.next_check_at, new Date(now).toISOString(), "the deadline must not collapse to now");
});

test("active-work hold arms next_check_at at last commit + 3h", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("active123"),
    collectPrStateFn: async () =>
      makeCtx({ headSha: "active123", lastCommitTs: now - 3600_000 }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "request_review",
      reason: "no review yet",
      reused: false,
      stateEntry,
      notifications: [],
    }),
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "wait");
  assert.match(prLine.reason, /still working/i);
  assert.equal(prLine.next_check_at, new Date(now + 2 * 3600_000).toISOString());
});

test("recurring LLM failure arms +1h and reports a needs-human owner notification", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {
      [`${REPO}#7`]: {
        llm_failures_sha: "llmfail123",
        llm_failures: 2,
      },
    },
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("llmfail123"),
    collectPrStateFn: async () => makeCtx({ headSha: "llmfail123" }),
    llmDecider: async () => {
      throw new Error("simulated llm outage");
    },
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "llm_failed");
  assert.equal(prLine.next_check_at, new Date(now + 3600_000).toISOString());
  assert.equal(prLine.owner_notifications.length, 1);
  assert.equal(prLine.owner_notifications[0].event, "needs-human");
});

test("transient LLM failures schedule another Tick before terminal escalation", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("llmfail123"),
    collectPrStateFn: async () => makeCtx({ headSha: "llmfail123" }),
    llmDecider: async () => { throw new Error("simulated temporary outage"); },
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "wait");
  assert.equal(prLine.next_check_at, new Date(now + 3600_000).toISOString());
  assert.deepEqual(prLine.owner_notifications, []);
});

test("failed PR-state reads are explicitly marked in the JSON report", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const out = await runMonitorOnce({
      repos: [REPO],
      state: {},
      nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
      dryRun: true,
      emitJsonReport: true,
      runGhFn: async (args) => {
        if (args[0] === `repos/${REPO}/pulls?state=open&per_page=100&page=1`) return [makePr("readfail123")];
        if (args[0] === `repos/${REPO}/pulls/7/reviews`) return [];
        if (args[0] === `repos/${REPO}/pulls/7/comments`) throw new Error("API unavailable");
        throw new Error(`unexpected gh call: ${args[0]}`);
      },
    });
    const prLine = prJsonLine(out);
    assert.equal(prLine.fetch_failed, true);
    assert.equal(prLine.next_check_at, null);
    assert.equal(out.overallReport.scope_fetch_failures, 1);
  } finally {
    console.error = originalError;
  }
});

test("notify_ready reports next_check_at null with a structured owner notification", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("ready123"),
    collectPrStateFn: async () => makeCtx({ headSha: "ready123" }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "notify_ready",
      reason: "all clear",
      reused: false,
      stateEntry,
      notifications: [],
    }),
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.next_check_at, null);
  assert.equal(prLine.owner_notifications.length, 1);
  assert.equal(prLine.owner_notifications[0].event, "notify_ready");
  assert.match(prLine.owner_notifications[0].message, /READY for your review/);
});

test("draft skip reports next_check_at null and no owner notifications", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("draft123"),
    collectPrStateFn: async () => makeCtx({ headSha: "draft123", draft: true }),
    llmDecider: async () => {
      throw new Error("draft PRs skip the loop; the LLM must not be called");
    },
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "skip_wip");
  assert.equal(prLine.next_check_at, null);
  assert.deepEqual(prLine.owner_notifications, []);
});

test("idle wait reports next_check_at null and no owner notifications", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("idle123"),
    collectPrStateFn: async () => makeCtx({ headSha: "idle123" }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "wait",
      reason: "nothing worth doing right now",
      reused: false,
      stateEntry,
      notifications: [],
    }),
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "wait");
  assert.equal(prLine.next_check_at, null);
  assert.deepEqual(prLine.owner_notifications, []);
});

test("a decision reused from the signature cache carries the pending ping deadline", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const llmDecider = async () => ({ action: "request_review", reason: "please review" });
  const runGhFn = repoScopeGh("cache123");
  const collectPrStateFn = async () => makeCtx({ headSha: "cache123" });

  const first = await runMonitorOnce({
    repos: [REPO],
    state: {},
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn,
    collectPrStateFn,
    llmDecider,
  });
  const second = await runMonitorOnce({
    repos: [REPO],
    state: first.state,
    nowMs: now + 3600_000,
    dryRun: true,
    emitJsonReport: true,
    runGhFn,
    collectPrStateFn,
    llmDecider,
  });

  const prLine = prJsonLine(second);
  assert.equal(prLine.reused_cached_decision, true);
  assert.equal(prLine.next_check_at, new Date(now + 12 * 3600_000).toISOString());
});

test("review/fix retry exhaustion keeps the weekly retry and a needs-human notification", async () => {
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const out = await runMonitorOnce({
    repos: [REPO],
    state: {
      [`${REPO}#7`]: {
        review_fix_pings_sha: "exhaust123",
        review_fix_pings_action: "request_review",
        review_fix_pings: 3,
        last_ping_ts: new Date(now - 2 * 24 * 3600_000).toISOString(),
      },
    },
    nowMs: now,
    dryRun: true,
    emitJsonReport: true,
    runGhFn: repoScopeGh("exhaust123"),
    collectPrStateFn: async () => makeCtx({ headSha: "exhaust123" }),
    decideFn: async ({ stateEntry }) => ({
      handled: true,
      action: "request_review",
      reason: "still waiting",
      reused: false,
      stateEntry,
      notifications: [],
    }),
  });

  const prLine = prJsonLine(out);
  assert.equal(prLine.terminal, "needs-human");
  // Exhaustion happens this run: the weekly retry anchors at the exhaustion
  // moment (+168h), not at the older last ping.
  assert.equal(prLine.next_check_at, new Date(now + 168 * 3600_000).toISOString());
  assert.equal(prLine.owner_notifications.length, 1);
  assert.equal(prLine.owner_notifications[0].event, "needs-human");
});

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a decision-command stub and return the shell command that runs it. */
function writeDecisionCommand(dir, body) {
  const scriptPath = path.join(dir, "decision-command.mjs");
  fs.writeFileSync(scriptPath, body);
  return `"${process.execPath}" "${scriptPath}"`;
}

async function withEnv(vars, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const NO_DECISION_ENV = {
  PR_MONITOR_LLM_CMD: undefined,
  PR_MONITOR_LLM_CMD_TIMEOUT_MS: undefined,
  OPENROUTER_API_KEY: undefined,
};

async function runThreeCommandTicks(command, envOverrides = {}) {
  const home = makeTempDir("pr-monitor-cmd-home-");
  const ticks = [];
  await withEnv(
    { ...NO_DECISION_ENV, HOME: home, PR_MONITOR_LLM_CMD: command, ...envOverrides },
    async () => {
      let state = {};
      for (let attempt = 0; attempt < 3; attempt++) {
        const tick = await runMonitorOnce({
          repos: [REPO],
          state,
          nowMs: Date.parse("2026-09-08T00:00:00.000Z") + attempt * 600_000,
          dryRun: true,
          runGhFn: repoScopeGh("cmdfail123"),
          collectPrStateFn: async () => makeCtx({ headSha: "cmdfail123" }),
        });
        ticks.push(tick);
        state = tick.state;
      }
    }
  );
  return ticks;
}

function assertCommandFailureEscalation(ticks, failurePattern) {
  assert.equal(ticks[0].reports[0].action, "wait");
  assert.match(ticks[0].reports[0].reason, failurePattern);
  assert.match(ticks[0].reports[0].reason, /retrying \(1\/3\)/);
  assert.equal(ticks[0].reports[0].decision_adapter, "decision_command");
  assert.deepEqual(ticks[0].reports[0].owner_notifications, []);
  assert.equal(ticks[0].state[`${REPO}#7`].llm_failures, 1);

  assert.match(ticks[1].reports[0].reason, /retrying \(2\/3\)/);
  assert.equal(ticks[1].state[`${REPO}#7`].llm_failures, 2);

  const finalReport = ticks[2].reports[0];
  assert.equal(finalReport.action, "llm_failed");
  assert.equal(finalReport.terminal, "needs-human");
  assert.equal(finalReport.done, true);
  assert.equal(finalReport.owner_notifications.length, 1);
  assert.equal(finalReport.owner_notifications[0].event, "needs-human");
  assert.equal(finalReport.decision_adapter, "decision_command");
  assert.match(finalReport.reason, /after 3 attempts on this head/i);
  assert.equal(ticks[2].state[`${REPO}#7`].llm_failures, 3);
}

test("decision command drives the decide stage and receives the request on stdin", async () => {
  const dir = makeTempDir("pr-monitor-cmd-");
  const capturePath = path.join(dir, "captured-request.json");
  const command = writeDecisionCommand(dir, `
import fs from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(capturePath)}, input);
  process.stdout.write(JSON.stringify({ action: "request_review", reason: "command says review" }));
});
`);

  const out = await withEnv(
    { ...NO_DECISION_ENV, HOME: dir, PR_MONITOR_LLM_CMD: command },
    () => runMonitorOnce({
      repos: [REPO],
      state: {},
      nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
      dryRun: true,
      emitJsonReport: true,
      runGhFn: repoScopeGh("cmd123"),
      collectPrStateFn: async () => makeCtx({ headSha: "cmd123" }),
    })
  );

  const captured = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  assert.equal(captured.repo, REPO);
  assert.equal(captured.pr, 7);
  assert.equal(captured.head_sha, "cmd123");

  const [prLine] = out.output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.equal(prLine.action, "request_review");
  assert.equal(prLine.reason, "command says review");
  assert.equal(prLine.decision_adapter, "decision_command");
  assert.match(out.output, /\[DRY-RUN\].*@copilot code review/);
});

test("the skill env file can define the decision command", async () => {
  const home = makeTempDir("pr-monitor-envfile-home-");
  const dir = makeTempDir("pr-monitor-envfile-cmd-");
  const command = writeDecisionCommand(
    dir,
    `process.stdout.write(JSON.stringify({ action: "request_fix", reason: "env file command" }));`
  );
  fs.writeFileSync(path.join(home, ".pr-monitor.env"), `PR_MONITOR_LLM_CMD=${command}\n`);

  const out = await withEnv(
    { ...NO_DECISION_ENV, HOME: home },
    () => runMonitorOnce({
      repos: [REPO],
      state: {},
      nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
      dryRun: true,
      runGhFn: repoScopeGh("envfile123"),
      collectPrStateFn: async () => makeCtx({ headSha: "envfile123" }),
    })
  );

  assert.equal(out.reports[0].action, "request_fix");
  assert.equal(out.reports[0].reason, "env file command");
  assert.equal(out.reports[0].decision_adapter, "decision_command");
});

test("an explicit decision command wins over model+credential", async () => {
  const dir = makeTempDir("pr-monitor-cmd-");
  const command = writeDecisionCommand(
    dir,
    `process.stdout.write(JSON.stringify({ action: "wait", reason: "command wins" }));`
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("model path must not run when a decision command is defined");
  };
  try {
    const out = await withEnv(
      { ...NO_DECISION_ENV, HOME: dir, PR_MONITOR_LLM_CMD: command, OPENROUTER_API_KEY: "test-key" },
      () => runMonitorOnce({
        repos: [REPO],
        state: {},
        nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
        dryRun: true,
        runGhFn: repoScopeGh("precedence123"),
        collectPrStateFn: async () => makeCtx({ headSha: "precedence123" }),
      })
    );

    assert.equal(out.reports[0].action, "wait");
    assert.equal(out.reports[0].reason, "command wins");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decision command non-zero exit consumes the failure budget and escalates on the third attempt", async () => {
  const command = writeDecisionCommand(
    makeTempDir("pr-monitor-cmd-"),
    `process.stderr.write("boom"); process.exit(4);`
  );
  const ticks = await runThreeCommandTicks(command);
  assertCommandFailureEscalation(ticks, /LLM command exited 4: boom/);
});

test("decision command timeout consumes the failure budget and escalates on the third attempt", async () => {
  const command = writeDecisionCommand(
    makeTempDir("pr-monitor-cmd-"),
    `setTimeout(() => process.stdout.write(JSON.stringify({ action: "wait", reason: "too late" })), 30_000);`
  );
  const ticks = await runThreeCommandTicks(command, { PR_MONITOR_LLM_CMD_TIMEOUT_MS: "250" });
  assertCommandFailureEscalation(ticks, /LLM command timed out after 250ms/);
});

test("unparseable decision command output consumes the failure budget and escalates on the third attempt", async () => {
  const command = writeDecisionCommand(
    makeTempDir("pr-monitor-cmd-"),
    `process.stdout.write("not a JSON decision");`
  );
  const ticks = await runThreeCommandTicks(command);
  assertCommandFailureEscalation(ticks, /unparseable LLM command JSON/i);
});

test("no decision source resolves to an actionable wait without notification or budget movement", async () => {
  const home = makeTempDir("pr-monitor-none-home-");
  const runTick = (state, nowMs) => runMonitorOnce({
    repos: [REPO],
    state,
    nowMs,
    dryRun: true,
    runGhFn: repoScopeGh("nosource123"),
    collectPrStateFn: async () => makeCtx({ headSha: "nosource123" }),
  });

  const result = await withEnv(
    { ...NO_DECISION_ENV, HOME: home },
    async () => {
      const first = await runTick({}, Date.parse("2026-09-08T00:00:00.000Z"));
      const second = await runTick(first.state, Date.parse("2026-09-08T01:00:00.000Z"));
      return { first, second };
    }
  );

  for (const tick of [result.first, result.second]) {
    const [report] = tick.reports;
    assert.equal(report.action, "wait");
    assert.equal(report.decision_adapter, "none");
    assert.equal(report.done, false);
    assert.equal(report.terminal, null);
    assert.deepEqual(report.owner_notifications, []);
    assert.match(report.reason, /PR_MONITOR_LLM_CMD/);
    assert.match(report.reason, /OPENROUTER_API_KEY/);
    assert.equal(tick.output, "", "a configuration gap must stay silent");
    assert.equal(Object.hasOwn(tick.state[`${REPO}#7`], "llm_failures"), false);
  }
});

test("deterministic gates still decide without a decision source", async () => {
  const home = makeTempDir("pr-monitor-none-home-");
  const out = await withEnv(
    { ...NO_DECISION_ENV, HOME: home },
    () => runMonitorOnce({
      repos: [REPO],
      state: {},
      nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
      dryRun: true,
      emitJsonReport: true,
      runGhFn: repoScopeGh("dirty-nosource"),
      collectPrStateFn: async () =>
        makeCtx({ headSha: "dirty-nosource", hasConflicts: true, mergeable: false, mergeableState: "dirty" }),
    })
  );

  const prLine = prJsonLine(out);
  assert.equal(prLine.action, "request_rebase");
  assert.equal(prLine.decision_adapter, null);
  assert.doesNotMatch(prLine.reason, /PR_MONITOR_LLM_CMD/);
});

test("model+credential remains the deployed decision source when no command is defined", async () => {
  const home = makeTempDir("pr-monitor-model-home-");
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ action: "wait", reason: "model decided" }) } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const out = await withEnv(
      { ...NO_DECISION_ENV, HOME: home, OPENROUTER_API_KEY: "test-key" },
      () => runMonitorOnce({
        repos: [REPO],
        state: {},
        nowMs: Date.parse("2026-09-08T00:00:00.000Z"),
        dryRun: true,
        runGhFn: repoScopeGh("model123"),
        collectPrStateFn: async () => makeCtx({ headSha: "model123" }),
      })
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
    const requestBody = JSON.parse(calls[0].init.body);
    assert.equal(requestBody.temperature, 0);
    assert.equal(JSON.parse(requestBody.messages[1].content).head_sha, "model123");
    assert.equal(out.reports[0].action, "wait");
    assert.equal(out.reports[0].reason, "model decided");
    assert.equal(out.reports[0].decision_adapter, "model_credential");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
