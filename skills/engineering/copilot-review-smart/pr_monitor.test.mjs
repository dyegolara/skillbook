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
  inlineTranscript = [],
  commentUrls = [],
  lastCopilotComment = "",
  lastCopilotCommentTs = null,
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
    commentUrls,
    lastCopilotComment,
    lastCopilotCommentTs,
    issueTranscript,
    inlineTranscript,
    lastCommitTs: null,
    mergeable: true,
    mergeableState: "clean",
    hasConflicts: false,
    mergeUnknown: false,
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
