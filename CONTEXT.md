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
