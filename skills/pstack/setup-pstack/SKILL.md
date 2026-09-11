---
name: "setup-pstack"
description: "Configure which models pstack uses per role. Detects your available models and writes an always-applied rule that overrides the skill defaults. Use for \"configure pstack models\" or changing pstack's model choices."
license: MIT
metadata:
  upstream: "https://github.com/cursor/plugins/tree/main/pstack"
  upstream-commit: "f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d"
  upstream-path: "pstack/skills/setup-pstack/SKILL.md"
---

# Setup pstack

Write `~/.agents/rules/pstack-models.md`, an always-applied rule that sets pstack's model per role. The legacy `~/.cursor/rules/pstack-models.mdc` path still works as a fallback.

## Steps

### 1. Detect available models

Enumerate the model identifiers your harness lets you pass to a subagent; if your harness offers no model choice, skip the rule and roles fall back to the parent model. That enumeration is the dependable source, and if your harness also exposes a models API or CLI that lists the user's entitled models, prefer it for completeness. If you cannot detect any, ask the user to paste the identifiers they have access to. Never write a real identifier you have not confirmed is available. The aliases `inherit-parent` and `auto` are always valid even though they are not detected identifiers.

### 2. Load current state

The default role-to-model mapping is the rule shape shown in step 5 below. If `~/.agents/rules/pstack-models.md` already exists, read it and treat its values as the current choices; when that portable path is absent, read the legacy `~/.cursor/rules/pstack-models.mdc` as a fallback. Otherwise start from those defaults.

### 3. Map and confirm

Show every role with its current model, marking any real slug not in the detected set as needing a choice. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat model, which is how Auto users stay on Auto) as the options. Prefer your harness's structured question tool over free text, if it has one (for example AskQuestion); otherwise ask in plain text. For panel roles (arena runners, architect runners, interrogate reviewers, multi-phase lanes) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real slug written must be in the detected set. `inherit-parent` and `auto` always pass. If a chosen real slug is not available, stop and ask again.

### 5. Write the rule

Write `~/.agents/rules/pstack-models.md` with `alwaysApply: true` and one line per role, using the same labels poteto-mode uses. Overwrite the whole file so re-runs stay idempotent. On older Cursor setups the legacy `~/.cursor/rules/pstack-models.mdc` path works as a fallback. Shape:

```
---
description: pstack per-role model choices (overrides skill defaults)
alwaysApply: true
---
# pstack model configuration. One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit the subagent's model). Alias entries in a panel list still count toward its fan-out.
feature, refactoring: inherit-parent
bug-fix: inherit-parent
perf-issue: inherit-parent
hillclimb: inherit-parent
judgment and prose: inherit-parent
hardest tasks: inherit-parent
how explorer: inherit-parent
how explainer: inherit-parent
why investigators: inherit-parent
why synthesizer: inherit-parent
reflect tooling: inherit-parent
reflect judgment, divergent, synthesizer: inherit-parent
arena runners: inherit-parent, inherit-parent, inherit-parent, inherit-parent
arena cross-judge pool: inherit-parent, inherit-parent, inherit-parent, inherit-parent
swarm workers: inherit-parent
architect runners: inherit-parent, inherit-parent, inherit-parent, inherit-parent
interrogate reviewers: inherit-parent, inherit-parent, inherit-parent, inherit-parent
multi-phase lanes: inherit-parent
```

### 6. Confirm

Tell the user the rule was written and that it applies to new sessions. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with the create-verification-skill skill." On yes, invoke the **create-verification-skill** skill (resolves wherever pstack is installed: workspace, user, or plugin). On no, move on without pushing.
