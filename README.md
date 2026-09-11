# Skillbook

[![skills.sh](https://skills.sh/b/dyegolara/skillbook)](https://skills.sh/dyegolara/skillbook)

> **Note:** This repository contains agent skills in the standard [Agent Skills](https://agentskills.io) format — a folder per skill with a `SKILL.md` of instructions, scripts and resources an agent loads dynamically for specialized tasks. Skills are self-contained, composable, and model-agnostic. Hack around with them, make them your own.

## What's inside

| Skill | Source | Category | What it does |
|---|---|---|---|
| `copilot-review-smart` | **in-repo** (`./skills/engineering/copilot-review-smart`) | engineering | Smart Copilot PR-review watchdog: reads review state + full comment transcript, checks merge conflicts first, and lets an LLM decide (rebase / review / fix / notify / wait) instead of pinging `@copilot code review` on a loop. Multi-repo. |
| `pstack` pack | **ported** (`./skills/pstack`, from [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack), MIT) | pstack | 47 ported, harness-agnostic engineering skills: `poteto-mode` with 23 playbooks, 23 principles, and the standalone skills (`how`, `why`, `architect`, `arena`, `interrogate`, `swarm`, and more), plus the upstream tooling on Node. See [`skills/pstack/README.md`](./skills/pstack/README.md). |
| `lnurl-auth` | [dyegolara/lnurl-auth-agents](https://github.com/dyegolara/lnurl-auth-agents) (npm `lnurl-auth`) | auth | LNURL-auth (LUD-04) signer — Sign in with Lightning for LLM agents. No wallet, no node, no payment. |
| `nostr-auth` | [dyegolara/nostr-auth-agents](https://github.com/dyegolara/nostr-auth-agents) (npm `nostr-auth`, also on skills.sh + ClawHub) | auth | Nostr sign-in (NIP-07) for LLM coding agents — no wallet, no extension, auth-only. |

The two auth skills are **references only** — they keep their own repos, their
own npm packages and their own skills.sh/ClawHub presence. This book points at
their published channels (npm / skills.sh / ClawHub), never copies them.

The pstack pack is the opposite case: it has no published skill channel, so it
is **ported** (copied under its MIT license and adapted) and this repo becomes
its canonical source. Its upstream pin, the adaptations, and the drift check
live in [`skills/pstack/_upstream/`](./skills/pstack/_upstream/PROVENANCE.md).

## Installation

Two ways in, two philosophies: the **Claude Code plugin** installs this book's own skills as a managed bundle; **[skills.sh](https://skills.sh)** / **npm** install the referenced auth skills from their published channels (no repo cloning, no copies).

### 1. Get the skills

<details>
<summary><strong>Claude Code (plugin) — this book's skills (own + ported)</strong></summary>

Add this repo as a marketplace, then install the book's skills:

```bash
/plugin marketplace add dyegolara/skillbook
/plugin install skillbook-skills@skillbook
```

The referenced auth skills (`lnurl-auth`, `nostr-auth`) are NOT in this
marketplace on purpose — they install from their published channels below.

</details>

<details>
<summary><strong>skills.sh (editable copy) — own + ported + referenced</strong></summary>

```bash
npx skills@latest add dyegolara/skillbook                       # own + ported skills
npx skills@latest add dyegolara/lnurl-auth-agents --skill lnurl-auth
npx skills@latest add dyegolara/nostr-auth-agents --skill nostr-auth
```

Or, from this repo:

```bash
npm run skills:install    # runs the two `npx skills add` commands above
```

</details>

<details>
<summary><strong>npm (package.json, by reference)</strong></summary>

Both auth skills are published to the npm registry — this repo declares them as
dependencies — `npm install` pulls the packages (SKILL.md included) straight
from npm, no files vendored:

```bash
npm install          # fetches lnurl-auth + nostr-auth from the npm registry
npm run verify       # checks every reference resolves (npm / skills.sh / ClawHub)
```

</details>

### 2. Use it

Skills trigger naturally from their descriptions; for the full watchdog
setup (cron, script, state) read `skills/engineering/copilot-review-smart/SKILL.md`.
For the pstack pack, start with `setup-pstack` and then `poteto-mode`; the pack
map and its runtime requirements are in [`skills/pstack/README.md`](./skills/pstack/README.md).
The auth skills document their own MCP server + CLI usage in their repos.

## Contributing

Add a skill as a folder under `skills/<category>/<skill>/` with a `SKILL.md`,
then register it in `.claude-plugin/plugin.json` and the table above. External
skills join by adding a reference (npm dependency or marketplace plugin) — never
a copy. The pstack pack is a deliberate exception: it is ported under its MIT
license with provenance and a drift check in
[`skills/pstack/_upstream/`](./skills/pstack/_upstream/PROVENANCE.md).

## License

MIT — see [LICENSE](./LICENSE).

---

_From Dojo Mojo Casa House, with mojo._