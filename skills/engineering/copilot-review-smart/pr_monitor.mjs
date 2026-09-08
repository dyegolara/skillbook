#!/usr/bin/env node
/**
 * pr_monitor.mjs — SMART Copilot review watchdog (portable, multi-repo).
 *
 * Reference implementation of the copilot-review-smart skill. Plain ESM
 * JavaScript — no build step, runs on any agent runtime with Node >= 18
 * and an authenticated `gh` CLI. See docs/adr/0002 for the standard.
 *
 * Replaces the naive ping-pong loop that kept posting "@copilot code review"
 * every day even after Copilot had already said everything passes.
 *
 * Env config:
 *   PR_MONITOR_REPOS       (required) "owner/repo1,owner/repo2"
 *   PR_MONITOR_STATE_PATH  state file (default ~/.cache/pr-monitor/state.json)
 *   PR_MONITOR_MODEL       OpenRouter model for the decision LLM
 *   OPENROUTER_API_KEY     (or in ~/.hermes/.env / ~/.pr-monitor.env)
 *   DRY_RUN=1              print would-be comments; never post, never persist
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideWithLlm } from "./decision.mjs";

const execFileP = promisify(execFile);

// Watched repos. REQUIRED: an installed skill must never default to watching
// someone else's repos — the agent passes its repos as context.
const REPOS = (process.env.PR_MONITOR_REPOS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (REPOS.length === 0) {
  console.error(
    "PR_MONITOR_REPOS is required: PR_MONITOR_REPOS=\"owner/repo1,owner/repo2\" node pr_monitor.mjs"
  );
  process.exit(1);
}

const STATE_PATH = process.env.PR_MONITOR_STATE_PATH ||
  path.join(os.homedir(), ".cache", "pr-monitor", "state.json");

const COPILOT_SUBSTR = "copilot";
const MODEL = process.env.PR_MONITOR_MODEL || "deepseek/deepseek-v4-flash-0731";
const DRY_RUN = process.env.DRY_RUN === "1";

// Don't re-ping Copilot on the same head sha more often than this. This is
// the key guard that prevents the previous infinite daily ping loop.
const PING_MIN_INTERVAL_HOURS = 12;
// Minimum age of the newest Copilot review before we'd consider re-reviewing
// the same sha (room for Copilot to actually post before we ping again).
const COOLDOWN_AFTER_REVIEW_HOURS = 6;

// Rebase retry policy: a conflicted PR must NOT deadlock. After a rebase
// request (ours or the human's), wait REBASE_RETRY_HOURS for branch movement;
// if the PR is STILL dirty, re-ping — up to REBASE_MAX_PINGS per head sha.
// Exhausted => notify the owner once (per sha) and retry weekly.
const REBASE_RETRY_HOURS = 6;
const REBASE_MAX_PINGS = 3;
const REBASE_STALE_RETRY_HOURS = 24 * 7;

// A very recent last commit means an agent is (probably) still pushing work:
// hold ALL Copilot pings until the branch goes quiet. (notify_ready is
// exempt — it never touches GitHub.)
const ACTIVE_WORK_QUIET_HOURS = 3;

const H = (h) => h * 3600_000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function runGh(args) {
  try {
    const { stdout } = await execFileP("gh", ["api", ...args]);
    try {
      return JSON.parse(stdout);
    } catch {
      return stdout;
    }
  } catch (e) {
    throw new Error(`gh failed: ${args.join(" ")}\n${String(e.stderr || e.message).trim()}`);
  }
}

/** Fetch a listing endpoint with per_page=100, following up to maxPages.
 * Long-lived PRs (>30 comments) would otherwise silently lose the newest
 * transcript entries — the exact comments the bot must read. */
async function ghPaginated(pathname, maxPages = 3) {
  const items = [];
  const sep = pathname.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const batch = await runGh([`${pathname}${sep}per_page=100&page=${page}`]);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

/** Read KEY=VAL from an env file without printing it. Checked order:
 * process env, ~/.pr-monitor.env, ~/.hermes/.env (legacy deployed cron). */
function loadEnvKey(name) {
  if (process.env[name]) return process.env[name];
  for (const file of ["~/.pr-monitor.env", "~/.hermes/.env"]) {
    try {
      for (const line of fs.readFileSync(file.replace("~", os.homedir()), "utf8").split("\n")) {
        const t = line.trim();
        if (t.startsWith(name + "=")) return t.slice(name.length + 1).trim();
      }
    } catch {
      // missing file — fine
    }
  }
  return "";
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function postComment(repo, num, body) {
  if (DRY_RUN) {
    console.log(`[DRY-RUN] ${repo}#${num}: ${body}`);
    return;
  }
  await runGh([`repos/${repo}/issues/${num}/comments`, "-f", `body=${body}`, "-X", "POST"]);
}

async function requestReview(repo, num) {
  await postComment(repo, num, "@copilot code review");
}

async function requestFix(repo, num, commentUrls) {
  if (!commentUrls.length) return requestReview(repo, num);
  await postComment(
    repo,
    num,
    `@copilot work on the issues mentioned in these comments ${commentUrls.join(" ")}`
  );
}

/** Ask Copilot to resolve the PR's merge conflicts with origin/main. Do NOT
 * prescribe rebase: Copilot's environment cannot force-push, so it
 * integrates main via merge. What we demand is that the conflicts get
 * RESOLVED, wisely, preserving both branches' work. */
async function requestRebase(repo, num) {
  await postComment(
    repo,
    num,
    "@copilot resolve the merge conflicts between this branch and " +
      "origin/main. Be wise with the strategy: carefully preserve the " +
      "features and decisions of BOTH branches — do not silently drop or " +
      "overwrite either side unless it is part of the new features (this " +
      "branch over main). If you are not confident on a change or have a " +
      "question about a decision, consult the spec, tickets and " +
      "documentation to see if there could be any answer, if not, ask the " +
      "user."
  );
}

function toMs(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function maxTs(tsList) {
  const vals = tsList.map(toMs).filter((v) => v !== null);
  return vals.length ? Math.max(...vals) : null;
}

function isCopilot(item) {
  const login = item?.user?.login || "";
  return login.toLowerCase().includes(COPILOT_SUBSTR);
}

// ---------------------------------------------------------------------------
// GitHub state collector
// ---------------------------------------------------------------------------

async function collectPrState(pr, num, repo) {
  const headSha = pr.head?.sha || null;
  const title = pr.title || "";

  // Copilot reviews (the formal pull_request reviews).
  const reviews = await ghPaginated(`repos/${repo}/pulls/${num}/reviews`).catch(() => []);
  const copilotReviews = reviews.filter(isCopilot);
  const approved = copilotReviews.some((r) => r.state === "APPROVED");
  const commented = copilotReviews.some((r) => r.state === "COMMENTED");
  const latestReviewTs = maxTs(copilotReviews.map((r) => r.submitted_at));
  const latestReviewState = copilotReviews.at(-1)?.state || null;

  // Inline review comments left by Copilot (the actual feedback content).
  // NOTE: the REST API does NOT expose thread resolution state, so every
  // top-level Copilot inline comment counts as unaddressed — the decision
  // LLM reads the transcripts and decides if the feedback was really
  // handled. (The Python version "checked" a `resolved` field that never
  // exists in this payload — always-true bug, fixed here by being honest.)
  const rcomments = await ghPaginated(`repos/${repo}/pulls/${num}/comments`).catch(() => []);
  const copilotRcomments = rcomments.filter(isCopilot);
  const latestInlineTs = maxTs(copilotRcomments.map((c) => c.created_at));
  const nInlineUnresolved = copilotRcomments.filter(
    (c) => c.in_reply_to_id == null && c.diff_hunk
  ).length;
  const commentUrls = copilotRcomments.map((c) => c.html_url).filter(Boolean);

  // Issue-level comments (the transcript where we posted "@copilot code
  // review" and Copilot replied). Only Copilot's replies carry its verdict.
  const icomments = await ghPaginated(`repos/${repo}/issues/${num}/comments`).catch(() => []);
  const copilotIcomments = icomments.filter(isCopilot);
  const lastCopilotComment = copilotIcomments.at(-1)?.body || "";
  const lastCopilotCommentTs = maxTs(copilotIcomments.map((c) => c.created_at));

  // FULL transcript (ANY author) — the human context the bot must read
  // before acting. Newest 40 issue + 40 inline, bodies truncated.
  const issueTranscript = icomments.slice(-40).map((c) => ({
    author: c.user?.login || "?",
    ts: c.created_at,
    body: (c.body || "").slice(0, 400),
  }));
  const inlineTranscript = rcomments.slice(-40).map((c) => ({
    author: c.user?.login || "?",
    ts: c.created_at,
    body: (c.body || "").slice(0, 300),
  }));

  // Commits on the PR head branch (oldest-first — take the newest).
  const commits = await ghPaginated(`repos/${repo}/pulls/${num}/commits`).catch(() => []);
  const lastCommitTs = maxTs(commits.map((c) => c.commit?.author?.date));

  // Merge-ability vs main: the HARD prerequisite before any review.
  // - dirty / mergeable:false => conflicts with main
  // - behind/blocked/unstable/clean/draft => NOT a conflict
  // - both null => GitHub hasn't computed it yet (async) -> unknown
  let mergeable = pr.mergeable ?? null;
  let mergeableState = pr.mergeable_state ?? null;
  if (mergeable === null && mergeableState === null) {
    const full = await runGh([`repos/${repo}/pulls/${num}`]).catch(() => null);
    if (full && typeof full === "object") {
      mergeable = full.mergeable ?? null;
      mergeableState = full.mergeable_state ?? null;
    }
  }
  const hasConflicts = mergeableState === "dirty" || mergeable === false;
  const mergeUnknown = mergeable === null && mergeableState === null;

  return {
    num,
    title,
    draft: Boolean(pr.draft),
    headSha,
    approved,
    commented,
    latestReviewState,
    latestReviewTs,
    nInlineUnresolved,
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

// ---------------------------------------------------------------------------
// LLM decision
// ---------------------------------------------------------------------------

class LLMDecisionError extends Error {}

async function callLlm(decisionCtx) {
  const apiKey = loadEnvKey("OPENROUTER_API_KEY");
  if (!apiKey) throw new LLMDecisionError("no OPENROUTER_API_KEY");

  const system =
    "You are a senior engineer's PR-watchdog. Given the state of a GitHub " +
    "pull request and the FULL comment transcript (any author: human, " +
    "Copilot, bots), decide what the bot should do. You output JSON only.\n\n" +
    "CONTEXT FIRST: read the whole issue_transcript and inline_transcript " +
    "before deciding. Respect what has already been asked — if a human or " +
    "Copilot already requested a rebase/review on the current head and it " +
    "is still pending, do NOT ask again; WAIT. Never duplicate requests.\n\n" +
    "Rules:\n" +
    "- REQUEST_REVIEW: Copilot has NOT reviewed the current head sha yet, OR " +
    "there are new commits after the last review that the reviewer hasn't " +
    "seen. We ping '@copilot code review'.\n" +
    "- REQUEST_FIX: Copilot left actionable review comments on the current " +
    "head that are still unaddressed AND are newer than the last commit " +
    "(i.e. Copilot is waiting for the author to fix). Ping '@copilot work " +
    "on the issues...'.\n" +
    "- NOTIFY_READY: Copilot has already confirmed the current head sha is " +
    "clean (e.g. its latest comment/review says all tests pass / no issues " +
    "/ approved), AND no new commits or new review comments have appeared " +
    "since. Do NOT ping Copilot again — instead tell the human owner the " +
    "PR is ready for their review.\n" +
    "- WAIT: not enough info, or too soon after the last action — wait for " +
    "the next cron tick. Also pick WAIT if agent_still_working is true: " +
    "pings interrupt active work.\n\n" +
    "Prefer NOTIFY_READY whenever the latest Copilot feedback on the current " +
    "head sha indicates a clean bill of health. Never REQUEST_REVIEW when " +
    "the newest Copilot review/comment already covers the current head sha " +
    "and reported no issues. If merge_unknown is true, pick WAIT.\n" +
    'JSON shape: {"action": "request_review|request_fix|notify_ready|wait", ' +
    '"reason": "short justification in English"}';

  let res;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(decisionCtx) },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new LLMDecisionError(`LLM call failed: ${e.message || e}`);
  }
  if (!res.ok) throw new LLMDecisionError(`LLM HTTP ${res.status}`);
  const payload = await res.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new LLMDecisionError("LLM returned no content");

  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new LLMDecisionError(`unparseable LLM JSON: ${content.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// throttle / state guards
// ---------------------------------------------------------------------------

function throttleOkSameSha(st, nowMs, headSha) {
  if (st.last_ping_sha !== headSha) return true; // new commits -> fresh ping allowed
  const last = toMs(st.last_ping_ts);
  if (last === null) return true;
  return nowMs - last >= H(PING_MIN_INTERVAL_HOURS);
}

function tooSoonAfterReview(ctx, nowMs) {
  const ts = ctx.latestReviewTs ?? ctx.latestInlineTs;
  const dt = toMs(ts);
  if (dt === null) return false;
  return nowMs - dt < H(COOLDOWN_AFTER_REVIEW_HOURS);
}

function agentStillWorking(ctx, nowMs) {
  const dt = toMs(ctx.lastCommitTs);
  if (dt === null) return false;
  return nowMs - dt < H(ACTIVE_WORK_QUIET_HOURS);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const nowMs = Date.now();
  const state = loadState();
  // Per-repo head shas already reported "ready" (key "repo:sha") -> notify once.
  const seenReady = new Set(state.seen_ready_shas || []);

  const notifications = [];
  let githubActionsTaken = 0;

  // Collect open PRs from every watched repo. A failure on one repo must
  // not kill the whole run.
  const prsByRepo = {};
  for (const repo of REPOS) {
    try {
      const prs = await runGh([`repos/${repo}/pulls?state=open`]);
      if (Array.isArray(prs)) prsByRepo[repo] = prs;
    } catch (e) {
      console.error(`⚠️ Could not list PRs for ${repo}: ${String(e).slice(0, 200)}`);
    }
  }

  for (const [repo, prs] of Object.entries(prsByRepo)) {
    for (const pr of prs) {
      const num = pr.number;
      const skey = `${repo}#${num}`;
      const st = state[skey] || {};
      const ctx = await collectPrState(pr, num, repo);
      const headSha = ctx.headSha;

      const agentWorking = agentStillWorking(ctx, nowMs);
      const decisionCtx = {
        pr: num,
        repo,
        title: ctx.title,
        draft: ctx.draft,
        head_sha: headSha,
        last_commit_ts: ctx.lastCommitTs ? new Date(ctx.lastCommitTs).toISOString() : null,
        copilot_reviews: {
          latest_state: ctx.latestReviewState,
          latest_submitted_at: ctx.latestReviewTs ? new Date(ctx.latestReviewTs).toISOString() : null,
          approved_any: ctx.approved,
        },
        copilot_inline_feedback: {
          count_unresolved: ctx.nInlineUnresolved,
          latest_at: ctx.latestInlineTs ? new Date(ctx.latestInlineTs).toISOString() : null,
        },
        last_copilot_issue_comment: {
          ts: ctx.lastCopilotCommentTs ? new Date(ctx.lastCopilotCommentTs).toISOString() : null,
          body: ctx.lastCopilotComment.slice(0, 2000),
        },
        // FULL transcript so the LLM sees the human context: who asked
        // what and when (ANY author, not just Copilot).
        issue_transcript: ctx.issueTranscript,
        inline_transcript: ctx.inlineTranscript,
        merge_status: {
          mergeable: ctx.mergeable,
          mergeable_state: ctx.mergeableState,
          has_conflicts: ctx.hasConflicts,
          merge_unknown: ctx.mergeUnknown,
        },
        has_new_commits_since_last_review:
          ctx.lastCommitTs !== null && ctx.latestReviewTs !== null && ctx.lastCommitTs > ctx.latestReviewTs,
        has_new_commits_since_last_inline:
          ctx.lastCommitTs !== null && ctx.latestInlineTs !== null && ctx.lastCommitTs > ctx.latestInlineTs,
        agent_still_working: agentWorking,
        note_agent_still_working: agentWorking
          ? `The last commit is VERY recent (< ${ACTIVE_WORK_QUIET_HOURS}h): an agent ` +
            "is likely still working on this branch. Prefer WAIT — pings interrupt active work."
          : null,
      };

      // --- Signature cache: skip the LLM when nothing relevant changed.
      const sig = [
        headSha || "",
        ctx.latestReviewTs || "",
        ctx.latestReviewState || "",
        ctx.latestInlineTs || "",
        ctx.lastCopilotCommentTs || "",
        ctx.nInlineUnresolved,
        ctx.approved,
        ctx.mergeable,
        ctx.mergeableState,
        // Transcript digest: any NEW comment (any author) must invalidate
        // the cached decision — the bot reads context first.
        ctx.issueTranscript.length,
        ctx.issueTranscript.at(-1)?.ts || "",
        ctx.inlineTranscript.length,
        ctx.inlineTranscript.at(-1)?.ts || "",
      ].join("|");
      const decided = await decideWithLlm({
        ctx: { ...ctx, repo, num },
        stateEntry: st,
        nowMs,
        sig,
        rebaseRetryHours: REBASE_RETRY_HOURS,
        rebaseMaxPings: REBASE_MAX_PINGS,
        rebaseStaleRetryHours: REBASE_STALE_RETRY_HOURS,
        llmContext: decisionCtx,
        llmDecider: callLlm,
      });
      Object.assign(st, decided.stateEntry);
      notifications.push(...decided.notifications);
      const action = decided.action;
      const reason = decided.reason;

      if (action === "skip_wip" || action === "llm_failed") {
        st.last_head_sha = headSha;
        state[skey] = st;
        continue;
      }

      // --- NOTIFY_READY: do NOT touch GitHub, just message the owner.
      if (action === "notify_ready") {
        const readyKey = `${repo}:${headSha}`;
        if (!seenReady.has(readyKey)) {
          seenReady.add(readyKey);
          notifications.push(
            `🟢 PR #${num} is READY for your review: **${ctx.title}**\n` +
              `\`${(headSha || "").slice(0, 8)}\` · Copilot already confirmed it is clean (${reason}).\n` +
              `→ http://github.com/${repo}/pull/${num}`
          );
        }
        st.last_head_sha = headSha;
        state[skey] = st;
        continue;
      }

      // --- REQUEST_REBASE: conflicts block everything else. No
      // review-cooldown gate here: a review on a conflicted PR is useless
      // anyway (the 12h same-sha throttle still applies).
      if (action === "request_rebase") {
        if (agentWorking) {
          st._sig = sig;
          st._action = "wait";
          st._reason =
            `Last commit is newer than ${ACTIVE_WORK_QUIET_HOURS}h: an agent is still ` +
            "working on this branch; do not interrupt with pings.";
        } else if (throttleOkSameSha(st, nowMs, headSha)) {
          await requestRebase(repo, num);
          githubActionsTaken++;
          st.last_ping_ts = new Date(nowMs).toISOString();
          st.last_ping_sha = headSha;
          // Count rebase pings per head sha (drives the retry policy).
          if (st.rebase_pings_sha !== headSha) {
            st.rebase_pings_sha = headSha;
            st.rebase_pings = 1;
          } else {
            st.rebase_pings = (Number(st.rebase_pings) || 0) + 1;
          }
          notifications.push(
            `🔀 PR #${num} has conflicts with main: asked Copilot to resolve conflicts ` +
              "with origin/main. When resolved, the loop will continue with code review.\n" +
              `→ http://github.com/${repo}/pull/${num}`
          );
        }
        st.last_head_sha = headSha;
        state[skey] = st;
        continue;
      }

      // --- REQUEST_FIX / REQUEST_REVIEW (same ping guards).
      if (action === "request_fix" || action === "request_review") {
        const pingOk =
          !agentWorking &&
          throttleOkSameSha(st, nowMs, headSha) &&
          !tooSoonAfterReview(ctx, nowMs);
        if (pingOk) {
          if (action === "request_fix") await requestFix(repo, num, ctx.commentUrls);
          else await requestReview(repo, num);
          githubActionsTaken++;
          st.last_ping_ts = new Date(nowMs).toISOString();
          st.last_ping_sha = headSha;
        }
        st.last_head_sha = headSha;
        state[skey] = st;
        continue;
      }

      // --- WAIT / unknown action: no action.
      st.last_head_sha = headSha;
      state[skey] = st;
    }
  }

  state.seen_ready_shas = [...seenReady].sort();
  // Never persist in dry-run — a dry run must not poison the real
  // throttle/cache bookkeeping.
  if (!DRY_RUN) saveState(state);

  // Output: only emit human-facing notifications (empty otherwise ->
  // no_agent cron stays silent so we don't spam the owner).
  if (notifications.length) console.log(notifications.join("\n\n"));
}

main().catch((e) => {
  console.error(`⚠️ pr_monitor crashed: ${e.stack || e}`);
  process.exit(1);
});
