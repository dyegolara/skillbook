# 0002 — Plain ESM JavaScript (.mjs) for skill scripts

This repo is a skillbook: Markdown-first, with small utility scripts shipped
inside skill folders so any agent can run them. All skill scripts are written
in plain ESM JavaScript (`.mjs`) executed directly with Node >= 18 — no
TypeScript, no transpilation, no build step. The criterion is agent
portability: a script next to a `SKILL.md` must run as-is in any agentic
environment, and agents universally have Node and a shell but no guaranteed
toolchain for compiling.

## Considered Options

- **TypeScript (compiled)**: rejected — adds a build step and a `dist`
  artifact that the "install skill, run script" contract would have to
  explain. (Note: most other repos in this org are TS; this repo is
  deliberately not, because here the code is a guest of the docs.)
- **Python**: rejected — the original `pr_monitor.py` was Python, but it
  required a Python runtime that not every agent environment guarantees,
  and it split the repo across two language toolchains for no benefit.
- **Plain `.mjs` (chosen)**: zero dependencies beyond Node itself; matches
  the existing `scripts/verify-publishing.mjs`.

## Consequences

- No type checking: scripts stay small, dependency-light, and are validated
  by `node --check` and `DRY_RUN=1` smoke tests instead.
- A script that grows beyond ~500 lines of real logic should be extracted
  into its own npm package (where TypeScript applies) rather than growing
  in place.
