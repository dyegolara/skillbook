# Skillbook

[![skills.sh](https://skills.sh/b/dyegolara/skillbook)](https://skills.sh/dyegolara/skillbook)

> **Note:** This repository contains agent skills in the standard [Agent Skills](https://agentskills.io) format — a folder per skill with a `SKILL.md` of instructions, scripts and resources an agent loads dynamically for specialized tasks. Skills are self-contained, composable, and model-agnostic. Hack around with them, make them your own.

## What's inside

| Skill | Source | Category | What it does |
|---|---|---|---|
| `copilot-review-smart` | **in-repo** (`./skills/engineering/copilot-review-smart`) | engineering | Smart Copilot PR-review watchdog: reads review state + full comment transcript, checks merge conflicts first, and lets an LLM decide (rebase / review / fix / notify / wait) instead of pinging `@copilot code review` on a loop. Multi-repo. |
| `lnurl-auth` | [dyegolara/lnurl-auth-agents](https://github.com/dyegolara/lnurl-auth-agents) (npm `lnurl-auth`) | auth | LNURL-auth (LUD-04) signer — Sign in with Lightning for LLM agents. No wallet, no node, no payment. |
| `nostr-auth` | [dyegolara/nostr-auth-agents](https://github.com/dyegolara/nostr-auth-agents) | auth | Nostr sign-in (NIP-07) for LLM coding agents — no wallet, no extension, auth-only. |

The two auth skills are **references only** — they keep their own repos, their own npm packages and their own skills.sh presence. This book points at them, never copies them.

## Installation

Two ways in, two philosophies: the **Claude Code plugin** installs the whole set (own + referenced) as managed bundles; **[skills.sh](https://skills.sh)** copies editable skill files into your project so you can hack on them.

### 1. Get the skills

<details>
<summary><strong>Claude Code (plugin)</strong></summary>

Add this repo as a marketplace, then install what you need:

```bash
/plugin marketplace add dyegolara/skillbook
```

Then install each plugin from the marketplace:

```bash
/plugin install skillbook-skills@skillbook          # own skills
/plugin install lnurl-auth@skillbook                # reference -> dyegolara/lnurl-auth-agents
/plugin install nostr-auth@skillbook                # reference -> dyegolara/nostr-auth-agents
```

The referenced plugins resolve from their own repositories (Claude Code fetches
them by `source` URL), so updates ship from the original repos, not from here.

</details>

<details>
<summary><strong>skills.sh (editable copy)</strong></summary>

```bash
npx skills@latest add dyegolara/skillbook
npx skills add dyegolara/lnurl-auth-agents --skill lnurl-auth
npx skills add dyegolara/nostr-auth-agents --skill nostr-auth
```

</details>

<details>
<summary><strong>npm (package.json, by reference)</strong></summary>

This repo's own `package.json` declares the published auth skills as dependencies
(`lnurl-auth` from the npm registry, `nostr-auth` from its GitHub repo), so a
single `npm install` pulls them — without vendoring any files:

```bash
npm install          # fetches lnurl-auth + nostr-auth packages (SKILL.md included)
npm run verify       # checks every reference resolves (npm + GitHub)
```

</details>

### 2. Use it

Own skills trigger naturally from their descriptions; for the full watchdog
setup (cron, script, state) read `skills/engineering/copilot-review-smart/SKILL.md`.
The auth skills document their own MCP server + CLI usage in their repos.

## Contributing

Add a skill as a folder under `skills/<category>/<skill>/` with a `SKILL.md`,
then register it in `.claude-plugin/plugin.json` and the table above. External
skills join by adding a reference (npm dependency or marketplace plugin) — never
a copy.

## License

MIT — see [LICENSE](./LICENSE).

---

_From Dojo Mojo Casa House, with mojo._