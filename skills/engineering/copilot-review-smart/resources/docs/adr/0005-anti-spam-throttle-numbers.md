# 0005 — Anti-spam throttle numbers

The watchdog uses fixed throttle numbers as defensive policy, not runtime
configuration. In this skill, configurability would increase error surface and
make anti-spam behavior drift across installs.

## Decision

Keep these constants hard-coded:

| Constant | Value | Origin |
|---|---:|---|
| `PING_MIN_INTERVAL_HOURS` | 12h | Prevent same-sha ping loops for review/fix requests. |
| `REBASE_PING_MIN_INTERVAL_HOURS` | 6h | Keep conflict-resolution retries aligned with the 6h rebase retry window. |
| `COOLDOWN_AFTER_REVIEW_HOURS` | 6h | Give Copilot time to post follow-up before re-pinging. |
| `REBASE_RETRY_HOURS` | 6h | Deadlock incident with frozen conflicted PRs; shorten escalation path while active-work guard prevents in-flight spam. |
| `REBASE_MAX_PINGS` | 3 | Bounded retries before owner escalation on a head sha. |
| `REBASE_STALE_RETRY_HOURS` | 168h | Weekly retry after escalation so truly stuck PRs are revisited without daily noise. |
| `ACTIVE_WORK_QUIET_HOURS` | 3h | Incident (`bitsimp#262`): pings derailed active agent work; hold pings for recent commits. |
| Transcript pagination window | 40+40 items | Incident where default 30-item pages hid newest comments and broke duplicate detection. |

## Consequences

- The policy is stable and predictable across deployments.
- The 6h rebase retry is safe only together with active-work suppression; this
  coupling is intentional and must be preserved.
- Any future change to these values requires an ADR update, not ad-hoc env
  tuning.
