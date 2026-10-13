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
import { pathToFileURL } from "node:url";
import {
  isConnectionError,
  parseIdFlags,
  reachApi,
  requestJson,
  stageLabel,
} from "./launch-stage.mjs";

/** @typedef {import("./launch-stage.mjs").TaskIds} TaskIds */

// Pins per ADR-0006 and grill-with-spec/SKILL.md frontmatter: the grill model
// at its highest available effort.
export const GRILL_PIN = { model: "opencode-go/glm-5.3", effort: "max" };

/**
 * The reachable-API path: create the opencode session on the task, rename it,
 * pin model and effort, then send the re-entry prompt verbatim. A
 * connection-level failure on the create call leaves no session id and may
 * still fall back to the pause; every failure after the session exists
 * carries its id and is a hard error.
 *
 * @param {{ spec: number|string, prompt: string, ids: TaskIds, worktreePath: string, apiBase: string, fetchImpl?: typeof fetch }} options
 */
export async function createGrillSession({ spec, prompt, ids, worktreePath, apiBase, fetchImpl = fetch }) {
  const label = stageLabel(spec, "grill-with-spec");
  const created = await requestJson(fetchImpl, `${apiBase}/agent/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adapterId: "opencode", worktreePath, ...ids }),
  });
  const sessionId = created?.sessionId;
  if (!sessionId) throw new Error("Kepler agent session start returned no sessionId");

  try {
    await requestJson(fetchImpl, `${apiBase}/agent/rename-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, name: label }),
    });
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
    await requestJson(fetchImpl, `${apiBase}/agent/send-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, prompt }),
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    error.sessionId = sessionId;
    throw error;
  }

  return { sessionId, label };
}

export async function openGrillSession({ spec, prompt, flags, deps = {} }) {
  const { fetchImpl = fetch, worktreePath = process.cwd() } = deps;
  const label = stageLabel(spec, "grill-with-spec"); // a bad spec is a hard error before any fetch
  const fallback = (error) => ({ path: "pause", label, reason: error.message });

  const reached = await reachApi({ apiBase: deps.apiBase, dataDir: deps.dataDir, fetchImpl, worktreePath, flags });
  if (!reached.ok) return fallback(reached.error);
  const { apiBase, ids } = reached;

  let created;
  try {
    created = await createGrillSession({ spec, prompt, ids, worktreePath, apiBase, fetchImpl });
  } catch (error) {
    // Never fall back once a session exists; failures after creation carry its id.
    if (isConnectionError(error) && !error.sessionId) return fallback(error);
    throw error;
  }

  return { path: "api", ...created };
}

/** The manual re-entry route: the pause plus the re-entry prompt, verbatim. */
export function buildPauseLines({ label, prompt, reason }) {
  return [
    `open-grill-session: ${reason} — grill session not opened`,
    `open-grill-session: ${label} paused. Re-enter with /grill-with-spec and this re-entry prompt:`,
    prompt,
  ];
}

/** Hard-error report: the error, plus the created session's id when there is one. */
export function failureLines(error) {
  const lines = [`open-grill-session: ${error.message}`];
  if (error.sessionId) {
    lines.push(`open-grill-session: session ${error.sessionId} was already created — terminate it or reuse it`);
  }
  return lines;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const [spec, prompt] = argv;
  if (spec === undefined || prompt === undefined) {
    throw new Error(
      "usage: open-grill-session.mjs <spec> '<re-entry prompt>' [--repo-id <id> --worktree-id <id> --task-id <id>]"
    );
  }
  const flags = parseIdFlags(argv.slice(2));
  const write = deps.write ?? ((line) => process.stdout.write(`${line}\n`));
  const result = await openGrillSession({ spec, prompt, flags, deps });
  if (result.path === "api") {
    write(`open-grill-session: opened ${result.label} as Kepler session ${result.sessionId}`);
  } else {
    for (const line of buildPauseLines({ label: result.label, prompt, reason: result.reason })) {
      write(line);
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    for (const line of failureLines(error)) console.error(line);
    process.exitCode = 1;
  });
}
