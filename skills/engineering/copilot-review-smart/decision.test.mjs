import test from "node:test";
import assert from "node:assert/strict";
import { decideDeterministic, decideWithLlm } from "./decision.mjs";

const BASE_NOW = Date.parse("2026-09-08T00:00:00.000Z");

function call(partial) {
  return decideDeterministic({
    ctx: {
      repo: "dyegolara/skillbook",
      num: 3,
      title: "Test PR",
      draft: false,
      headSha: "abc123",
      hasConflicts: false,
      mergeUnknown: false,
      issueTranscript: [],
      ...partial.ctx,
    },
    stateEntry: partial.stateEntry || {},
    nowMs: partial.nowMs ?? BASE_NOW,
    sig: partial.sig ?? "sig",
    rebaseRetryHours: 6,
    rebaseMaxPings: 3,
    rebaseStaleRetryHours: 24 * 7,
  });
}

function assertDecision(out, action, reasonIncludes) {
  assert.equal(out.action, action);
  assert.match(out.reason, reasonIncludes);
}

test("draft PR skips loop", () => {
  const out = call({ ctx: { draft: true } });
  assertDecision(out, "skip_wip", /draft\/WIP/i);
});

test("WIP-titled PR skips loop", () => {
  const out = call({ ctx: { title: "[WIP] still cooking" } });
  assertDecision(out, "skip_wip", /draft\/WIP/i);
});

test("dirty PR with no prior conflict-resolution request asks for rebase", () => {
  const out = call({
    ctx: {
      hasConflicts: true,
      issueTranscript: [
        {
          author: "alice",
          ts: new Date(BASE_NOW - 3 * 3600_000).toISOString(),
          body: "Looks good overall, thanks!",
        },
      ],
    },
  });
  assertDecision(out, "request_rebase", /no one has asked/i);
});

test("fresh rebase request (<6h) waits", () => {
  const out = call({
    ctx: {
      hasConflicts: true,
      issueTranscript: [
        {
          author: "alice",
          ts: new Date(BASE_NOW - 2 * 3600_000).toISOString(),
          body: "@copilot resolve the merge conflicts with origin/main",
        },
      ],
    },
  });
  assertDecision(out, "wait", /newer than 6h/i);
});

test("stale rebase request with budget left retries", () => {
  const out = call({
    ctx: {
      hasConflicts: true,
      issueTranscript: [
        {
          author: "alice",
          ts: new Date(BASE_NOW - 7 * 3600_000).toISOString(),
          body: "@copilot resolve the merge conflicts with origin/main",
        },
      ],
    },
    stateEntry: {
      rebase_pings_sha: "abc123",
      rebase_pings: 2,
    },
  });
  assertDecision(out, "request_rebase", /still conflicted after the previous rebase request/i);
});

test("budget exhausted waits with owner escalation reason", () => {
  const out = call({
    ctx: {
      hasConflicts: true,
      issueTranscript: [
        {
          author: "alice",
          ts: new Date(BASE_NOW - 7 * 3600_000).toISOString(),
          body: "@copilot resolve the merge conflicts with origin/main",
        },
      ],
    },
    stateEntry: {
      rebase_pings_sha: "abc123",
      rebase_pings: 3,
      last_ping_ts: new Date(BASE_NOW - 2 * 24 * 3600_000).toISOString(),
    },
  });
  assertDecision(out, "wait", /retry budget exhausted/i);
});

test("weekly retry resets budget and re-requests rebase", () => {
  const out = call({
    ctx: {
      hasConflicts: true,
      issueTranscript: [
        {
          author: "alice",
          ts: new Date(BASE_NOW - 7 * 3600_000).toISOString(),
          body: "@copilot resolve the merge conflicts with origin/main",
        },
      ],
    },
    stateEntry: {
      rebase_pings_sha: "abc123",
      rebase_pings: 3,
      last_ping_ts: new Date(BASE_NOW - 8 * 24 * 3600_000).toISOString(),
    },
  });
  assertDecision(out, "request_rebase", /weekly retry/i);
});

test("mergeability unknown waits", () => {
  const out = call({ ctx: { mergeUnknown: true } });
  assertDecision(out, "wait", /mergeability yet/i);
});

test("unchanged signature reuses cached decision and never calls LLM", async () => {
  const llmDecider = async () => {
    throw new Error("LLM should not be called when signature is unchanged");
  };
  const out = await decideWithLlm({
    ctx: {
      repo: "dyegolara/skillbook",
      num: 3,
      title: "Test PR",
      draft: false,
      headSha: "abc123",
      hasConflicts: false,
      mergeUnknown: false,
      issueTranscript: [],
    },
    stateEntry: {
      _sig: "same-sig",
      _action: "wait",
      _reason: "cached reason",
    },
    nowMs: BASE_NOW,
    sig: "same-sig",
    rebaseRetryHours: 6,
    rebaseMaxPings: 3,
    rebaseStaleRetryHours: 24 * 7,
    llmContext: {},
    llmDecider,
  });

  assertDecision(out, "wait", /cached reason/i);
});

test("any new comment invalidates signature and triggers a fresh decision", async () => {
  const ctx = {
    repo: "dyegolara/skillbook",
    num: 3,
    title: "Test PR",
    draft: false,
    headSha: "abc123",
    hasConflicts: false,
    mergeUnknown: false,
    issueTranscript: [],
  };
  const first = await decideWithLlm({
    ctx,
    stateEntry: {},
    nowMs: BASE_NOW,
    sig: "sig-before-new-comment",
    rebaseRetryHours: 6,
    rebaseMaxPings: 3,
    rebaseStaleRetryHours: 24 * 7,
    llmContext: {},
    llmDecider: async () => ({ action: "wait", reason: "before new comment" }),
  });

  const second = await decideWithLlm({
    ctx,
    stateEntry: first.stateEntry,
    nowMs: BASE_NOW + 60_000,
    sig: "sig-after-new-comment",
    rebaseRetryHours: 6,
    rebaseMaxPings: 3,
    rebaseStaleRetryHours: 24 * 7,
    llmContext: {},
    llmDecider: async () => ({ action: "request_review", reason: "new comment found" }),
  });
  assertDecision(second, "request_review", /new comment/i);
});
