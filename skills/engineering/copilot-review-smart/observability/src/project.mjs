/** Pure projections: state files in, JSON payloads out. Nothing here reads or
 * writes; `server.mjs` loads the files and hands them to these functions. */

import { tickInFlight } from "../../tick_liveness.mjs";
import { isGateWaitReason, isLlmRetryReason } from "../../decision.mjs";
import { isPrStateFetchFailureReason } from "../../collection_failure.mjs";
import { STAGES } from "./stages.mjs";
import {
  isNoDecisionSource,
  NO_DECISION_SOURCE_STAGE_OUTCOME,
} from "../../decision_source.mjs";

const FLOW_KEY_RE = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/;

const iso = (ms) => new Date(ms).toISOString();

function byTimestamp(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function byDeadline(a, b) {
  if (a.deadline_at !== b.deadline_at) return a.deadline_at < b.deadline_at ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** A Flow key is `owner/repo#num`, the key the Tick state and the Listener
 * Expectations already use. Returns null for anything else. */
export function parseFlowKey(key) {
  const match = FLOW_KEY_RE.exec(String(key));
  if (!match) return null;
  return { key: String(key), repo: match[1], num: Number(match[2]) };
}

/** Every Flow either state file knows about, sorted. */
export function flowKeys(tickState, listenerState) {
  const keys = new Set();
  for (const key of Object.keys(tickState || {})) {
    if (parseFlowKey(key)) keys.add(key);
  }
  for (const key of Object.keys(listenerState?.expectations || {})) {
    if (parseFlowKey(key)) keys.add(key);
  }
  for (const key of Object.keys(listenerState?.closed_flows || {})) {
    if (parseFlowKey(key)) keys.add(key);
  }
  return [...keys].sort();
}

/** One persisted tick record, projected for a client. The timeline and the
 * Flow's tick history must expose the same fields with the same defaults, so
 * both go through here. */
function tickRecordFields(record) {
  return {
    ts: record?.ts ?? null,
    action: record?.action ?? null,
    reason: record?.reason ?? null,
    terminal: record?.terminal ?? null,
    ...(record?.decision_source ? { decision_source: record.decision_source } : {}),
  };
}

/** `GET /health`: the Listener's health shape, projected from disk. The
 * `status` answers whether the watchdog is alive (`ok` / `dead` / `absent`);
 * `last_delivery` is in-memory in the live Listener and is therefore `null`
 * here — it is not persisted anywhere the projection can read. */
export function projectHealth({ tickState, listenerState, listenerPid }) {
  return {
    status: listenerPid.status,
    pid: listenerPid.pid,
    started_at: listenerPid.started_at,
    last_delivery: null,
    tracked_flows: flowKeys(tickState, listenerState),
    pending_expectations: Object.keys(listenerState?.expectations || {})
      .filter((key) => parseFlowKey(key))
      .sort(),
  };
}

/** `GET /timeline`: every persisted Tick outcome (oldest first), the run-level
 * in-flight marker, and the checks that are scheduled — the armed
 * Expectations with their deadlines, plus a persisted `next_check_at` only
 * where no Expectation is armed for that Flow. */
export function projectTimeline({ tickState, listenerState, nowMs, isAliveFn }) {
  const executed = [];
  for (const key of Object.keys(tickState || {})) {
    const flow = parseFlowKey(key);
    if (!flow) continue;
    const history = Array.isArray(tickState[key]?.tick_history) ? tickState[key].tick_history : [];
    for (const record of history) {
      executed.push({
        key: flow.key,
        repo: flow.repo,
        pr: flow.num,
        ...tickRecordFields(record),
      });
    }
  }
  executed.sort(byTimestamp);

  const scheduled = [];
  const armed = new Set();
  for (const [key, expectation] of Object.entries(listenerState?.expectations || {})) {
    if (isFlowClosed(key, tickState, listenerState)) continue;
    const flow = parseFlowKey(key);
    if (!flow) continue;
    const deadlineMs = Number(expectation?.deadline_ms);
    if (!Number.isFinite(deadlineMs)) continue;
    armed.add(key);
    scheduled.push({
      key: flow.key,
      repo: flow.repo,
      pr: flow.num,
      deadline_at: iso(deadlineMs),
      source: "expectation",
      overdue: deadlineMs <= nowMs,
      origin: expectation?.origin ?? null,
      backoff_index: Number.isInteger(expectation?.backoff_index) ? expectation.backoff_index : 0,
    });
  }
  for (const key of Object.keys(tickState || {})) {
    const flow = parseFlowKey(key);
    if (!flow || armed.has(key)) continue;
    if (isFlowClosed(key, tickState, listenerState)) continue;
    const nextCheckAt = tickState[key]?.next_check_at;
    if (!nextCheckAt) continue;
    const deadlineMs = Date.parse(nextCheckAt);
    if (Number.isNaN(deadlineMs)) continue;
    scheduled.push({
      key: flow.key,
      repo: flow.repo,
      pr: flow.num,
      deadline_at: iso(deadlineMs),
      source: "next_check_at",
      overdue: deadlineMs <= nowMs,
    });
  }
  scheduled.sort(byDeadline);

  return {
    now: iso(nowMs),
    executed,
    in_flight: tickInFlight(tickState, { nowMs, ...(isAliveFn ? { isAliveFn } : {}) }),
    scheduled,
  };
}

// ---------------------------------------------------------------------------
// Stage projection
// ---------------------------------------------------------------------------
//
// The persisted state does not record per-Stage progress. The Tick history,
// the armed Expectation and `next_check_at` are the only evidence, so the
// projection derives, from the latest Tick record for a Flow, which Stages
// that Tick demonstrably completed. The README documents the full table.

/** Stages the latest Tick demonstrably completed, excluding `schedule` (which
 * every persisted Tick writes via its `next_check_at` field, and which the
 * caller places relative to the armed deadline). */
function reachedStages(record) {
  const action = record?.action || "";
  const reason = record?.reason || "";
  if (isPrStateFetchFailureReason(reason)) return new Set(["collect"]);
  const reached = new Set(["collect", "check"]);
  if (action === "request_rebase") {
    // The conflict gate decided; the cache and the LLM were skipped.
    reached.add("act");
  } else if (action === "request_review" || action === "request_fix" || action === "notify_ready" || action === "llm_failed") {
    reached.add("reuse").add("decide").add("act");
  } else if (action === "wait") {
    // Gate waits stop at `check`; every other wait passed the signature
    // cache. Only explicit evidence proves the LLM ran.
    if (!isGateWaitReason(reason)) reached.add("reuse");
    // Layer 3 carries decision_source "none" and its reason says "LLM" (no
    // decision source configured), which is a configuration gap, not a
    // decision: the caller marks `decide` current for that record instead.
    if (record?.decision_source && !isNoDecisionSource(record.decision_source)) {
      reached.add("decide");
    }
    if (record?.terminal === "needs-human") reached.add("act");
  }
  // `skip_wip` is the draft/WIP gate: collect + check only.
  return reached;
}

function stageOutcome(stage, { last, action, reason, decisionSource, allClear, closed, closure, deadlineIso }) {
  switch (stage) {
    case "collect":
      if (closed) return "PR closure recorded";
      return isPrStateFetchFailureReason(reason) ? "PR state collection failed" : "PR state collected";
    case "check":
      if (closed) return closure?.reason || reason || "PR is closed";
      if (action === "skip_wip") return "draft/WIP — skipped";
      if (action === "request_rebase") return "merge conflicts — conflict-resolution policy";
      if (isGateWaitReason(reason)) return `gate held: ${reason}`;
      return "deterministic gates passed";
    case "reuse":
      return "signature cache checked";
    case "decide":
      if (action === "llm_failed") return "LLM decision failed";
      if (isLlmRetryReason(reason)) return "LLM decision failed; retry scheduled";
      if (isNoDecisionSource(decisionSource)) return NO_DECISION_SOURCE_STAGE_OUTCOME;
      if (decisionSource) return `decision made by ${decisionSource}`;
      return "LLM decision made";
    case "act":
      if (action === "request_rebase") return "asked Copilot to resolve conflicts";
      if (action === "request_review") return "asked Copilot to review";
      if (action === "request_fix") return "asked Copilot to fix review comments";
      if (action === "notify_ready") return "notified owner: All-clear / Notify-ready";
      if (action === "llm_failed" || last?.terminal === "needs-human") return "escalated to owner";
      return "no action taken";
    case "schedule":
      if (closed) return "not scheduled — PR closed";
      if (allClear) return "not scheduled — flow closed (All-clear)";
      if (deadlineIso) return `next check at ${deadlineIso}`;
      return "quiescent — only a Delivery wakes the Flow";
    default:
      return null;
  }
}

function projectStages({ entry, expectation, deadlineIso, closed, closure }) {
  const history = Array.isArray(entry?.tick_history) ? entry.tick_history : [];
  const last = history.at(-1) ?? null;
  const action = closed ? "closed" : last?.action ?? null;
  const reason = closed ? closure?.reason || last?.reason || "PR is closed" : last?.reason ?? "";
  const decisionSource = last?.decision_source ?? null;
  const allClear = !closed && action === "notify_ready" && last?.terminal === "done";
  const armed = deadlineIso !== null && deadlineIso !== undefined;

  const statuses = Object.fromEntries(STAGES.map((stage) => [stage, "next"]));
  if (closed) {
    statuses.collect = "past";
    statuses.check = "past";
    statuses.schedule = "past";
  } else if (last) {
    for (const stage of reachedStages(last)) statuses[stage] = "past";
    // Layer 3 is a configuration gap: the Flow waits at `decide` for a
    // decision source rather than having completed a decision.
    if (isNoDecisionSource(last.decision_source)) statuses.decide = "current";
    statuses.schedule = allClear && !armed ? "past" : "current";
  } else if (armed || expectation) {
    statuses.schedule = "current";
  } else {
    statuses.collect = "current";
  }

  return STAGES.map((stage) => {
    const status = statuses[stage];
    if (status === "next") return { stage, status, outcome: null, at: null };
    return {
      stage,
      status,
      outcome: stageOutcome(stage, { last, action, reason, decisionSource, allClear, closed, closure, deadlineIso }),
      at: last?.ts ?? null,
    };
  });
}

/** Glossary outcomes only: All-clear/Notify-ready, Stuck PR, Needs-human.
 * Everything else (waiting, skipped, closed by GitHub) is not terminal. */
function terminalOutcome(entry, last, closed = false) {
  if (closed) return null;
  if (!last) return null;
  if (last.terminal === "done") {
    return last.action === "notify_ready" ? "All-clear / Notify-ready" : null;
  }
  if (last.terminal === "needs-human") {
    const stuck =
      entry?.rebase_pings_sha &&
      entry.rebase_pings_sha === entry.last_head_sha &&
      Number(entry.rebase_pings) >= 3;
    return stuck ? "Stuck PR" : "Needs-human";
  }
  return null;
}

function effectiveDeadline(entry, expectation, closed = false) {
  if (closed) return null;
  const expectationMs = expectation ? Number(expectation.deadline_ms) : null;
  if (Number.isFinite(expectationMs)) return expectationMs;
  const persisted = entry?.next_check_at ? Date.parse(entry.next_check_at) : NaN;
  return Number.isNaN(persisted) ? null : persisted;
}

/** One Flow in full: the row fields plus the Stage sequence, the Tick history
 * and the armed Expectation. Returns null when neither state file knows the
 * key. */
export function projectFlow({ key, tickState, listenerState, nowMs }) {
  const flow = parseFlowKey(key);
  if (!flow) return null;
  const entry = tickState?.[key];
  const closure = listenerState?.closed_flows?.[key] ?? null;
  const expectation = listenerState?.expectations?.[key] ?? null;
  const history = Array.isArray(entry?.tick_history) ? entry.tick_history : [];
  const last = history.at(-1) ?? null;
  const closed = Boolean(closure || (last?.action === "closed" && last?.terminal === "done"));
  const activeExpectation = closed ? null : expectation;
  if (!entry && !expectation && !closure) return null;

  const deadlineMs = effectiveDeadline(entry, activeExpectation, closed);
  const deadlineIso = deadlineMs === null ? null : iso(deadlineMs);
  const armed = deadlineIso !== null;
  const stages = projectStages({ entry, expectation: activeExpectation, deadlineIso, closed, closure });

  return {
    key,
    repo: flow.repo,
    pr: flow.num,
    head_sha: entry?.last_head_sha ?? null,
    stage: stages.find((stage) => stage.status === "current")?.stage ?? null,
    stages,
    action: closed ? "closed" : last?.action ?? null,
    reason: closed ? closure?.reason ?? last?.reason ?? "PR is closed" : last?.reason ?? null,
    next_check_at: deadlineIso,
    terminal: terminalOutcome(entry, last, closed),
    done: closed || Boolean(last?.terminal === "done" && !armed),
    tick_history: history.map(tickRecordFields),
    expectation: activeExpectation
      ? {
          repo: flow.repo,
          num: flow.num,
          deadline_at: deadlineIso,
          origin: expectation.origin ?? null,
          backoff_index: Number.isInteger(expectation.backoff_index) ? expectation.backoff_index : 0,
          overdue: deadlineMs !== null && deadlineMs <= nowMs,
        }
      : null,
  };
}

function isFlowClosed(key, tickState, listenerState) {
  if (listenerState?.closed_flows?.[key]) return true;
  const history = tickState?.[key]?.tick_history;
  const last = Array.isArray(history) ? history.at(-1) : null;
  return last?.action === "closed" && last?.terminal === "done";
}

/** `GET /flows`: summary rows with the same Stage projection as the detail
 * route, but without its completion, history or Expectation details. */
export function projectFlows({ tickState, listenerState, nowMs }) {
  return flowKeys(tickState, listenerState).map((key) => {
    const flow = projectFlow({ key, tickState, listenerState, nowMs });
    if (!flow) return null;
    const { key: flowKey, repo, pr, head_sha, stage, stages, action, reason, next_check_at, terminal } = flow;
    return { key: flowKey, repo, pr, head_sha, stage, stages, action, reason, next_check_at, terminal };
  }).filter(Boolean);
}
