# 0010 — The `DEV_ENV_*` contract ships as generated JSON

**Status**: Accepted

**Context**: The dashboard consumes this repo's chain pins — providers, efforts, agents, defaults, provider key variables — to validate what a settings surface may save. It cannot import this repo's ESM at runtime: the two run in separate containers and separate repos. Copying the literal lists by hand is what produced the `OPENCODE_GO_API_KEY` drift, where a variable name existed in two places and only one of them was real.

**Decision**: `scripts/emit-dev-env-contract.mjs` generates `contracts/dev-env.contract.json` from `env-defaults.mjs`. The artifact records `source` as the repo, the path, the commit, and the SHA-256 of the `env-defaults.mjs` bytes it was generated from. `source.commit` is the last commit that touched `skills/software-factory/scripts/env-defaults.mjs`. That commit introduced the recorded bytes. It is not `HEAD` at generation time. `source.repo` is read from the `repository` field in `package.json`. The check verifies `source.commit` when that object is available. `source.sha256` remains the source reference after a squash merge, when the recorded commit object may be gone.

Amended 2026-11-12, ticket #190. This record supersedes the commitment to pin the artifact where it is consumed and to fail CI when a pinned copy disagrees with this repo. `docs/adr/0012-contract-ships-definitions-dashboard-owns-values.md` replaces that commitment.

**Consequences**: Regeneration on the same history rewrites nothing. A consumer can say which contract it validated against from the recorded `source`. The check verifies `source.commit` when the object is available. `source.sha256` is the reference that survives a squash merge. `source.repo` comes from `package.json`. A fork checkout passes the check. Emit fails when `env-defaults.mjs` has no commit. Emit fails when the `repository` field is missing or malformed. The pin-and-check commitment is retired. ADR-0012 replaces it.

## Considered Options

Consumers importing `env-defaults.mjs` directly (impossible across repo boundaries); each consumer keeping its own copy of the lists (silent drift, already burned us); reading the contract at runtime from a dev-server's installed skillbook (couples a UI to whatever version each dev-server happens to carry).
