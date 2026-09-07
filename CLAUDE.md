# Dojo Mojo Skillbook

[![skills.sh](https://skills.sh/b/dyegolara/skillbook)](https://skills.sh/dyegolara/skillbook)

> **Note:** This repository contains agent skills in the standard [Agent Skills](https://agentskills.io) format — a folder per skill with a `SKILL.md` of instructions, scripts and resources an agent loads dynamically for specialized tasks. Skills are self-contained, composable, and model-agnostic.

## Agent skills

### Issue tracker

Issues are tracked on GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

N/A — triage skill not installed in this repo.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.

### Own skills

| Skill | Category | What it does |
|---|---|---|
| `copilot-review-smart` | engineering | Smart Copilot PR-review watchdog: reads review state + full comment transcript, checks merge conflicts first, and lets an LLM decide (rebase / review / fix / notify / wait) instead of pinging `@copilot code review` on a loop. Multi-repo. |

### Referenced skills (npm deps)

| Skill | Source | Category | What it does |
|---|---|---|---|
| `lnurl-auth` | `dyegolara/lnurl-auth-agents` (npm) | auth | LNURL-auth (LUD-04) signer — Sign in with Lightning for LLM agents. |
| `nostr-auth` | `dyegolara/nostr-auth-agents` (npm) | auth | Nostr sign-in (NIP-07) for LLM coding agents — no wallet, no extension. |