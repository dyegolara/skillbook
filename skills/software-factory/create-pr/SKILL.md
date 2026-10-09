---
name: create-pr
description: "Software-factory chain stage: push the verified integration branch, write the PR body with the pr skill, mark the existing draft ready or open a ready PR against main, and close the spec and its tickets. Use for /create-pr or shipping a reviewed chain run."
disable-model-invocation: true
license: MIT
metadata:
  model: opencode-go/muse-spark-1.3-contributor
  thinking: xhigh
---

# create-pr

Ship verified work: push the integration branch and open — or finish — a ready
PR against `main` that closes the spec and its tickets.

**Model pin**: `opencode-go/muse-spark-1.3-contributor`, `--thinking xhigh`
(the provider's cap). It runs as a background pi terminal session from the
shared worktree, launched by `code-review-loop` after a clean review.

## Process

1. Read the handoff doc and its pointers: the spec issue, the tickets, the
   integration branch, the review report. Confirm the review is clean and
   that every ticket is either closed or covered by the PR's closing links.

2. Push the branch: `git push -u origin <branch>`. Never force-push.

3. Call the Skill tool for `pr`. Write the body to a file and pass it with
   `--body-file`. Use the vocabulary in `GLOSSARY.md`. Evidence is the review
   report's clean result plus the test runs from the implementation; Merge
   Danger states whether the merge is a one-way or two-way door.

4. Finish the PR:

   - If a draft PR exists for the branch (implement-spec opens one after the
     first merge), mark it ready: `gh pr ready <number>`.
   - Otherwise create a ready PR against `main`:
     `gh pr create --base main --head <branch> --title <title> --body-file <path>`.
     Never open a draft.

5. Close the spec and its tickets through the body's closing keywords — one
   `Closes #<n>` line per issue, the spec and every ticket — or set the same
   links with `gh pr edit`. Verify with
   `gh pr view --json closingIssuesReferences`.

6. Report the PR URL, the branch and the closing links. The chain ends here.

## Handoff

This is the terminal stage, so there is no next stage: no `handoff` doc, no
next session. The ready PR is the durable artifact, the review report is its
evidence, and the maintainer takes it from there.
