# Provenance

Ported from **pstack** in [`cursor/plugins`](https://github.com/cursor/plugins) at commit
[`f5bdd68`](https://github.com/cursor/plugins/commit/f5bdd6826fd0a0d9cbc4347134c3a74a200b9d9d) (pstack v0.15.1, captured
2026-09-11). License: MIT, © 2026 Lauren Tan. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## What was ported

- All 47 skills: the 23 `principle-*` skills, `poteto-mode` with its 23
  nested playbooks, and the 23 standalone skills.
- The `poteto-agent` and `comment-sicko` agent definitions, shipped as
  optional, non-skill files under `skills/pstack/agents/`.
- The pstack tooling under `poteto-mode/scripts/` (watch-pr, orch, the plan
  validator, the worktree audit, the decision-log helper, and the bootstrap).

## What was not ported

- `automations/benny`: its runtime is Cursor Automations with no portable
  equivalent. Excluded deliberately, not by oversight.
- `docs/guide/` and `assets/`: upstream documentation and logos, not part of
  the skill pack contract.
- The `.cursor-plugin/plugin.json`: this book's plugin manifest replaces it.

## Structural changes

- Frontmatter is normalized to the standard Agent Skills fields (`name`,
  `description`, `license`) plus `metadata`; client-only fields move under
  `metadata.client-only`.
- Cursor-only couplings (model slugs, named subagents, cloud defaults,
  `.cursor` paths, built-ins) are rewritten as optional capabilities with
  explicit fallbacks; see `docs/adr/0003` and `docs/adr/0004`.
- The tooling package scope is renamed and runs on Node >= 22.18.0 via native
  type stripping; Bun is a dev-only dependency for the upstream test suite.
- Every adapted file maps to its upstream blob in `upstream-manifest.json`;
  `verify-upstream.mjs` reports drift against the pin.
