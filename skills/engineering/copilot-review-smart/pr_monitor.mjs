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
 *   PR_MONITOR_PR          (optional) single PR scope: "owner/repo#123"
 *   PR_MONITOR_STATE_PATH  state file (default ~/.cache/pr-monitor/state.json)
 *   PR_MONITOR_REPORT      "jsonl" / "1" => emit agent-facing JSON lines
 *   PR_MONITOR_MODEL       OpenRouter model for the decision LLM
 *   OPENROUTER_API_KEY     (or in ~/.hermes/.env / ~/.pr-monitor.env)
 *   DRY_RUN=1              print would-be comments; never post, never persist
 *
 * CLI flags:
 *   --repo owner/repo      repo scope (repeatable)
 *   --repos a/b,c/d        repo scope (comma-separated)
 *   --pr owner/repo#123    single PR scope (or GitHub PR URL)
 *   --json-report          emit one JSON line per PR plus one overall line
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideWithLlm } from "./decision.mjs";

const execFileP = promisify(execFile);

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
const REBASE_PING_MIN_INTERVAL_HOURS = 6;
const REBASE_MAX_PINGS = 3;
const REBASE_STALE_RETRY_HOURS = 24 * 7;

// A very recent last commit means an agent is (probably) still pushing work:
// hold ALL Copilot pings until the branch goes quiet. (notify_ready is
// exempt — it never touches GitHub.)
const ACTIVE_WORK_QUIET_HOURS = 3;
const REVIEW_FIX_MAX_PINGS = 3;
const STATE_LOCK_PATH = `${STATE_PATH}.lock`;
const STATE_LOCK_TIMEOUT_MS = 30_000;
const STATE_LOCK_RETRY_MS = 200;
const STATE_LOCK_STALE_MS = 10 * 60_000;
const STATE_LOCK_HEARTBEAT_MS = 60_000;

const H = (h) => h * 3600_000;
const JSON_REPORT_ENV_VALUES = new Set(["1", "true", "json", "jsonl"]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function splitRepos(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePrRef(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/^https?:\/\/github\.com\//i, "");
  const match = normalized.match(/^([^/\s]+\/[^/\s]+)#(\d+)$/) ||
    normalized.match(/^([^/\s]+\/[^/\s]+)\/pull\/(\d+)$/);
  if (!match) {
    throw new Error(
      `Invalid PR scope "${raw}". Use owner/repo#123 or https://github.com/owner/repo/pull/123`
    );
  }
  return { repo: match[1], num: Number(match[2]) };
}

function parseCliArgs(argv = []) {
  const repoArgs = [];
  let targetPr = null;
  let emitJsonReport = null;

  function nextValue(flag, index) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") {
      repoArgs.push(nextValue(arg, i));
      i++;
    } else if (arg === "--repos") {
      repoArgs.push(...splitRepos(nextValue(arg, i)));
      i++;
    } else if (arg === "--pr") {
      targetPr = parsePrRef(nextValue(arg, i));
      i++;
    } else if (arg === "--json-report") {
      emitJsonReport = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    repos: repoArgs.length ? repoArgs : null,
    targetPr,
    emitJsonReport,
  };
}

function resolveInvocation(argv = process.argv.slice(2)) {
  const cli = parseCliArgs(argv);
  const envRepos = splitRepos(process.env.PR_MONITOR_REPOS || "");
  const envPr = parsePrRef(process.env.PR_MONITOR_PR || "");
  const envEmitJsonReport = JSON_REPORT_ENV_VALUES.has(
    String(process.env.PR_MONITOR_REPORT || "").trim().toLowerCase()
  );
  const repos = cli.repos ?? envRepos;
  const targetPr = cli.targetPr ?? envPr;
  const emitJsonReport = cli.emitJsonReport ?? envEmitJsonReport;

  if (repos.length > 0 && targetPr) {
    throw new Error(
      "Choose exactly one scope: repo(s) via --repo/--repos/PR_MONITOR_REPOS or a single PR via --pr/PR_MONITOR_PR."
    );
  }

  return { repos, targetPr, emitJsonReport };
}

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

/** Fetch a listing endpoint with per_page=100, following pages until empty.
 * Long-lived PRs (>30 comments) would otherwise silently lose transcript
 * entries — the exact comments the bot must read. */
async function ghPaginated(pathname) {
  return ghPaginatedWith(runGh, pathname);
}

async function ghPaginatedWith(runGhFn, pathname) {
  const items = [];
  const sep = pathname.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    const batch = await runGhFn([`${pathname}${sep}per_page=100&page=${page}`]);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseLockOwner(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Number.isInteger(parsed?.pid) && typeof parsed?.token === "string" && parsed.token) {
      return { pid: parsed.pid, token: parsed.token };
    }
  } catch {
    // fall through for legacy pid-only locks
  }
  const pid = Number(text.split(/\s+/, 1)[0]);
  return Number.isInteger(pid) && pid > 0 ? { pid, token: null } : null;
}

function readLockRecord(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    return { raw, owner: parseLockOwner(raw) };
  } catch {
    return { raw: null, owner: null };
  }
}

function sameLockOwner(a, b) {
  return Boolean(a && b && a.pid === b.pid && a.token === b.token);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== "ESRCH";
  }
}

function startLockHeartbeat(fd, intervalMs = STATE_LOCK_HEARTBEAT_MS) {
  const timer = setInterval(() => {
    try {
      const now = new Date();
      fs.futimesSync(fd, now, now);
    } catch {
      // lock already released or replaced
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

async function acquireStateLock({
  lockPath = STATE_LOCK_PATH,
  timeoutMs = STATE_LOCK_TIMEOUT_MS,
  retryMs = STATE_LOCK_RETRY_MS,
  staleMs = STATE_LOCK_STALE_MS,
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      const owner = { pid: process.pid, token: randomUUID() };
      fs.writeFileSync(fd, JSON.stringify(owner));
      fs.fsyncSync(fd);
      return {
        fd,
        lockPath,
        owner,
        heartbeat: startLockHeartbeat(fd),
      };
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          const current = readLockRecord(lockPath);
          if (!isPidAlive(current.owner?.pid)) {
            const latest = readLockRecord(lockPath);
            if (current.raw === latest.raw) {
              fs.rmSync(lockPath, { force: true });
              continue;
            }
          }
        }
      } catch {
        // lock disappeared between checks; retry
      }
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`Timed out acquiring state lock: ${lockPath}`);
      }
      await sleep(retryMs);
    }
  }
}

function releaseStateLock(lock) {
  if (!lock) return;
  try {
    clearInterval(lock.heartbeat);
  } catch {
    // timer already cleared
  }
  try {
    const current = readLockRecord(lock.lockPath).owner;
    if (sameLockOwner(current, lock.owner)) {
      fs.rmSync(lock.lockPath, { force: true });
    }
  } catch {
    // lock already removed
  }
  try {
    fs.closeSync(lock.fd);
  } catch {
    // already closed
  }
}

async function postComment(repo, num, body, { dryRun = DRY_RUN, runGhFn = runGh, dryRunLogs = null } = {}) {
  if (dryRun) {
    if (Array.isArray(dryRunLogs)) dryRunLogs.push(`[DRY-RUN] ${repo}#${num}: ${body}`);
    return;
  }
  await runGhFn([`repos/${repo}/issues/${num}/comments`, "-f", `body=${body}`, "-X", "POST"]);
}

async function requestReview(repo, num, opts = {}) {
  await postComment(repo, num, "@copilot code review", opts);
}

async function requestFix(repo, num, commentUrls, opts = {}) {
  if (!commentUrls.length) return requestReview(repo, num, opts);
  await postComment(
    repo,
    num,
    `@copilot work on the issues mentioned in these comments ${commentUrls.join(" ")}`,
    opts
  );
}

/** Ask Copilot to resolve the PR's merge conflicts with origin/main. Do NOT
 * prescribe rebase: Copilot's environment cannot force-push, so it
 * integrates main via merge. What we demand is that the conflicts get
 * RESOLVED, wisely, preserving both branches' work. */
async function requestRebase(repo, num, opts = {}) {
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
      "user.",
    opts
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

function digestItems(items, projector) {
  return JSON.stringify((items || []).map(projector));
}

function buildReviewDigest(reviewTranscript) {
  return digestItems(reviewTranscript, (item) => [
    item?.author || "",
    item?.state || "",
    item?.commit_id || "",
    item?.ts || "",
    item?.body || "",
  ]);
}

function buildCommentDigest(transcript) {
  return digestItems(transcript, (item) => [
    item?.author || "",
    item?.ts || "",
    item?.body || "",
  ]);
}

function uniqueUrls(urls) {
  return [...new Set((urls || []).filter(Boolean))];
}

function isCopilot(item) {
  const login = item?.user?.login || "";
  return login.toLowerCase().includes(COPILOT_SUBSTR);
}

class PrStateFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrStateFetchError";
  }
}

// ---------------------------------------------------------------------------
// GitHub state collector
// ---------------------------------------------------------------------------

async function collectPrState(pr, num, repo, { runGhFn = runGh } = {}) {
  const headSha = pr.head?.sha || null;
  const title = pr.title || "";

  // Copilot reviews (the formal pull_request reviews).
  const reviews = await ghPaginatedWith(runGhFn, `repos/${repo}/pulls/${num}/reviews`).catch(() => []);
  const copilotReviews = reviews.filter(isCopilot);
  const approved = copilotReviews.some((r) => r.state === "APPROVED");
  const commented = copilotReviews.some((r) => r.state === "COMMENTED");
  const latestReviewTs = maxTs(copilotReviews.map((r) => r.submitted_at));
  const latestReviewState = copilotReviews.at(-1)?.state || null;
  const reviewTranscript = reviews.map((r) => ({
    author: r.user?.login || "?",
    ts: r.submitted_at,
    state: r.state || null,
    commit_id: r.commit_id || null,
    body: r.body || "",
  }));
  const reviewUrls = reviews
  .map((r) => r.html_url || (r.id ? `http://github.com/${repo}/pull/${num}#pullrequestreview-${r.id}` : null));

  // Inline review comments left by Copilot (the actual feedback content).
  // NOTE: the REST API does NOT expose thread resolution state, so every
  // top-level Copilot inline comment counts as unaddressed — the decision
  // LLM reads the transcripts and decides if the feedback was really
  // handled. (The Python version "checked" a `resolved` field that never
  // exists in this payload — always-true bug, fixed here by being honest.)
  const rcomments = await ghPaginatedWith(runGhFn, `repos/${repo}/pulls/${num}/comments`).catch((error) => {
    throw new PrStateFetchError(
      `Could not fetch inline review comments for ${repo}#${num}: ${String(error).slice(0, 200)}`
    );
  });
  const copilotRcomments = rcomments.filter(isCopilot);
  const latestInlineTs = maxTs(copilotRcomments.map((c) => c.created_at));
  const nInlineUnresolved = copilotRcomments.filter(
    (c) => c.in_reply_to_id == null && c.diff_hunk
  ).length;
  const inlineUrls = rcomments.map((c) => c.html_url);

  // Issue-level comments (the transcript where we posted "@copilot code
  // review" and Copilot replied). Only Copilot's replies carry its verdict.
  const icomments = await ghPaginatedWith(runGhFn, `repos/${repo}/issues/${num}/comments`).catch((error) => {
    throw new PrStateFetchError(
      `Could not fetch issue comments for ${repo}#${num}: ${String(error).slice(0, 200)}`
    );
  });
  const copilotIcomments = icomments.filter(isCopilot);
  const lastCopilotComment = copilotIcomments.at(-1)?.body || "";
  const lastCopilotCommentTs = maxTs(copilotIcomments.map((c) => c.created_at));
  const issueUrls = icomments.map((c) => c.html_url);

  // FULL transcript (ANY author) — the human context the bot must read
  // before acting.
  const issueTranscript = icomments.map((c) => ({
    author: c.user?.login || "?",
    ts: c.created_at,
    body: c.body || "",
  }));
  const inlineTranscript = rcomments.map((c) => ({
    author: c.user?.login || "?",
    ts: c.created_at,
    body: c.body || "",
  }));
  const commentUrls = uniqueUrls([...reviewUrls, ...inlineUrls, ...issueUrls]);

  // Commits on the PR head branch (oldest-first — take the newest).
  const commits = await ghPaginatedWith(runGhFn, `repos/${repo}/pulls/${num}/commits`).catch(() => []);
  const lastCommitTs = maxTs(commits.map((c) => c.commit?.author?.date));

  // Merge-ability vs main: the HARD prerequisite before any review.
  // - dirty / mergeable:false => conflicts with main
  // - behind/blocked/unstable/clean/draft => NOT a conflict
  // - both null => GitHub hasn't computed it yet (async) -> unknown
  let mergeable = pr.mergeable ?? null;
  let mergeableState = pr.mergeable_state ?? null;
  if (mergeable === null && mergeableState === null) {
    const full = await runGhFn([`repos/${repo}/pulls/${num}`]).catch(() => null);
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
    reviewTranscript,
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
    "pull request and the FULL transcript (reviews, issue comments, inline " +
    "comments; any author: human, Copilot, bots), decide what the bot should " +
    "do. You output JSON only.\n\n" +
    "CONTEXT FIRST: read the whole review_transcript, issue_transcript and " +
    "inline_transcript before deciding. Respect what has already been asked — if a human or " +
    "Copilot already requested a rebase/review on the current head and it " +
    "is still pending, do NOT ask again; WAIT. Never duplicate requests.\n\n" +
    "Rules:\n" +
    "- REQUEST_REVIEW: Copilot has NOT reviewed the current head sha yet, OR " +
    "there are new commits after the last review that the reviewer hasn't " +
    "seen. We ping '@copilot code review'.\n" +
    "- REQUEST_FIX: the transcript shows actionable review comments on the " +
    "current head that are still unaddressed AND are newer than the last " +
    "commit (i.e. the author still owes changes). Ping '@copilot work on the " +
    "issues...'.\n" +
    "- NOTIFY_READY: the transcript on the current head shows an All-clear: a " +
    "reviewer (human or Copilot) has no unaddressed comments left to address. " +
    "A formal APPROVED state is NOT required. Do NOT ping Copilot again — " +
    "instead tell the human owner the PR is ready for their review.\n" +
    "- WAIT: not enough info, or too soon after the last action — wait for " +
    "the next cron tick. Also pick WAIT if agent_still_working is true: " +
    "pings interrupt active work.\n\n" +
    "Prefer NOTIFY_READY whenever the latest reviewer signal on the current " +
    "head indicates a clean bill of health or no further requests. Never " +
    "REQUEST_REVIEW when the newest reviewer feedback already covers the " +
    "current head sha and reported no issues. If merge_unknown is true, pick WAIT.\n" +
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

function throttleOkSameSha(st, nowMs, headSha, minIntervalHours = PING_MIN_INTERVAL_HOURS) {
  if (st.last_ping_sha !== headSha) return true; // new commits -> fresh ping allowed
  const last = toMs(st.last_ping_ts);
  if (last === null) return true;
  return nowMs - last >= H(minIntervalHours);
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

function classifyTerminalState({ ctx, action, reason, stateEntry }) {
  if (action === "notify_ready") return { done: true, terminal: "done", skipped: false };
  if (action === "llm_failed") return { done: true, terminal: "needs-human", skipped: false };
  if (
    action === "wait" &&
    stateEntry.review_fix_exhausted_sha === ctx.headSha &&
    /retry budget exhausted/i.test(reason || "")
  ) {
    return { done: true, terminal: "needs-human", skipped: false };
  }
  if (
    ctx.hasConflicts &&
    action === "wait" &&
    stateEntry.stuck_notified_sha === ctx.headSha &&
    /retry budget exhausted/i.test(reason || "")
  ) {
    return { done: true, terminal: "needs-human", skipped: false };
  }
  if (action === "skip_wip") return { done: true, terminal: "skipped", skipped: true };
  return { done: false, terminal: null, skipped: false };
}

function buildOverallReport({ reports, targetPr, scopeFetchFailures = 0 }) {
  const actionableReports = reports.filter((report) => !report.skipped);
  return {
    type: "overall",
    scope: targetPr ? "single-pr" : "repo",
    repo: targetPr?.repo || null,
    pr: targetPr?.num || null,
    done: scopeFetchFailures === 0 && actionableReports.every((report) => report.done),
    actionable_prs: actionableReports.length,
    terminal_prs: actionableReports.filter((report) => report.done).length,
    needs_human_prs: actionableReports.filter((report) => report.terminal === "needs-human").length,
    skipped_prs: reports.filter((report) => report.skipped).length,
    scope_fetch_failures: scopeFetchFailures,
  };
}

function buildTerminalPrReport({
  repo,
  pr,
  action = "wait",
  reason,
  headSha = pr?.head?.sha || null,
  terminal = "done",
  skipped = false,
}) {
  return {
    type: "pr",
    repo,
    pr: pr?.number ?? null,
    head_sha: headSha,
    action,
    reason,
    reused_cached_decision: false,
    github_action_posted: false,
    done: true,
    terminal,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function runMonitorOnce({
  nowMs = Date.now(),
  repos,
  targetPr = null,
  state = {},
  collectPrStateFn = collectPrState,
  decideFn = decideWithLlm,
  llmDecider = callLlm,
  runGhFn = runGh,
  dryRun = DRY_RUN,
  emitJsonReport = false,
} = {}) {
  const effectiveRepos = Array.isArray(repos)
    ? repos
    : targetPr?.repo
      ? [targetPr.repo]
      : [];
  if (effectiveRepos.length === 0 && !targetPr) {
    return {
      state,
      notifications: [],
      githubActionsTaken: 0,
      reports: [],
      overallReport: buildOverallReport({ reports: [], targetPr: null }),
      output: "",
    };
  }

  const nextState = { ...state };
  // Per-repo head shas already reported "ready" (key "repo:sha") -> notify once.
  const seenReady = new Set(nextState.seen_ready_shas || []);

  const notifications = [];
  const dryRunLogs = [];
  const reports = [];
  let githubActionsTaken = 0;
  let scopeFetchFailures = 0;

  // Collect open PRs from every watched repo. A failure on one repo must
  // not kill the whole run.
  const prsByRepo = {};
  if (targetPr) {
    try {
      const pr = await runGhFn([`repos/${targetPr.repo}/pulls/${targetPr.num}`]);
      if (pr && typeof pr === "object" && pr.state === "open") {
        prsByRepo[targetPr.repo] = [pr];
      } else {
        reports.push(buildTerminalPrReport({
          repo: targetPr.repo,
          pr,
          reason: `Requested PR is not open (${pr?.merged ? "merged" : pr?.state || "closed"}); monitoring is complete.`,
        }));
        prsByRepo[targetPr.repo] = [];
      }
    } catch (e) {
      scopeFetchFailures++;
      console.error(
        `⚠️ Could not fetch PR ${targetPr.repo}#${targetPr.num}: ${String(e).slice(0, 200)}`
      );
    }
  } else {
    for (const repo of effectiveRepos) {
      try {
        const prs = await ghPaginatedWith(runGhFn, `repos/${repo}/pulls?state=open`);
        if (Array.isArray(prs)) prsByRepo[repo] = prs;
      } catch (e) {
        scopeFetchFailures++;
        console.error(`⚠️ Could not list PRs for ${repo}: ${String(e).slice(0, 200)}`);
      }
    }
  }

  for (const [repo, prs] of Object.entries(prsByRepo)) {
    for (const pr of prs) {
      const num = pr.number;
      const skey = `${repo}#${num}`;
      const st = { ...(nextState[skey] || {}) };
      let ctx;
      try {
        ctx = await collectPrStateFn(pr, num, repo, { runGhFn });
      } catch (error) {
        if (!(error instanceof PrStateFetchError)) throw error;
        scopeFetchFailures++;
        console.error(`⚠️ ${error.message}`);
        reports.push({
          type: "pr",
          repo,
          pr: num,
          head_sha: pr.head?.sha || null,
          action: "wait",
          reason: error.message,
          reused_cached_decision: false,
          github_action_posted: false,
          done: false,
          terminal: null,
          skipped: false,
        });
        continue;
      }
      const headSha = ctx.headSha;
      const reviewTranscript = Array.isArray(ctx.reviewTranscript) ? ctx.reviewTranscript : [];
      const reviewDigest = buildReviewDigest(reviewTranscript);
      const issueDigest = buildCommentDigest(ctx.issueTranscript);
      const inlineDigest = buildCommentDigest(ctx.inlineTranscript);
      const reviewFixResponseSig = [
        reviewDigest,
        inlineDigest,
        ctx.lastCopilotCommentTs || "",
        ctx.lastCopilotComment || "",
      ].join("|");

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
        review_transcript: reviewTranscript,
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
        reviewDigest,
        issueDigest,
        inlineDigest,
      ].join("|");
      const decided = await decideFn({
        ctx: { ...ctx, repo, num },
        stateEntry: st,
        nowMs,
        sig,
        rebaseRetryHours: REBASE_RETRY_HOURS,
        rebaseMaxPings: REBASE_MAX_PINGS,
        rebaseStaleRetryHours: REBASE_STALE_RETRY_HOURS,
        llmContext: decisionCtx,
        llmDecider,
      });
      Object.assign(st, decided.stateEntry);
      notifications.push(...decided.notifications);
      let action = decided.action;
      let reason = decided.reason;
      const pendingReviewFixAction =
        st.review_fix_pending_sha === headSha &&
        ["request_review", "request_fix"].includes(st.review_fix_pending_action)
          ? st.review_fix_pending_action
          : null;
      const pendingRetryDue =
        action === "wait" &&
        pendingReviewFixAction &&
        st.review_fix_pending_response_sig === reviewFixResponseSig &&
        !agentWorking &&
        throttleOkSameSha(st, nowMs, headSha) &&
        !tooSoonAfterReview(ctx, nowMs);
      if (pendingRetryDue) {
        action = pendingReviewFixAction;
        reason =
          `Pending ${pendingReviewFixAction.replace("request_", "")} request is older than ` +
          `${PING_MIN_INTERVAL_HOURS}h with no new review feedback; retrying.`;
        st._action = action;
        st._reason = reason;
      }
      let finalAction = action;
      let finalReason = reason;
      let githubActionPosted = false;

      if (action === "skip_wip" || action === "llm_failed") {
        st.last_head_sha = headSha;
        nextState[skey] = st;
        reports.push({
          type: "pr",
          repo,
          pr: num,
          head_sha: headSha,
          action: finalAction,
          reason: finalReason,
          reused_cached_decision: decided.reused,
          github_action_posted: githubActionPosted,
          ...classifyTerminalState({ ctx, action: finalAction, reason: finalReason, stateEntry: st }),
        });
        continue;
      }

      // --- NOTIFY_READY: do NOT touch GitHub, just message the owner.
      if (action === "notify_ready") {
        delete st.review_fix_pending_sha;
        delete st.review_fix_pending_action;
        delete st.review_fix_pending_response_sig;
        delete st.review_fix_exhausted_sha;
        delete st.review_fix_exhausted_action;
        const readyKey = `${repo}:${headSha}`;
        if (!seenReady.has(readyKey)) {
          seenReady.add(readyKey);
          notifications.push(
            `🟢 PR #${num} is READY for your review: **${ctx.title}**\n` +
              `\`${(headSha || "").slice(0, 8)}\` · The review transcript reached an All-clear (${reason}).\n` +
              `→ http://github.com/${repo}/pull/${num}`
          );
        }
        st.last_head_sha = headSha;
        nextState[skey] = st;
        reports.push({
          type: "pr",
          repo,
          pr: num,
          head_sha: headSha,
          action: finalAction,
          reason: finalReason,
          reused_cached_decision: decided.reused,
          github_action_posted: githubActionPosted,
          ...classifyTerminalState({ ctx, action: finalAction, reason: finalReason, stateEntry: st }),
        });
        continue;
      }

      // --- REQUEST_REBASE: conflicts block everything else. No
      // review-cooldown gate here: a review on a conflicted PR is useless
      // anyway (conflict pings have their own 6h same-sha throttle).
      if (action === "request_rebase") {
        if (agentWorking) {
          finalAction = "wait";
          finalReason =
            `Last commit is newer than ${ACTIVE_WORK_QUIET_HOURS}h: an agent is still ` +
            "working on this branch; do not interrupt with pings.";
          st._sig = sig;
          st._action = finalAction;
          st._reason = finalReason;
        } else if (throttleOkSameSha(st, nowMs, headSha, REBASE_PING_MIN_INTERVAL_HOURS)) {
          await requestRebase(repo, num, { dryRun, runGhFn, dryRunLogs });
          if (!dryRun) {
            githubActionsTaken++;
            githubActionPosted = true;
          }
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
        } else {
          finalAction = "wait";
          finalReason =
            `A conflict-resolution ping was already sent for this head sha in the last ` +
            `${REBASE_PING_MIN_INTERVAL_HOURS}h; wait before retrying.`;
        }
        st.last_head_sha = headSha;
        nextState[skey] = st;
        reports.push({
          type: "pr",
          repo,
          pr: num,
          head_sha: headSha,
          action: finalAction,
          reason: finalReason,
          reused_cached_decision: decided.reused,
          github_action_posted: githubActionPosted,
          ...classifyTerminalState({ ctx, action: finalAction, reason: finalReason, stateEntry: st }),
        });
        continue;
      }

      // --- REQUEST_FIX / REQUEST_REVIEW (same ping guards).
      if (action === "request_fix" || action === "request_review") {
        const reviewFixPings = st.review_fix_pings_sha === headSha &&
          st.review_fix_pings_action === action
          ? Number(st.review_fix_pings) || 0
          : 0;
        const pingOk =
          !agentWorking &&
          throttleOkSameSha(st, nowMs, headSha) &&
          !tooSoonAfterReview(ctx, nowMs);
        if (reviewFixPings >= REVIEW_FIX_MAX_PINGS) {
          finalAction = "wait";
          finalReason =
            `Review/fix retry budget exhausted (${reviewFixPings} pings on this sha): ` +
            "owner escalated; stop retrying until new commits land.";
          st.review_fix_exhausted_sha = headSha;
          st.review_fix_exhausted_action = action;
          st.review_fix_pending_sha = headSha;
          st.review_fix_pending_action = action;
          st.review_fix_pending_response_sig = reviewFixResponseSig;
          if (st.review_fix_stuck_notified_sha !== headSha) {
            st.review_fix_stuck_notified_sha = headSha;
            notifications.push(
              `🔴 PR #${num} has ${reviewFixPings} unanswered Copilot review/fix requests on ` +
                `this head: **${ctx.title}**\nDecide next step manually.\n` +
                `→ http://github.com/${repo}/pull/${num}`
            );
          }
        } else if (pingOk) {
          if (action === "request_fix") {
            await requestFix(repo, num, ctx.commentUrls, { dryRun, runGhFn, dryRunLogs });
          } else {
            await requestReview(repo, num, { dryRun, runGhFn, dryRunLogs });
          }
          if (!dryRun) {
            githubActionsTaken++;
            githubActionPosted = true;
          }
          st.last_ping_ts = new Date(nowMs).toISOString();
          st.last_ping_sha = headSha;
          st.review_fix_pings_sha = headSha;
          st.review_fix_pings_action = action;
          st.review_fix_pings = reviewFixPings + 1;
          st.review_fix_pending_sha = headSha;
          st.review_fix_pending_action = action;
          st.review_fix_pending_response_sig = reviewFixResponseSig;
          delete st.review_fix_exhausted_sha;
          delete st.review_fix_exhausted_action;
        } else if (agentWorking) {
          finalAction = "wait";
          finalReason =
            `Last commit is newer than ${ACTIVE_WORK_QUIET_HOURS}h: an agent is still ` +
            "working on this branch; do not interrupt with pings.";
        } else if (!throttleOkSameSha(st, nowMs, headSha)) {
          finalAction = "wait";
          finalReason =
            `A ${action.replace("request_", "")} ping was already sent for this head sha in the ` +
            `last ${PING_MIN_INTERVAL_HOURS}h; wait before retrying.`;
        } else if (tooSoonAfterReview(ctx, nowMs)) {
          finalAction = "wait";
          finalReason =
            `The newest Copilot review is still within the ${COOLDOWN_AFTER_REVIEW_HOURS}h cooldown; wait.`;
        }
        st.last_head_sha = headSha;
        nextState[skey] = st;
        reports.push({
          type: "pr",
          repo,
          pr: num,
          head_sha: headSha,
          action: finalAction,
          reason: finalReason,
          reused_cached_decision: decided.reused,
          github_action_posted: githubActionPosted,
          ...classifyTerminalState({ ctx, action: finalAction, reason: finalReason, stateEntry: st }),
        });
        continue;
      }

      // --- WAIT / unknown action: no action.
      st.last_head_sha = headSha;
      nextState[skey] = st;
      reports.push({
        type: "pr",
        repo,
        pr: num,
        head_sha: headSha,
        action: finalAction,
        reason: finalReason,
        reused_cached_decision: decided.reused,
        github_action_posted: githubActionPosted,
        ...classifyTerminalState({ ctx, action: finalAction, reason: finalReason, stateEntry: st }),
      });
    }
  }

  nextState.seen_ready_shas = [...seenReady].sort();
  const outputParts = [...dryRunLogs];
  if (notifications.length) outputParts.push(notifications.join("\n\n"));
  const overallReport = buildOverallReport({ reports, targetPr, scopeFetchFailures });
  if (emitJsonReport) {
    outputParts.push(...reports.map((report) => JSON.stringify(report)));
    outputParts.push(JSON.stringify(overallReport));
  }

  return {
    state: nextState,
    notifications,
    githubActionsTaken,
    reports,
    overallReport,
    output: outputParts.join("\n"),
  };
}

async function main() {
  const { repos, targetPr, emitJsonReport } = resolveInvocation();
  if (repos.length === 0 && !targetPr) {
    console.error(
      "Scope is required: pass --repo/--repos or --pr, or set PR_MONITOR_REPOS / PR_MONITOR_PR."
    );
    process.exit(1);
  }

  let lock = null;
  try {
    if (!DRY_RUN) lock = await acquireStateLock();
    const state = loadState();
    const out = await runMonitorOnce({
      nowMs: Date.now(),
      repos,
      targetPr,
      state,
      dryRun: DRY_RUN,
      emitJsonReport,
    });

    // Never persist in dry-run — a dry run must not poison the real
    // throttle/cache bookkeeping.
    if (!DRY_RUN) saveState(out.state);

    // Output: only emit human-facing notifications (empty otherwise ->
    // no_agent cron stays silent so we don't spam the owner).
    if (out.output) console.log(out.output);
  } finally {
    releaseStateLock(lock);
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((e) => {
    console.error(`⚠️ pr_monitor crashed: ${e.stack || e}`);
    process.exit(1);
  });
}
