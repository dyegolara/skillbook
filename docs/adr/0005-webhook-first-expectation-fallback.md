# 0005 — Webhook-first loop with Expectation fallback

**Status**: Accepted

**Context**: The Copilot-review watchdog was cron-only: it polled GitHub on a
cadence, so every step (ask review, ask fix, resolve conflicts) waited up to a
full tick to be noticed. The skill needed a way to react to Copilot's actions
in seconds without reintroducing the ping loops the anti-spam gates exist to
prevent — and without making the loop depend on any specific platform's
webhook or serverless offering.

**Decision**:

- A Delivery is a trigger, never a decision: no event→action mapping. The
  deterministic gates, transcript reading, LLM decision and throttles are the
  same pipeline as the cron tick.
- The Listener is transport only: HMAC-SHA256 verification over the raw body,
  watched-repo filter, Echo filter by sender login, per-PR debounce, one tick
  at a time; it spawns `pr_monitor.mjs --pr owner/repo#123 --json-report` and
  reads the report.
- Fallback is by Expectation, not by polling: the tick emits `next_check_at`
  per PR; the Listener arms it and fires a Fallback tick if no Delivery
  arrives first. No expectations → loop asleep (zero GitHub/LLM calls). The
  complete `next_check_at` derivation policy is the table in the skill's
  `SKILL.md` ("`next_check_at` derivation policy").
- Lifecycle: the Listener is ephemeral — it exits when no open PR is left to
  watch (`--keep-alive` for supervised always-on Hosts); the Hook is permanent
  per repo and bound by hook id, so a changing public URL updates the existing
  hook instead of duplicating it.
- The public endpoint is external to the skill: `PR_MONITOR_PUBLIC_URL` is the
  contract, with recipes for Tailscale Funnel, ngrok, cloudflared and reverse
  proxies. The deployment files are platform-agnostic; the agent picks where
  to run them for its Host.
- Deliveries missed while no Listener was up are recovered by the Startup tick.
  GitHub does not retry failed deliveries.

Rejected options:

- **Event → action mapping**: duplicates the anti-spam policy and reintroduces
  the ping loops the gates exist to prevent.
- **Global periodic sweep as fallback** (fixed interval or global idle timer):
  brings polling back; expectations are targeted to the flows that actually
  wait for something.
- **Platform-native handler per platform**: fragments the skill into N
  platform adapters; the Host abstraction plus one Listener keeps it portable.
- **GitHub Actions as the listener**: needs no public endpoint, but the
  state/lock model would have to be externalized and a workflow installed in
  every watched repo.
- **Vercel as public relay**: documented as an alternative for Hosts without a
  public URL, not implemented; it adds a hop where a Delivery can be lost.

**Consequences**:

- Steps advance seconds after Copilot acts instead of up to a cadence later.
- Idle cost is one open local socket: no API calls, no LLM, no timers.
- Residual risk, accepted: a failed Delivery on a quiescent Flow (no
  Expectation) is only recovered by the next Delivery or a new invocation.
- The Tick contract changes only additively (`next_check_at`, structured owner
  notifications in the JSON report); cron mode and its recipe are unchanged.
- The ADR lives in the repo's `docs/adr/` (this file), not inside the skill;
  the skill's `SKILL.md` links here for the design record.
