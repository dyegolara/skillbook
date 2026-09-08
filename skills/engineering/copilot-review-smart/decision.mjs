const COPILOT_SUBSTR = "copilot";
const WIP_TITLE_RE = /^\s*\[?(wip|draft|dnm|do not merge|work in progress)\b/i;
const H = (h) => h * 3600_000;

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
        `Conflict-resolution request is newer than ${rebaseRetryHours}h and no ` +
        "new commits were pushed: wait before retrying.";
    } else if (rebasePings >= rebaseMaxPings) {
      const lastPingMs = toMs(st.last_ping_ts);
      const weeklyDue = lastPingMs !== null && nowMs - lastPingMs >= H(rebaseStaleRetryHours);
      if (weeklyDue) {
        st.rebase_pings = 0;
        action = "request_rebase";
        reason =
          "Weekly retry: PR still has conflicts after exhausting rebase " +
          "retries; ask Copilot again.";
      } else {
        action = "wait";
        reason =
          `Rebase retry budget exhausted (${rebasePings} pings on this sha) and ` +
          "PR is still conflicted: owner escalated; weekly retry only.";
        if (st.stuck_notified_sha !== ctx.headSha) {
          st.stuck_notified_sha = ctx.headSha;
          notifications.push(
            `🔴 PR #${ctx.num} has ${rebasePings} rebase requests to Copilot and is STILL ` +
              `conflicted: **${ctx.title}**\n` +
              "Decide next step: manual merge, manual rebase, or close.\n" +
              `→ http://github.com/${ctx.repo}/pull/${ctx.num}`
          );
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
    reason = "GitHub has not computed PR mergeability yet; wait for next tick.";
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

export { isRebaseRequest, newestRebaseRequestTsMs };
