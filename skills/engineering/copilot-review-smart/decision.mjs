import { DECISION_SOURCES } from "./decision_source.mjs";

const COPILOT_SUBSTR = "copilot";
const WIP_TITLE_RE = /^\s*\[?(wip|draft|dnm|do not merge|work in progress)\b/i;
const H = (h) => h * 3600_000;
const LLM_MAX_FAILURES_PER_HEAD = 3;

/** Layer 3 of the resolution chain (ADR-0007): no decider resolved. This is a
 * configuration gap, not a decision failure — it must never consume the
 * per-head budget or escalate to Needs-human. */
export class NoDecisionSourceError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "NoDecisionSourceError";
  }
}

function toMs(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Does this comment ASK Copilot to resolve merge conflicts (by rebase OR
 * merge)? Quote-lines (starting with '>') are stripped: Copilot's replies
 * quote requests back, and an ack must never count as a new request. */
function isRebaseRequest(body) {
  const stripped = (body || "")
    .split("\n")
    .filter((ln) => !ln.trim().startsWith(">"))
    .join("\n");
  const b = stripped.toLowerCase();
  return b.includes("rebase") || b.includes("merge conflict") || (b.includes("resolv") && b.includes("conflict"));
}

/** Timestamp (ms) of the newest conflict-resolution request by a NON-Copilot
 * author (the human or this bot). Copilot's replies only quote/ack requests
 * — they must never count as pending requests themselves. */
function newestRebaseRequestTsMs(issueTranscript, copilotSubstr = COPILOT_SUBSTR) {
  let best = null;
  for (const c of issueTranscript || []) {
    if ((c.author || "").toLowerCase().includes(copilotSubstr)) continue;
    if (!isRebaseRequest(c.body)) continue;
    const ts = toMs(c.ts);
    if (ts !== null && (best === null || ts > best)) best = ts;
  }
  return best;
}

/** The opening words of every deterministic gate wait emitted before the
 * signature cache. The reasons are the interface the observability
 * projection reads, so they are defined here beside the gate that emits
 * them: `isGateWaitReason` and the emitters can never drift apart. */
const CONFLICT_WINDOW_PREFIX = "Conflict-resolution request is newer than";
const REBASE_BUDGET_PREFIX = "Rebase retry budget exhausted";
const MERGE_UNKNOWN_REASON = "GitHub has not computed PR mergeability yet; wait for next tick.";
const LLM_RETRY_PREFIX = "Could not decide with LLM (";

/** Did a deterministic gate hold this wait before the cache? The persisted
 * Tick record has no Stage field (#107), so the projection asks the module
 * that emitted the reason instead of matching the prose on its own. */
export function isGateWaitReason(reason) {
  const text = String(reason || "");
  return (
    text.startsWith(CONFLICT_WINDOW_PREFIX) ||
    text.startsWith(REBASE_BUDGET_PREFIX) ||
    text === MERGE_UNKNOWN_REASON
  );
}

export function isLlmRetryReason(reason) {
  return String(reason || "").startsWith(LLM_RETRY_PREFIX);
}

export function decideDeterministic({
  ctx,
  stateEntry = {},
  nowMs,
  sig,
  rebaseRetryHours,
  rebaseMaxPings,
  rebaseStaleRetryHours,
}) {
  const st = { ...stateEntry };
  const notifications = [];
  const cachedSig = st._sig;
  const cachedAction = st._action;

  let action;
  let reason;
  let reused = false;

  if (ctx.draft || WIP_TITLE_RE.test(ctx.title || "")) {
    action = "skip_wip";
    reason =
      "PR is draft/WIP: another agent is likely working on it; skip the loop " +
      "(no ping, no review) until it is ready.";
  } else if (ctx.hasConflicts) {
    const reqTsMs = newestRebaseRequestTsMs(ctx.issueTranscript);
    let rebasePings = Number(st.rebase_pings) || 0;
    if (st.rebase_pings_sha !== ctx.headSha) rebasePings = 0; // new head => fresh budget

    if (reqTsMs === null) {
      action = "request_rebase";
      reason =
        "PR has conflicts with main and no one has asked for conflict " +
        "resolution yet: ask Copilot to resolve conflicts with origin/main " +
        "before any review.";
    } else if (nowMs - reqTsMs < H(rebaseRetryHours)) {
      action = "wait";
      reason =
        `${CONFLICT_WINDOW_PREFIX} ${rebaseRetryHours}h and no ` +
        "new commits were pushed: wait before retrying.";
    } else if (rebasePings >= rebaseMaxPings) {
      const lastPingMs = toMs(st.last_ping_ts);
      // The weekly gate anchors at the escalation moment, not the last ping:
      // the derivation arms the same anchor so gate and deadline coincide.
      const weeklyAnchorMs = st.stuck_notified_sha === ctx.headSha
        ? toMs(st.stuck_notified_ts) ?? lastPingMs
        : lastPingMs;
      const weeklyDue = weeklyAnchorMs !== null && nowMs - weeklyAnchorMs >= H(rebaseStaleRetryHours);
      if (weeklyDue) {
        st.rebase_pings = 0;
        st.stuck_notified_sha = ctx.headSha;
        st.stuck_notified_ts = new Date(nowMs).toISOString();
        action = "request_rebase";
        reason =
          "Weekly retry: PR still has conflicts after exhausting rebase " +
          "retries; ask Copilot again.";
      } else {
        action = "wait";
        reason =
          `${REBASE_BUDGET_PREFIX} (${rebasePings} pings on this sha) and ` +
          "PR is still conflicted: owner escalated; weekly retry only.";
        if (st.stuck_notified_sha !== ctx.headSha) {
          st.stuck_notified_sha = ctx.headSha;
          st.stuck_notified_ts = new Date(nowMs).toISOString();
          notifications.push({
            event: "escalation",
            message:
              `🔴 PR #${ctx.num} has ${rebasePings} rebase requests to Copilot and is STILL ` +
              `conflicted: **${ctx.title}**\n` +
              "Decide next step: manual merge, manual rebase, or close.\n" +
              `→ http://github.com/${ctx.repo}/pull/${ctx.num}`,
          });
        }
      }
    } else {
      action = "request_rebase";
      reason =
        `PR is still conflicted after the previous rebase request (${rebasePings} ` +
        "ping(s) on this sha): ask Copilot again to resolve conflicts with " +
        "origin/main.";
    }
  } else if (ctx.mergeUnknown) {
    action = "wait";
    reason = MERGE_UNKNOWN_REASON;
  } else if (cachedSig === sig && cachedAction) {
    action = cachedAction;
    reason = st._reason || action;
    reused = true;
  } else {
    return {
      handled: false,
      action: null,
      reason: null,
      reused: false,
      stateEntry: st,
      notifications,
    };
  }

  st._sig = sig;
  st._action = action;
  if (reason) st._reason = reason;

  return {
    handled: true,
    action,
    reason,
    reused,
    stateEntry: st,
    notifications,
  };
}

function normalizeLlmDecision(decision) {
  const llmAction = (decision?.action || "").trim().toLowerCase();
  if (llmAction === "request_rebase") {
    return {
      action: "wait",
      reason:
        "LLM returned request_rebase, but rebase requests are deterministic at the conflict gate; waiting.",
    };
  }
  if (["request_review", "request_fix", "notify_ready", "wait"].includes(llmAction)) {
    return { action: llmAction, reason: decision?.reason || llmAction };
  }
  return {
    action: "wait",
    reason: `LLM returned unknown action (${llmAction || "empty"}); waiting.`,
  };
}

export async function decideWithLlm({
  ctx,
  stateEntry = {},
  nowMs,
  sig,
  rebaseRetryHours,
  rebaseMaxPings,
  rebaseStaleRetryHours,
  llmContext,
  llmDecider,
  decisionSource = null,
}) {
  const deterministic = decideDeterministic({
    ctx,
    stateEntry,
    nowMs,
    sig,
    rebaseRetryHours,
    rebaseMaxPings,
    rebaseStaleRetryHours,
  });
  if (deterministic.handled) return deterministic;

  const st = { ...deterministic.stateEntry };
  const notifications = [...deterministic.notifications];

  let decision;
  try {
    decision = await llmDecider(llmContext);
  } catch (e) {
    // Layer 3: no source resolved. A configuration gap is not a decision
    // failure: wait with the setup path, never touch the per-head budget,
    // never escalate to Needs-human.
    if (e instanceof NoDecisionSourceError) {
      return {
        handled: true,
        action: "wait",
        reason: e.message,
        reused: false,
        decision_source: DECISION_SOURCES.none,
        stateEntry: st,
        notifications,
      };
    }
    const failures = st.llm_failures_sha === ctx.headSha
      ? (Number(st.llm_failures) || 0) + 1
      : 1;
    st.llm_failures_sha = ctx.headSha;
    st.llm_failures = failures;

    if (failures < LLM_MAX_FAILURES_PER_HEAD) {
      delete st._sig;
      delete st._action;
      st._reason =
        `${LLM_RETRY_PREFIX}${e.message || e}); retrying ` +
        `(${failures}/${LLM_MAX_FAILURES_PER_HEAD}).`;
      return {
        handled: true,
        action: "wait",
        reason: st._reason,
        reused: false,
        decision_source: decisionSource,
        stateEntry: st,
        notifications,
      };
    }

    st._sig = sig;
    st._action = "llm_failed";
    st._reason =
      `Could not decide with LLM after ${failures} attempts on this head (${e.message || e})`;
    if (st.llm_fail_notified_sha !== ctx.headSha) {
      st.llm_fail_notified_sha = ctx.headSha;
      notifications.push({
        event: "needs-human",
        message:
          `⚠️ ${ctx.repo}#${ctx.num}: could not decide with LLM after ${failures} attempts ` +
          `on this head (${e.message || e}). Please inspect manually.`,
      });
    }
    return {
      handled: true,
      action: "llm_failed",
      reason: st._reason,
      reused: false,
      decision_source: decisionSource,
      stateEntry: st,
      notifications,
    };
  }

  const { action, reason } = normalizeLlmDecision(decision);
  st.llm_failures_sha = ctx.headSha;
  st.llm_failures = 0;
  st._sig = sig;
  st._action = action;
  if (reason) st._reason = reason;
  return {
    handled: true,
    action,
    reason,
    reused: false,
    decision_source: decisionSource,
    stateEntry: st,
    notifications,
  };
}

export { isRebaseRequest, newestRebaseRequestTsMs, normalizeLlmDecision };
