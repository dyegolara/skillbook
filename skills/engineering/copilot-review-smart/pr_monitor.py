#!/usr/bin/env python3
"""
pr_monitor.py — SMART Copilot review watchdog (portable, multi-repo).

This copy ships inside the copilot-review-smart skill. Configuration is all
env-driven: PR_MONITOR_REPOS, PR_MONITOR_STATE_PATH, PR_MONITOR_MODEL,
OPENROUTER_API_KEY (or whatever _load_env_key finds), DRY_RUN=1.

Replaces the naive ping-pong loop that kept posting "@copilot code review"
every day even after Copilot had already said everything passes.

Key ideas:
  1. The bot reads GitHub state and the LAST Copilot comment/review.
  2. It considers when each event happened (timestamps) — has the head SHA
     changed? is the latest Copilot review NEWER than the last commit?
  3. An LLM call makes the decision: REQUEST_REVIEW / REQUEST_REBASE /
     REQUEST_FIX / NOTIFY_READY / WAIT.
  4. If NOTHING (PR is green / Copilot already confirmed clean), the bot does
     NOT post on GitHub at all — it only sends a message to the owner saying
     the PR is ready for their review.
  5. HARD GATE before any decision: if the PR has merge conflicts with main
     (mergeable_state dirty / mergeable false), the bot reads the FULL comment
     transcript first: if a rebase was already requested by anyone (human,
     Copilot or the bot itself) after the last commit, it WAITS (no duplicate
     pings) — otherwise it asks Copilot to rebase onto origin/main and the
     loop resumes once the sha is clean again. If mergeability is still
     unknown, it waits.

Because the decision endpoint can change and we want cheap, deterministic-ish
behaviour, the LLM is called via OpenRouter (chat completions). Model is
overridable via PR_MONITOR_MODEL env.

Auth: relies on `gh` (token in macOS keychain).
"""

import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

# Repos watched by the monitor. Every open PR in these repos goes through the
# same loop: conflict gate -> (rebase) -> review -> notify.
# Watched repos, override with PR_MONITOR_REPOS="owner/repo1,owner/repo2".
REPOS = [
    r.strip()
    for r in os.environ.get(
        "PR_MONITOR_REPOS", "dyegolara/monitor,dyegolara/bitsimp"
    ).split(",")
    if r.strip()
]
# Where the loop persists its cache/throttle bookkeeping.
# Override with PR_MONITOR_STATE_PATH (the default matches the Hermes cron).
STATE_PATH = os.path.expanduser(
    os.environ.get(
        "PR_MONITOR_STATE_PATH", "~/.hermes/cron/output/pr-monitor-state.json"
    )
)
COPILOT_SUBSTR = "copilot"

# Default model for the decision LLM.
MODEL = os.environ.get("PR_MONITOR_MODEL", "deepseek/deepseek-v4-flash-0731")

# Dry-run mode: act like normal but never POST to GitHub (and don't persist
# state). Useful for testing without touching real PRs.
DRY_RUN = os.environ.get("DRY_RUN") == "1"

# Don't re-ping Copilot on the same head sha more often than this. This is the
# key guard that prevents the previous infinite daily ping loop.
PING_MIN_INTERVAL_HOURS = 12
# Minimum age of the newest Copilot review before we'd consider re-reviewing
# the same sha (room for Copilot to actually post before we ping again).
COOLDOWN_AFTER_REVIEW_HOURS = 6

# Rebase retry policy: a conflicted PR must NOT deadlock. After a rebase
# request (ours or the human's), we wait REBASE_RETRY_HOURS for branch
# movement; if the PR is STILL dirty (Copilot ignored it or its merge failed),
# we re-ping — up to REBASE_MAX_PINGS pings per head sha. Once exhausted, we
# stop pinging Copilot hourly and switch to a weekly cadence + tell the owner
# once (per sha) that the PR is stuck so they can close/merge manually.
REBASE_RETRY_HOURS = 24
REBASE_MAX_PINGS = 3
REBASE_STALE_RETRY_HOURS = 24 * 7

# Never apply the loop to WIP work: draft PRs (and WIP-titled ones) are being
# actively worked on — a bot ping derails the assigned agent (it drops its
# task to answer us and doesn't resume). Skip them entirely.
WIP_TITLE_RE = re.compile(r"^\s*\[?(wip|draft|dnm|do not merge|work in progress)\b", re.I)

# A very recent last commit means an agent is (probably) still pushing work:
# pinging then interrupts it. Give the branch this quiet window before ANY
# Copilot ping. (notify_ready is exempt — it never touches GitHub.)
ACTIVE_WORK_QUIET_HOURS = 3


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def run_gh(args):
    p = subprocess.run(["gh", "api"] + args, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"gh failed: {' '.join(args)}\n{p.stderr.strip()}")
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return p.stdout


def gh_paginated(path, max_pages=3):
    """Fetch a listing endpoint with per_page=100, following up to max_pages
    of results. Long-lived PRs (>30 comments) would otherwise silently lose
    the newest transcript entries — the exact comments the bot must read."""
    items = []
    sep = "&" if "?" in path else "?"
    for page in range(1, max_pages + 1):
        batch = run_gh([f"{path}{sep}per_page=100&page={page}"])
        if not isinstance(batch, list) or not batch:
            break
        items.extend(batch)
        if len(batch) < 100:
            break
    return items


def _load_env_key(name):
    """Read a KEY=VAL from ~/.hermes/.env without printing it."""
    env_path = os.path.expanduser("~/.hermes/.env")
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith(name + "="):
                    return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    return os.environ.get(name, "")


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def post_comment(repo, num, body):
    if DRY_RUN:
        print(f"[DRY-RUN] {repo}#{num}: {body}")
        return
    run_gh([f"repos/{repo}/issues/{num}/comments", "-f", f"body={body}", "-X", "POST"])


def request_review(repo, num):
    """Ask the Copilot coding agent / reviewer to review via bot command."""
    post_comment(repo, num, "@copilot code review")


def request_fix(repo, num, comment_urls):
    if not comment_urls:
        post_comment(repo, num, "@copilot code review")
        return
    urls = " ".join(comment_urls)
    post_comment(repo, num, f"@copilot work on the issues mentioned in these comments {urls}")


def request_rebase(repo, num):
    """Ask the Copilot coding agent to resolve the PR's merge conflicts with
    origin/main. Do NOT prescribe rebase: Copilot's environment cannot
    force-push, so it integrates main via merge. What we demand is that the
    conflicts get RESOLVED, wisely, preserving both branches' work."""
    post_comment(
        repo,
        num,
        "@copilot resolve the merge conflicts between this branch and "
        "origin/main. Be wise with the strategy: carefully preserve the "
        "features and decisions of BOTH branches — do not silently drop or "
        "overwrite either side unless it is part of the new features (this "
        "branch over main). If you are not confident on a change or have a "
        "question about a decision, consult the spec, tickets and "
        "documentation to see if there could be any answer, if not, ask the "
        "user.",
    )


def _max_ts(ts_iter):
    vals = [t for t in ts_iter if t]
    return max(vals) if vals else None


def _iso_to_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def is_copilot(item):
    login = ((item or {}).get("user") or {}).get("login") or ""
    return COPILOT_SUBSTR in login.lower()


# ---------------------------------------------------------------------------
# GitHub state collector
# ---------------------------------------------------------------------------

def collect_pr_state(pr, num, repo):
    """Gather everything the LLM needs to decide, plus raw facts we act on."""
    head_sha = (pr.get("head") or {}).get("sha")
    draft = pr.get("draft")
    title = pr.get("title", "")

    # Copilot reviews (the formal pull_request reviews).
    try:
        reviews = gh_paginated(f"repos/{repo}/pulls/{num}/reviews")
    except RuntimeError:
        reviews = []
    reviews = reviews if isinstance(reviews, list) else []
    copilot_reviews = [r for r in reviews if is_copilot(r)]
    approved = any(r.get("state") == "APPROVED" for r in copilot_reviews)
    commented = any(r.get("state") == "COMMENTED" for r in copilot_reviews)
    latest_review_ts = _max_ts(r.get("submitted_at") for r in copilot_reviews)
    latest_review_state = None
    if copilot_reviews:
        latest_review_state = copilot_reviews[-1].get("state")

    # Inline review comments left by Copilot (the actual feedback content).
    try:
        rcomments = gh_paginated(f"repos/{repo}/pulls/{num}/comments")
    except RuntimeError:
        rcomments = []
    rcomments = rcomments if isinstance(rcomments, list) else []
    copilot_rcomments = [c for c in rcomments if is_copilot(c)]
    latest_inline_ts = _max_ts(c.get("created_at") for c in copilot_rcomments)
    n_inline_unresolved = 0
    for c in copilot_rcomments:
        if c.get("in_reply_to_id") is None and c.get("diff_hunk"):
            x = (c.get("_links") or {}).get("html") or {}
            resolved = x.get("resolved") if isinstance(x, dict) else None
            if not resolved:
                n_inline_unresolved += 1
    comment_urls = [c.get("html_url") for c in copilot_rcomments if c.get("html_url")]

    # Issue-level comments (the transcript where we posted "@copilot code review"
    # and Copilot replied). Only Copilot's replies carry its verdict.
    try:
        icomments = gh_paginated(f"repos/{repo}/issues/{num}/comments")
    except RuntimeError:
        icomments = []
    icomments = icomments if isinstance(icomments, list) else []
    copilot_icomments = [c for c in icomments if is_copilot(c)]
    last_copilot_comment = copilot_icomments[-1].get("body", "") if copilot_icomments else ""
    last_copilot_comment_ts = _max_ts(c.get("created_at") for c in copilot_icomments)

    # FULL transcript (ANY author, not just Copilot) — the human context the
    # bot must read before acting. Newest 40 issue + 40 inline comments, bodies
    # truncated to keep the LLM prompt bounded.
    issue_transcript = [
        {
            "author": ((c.get("user") or {}).get("login") or "?"),
            "ts": c.get("created_at"),
            "body": (c.get("body") or "")[:400],
        }
        for c in icomments
    ][-40:]
    inline_transcript = [
        {
            "author": ((c.get("user") or {}).get("login") or "?"),
            "ts": c.get("created_at"),
            "body": (c.get("body") or "")[:300],
        }
        for c in rcomments
    ][-40:]

    # Commits on the PR head branch.
    try:
        commits = gh_paginated(f"repos/{repo}/pulls/{num}/commits")
    except RuntimeError:
        commits = []
    commits = commits if isinstance(commits, list) else []
    commit_dates = [c.get("commit", {}).get("author", {}).get("date") for c in commits]
    last_commit_ts = _max_ts(commit_dates)

    # Merge-ability vs main: the HARD prerequisite before any review.
    # - mergeable_state "dirty" / mergeable False  => conflicts with main
    # - mergeable_state "clean"/"behind"/"unstable"/"blocked"/"draft" => OK
    #   (behind = PR is outdated but still mergeable; not a conflict)
    # - both None => GitHub hasn't computed it yet (async) -> treat as unknown
    mergeable = pr.get("mergeable")
    mergeable_state = pr.get("mergeable_state")
    if mergeable is None and mergeable_state is None:
        # The list endpoint often returns null while the mergeability is being
        # computed; a per-PR fetch sometimes has it ready already.
        try:
            full = run_gh([f"repos/{repo}/pulls/{num}"])
            if isinstance(full, dict):
                mergeable = full.get("mergeable")
                mergeable_state = full.get("mergeable_state")
        except RuntimeError:
            pass
    has_conflicts = mergeable_state == "dirty" or mergeable is False
    merge_unknown = mergeable is None and mergeable_state is None

    return {
        "num": num,
        "title": title,
        "draft": bool(draft),
        "head_sha": head_sha,
        "approved": approved,
        "commented": commented,
        "latest_review_state": latest_review_state,
        "latest_review_ts": latest_review_ts,
        "n_inline_unresolved": n_inline_unresolved,
        "latest_inline_ts": latest_inline_ts,
        "comment_urls": comment_urls,
        "last_copilot_comment": last_copilot_comment,
        "last_copilot_comment_ts": last_copilot_comment_ts,
        "issue_transcript": issue_transcript,
        "inline_transcript": inline_transcript,
        "last_commit_ts": last_commit_ts,
        "mergeable": mergeable,
        "mergeable_state": mergeable_state,
        "has_conflicts": has_conflicts,
        "merge_unknown": merge_unknown,
    }


# ---------------------------------------------------------------------------
# LLM decision
# ---------------------------------------------------------------------------

class LLMDecisionError(RuntimeError):
    pass


def call_llm(decision_ctx):
    """Ask the LLM to classify what to do. Returns a dict with 'action' and
    optional 'reason'. action in {request_review, request_fix, notify_ready,
    wait}."""
    api_key = _load_env_key("OPENROUTER_API_KEY")
    if not api_key:
        raise LLMDecisionError("no OPENROUTER_API_KEY")

    system = (
        "You are a senior engineer's PR-watchdog. Given the state of a GitHub "
        "pull request and the FULL comment transcript (any author: human, "
        "Copilot, bots), decide what the bot should do. You output JSON only.\n\n"
        "CONTEXT FIRST: read the whole issue_transcript and inline_transcript "
        "before deciding. Respect what has already been asked — if a human or "
        "Copilot already requested a rebase/review on the current head and it "
        "is still pending, do NOT ask again; WAIT. Never duplicate requests.\n\n"
        "Rules:\n"
        "- REQUEST_REVIEW: Copilot has NOT reviewed the current head sha yet, OR "
        "  there are new commits after the last review that the reviewer hasn't "
        "  seen. We ping '@copilot code review'.\n"
        "- REQUEST_REBASE: the PR has merge conflicts with main (has_conflicts "
        "  true). This is a HARD prerequisite: never review a conflicted PR. "
        "  Ping asking Copilot to RESOLVE the merge conflicts with origin/main "
        "  (any strategy it can use in its environment — it cannot force-push, "
        "  so it usually merges), preserving both branches' work.\n"
        "- REQUEST_FIX: Copilot left actionable review comments on the current "
        "  head that are still unaddressed AND are newer than the last commit "
        "  (i.e. Copilot is waiting for the author to fix). Ping '@copilot work "
        "  on the issues...'.\n"
        "- NOTIFY_READY: Copilot has already confirmed the current head sha is "
        "  clean (e.g. its latest comment/review says all tests pass / no issues "
        "  / approved), AND no new commits or new review comments have appeared "
        "  since. Do NOT ping Copilot again — instead tell the human owner the "
        "  PR is ready for their review.\n"
        "- WAIT: not enough info, or too soon after the last action — wait for "
        "  the next cron tick.\n\n"
        "Prefer NOTIFY_READY whenever the latest Copilot feedback on the current "
        "head sha indicates a clean bill of health. Never REQUEST_REVIEW when "
        "the newest Copilot review/comment already covers the current head sha "
        "and reported no issues. Never pick request_review/notify_ready when "
        "has_conflicts is true (the hard rebase gate wins); if merge_unknown is "
        "true, pick WAIT.\n"
        "JSON shape: {\"action\": \"request_review|request_rebase|request_fix|"
        "notify_ready|wait\", "
        "\"reason\": \"short justification in Spanish\"}"
    )

    user = json.dumps(decision_ctx, ensure_ascii=False, default=str)

    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps({
            "model": MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode())
        content = payload["choices"][0]["message"]["content"]
    except Exception as e:
        raise LLMDecisionError(f"LLM call failed: {e}")

    try:
        return json.loads(content)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", content, re.S)
        if m:
            return json.loads(m.group(0))
        raise LLMDecisionError(f"unparseable LLM JSON: {content[:200]}")


# ---------------------------------------------------------------------------
# throttle / state guards
# ---------------------------------------------------------------------------

def throttle_ok_same_sha(state_entry, now, head_sha):
    """We should NOT ping the same head sha again too soon."""
    last = state_entry.get("last_ping_ts")
    last_sha = state_entry.get("last_ping_sha")
    if last_sha != head_sha:
        return True  # new commits -> fresh ping allowed
    if not last:
        return True
    last_dt = _iso_to_dt(last)
    if not last_dt:
        return True
    return (now - last_dt) >= timedelta(hours=PING_MIN_INTERVAL_HOURS)


def too_soon_after_review(state_entry, now, state_ctx):
    """If Copilot's newest review is VERY recent, give it a moment before we'd
    ping on the same sha (avoid the ping landing before Copilot reviews)."""
    latest_review_ts = state_ctx.get("latest_review_ts") or state_ctx.get("latest_inline_ts")
    if not latest_review_ts:
        return False
    dt = _iso_to_dt(latest_review_ts)
    if not dt:
        return False
    return (now - dt) < timedelta(hours=COOLDOWN_AFTER_REVIEW_HOURS)


def already_notified_ready(seen_shas, head_sha):
    return head_sha in seen_shas


def agent_still_working(state_ctx, now):
    """True if the branch's last commit is VERY recent — an agent is likely
    still actively working. Pinging Copilot then would interrupt it (real
    incident: bitsimp#262 — the ping derailed the assigned agent and it never
    resumed its task). notify_ready is exempt (it never touches GitHub)."""
    last_commit = state_ctx.get("last_commit_ts")
    if not last_commit:
        return False
    dt = _iso_to_dt(last_commit)
    if not dt:
        return False
    return (now - dt) < timedelta(hours=ACTIVE_WORK_QUIET_HOURS)


def is_rebase_request(body):
    """Does this comment ASK Copilot to resolve merge conflicts (by rebase
    OR merge)? Quotes (lines starting with '>'), which Copilot echoes back
    via merge — so 'resolve the merge conflicts' counts the same as 'rebase'."""
    body = "\n".join(
        ln for ln in (body or "").splitlines() if not ln.lstrip().startswith(">")
    )
    b = body.lower()
    asks_resolution = (
        "rebase" in b
        or "merge conflict" in b
        or ("resolv" in b and "conflict" in b)
    )
    return asks_resolution and ("@copilot" in b or "haz rebase" in b)


def newest_rebase_request_ts(issue_transcript):
    """Timestamp of the newest rebase request made by a NON-Copilot author
    (the human or this bot). Copilot's replies only quote/ack requests — they
    must never count as pending requests themselves."""
    best = None
    for c in issue_transcript or []:
        author = (c.get("author") or "").lower()
        if "copilot" in author:
            continue
        if is_rebase_request(c.get("body")):
            ts = c.get("ts")
            if ts and (best is None or ts > best):
                best = ts
    return best


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    now = datetime.now(timezone.utc)
    state = load_state()
    # Per-repo head shas already reported "ready" (key "repo:sha") -> notify once.
    seen_ready = set(state.get("seen_ready_shas", []))

    notifications = []  # human-facing messages emitted this run (delivered to owner)
    github_actions_taken = 0

    # Collect open PRs from every watched repo. A failure on one repo must
    # not kill the whole run.
    prs_by_repo = {}
    for repo in REPOS:
        try:
            prs = run_gh([f"repos/{repo}/pulls?state=open"])
            if isinstance(prs, list):
                prs_by_repo[repo] = prs
        except RuntimeError as e:
            print(f"⚠️ No pude listar los PRs de {repo}: {str(e)[:200]}")

    for repo, prs in prs_by_repo.items():
        for pr in prs:
            num = pr.get("number")
            skey = f"{repo}#{num}"
            st = state.get(skey, {})
            ctx = collect_pr_state(pr, num, repo)
            head_sha = ctx["head_sha"]

            # Shorthand for decision_ctx sent to the LLM.
            decision_ctx = {
                "pr": num,
                "repo": repo,
                "title": ctx["title"],
                "draft": ctx["draft"],
                "head_sha": head_sha,
                "last_commit_ts": ctx["last_commit_ts"],
                "copilot_reviews": {
                    "latest_state": ctx["latest_review_state"],
                    "latest_submitted_at": ctx["latest_review_ts"],
                    "approved_any": ctx["approved"],
                },
                "copilot_inline_feedback": {
                    "count_unresolved": ctx["n_inline_unresolved"],
                    "latest_at": ctx["latest_inline_ts"],
                },
                "last_copilot_issue_comment": {
                    "ts": ctx["last_copilot_comment_ts"],
                    "body": ctx["last_copilot_comment"][:2000],
                },
                # FULL transcript so the LLM sees the human context: who
                # asked what and when (ANY author, not just Copilot).
                "issue_transcript": ctx["issue_transcript"],
                "inline_transcript": ctx["inline_transcript"],
                "merge_status": {
                    "mergeable": ctx["mergeable"],
                    "mergeable_state": ctx["mergeable_state"],
                    "has_conflicts": ctx["has_conflicts"],
                    "merge_unknown": ctx["merge_unknown"],
                },
                "has_new_commits_since_last_review": bool(
                    ctx["last_commit_ts"] and ctx["latest_review_ts"]
                    and ctx["last_commit_ts"] > ctx["latest_review_ts"]
                ),
                "has_new_commits_since_last_inline": bool(
                    ctx["last_commit_ts"] and ctx["latest_inline_ts"]
                    and ctx["last_commit_ts"] > ctx["latest_inline_ts"]
                ),
                "agent_still_working": agent_still_working(ctx, now),
                "note_agent_still_working": (
                    "The last commit is VERY recent (< "
                    f"{ACTIVE_WORK_QUIET_HOURS}h): an agent is likely still "
                    "working on this branch. Prefer WAIT — pings interrupt "
                    "active work."
                ) if agent_still_working(ctx, now) else None,
            }

            # --- Signature cache: skip the LLM when nothing relevant changed.
            # The LLM call is the only "expensive" part; if the head sha AND all
            # Copilot feedback timestamps are unchanged from the last eval, we
            # reuse the previous decision instead of burning tokens.
            _sig = "|".join([
                str(head_sha or ""),
                str(ctx["latest_review_ts"] or ""),
                str(ctx["latest_review_state"] or ""),
                str(ctx["latest_inline_ts"] or ""),
                str(ctx["last_copilot_comment_ts"] or ""),
                str(ctx["n_inline_unresolved"]),
                str(ctx["approved"]),
                str(ctx["mergeable"]),
                str(ctx["mergeable_state"]),
                # Transcript digest: any NEW comment (any author) must
                # invalidate the cached decision — the bot reads context first.
                str(len(ctx["issue_transcript"])),
                str((ctx["issue_transcript"] or [{}])[-1].get("ts") or ""),
                str(len(ctx["inline_transcript"])),
                str((ctx["inline_transcript"] or [{}])[-1].get("ts") or ""),
            ])
            cached = st.get("_sig")
            cached_action = st.get("_action")

            # --- Hard gates (deterministic, evaluated BEFORE the LLM):
            # 0) WIP / draft => skip the PR entirely. Draft PRs are being
            #    actively worked on by an agent: a bot ping interrupts it
            #    (it drops its assigned task to answer us and never resumes —
            #    real incident on bitsimp#262). No LLM call, no ping, no
            #    notification: just record the head and move on. The loop
            #    picks the PR up the moment it's marked ready.
            # 1) Merge conflicts with main => never review a conflicted PR.
            #    Rebase-retry policy: a request must NOT deadlock the loop.
            #    After any rebase request (ours or the human's), give Copilot
            #    REBASE_RETRY_HOURS to move the branch; if the PR is STILL
            #    dirty (ignored ack, failed merge), re-ping — up to
            #    REBASE_MAX_PINGS pings per head sha. Exhausted => notify the
            #    owner once (per sha) and fall back to a weekly retry.
            # 2) Mergeability unknown => GitHub hasn't computed it yet; wait.
            if ctx["draft"] or WIP_TITLE_RE.match(ctx["title"] or ""):
                st["_sig"] = _sig
                st["_action"] = "skip_wip"
                st["_reason"] = (
                    "PR en draft/WIP: otro agente está trabajando en él; el "
                    "loop no aplica (no ping, no review) hasta que esté listo."
                )
                st["last_head_sha"] = head_sha
                state[skey] = st
                continue
            if ctx["has_conflicts"]:
                req_ts = _iso_to_dt(newest_rebase_request_ts(ctx["issue_transcript"]))
                rebase_pings = int(st.get("rebase_pings", 0) or 0)
                if st.get("rebase_pings_sha") != head_sha:
                    rebase_pings = 0  # new head => fresh retry budget
                if req_ts is None:
                    # Nobody (human/bot) has asked for a rebase on this branch
                    # state -> ask now.
                    action, _reused = "request_rebase", False
                    reason = (
                        "El PR tiene conflictos con main y nadie ha pedido "
                        "rebase todavía: pedir rebase sobre origin/main antes "
                        "de cualquier review."
                    )
                elif (now - req_ts) < timedelta(hours=REBASE_RETRY_HOURS):
                    # A fresh rebase request is in flight; give Copilot its
                    # window before re-pinging.
                    action, _reused = "wait", False
                    reason = (
                        "Rebase pedido hace menos de "
                        f"{REBASE_RETRY_HOURS}h y sin commits nuevos: esperar "
                        "a que Copilot lo ejecute antes de re-pedir."
                    )
                elif rebase_pings >= REBASE_MAX_PINGS:
                    last_ping_dt = _iso_to_dt(st.get("last_ping_ts"))
                    weekly_due = (
                        last_ping_dt is not None
                        and (now - last_ping_dt) >= timedelta(hours=REBASE_STALE_RETRY_HOURS)
                    )
                    if weekly_due:
                        # Weekly retry cycle: reset budget, ping again.
                        rebase_pings = 0
                        st["rebase_pings"] = 0
                        action, _reused = "request_rebase", False
                        reason = (
                            "Reintento semanal: el PR sigue con conflictos "
                            "tras agotar los re-pings de rebase; pedir de "
                            "nuevo a Copilot."
                        )
                    else:
                        action, _reused = "wait", False
                        reason = (
                            f"Rebase agotado ({rebase_pings} pings en este sha) "
                            "y el PR sigue con conflictos: escalado al dueño; "
                            "reintento semanal."
                        )
                        if st.get("stuck_notified_sha") != head_sha:
                            st["stuck_notified_sha"] = head_sha
                            notifications.append(
                                f"🔴 PR #{num} lleva {rebase_pings} pedidos de "
                                f"rebase a Copilot y SIGUE con conflictos: "
                                f"**{ctx['title']}**\n"
                                f"Decide: merge manual, rebase a mano o cerrarlo.\n"
                                f"→ http://github.com/{repo}/pull/{num}"
                            )
                else:
                    # Retry window expired (still dirty) and budget remains.
                    action, _reused = "request_rebase", False
                    reason = (
                        "El PR SIGUE con conflictos tras el rebase anterior "
                        f"({rebase_pings} ping(s) en este sha): re-pedir a "
                        "Copilot rebase sobre origin/main resolviendo los "
                        "conflictos."
                    )
            elif ctx["merge_unknown"]:
                if cached == _sig and cached_action == "wait":
                    action, _reused = cached_action, True
                else:
                    action, _reused = "wait", False
                reason = st.get("_reason") or (
                    "GitHub aún no calcula la mergeability del PR; esperar al "
                    "próximo tick."
                )
            elif cached == _sig and cached_action:
                action = cached_action
                reason = st.get("_reason") or action
                _reused = True
            else:
                # Decide (fresh).
                try:
                    decision = call_llm(decision_ctx)
                except LLMDecisionError as e:
                    notifications.append(
                        f"⚠️ {repo}#{num}: no pude decidir con el LLM ({e}). Lo reviso "
                        f"la próxima ejecución."
                    )
                    st.setdefault("last_head_sha", head_sha)
                    state[skey] = st
                    continue

                action = (decision.get("action") or "").strip().lower()
                reason = decision.get("reason") or action
                _reused = False

            # Persist signature + decision so the next run can reuse it.
            st["_sig"] = _sig
            st["_action"] = action
            if reason:
                st["_reason"] = reason

            # --- NOTIFY_READY: do NOT touch GitHub, just message the owner.
            if action == "notify_ready":
                if already_notified_ready(seen_ready, f"{repo}:{head_sha}"):
                    # Already told the owner for this sha -> stay silent.
                    st["last_head_sha"] = head_sha
                    state[skey] = st
                    continue
                seen_ready.add(f"{repo}:{head_sha}")
                notifications.append(
                    f"🟢 PR #{num} está LISTO para tu revisión: **{ctx['title']}**\n"
                    f"`{head_sha[:8]}` · Copilot ya confirmó que está limpio "
                    f"({reason}).\n"
                    f"→ http://github.com/{repo}/pull/{num}"
                )
                st["last_head_sha"] = head_sha
                state[skey] = st
                continue

            # --- REQUEST_REBASE: merge conflicts block everything else, so the
            # rebase request takes precedence over reviews. No review-cooldown
            # gate here: a review on a conflicted PR is useless anyway (the
            # 12h same-sha throttle still applies).
            if action == "request_rebase":
                if agent_still_working(ctx, now):
                    st["_sig"] = _sig
                    st["_action"] = "wait"
                    st["_reason"] = (
                        "Último commit hace menos de "
                        f"{ACTIVE_WORK_QUIET_HOURS}h: un agente sigue "
                        "trabajando en la rama; no interrumpir con pings."
                    )
                elif throttle_ok_same_sha(st, now, head_sha):
                    request_rebase(repo, num)
                    github_actions_taken += 1
                    st["last_ping_ts"] = now.isoformat()
                    st["last_ping_sha"] = head_sha
                    # Count rebase pings per head sha (drives the retry policy).
                    if st.get("rebase_pings_sha") != head_sha:
                        st["rebase_pings_sha"] = head_sha
                        st["rebase_pings"] = 1
                    else:
                        st["rebase_pings"] = int(st.get("rebase_pings", 0) or 0) + 1
                    notifications.append(
                        f"🔀 PR #{num} tiene conflictos con main: le pedí a Copilot "
                        f"hacer rebase sobre origin/main. Cuando lo resuelva, el "
                        f"loop continúa con el code review.\n"
                        f"→ http://github.com/{repo}/pull/{num}"
                    )
                st["last_head_sha"] = head_sha
                state[skey] = st
                continue

            # --- REQUEST_FIX
            if action == "request_fix":
                if not agent_still_working(ctx, now) and throttle_ok_same_sha(st, now, head_sha) and not too_soon_after_review(st, now, ctx):
                    request_fix(repo, num, ctx["comment_urls"])
                    github_actions_taken += 1
                    st["last_ping_ts"] = now.isoformat()
                    st["last_ping_sha"] = head_sha
                st["last_head_sha"] = head_sha
                state[skey] = st
                continue

            # --- REQUEST_REVIEW
            if action == "request_review":
                if not agent_still_working(ctx, now) and throttle_ok_same_sha(st, now, head_sha) and not too_soon_after_review(st, now, ctx):
                    request_review(repo, num)
                    github_actions_taken += 1
                    st["last_ping_ts"] = now.isoformat()
                    st["last_ping_sha"] = head_sha
                st["last_head_sha"] = head_sha
                state[skey] = st
                continue

            # --- WAIT / default: no action.
            st["last_head_sha"] = head_sha
            state[skey] = st

        # Persist state (never in dry-run — a dry run must not poison the real
    # throttle/cache bookkeeping).
    state["seen_ready_shas"] = sorted(seen_ready)
    if not DRY_RUN:
        save_state(state)

    # Output: only emit human-facing notifications (empty otherwise ->
    # no_agent cron stays silent so we don't spam Telegram).
    if notifications:
        print("\n\n".join(notifications))
    else:
        # Nothing to report to the owner. Print nothing so the cron stays silent.
        pass


if __name__ == "__main__":
    main()
