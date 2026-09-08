# 0003 — LLM decision-maker behind deterministic gates

The watchdog keeps deterministic gates for facts GitHub can answer directly
(draft/WIP skip, merge-conflict dirty gate, unknown mergeability, throttles),
then delegates only the final intent choice (`request_review`, `request_fix`,
`notify_ready`, `wait`) to an LLM that reads the full transcript.

## Decision

- Keep deterministic gates first.
- Keep `request_rebase` deterministic at the dirty gate; the LLM never chooses
  it.
- Keep the transcript-aware final decision in an LLM prompt, because the
  nuanced "what was already asked/answered" signal lives in text, not stable
  fields.

## Rejected options

- **Heuristic: COMMENTED-not-APPROVED means not done**: rejected; Copilot often
  confirms clean PRs with `COMMENTED`, so this loop can spam forever.
- **Heuristic SHA pointers (`review_sha`/`fix_sha`)**: rejected; fragile state
  bookkeeping caused false negatives and blocked notify-ready.

## Consequences

- The LLM is the only expensive step; the signature cache short-circuits idle
  ticks.
- Deterministic policy remains testable without network through the extracted
  pure decision function.
