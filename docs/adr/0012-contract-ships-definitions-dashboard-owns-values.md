# 0012 — The contract ships the definition and the dashboard owns the values

**Status**: Accepted

**Context**: The dashboard's settings surface needs two kinds of data. One is the definition of the chain: which variables exist, which providers, agents and efforts are legal, what a bare environment resolves to. The other is the values an operator chooses: which provider and model each stage runs, which provider keys are set. A hand copy of definition data across repos already drifted once, when `OPENCODE_GO_API_KEY` lived in prose while the harnesses read `OPENCODE_API_KEY`. The code review of PR #188 found the spec's promised cross-repo drift check unwired, which forced the question of which repo owns which check.

**Decision**: The two kinds have different owners because they have different natures. skillbook owns the definition, which is methodology and flow: variable names, legal value lists, stage and agent sets, defaults, and emission rules. The definition ships as the generated `contracts/dev-env.contract.json`, and nothing else travels from skillbook to the dashboard. The dashboard owns the values, which are interface and operation. They live as a collection of rows in the dashboard's database and are edited from its UI. The dashboard reads the definition from the published artifact directly. It keeps no vendored copy of the definition, so no cross-repo drift check exists to maintain. Markdown never defines a variable: a doc may name one only to point at the code that owns it.

**Consequences**: A provider added or removed in skillbook reaches the dashboard through the definition it reads, with no pin bump and no alarm. The dashboard must decide when it fetches the definition, at build or at runtime, and what to show when skillbook is unreachable. skillbook's CI runs the documented gate, so a hand edit of the artifact fails before merge. The defaults stay in the contract because they define bare-environment behavior. Operator choices never appear in skillbook's files.

## Considered Options

A vendored copy of the artifact in the dashboard plus a CI check that fails when the copy and skillbook disagree (the spec's original mechanism: a copy and an alarm. The maintainer retired the copy because definition and values live in code, not in copies that age). A pinned git or npm dependency on skillbook (rejected in the dashboard's research doc: it adds network and an external package to the build). Values kept in skillbook's plain text and exported as variables (rejected: configuration is interface and operation, not methodology and flow).
