#!/usr/bin/env node
/**
 * open-grill-session.mjs — actuate the decision-forcing pause.
 *
 * Per ADR-0006 (amended 2026-10-10) the code-review-loop stage no longer
 * prints a pause and waits to be noticed: on a decision-forcing finding it
 * opens a fresh grilling session on the task through Kepler's loopback agent
 * API (the same server as the terminal API). The script creates an opencode
 * session on the current worktree, labels it `chain #<spec>:
 * grill-with-spec` with the spec number taken from the explicit argument
 * (never parsed from another label), pins the session's `model` and `effort`
 * config options to the grill pin recorded in grill-with-spec's frontmatter
 * and ADR-0006, and sends the re-entry prompt verbatim — so the session sits
 * `unread` on the maintainer's task. The spec number and the re-entry prompt
 * are explicit arguments; the repo/worktree/task ids reuse the launch
 * helper's id anchor (`GET /terminal/list`, preferring a chain-labeled
 * terminal) or its explicit `--repo-id/--worktree-id/--task-id` bootstrap
 * flags — one mechanism, no manual curl procedure.
 *
 * A connection-level failure to the agent API before a session exists is
 * reported with `error.message` preserved and the pause falls back to the
 * manual re-entry route: print the pause with the re-entry prompt and wait
 * for `/grill-with-spec`. Never degrade silently. Every non-connection
 * failure (HTTP error responses, malformed bodies) and every failure after
 * the session exists is a hard error; when a session was already created its
 * id is printed so nothing is lost silently.
 *
 * Plain ESM per ADR-0002, zero dependencies beyond Node.
 *
 * Usage:
 *   node skills/software-factory/scripts/open-grill-session.mjs <spec> '<re-entry prompt>'
 *     [--repo-id <id> --worktree-id <id> --task-id <id>]
 */
import {
  createLabeledSession,
  parseIdFlags,
  requestJson,
  runSessionCli,
  runSessionHelper,
  stageLabel,
} from "./launch-stage.mjs";

/** @typedef {import("./launch-stage.mjs").TaskIds} TaskIds */

// Pins per ADR-0006 and grill-with-spec/SKILL.md frontmatter: the grill model
// at its highest available effort.
export const GRILL_PIN = { model: "opencode-go/glm-5.3", effort: "max" };

/**
 * The grill's route-specific create step: the shared create orchestration
 * plus the grill's pre-send pin step — model and effort per `GRILL_PIN`. The
 * pin lives in the grill's own module (ADR-0006: the wake pins nothing). A
 * failure here carries the session's id and is a hard error.
 *
 * @param {{ label: string, prompt: string, ids: TaskIds, worktreePath: string, apiBase: string, fetchImpl?: typeof fetch }} options
 */
export async function createGrillSession({ label, prompt, ids, worktreePath, apiBase, fetchImpl = fetch }) {
  return createLabeledSession({
    label,
    prompt,
    ids,
    worktreePath,
    apiBase,
    fetchImpl,
    beforeSend: async (sessionId) => {
      for (const [configId, value] of [
        ["model", GRILL_PIN.model],
        ["effort", GRILL_PIN.effort],
      ]) {
        await requestJson(fetchImpl, `${apiBase}/agent/session-config-option`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, configId, value }),
        });
      }
    },
  });
}

/**
 * The grill's route shell: its label, prompt and pin step, handed to the
 * shared `runSessionHelper`, which owns the reach/create/fallback/emit shape
 * both session routes share.
 *
 * @param {{ spec: number|string, prompt: string, flags?: Object, deps?: Object }} options
 */
export async function openGrillSession({ spec, prompt, flags, deps = {} }) {
  return runSessionHelper({
    label: stageLabel(spec, "grill-with-spec"), // a bad spec is a hard error before any fetch
    prompt,
    flags,
    deps,
    fallbackPath: "pause",
    create: createGrillSession,
    successLine: (result) => `open-grill-session: opened ${result.label} as Kepler session ${result.sessionId}`,
    fallbackLines: (result) => buildPauseLines({ label: result.label, prompt, reason: result.reason }),
  });
}

/** The manual re-entry route: the pause plus the re-entry prompt, verbatim. */
export function buildPauseLines({ label, prompt, reason }) {
  return [
    `open-grill-session: ${reason} — grill session not opened`,
    `open-grill-session: ${label} paused. Re-enter with /grill-with-spec and this re-entry prompt:`,
    prompt,
  ];
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const [spec, prompt] = argv;
  if (spec === undefined || prompt === undefined) {
    throw new Error(
      "usage: open-grill-session.mjs <spec> '<re-entry prompt>' [--repo-id <id> --worktree-id <id> --task-id <id>]"
    );
  }
  return openGrillSession({ spec, prompt, flags: parseIdFlags(argv.slice(2)), deps });
}

runSessionCli({ toolName: "open-grill-session", moduleUrl: import.meta.url, main });
