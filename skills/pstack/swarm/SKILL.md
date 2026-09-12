---
name: "swarm"
description: "Fan out N parallel workers, drain them, and return one report. Use for \"swarm this\", or parallel coverage, races, gauntlets, and exploration."
license: MIT
metadata:
  upstream: "https://github.com/cursor/plugins/tree/main/pstack"
  upstream-commit: "f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d"
  upstream-path: "pstack/skills/swarm/SKILL.md"
  client-only:
    disable-model-invocation: true
---

# Swarm

Fan out N parallel workers, preferring a cloud/background run when your harness offers one; otherwise run them locally. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers, not the harness's concurrency limit.
4. Pick the worker model from `swarm workers` in `~/.agents/rules/pstack-models.md` when present, with the legacy `~/.cursor/rules/pstack-models.mdc` path as a fallback. Otherwise use your harness's default model. For a model race, name each arm's model up front.
5. Give each worker its own writable output when it writes.

## Phase B: Fan out

Spawn all N workers in one message with your harness's task mechanism if it has one; otherwise run them inline one at a time, each on the configured model. Prefer a cloud/background run when your harness offers one; otherwise run locally. Use a local run only when the worker needs access to something on the user's computer.

When a worker must start from a non-default pushed branch, pass your harness's cloud base-branch option if it has one; otherwise check out the branch before the worker starts.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
