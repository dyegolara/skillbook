# Dojo Mojo Skillbook

A collection of agent skills in the standard Agent Skills format. Markdown
first; the only code is small reference scripts shipped inside skill folders
so agents can run them directly.

## Language

### Skillbook core

**Skill**:
A self-contained folder with a `SKILL.md` (instructions, frontmatter) plus
optional scripts and resources, loadable by any agent.
_Avoid_: plugin, extension, prompt.

**Referenced skill**:
A skill that lives in another repo and is consumed by reference (npm /
skills.sh / ClawHub) — never copied into this skillbook.
_Avoid_: external skill, dependency skill.

**Own skill**:
A skill whose canonical source is this repo (`skills/<category>/<name>`).
_Avoid_: local skill.

**Script standard**:
The rule that every script shipped in a skill folder is plain ESM
JavaScript (`.mjs`), run directly by Node, with no build step. See
`docs/adr/0002`.
_Avoid_: (do not call it "the TS standard" — earlier drafts did)

### copilot-review-smart

**Watched repo**:
A GitHub repo whose open PRs the monitor loop drives toward a Copilot clean
bill of health. Always passed via `PR_MONITOR_REPOS`, never defaulted.
_Avoid_: target repo, monitored project.

**Transcript**:
The full paginated PR comment history (issue comments + inline comments, any
author). It is the source of truth for what was asked and answered.
_Avoid_: partial comments, just-Copilot view.

**Ping**:
A comment posted on GitHub mentioning `@copilot` asking it to act
(review / fix / resolve conflicts).
_Avoid_: message, request (a request can also be a human's).

**Ack**:
A Copilot quote-line reply that repeats a prior request. It counts as neither
a new request nor progress.
_Avoid_: work done, pending request.

**Dirty gate**:
The deterministic rule that a PR with merge conflicts with main
(`mergeable_state == "dirty"` or `mergeable == false`) never gets reviewed —
it first goes through the conflict-resolution retry policy.
_Avoid_: rebase gate (the gate is about conflicts, not the strategy).

**Active work**:
A branch whose last commit is < 3h old. Hold all pings while active work is in
flight (`notify_ready` is exempt because it never touches GitHub).
_Avoid_: idle branch.

**Signature cache**:
A hash of a PR's observable state (head sha, Copilot feedback timestamps,
transcript digest…) that, when unchanged between ticks, lets the loop reuse
the previous decision instead of calling the LLM.
_Avoid_: cache key (it is a cache *of* a decision, keyed by state).

**Notify-ready**:
The one action that never touches GitHub: the loop tells the owner a PR is
ready for human review. Fired by an All-clear; at most once per head sha.
_Avoid_: approval (Copilot posting `APPROVED` is a review state, not this).

**All-clear**:
The LLM's judgement, from the PR transcript, that the reviewer (Copilot or
a human) left no unaddressed comments on the current head. The signal that
triggers Notify-ready and ends a loop.
_Avoid_: approval, done (done is the loop's terminal state, this is the signal).

**Stuck PR**:
A conflicted PR that exhausted its conflict-resolution pings (3 per head
sha); the loop escalates to the owner once and retries weekly.
_Avoid_: dead PR, blocked PR (blocked is a GitHub `mergeable_state`).

**Needs-human**:
A terminal state of a loop: the bot can do nothing more on the PR —
Copilot repeatedly ignored its pings (e.g. out of credits) or could not
resolve the conflicts. The loop escalates to the owner once and stops.
_Avoid_: stuck PR (stuck describes the PR, this is the loop's state),
blocked (a GitHub `mergeable_state`).

**Escalation**:
A single owner notification that the loop cannot safely advance on its own for
the current head sha (stuck conflicts or recurring LLM/API failure).
_Avoid_: repeated alerts.

**Host**:
The machine where the skill runs — listener, state and timers live there. The
skill never assumes a platform, VPS or container runtime; choosing a host is
deployment, not design.
_Avoid_: server, VPS, runner, node.

**Tick**:
One invocation of the watchdog over a scope (a repo set or a single PR):
deterministic gates first, at most one LLM decision and one GitHub action per
PR. One invocation = exactly one tick.
_Avoid_: run, pass, cycle, iteration.

**Listener**:
The long-running HTTP process shipped by the skill: it receives GitHub
deliveries, verifies their signature, filters and coalesces them, and spawns
ticks. It holds no decision logic.
_Avoid_: server, daemon, receiver, webhook endpoint.

**Hook**:
The GitHub-side webhook registration on a watched repo. It is permanent —
updated by id, never recreated — and removed only by an explicit teardown.
_Avoid_: webhook (the hook is the registration; a delivery is one POST),
subscription.

**Delivery**:
One signed POST from GitHub carrying one event, identified by
`X-GitHub-Delivery`. Deliveries that fail while no Listener is up are not
retried by GitHub; the Startup tick is the recovery.
_Avoid_: event (the payload), notification.

**Echo**:
A delivery caused by the Listener's own ping comment. Ignored by author, never
counted as progress.
_Avoid_: feedback loop, self-trigger.

**Flow**:
The monitored lifecycle of one PR: it opens when the loop starts watching the
PR and closes at All-clear (Notify-ready) or when the PR is closed or merged.
Needs-human does not close it — it keeps its weekly retry.
_Avoid_: run, session, job.

**Expectation**:
The deadline a tick arms for a Flow — "something is worth re-checking at
`next_check_at`". The Listener fires a Fallback tick if no Delivery arrives
first; no expectations means the loop is asleep.
_Avoid_: timer, poll, sweep.

**Fallback tick**:
A tick triggered by an expired Expectation, not by a Delivery and not by a
schedule.
_Avoid_: cron, sweep, retry.

**Startup tick**:
The single full-scope tick a Listener runs at start, to recover deliveries
missed while it was down.
_Avoid_: sweep, catch-up poll.
