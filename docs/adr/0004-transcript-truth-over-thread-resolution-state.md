# 0004 — Transcript truth over thread-resolution state

The watchdog must decide from observable truth in REST payloads plus full
transcript text. GitHub REST does not provide review-thread resolution on
`pulls/{n}/comments`, so a "resolved" boolean cannot be trusted there.

## Decision

- Treat every top-level Copilot inline comment as potentially unaddressed.
- Use the full paginated transcript (issue + inline comments, any author) as
  the source of truth for what remains.
- Keep quote-line stripping for Copilot ack detection: quoted requests in
  Copilot replies must not count as fresh requests or progress.

## Context and alternatives

- The earlier Python monitor (v2.0.0 lineage) checked a non-existent `resolved`
  field in REST comments, which behaved like an always-true bug.
- GraphQL thread-resolution state was considered and rejected for this skill's
  current shape: the decision already depends on transcript semantics, and a
  "resolved" thread can still contain actionable feedback in context.

## Consequences

- The transcript reader is non-negotiable and must remain paginated.
- The ack heuristic is intentionally explicit and documented as fragile but
  necessary until an API exposes a definitive ack signal.
