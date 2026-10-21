---
name: create-pr
description: "Software-factory chain stage: push the verified integration branch, write the PR body with the pr skill, then use the branch's PR in whichever state it is — mark a draft ready, apply the written body to an already-ready PR, or open a ready PR against main when there is none, never a draft — and close the spec and its tickets. Use for /create-pr or shipping a reviewed chain run."
disable-model-invocation: true
license: MIT
metadata:
  model: opencode-go/muse-spark-1.3-contributor
  effort: xhigh
---

# create-pr

Ship verified work: push the integration branch and open — or finish — a ready
PR against `main` that closes the spec and its tickets.

**Model pin**: `opencode-go/muse-spark-1.3-contributor`, `--thinking xhigh`
(the provider's cap). It runs headless as a pi session that the pack helper
launches into a visible Kepler terminal from the shared worktree, started by
`code-review-loop` after a clean review.

**Standalone entry**: `/create-pr` without a task or a spec asks the user
which one — the spec issue, or the tracker issue at hand — before it reads
the handoff doc; the answer names the run's subject and the issues the PR
closes. Standalone invocations are outside the chain's contract; `create-pr`
is the chain's last stage and launches nothing, so no ids resolve and no
helper flags apply on this path.

## Process

1. Read the handoff doc and its pointers: the spec issue, the tickets, the
   integration branch, the review report. Confirm the review is clean and
   that every ticket is either closed or covered by the PR's closing links.

2. Push the branch: `git push -u origin <branch>`. Never force-push.

3. Call the Skill tool for `pr`. Write the body to a file and pass it with
   `--body-file`. Use the vocabulary in `GLOSSARY.md`. Evidence is the review
   report's clean result plus the test runs from the implementation; Merge
   Danger states whether the merge is a one-way or two-way door.

4. Finish the PR: use the branch's PR in whichever state it is — a branch
   that already has one never gets a second. Read it first:
   `gh pr list --head <branch> --state open --json number,isDraft --limit 1`.
   An empty result means there is no open PR for the branch; otherwise the
   single returned row supplies its `number` and `isDraft`.

   - **Draft** — the open result is a draft. Mark it ready:
     `gh pr ready <number>`.
   - **Ready** — the open result is ready. If step 3 wrote a body, apply it to
     that PR with `gh pr edit <number> --body-file <path>`, and never create a
     second one.
   - **No PR** — the open-only lookup returned an empty result. Create a ready
     one against `main`:
     `gh pr create --base main --head <branch> --title <title> --body-file <path>`.
     Never open a draft.

   Closed and merged PRs are not reused; when no open PR exists, create a new
   ready PR for the branch.

5. Close the spec and its tickets through the body's closing keywords — one
   `Closes #<n>` line per issue, the spec and every ticket — or set the same
   links with `gh pr edit`. Verify with
   `gh pr view --json closingIssuesReferences`.

6. Report the PR URL, the branch and the closing links. The chain ends here.

## Handoff

This is the terminal stage, so there is no next stage: no `handoff` doc, no
next session. The ready PR is the durable artifact, the review report is its
evidence, and the maintainer takes it from there.
