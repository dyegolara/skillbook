# 0003 — Port pstack as ported skills

pstack (`cursor/plugins`, MIT © Lauren Tan) is a Cursor-native engineering
skill pack. We copy it into `skills/pstack/` and adapt it to the standard Agent
Skills format with capability fallbacks for Cursor-only features (model slugs,
named subagents, cloud agents, `.cursor` paths), instead of referencing the
Cursor plugin. Referencing keeps upstream verbatim but enforces Cursor; porting
makes this repo the canonical source and lets every skill install on any
harness. The port keeps upstream names and structure (23 principles as
individual skills, playbooks nested in `poteto-mode`), and records provenance
under `skills/pstack/_upstream/`. `automations/benny` is excluded: its runtime
is Cursor Automations and has no portable equivalent. This carves an exception
to the "never copied" rule for Referenced skills, which still applies to skills
with their own published channel.

## Considered Options

- **Reference the Cursor plugin**: rejected — it is not a published skill
  channel and would keep the Cursor couplings the port exists to remove.
- **Copy verbatim**: rejected — leaves Cursor-only requirements enforced.

## Consequences

- Upstream changes do not flow automatically; `verify:upstream` reports drift
  against the recorded pin for manual review.
- Fixes and adaptations to ported skills land here, not upstream.
