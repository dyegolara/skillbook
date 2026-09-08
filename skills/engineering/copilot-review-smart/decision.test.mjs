import test from "node:test";
import assert from "node:assert/strict";
import { decideDeterministic } from "./decision.mjs";

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

test("draft/WIP PR skips loop", () => {
  const out = call({ ctx: { draft: true } });
  assert.equal(out.handled, true);
  assert.equal(out.action, "skip_wip");
});

test("dirty PR without prior request asks for rebase", () => {
  const out = call({ ctx: { hasConflicts: true } });
  assert.equal(out.handled, true);
  assert.equal(out.action, "request_rebase");
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
  assert.equal(out.action, "wait");
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
  assert.equal(out.action, "request_rebase");
});

test("budget exhausted escalates once and waits", () => {
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
  assert.equal(out.action, "wait");
  assert.equal(out.notifications.length, 1);
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
  assert.equal(out.action, "request_rebase");
  assert.equal(out.stateEntry.rebase_pings, 0);
});

test("mergeability unknown waits", () => {
  const out = call({ ctx: { mergeUnknown: true } });
  assert.equal(out.action, "wait");
});

test("signature unchanged reuses cached decision", () => {
  const out = call({
    sig: "same",
    stateEntry: {
      _sig: "same",
      _action: "wait",
      _reason: "cached reason",
    },
  });
  assert.equal(out.action, "wait");
  assert.equal(out.reused, true);
  assert.equal(out.reason, "cached reason");
});

test("new signal invalidates cache and requires LLM path", () => {
  const out = call({
    sig: "new-sig",
    stateEntry: {
      _sig: "old-sig",
      _action: "wait",
      _reason: "cached reason",
    },
  });
  assert.equal(out.handled, false);
});
