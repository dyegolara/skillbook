# The `DEV_ENV_*` contract ships as generated JSON

The dashboard consumes this repo's chain pins — providers, efforts, agents,
defaults, provider key variables — to validate what a settings surface may
save. It cannot import this repo's ESM at runtime: the two run in separate
containers and separate repos. Copying the literal lists by hand is what
produced the `OPENCODE_GO_API_KEY` drift, where a variable name existed in two
places and only one of them was real. We therefore **generate** the contract
from `env-defaults.mjs` — `scripts/emit-dev-env-contract.mjs` writes
`contracts/dev-env.contract.json` — and pin that file where it is consumed,
with a CI check that fails when the pinned copy and this repo disagree.

## Considered Options

Consumers importing `env-defaults.mjs` directly (impossible across repo
boundaries); each consumer keeping its own copy of the lists (silent drift,
already burned us); reading the contract at runtime from a dev-server's
installed skillbook (couples a UI to whatever version each dev-server happens
to carry).

## Consequences

Adding or removing a provider, agent or effort level is a change here that
lands in consumers through a reviewed pin bump, never through a guess. The
generated file carries the source commit so a consumer can say which contract
it validated against.
