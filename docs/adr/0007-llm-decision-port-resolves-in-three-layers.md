# 0007 — The LLM decision port resolves in three layers

**Status**: Accepted

**Context**: The final intent choice of a Tick belongs to an LLM behind
deterministic gates (`skills/engineering/copilot-review-smart/resources/docs/adr/0003`).
Until now the only way to reach one was `OPENROUTER_API_KEY` plus
`PR_MONITOR_MODEL`, hardwired to `https://openrouter.ai/api/v1/chat/completions`.
That breaks in two real situations. An agent session that invokes the skill has
its own model and provider but never exports credentials into the shell, so
every Tick dies on `no OPENROUTER_API_KEY`, burns the three-attempt-per-head
budget and escalates to Needs-human over a configuration problem rather than
over the PR. And a Claude Code environment authenticated by a Teams seat has no
API key option at all, so the hardwired OpenRouter call can never work there.

**Decision**:

- `llmDecider` stays the port. A resolution chain picks the adapter:
  1. **Explicit — defined via prompt or via config, and it always wins.**
     Either `PR_MONITOR_LLM_CMD` (a command: the decision request on stdin, a
     JSON decision on stdout — the universal adapter, which fits `pi --print`,
     `claude -p`, `opencode run` or a curl bridge alike) or
     `PR_MONITOR_MODEL` + `OPENROUTER_API_KEY` (today's direct HTTP call,
     generalized to a configurable provider). Either may come from
     `~/.pr-monitor.env` or from the invoking agent's own environment.
  2. **Auto — current agent, current provider.** When nothing is defined,
     discover the agent the process runs under (agent markers in the
     environment, binaries on `PATH`, and the session's model where the host
     exposes it) and synthesize the registered adapter's command for it.
  3. **None — a handled case.** `wait` with an actionable `reason` naming the
     setup path. No Needs-human notification.
- The skill never reads or prints another tool's credentials; each adapter
  resolves its own.
- Absence of a key is not an LLM failure: it does not consume the
  three-attempt-per-head budget and never escalates to Needs-human.

## Rejected options

- **Read the agent's `auth.json` and call its provider directly**: rejected —
  it makes the skill a reader of other tools' secret stores, and it cannot work
  where no key exists (Claude via Teams).
- **Delegate the decision to a fresh agent session**: rejected as the packaged
  path — it is a full session round trip inside a Tick that has a five-minute
  ceiling, it re-reads the whole transcript that the signature cache exists to
  avoid re-reading, and it has nobody to delegate to under a `no_agent` cron.
  The seam stays injectable so an operator can wire one.

## Consequences

- The existing deployment is unchanged: layer 1's second branch is exactly what
  it runs today.
- A Tick launched from an agent session decides with that session's model and
  provider, with nothing exported by hand.
- Environments without an API key work through their own agent CLI.
- The `decide` Stage reports which adapter ran, so a decision can be traced.
- Cost to accept: the skill now depends on an external command in the auto
  path. It already depends on `gh`, so the portability bar is "Node, a shell
  and the agent's own CLI", not "Node alone".
