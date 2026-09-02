# Skillbook

[![skills.sh](https://skills.sh/b/dyegolara/skillbook)](https://skills.sh/dyegolara/skillbook)

> **Note:** This repository contains agent skills in the standard [Agent Skills](https://agentskills.io) format — a folder per skill with a `SKILL.md` of instructions, scripts and resources an agent loads dynamically for specialized tasks. Skills are self-contained, composable, and model-agnostic. Hack around with them, make them your own.

## What's inside

| Skill | Category | What it does |
|---|---|---|
| [`copilot-review-smart`](./skills/engineering/copilot-review-smart) | engineering | Smart Copilot PR-review watchdog: reads review state + full comment transcript, checks merge conflicts first, and lets an LLM decide (rebase / review / fix / notify / wait) instead of pinging `@copilot code review` on a loop. Multi-repo. |

More skills coming — this book grows one page at a time.

## Installation

Two ways in, two philosophies: the **Claude Code plugin** installs the whole set as a managed, read-only bundle that updates when new skills ship; **[skills.sh](https://skills.sh)** copies editable skill files into your project so you can hack on them.

### 1. Get the skills

<details>
<summary><strong>Claude Code (plugin)</strong></summary>

```bash
claude plugins install skillbook-skills
```

Or, from inside a session:

```
/plugin install skillbook-skills
```

</details>

<details>
<summary><strong>Codex, Claude Code, and other agents (editable copy)</strong></summary>

```bash
npx skills@latest add dyegolara/skillbook
```

Pick the skills you want and which agents to install them on.

</details>

<details>
<summary><strong>For tinkerers (manual)</strong></summary>

Copy a skill folder straight into your agent's skills directory, e.g.:

```bash
cp -r skills/engineering/copilot-review-smart ~/.hermes/skills/github/
```

</details>

### 2. Use it

The skill triggers naturally from its description — e.g. "stop spamming @copilot on that PR, it's already clean." For the full watchdog setup (cron, script, state), read the skill's `SKILL.md`.

## Contributing

Skills here are practical tools that run in production (see `copilot-review-smart` — it powers a live multi-repo cron). If a skill helped you or you found a missing step, open an issue or PR.

## License

MIT — see [LICENSE](./LICENSE).

---

_From Dojo Mojo Casa House, with mojo._