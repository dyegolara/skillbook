# Dojo Mojo Skillbook

[![skills.sh](https://skills.sh/b/dyegolara/skillbook)](https://skills.sh/dyegolara/skillbook)

> **Note:** This repository contains agent skills in the standard [Agent Skills](https://agentskills.io) format — a folder per skill with a `SKILL.md` of instructions, scripts and resources an agent loads dynamically for specialized tasks. Skills are self-contained, composable, and model-agnostic.

## Agent skills

### Issue tracker

Issues are tracked on GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

N/A — triage skill not installed in this repo.

### Domain docs

Single-context layout. See `docs/agents/domain.md` and `docs/adr/`.

### Own skills

| Skill | Category | What it does |
|---|---|---|
| `copilot-review-smart` | engineering | Smart Copilot PR-review watchdog: reads review state + full comment transcript, checks merge conflicts first, and lets an LLM decide (rebase / review / fix / notify / wait) instead of pinging `@copilot code review` on a loop. Multi-repo. |

### Ported skills

pstack is copied in under `skills/pstack/` and adapted to be harness-agnostic;
this repo is its canonical source. The port, its provenance, and its runtime
rules are described in `skills/pstack/README.md`, `docs/adr/0003`, and
`docs/adr/0004`. `poteto-mode` is the entry point; it routes to its 23 nested
playbooks and the standalone skills (23 principles plus 23 standalone skills,
47 skills in all).

### Referenced skills (npm deps)

| Skill | Source | Category | What it does |
|---|---|---|---|
| `lnurl-auth` | `dyegolara/lnurl-auth-agents` (npm) | auth | LNURL-auth (LUD-04) signer — Sign in with Lightning for LLM agents. |
| `nostr-auth` | `dyegolara/nostr-auth-agents` (npm) | auth | Nostr sign-in (NIP-07) for LLM coding agents — no wallet, no extension. |

## Commands

| Command | What it checks |
|---|---|
| `npm run verify` | All of the below, in order. |
| `npm run verify:publishing` | Every referenced skill resolves on its published channel (network). |
| `npm run verify:upstream` | Upstream drift against the pstack pin (network). Fails on drift; `npm run verify` runs it with `--report-only` so upstream movement is reported but does not break the health check. |
| `npm run verify:pstack` | The pstack pack contract: frontmatter, cross-references, plugin registration, provenance, no required client couplings, Node smoke of the tooling. Offline except the tooling smoke, which may install tooling dependencies on first run (`npm run verify:pstack -- --skip-smoke` skips it). |
| `npm test` | All suites: this repo's scripts and skills, then the ported tooling suite. |
| `npm run test:pstack` | The ported tooling's upstream `bun:test` suite (Bun is a dev dependency). |
| `npm run typecheck:pstack` | TypeScript over the ported tooling (`verbatimModuleSyntax`, `erasableSyntaxOnly`). |

## Conventions

- Authored scripts inside skill folders are plain ESM JavaScript (`.mjs`), run
  directly by Node (ADR-0002). Ported tooling keeps its upstream TypeScript and
  runs on Node >= 22.18 via type stripping (ADR-0004).
- Do not commit `node_modules/`; the ported tooling installs its own
  dependencies on first use.
- When porting or adapting skills, keep upstream names and record provenance in
  `skills/pstack/_upstream/upstream-manifest.json`.
