const FAILURE_PREFIXES = Object.freeze({
  inline: "Could not fetch inline review comments",
  issue: "Could not fetch issue comments",
});

export function prStateFetchFailureReason(kind, repo, num, error) {
  const prefix = FAILURE_PREFIXES[kind];
  if (!prefix) throw new Error(`unknown PR-state collection failure kind: ${kind}`);
  return `${prefix} for ${repo}#${num}: ${String(error).slice(0, 200)}`;
}

export function isPrStateFetchFailureReason(reason) {
  return /^(?:Could not fetch inline review comments|Could not fetch issue comments) for [^/\s#]+\/[^/\s#]+#\d+:/.test(
    String(reason || "")
  );
}
