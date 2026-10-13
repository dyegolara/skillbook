/**
 * decision_source.mjs — the canonical vocabulary of the Tick report's
 * `decision_source` field (ADR-0007, spec #105, ticket #106).
 *
 * The report records which adapter made a decision, and the same value is
 * persisted into the per-PR Tick history the observability projection reads.
 * One module owns the strings so the resolver, the projection, the docs and
 * the fixtures cannot drift into two spellings of the same adapter.
 *
 * Layer 1 (explicit) resolves to `decision_command` or `model_credential`;
 * layer 2 (auto) names a discovered agent through `autoDecisionSource()`;
 * layer 3 (none) is the handled configuration gap, not an adapter that ran.
 * Plain ESM, zero dependencies (ADR-0008).
 */

export const DECISION_SOURCES = Object.freeze({
  decisionCommand: "decision_command",
  modelCredential: "model_credential",
  none: "none",
});

/** The auto layer's adapter name: `auto:<agent>` plus, when the host exposes
 * one, the pinned session model as `auto:<agent>:<provider>/<model>`. */
export function autoDecisionSource(agentName, model = null) {
  return model ? `auto:${agentName}:${model}` : `auto:${agentName}`;
}

/** Layer 3's handled case: no decider resolved. It is a configuration gap,
 * not a decision an adapter made. */
export function isNoDecisionSource(value) {
  return value === DECISION_SOURCES.none;
}

/** The Tick's layer-3 reason: the operator's setup checklist. It names the
 * setup paths and never escalates. */
export const NO_DECISION_SOURCE_REASON =
  "No LLM decision source is configured: define the PR_MONITOR_LLM_CMD " +
  "environment variable as a command that reads the decision request on stdin " +
  "and writes a JSON decision on stdout, or define a chat-completions provider " +
  "with PR_MONITOR_LLM_API_KEY (default: OPENROUTER_API_KEY) and optionally " +
  "PR_MONITOR_LLM_ENDPOINT / PR_MONITOR_MODEL, in the invoking environment or in " +
  "~/.pr-monitor.env / ~/.hermes/.env. Waiting without escalating.";

/** The decide Stage's outcome when the last Tick hit layer 3: it says the
 * configuration is missing instead of reading as a completed decision. */
export const NO_DECISION_SOURCE_STAGE_OUTCOME =
  "no decision source configured — waiting for setup (PR_MONITOR_LLM_CMD or PR_MONITOR_LLM_API_KEY)";
