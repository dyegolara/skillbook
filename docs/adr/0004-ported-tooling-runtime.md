# 0004 — Ported tooling runtime

Ported pstack tooling keeps upstream TypeScript and its `bun:test` suite, but
runs on Node >= 22.18.0, which executes `.ts` directly via native type stripping
— no build step, no Bun at runtime. Bun is a devDependency used only to run the
upstream tests unchanged. ADR-0002 (plain `.mjs`) keeps governing scripts
authored in this repo; the bootstrap installs dependencies with npm.

## Considered Options

- **Port the tooling to `.mjs`**: rejected — a mechanical rewrite of roughly
  6.8k lines that would put the port out of sync with upstream.
- **Bun as a runtime dependency (upstream as-is)**: rejected — a second runtime
  for the whole book with no functional gain.
- **Node with type stripping, Bun dev-only (chosen)**: one runtime everywhere,
  upstream tests untouched.

## Consequences

- Tooling `.ts` files use `.ts` import specifiers and `import type`; tsconfig
  moves to `verbatimModuleSyntax` + `erasableSyntaxOnly`.
- Node >= 22.18.0 is a documented requirement for tooling-backed skills.
