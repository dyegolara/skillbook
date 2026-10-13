#!/usr/bin/env node
/**
 * open-wake-session.mjs — actuate the wake: the unread resume notice a
 * giving-up stage leaves on the task.
 *
 * Per ADR-0006 (amended 2026-10-12) a stage that fails to run or dies mid-run
 * does not stall the chain silently: its retry wrapper exhausts its attempts
 * and leaves a FAILED marker in the terminal buffer with the exact resume
 * command, then actuates a wake — an unread session on the task carrying that
 * resume command — the same no-waiting-on-notice principle as the pause path.
 * This helper is the wake half: it creates an opencode session on the current
 * worktree through Kepler's loopback agent API (the same server as the
 * terminal API), labels it `chain #<spec>: wake — <stage>` with the spec
 * number and stage taken from explicit arguments (never parsed from another
 * label), and sends the wake prompt carrying the stage, the spec and the
 * resume command verbatim. The session pins no model or effort: it is a
 * message on the task, not an agent stage — the pin-every-spawn rule governs
 * `pi` spawns. The repo/worktree/task ids reuse the launch helper's id anchor
 * (`GET /terminal/list`, preferring a chain-labeled terminal) or its explicit
 * `--repo-id/--worktree-id/--task-id` bootstrap flags — one mechanism, no
 * manual curl procedure.
 *
 * A connection-level failure to the agent API before a session exists is
 * reported with `error.message` preserved, and the wake falls back to the
 * terminal: print the resume command so it is never lost. Every
 * non-connection failure (HTTP error responses, malformed bodies) and every
 * failure after the session exists is a hard error; when a session was
 * already created its id is printed so nothing is lost silently.
 *
 * Plain ESM per ADR-0002, zero dependencies beyond Node.
 *
 * Usage:
 *   node skills/software-factory/scripts/open-wake-session.mjs <stage> <spec> '<resume command>'
 *     [--repo-id <id> --worktree-id <id> --task-id <id>]
 */
import { pathToFileURL } from "node:url";
import {
  createLabeledSession,
  failureLines,
  isConnectionError,
  parseIdFlags,
  reachApi,
  stageLabel,
  stagePin,
} from "./launch-stage.mjs";

/** @typedef {import("./launch-stage.mjs").TaskIds} TaskIds */

/** The session label: the chain spec plus the failed stage, not another stage's name. */
export function wakeLabel(spec, stage) {
  return stageLabel(spec, `wake — ${stage}`);
}

/** The wake prompt: a notice for the maintainer, plus the resume command verbatim. */
export function buildWakePrompt({ stage, spec, resumeCommand }) {
  return [
    "WAKE NOTICE — this session is a notice for the maintainer; do not run any command or tool.",
    `The chain parked: the ${stage} stage gave up on spec #${spec} after its retries.`,
    "The maintainer resumes it with this exact command:",
    "",
    resumeCommand,
  ].join("\n");
}

/**
 * The reachable-API path: create the opencode session on the task, rename it,
 * then send the wake prompt verbatim. A connection-level failure on the
 * create call leaves no session id and may still fall back to the printed
 * resume command; every failure after the session exists carries its id and
 * is a hard error.
 *
 * @param {{ stage: string, spec: number|string, resumeCommand: string, ids: TaskIds, worktreePath: string, apiBase: string, fetchImpl?: typeof fetch }} options
 */
export async function createWakeSession({ stage, spec, resumeCommand, ids, worktreePath, apiBase, fetchImpl = fetch }) {
  return createLabeledSession({
    label: wakeLabel(spec, stage),
    prompt: buildWakePrompt({ stage, spec, resumeCommand }),
    ids,
    worktreePath,
    apiBase,
    fetchImpl,
  });
}

export async function openWakeSession({ stage, spec, resumeCommand, flags, deps = {} }) {
  const { fetchImpl = fetch, worktreePath = process.cwd() } = deps;
  stagePin(stage); // a bad stage is a hard error before any fetch
  const label = wakeLabel(spec, stage); // a bad spec too
  const fallback = (error) => ({ path: "fallback", label, reason: error.message, resumeCommand });

  const reached = await reachApi({ apiBase: deps.apiBase, dataDir: deps.dataDir, fetchImpl, worktreePath, flags });
  if (!reached.ok) return fallback(reached.error);
  const { apiBase, ids } = reached;

  let created;
  try {
    created = await createWakeSession({ stage, spec, resumeCommand, ids, worktreePath, apiBase, fetchImpl });
  } catch (error) {
    // Never fall back once a session exists; failures after creation carry its id.
    if (isConnectionError(error) && !error.sessionId) return fallback(error);
    throw error;
  }

  return { path: "api", ...created };
}

/** The terminal fallback: the error, then the resume command so it is never lost. */
export function buildWakeFallbackLines({ reason, resumeCommand }) {
  return [
    `open-wake-session: ${reason} — wake session not opened`,
    "open-wake-session: resume the chain with this exact command:",
    resumeCommand,
  ];
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const [stage, spec, resumeCommand] = argv;
  if (!stage || spec === undefined || resumeCommand === undefined) {
    throw new Error(
      "usage: open-wake-session.mjs <stage> <spec> '<resume command>' [--repo-id <id> --worktree-id <id> --task-id <id>]"
    );
  }
  const flags = parseIdFlags(argv.slice(3));
  const write = deps.write ?? ((line) => process.stdout.write(`${line}\n`));
  const result = await openWakeSession({ stage, spec, resumeCommand, flags, deps });
  if (result.path === "api") {
    write(`open-wake-session: woke ${result.label} as Kepler session ${result.sessionId}`);
  } else {
    for (const line of buildWakeFallbackLines({ reason: result.reason, resumeCommand })) {
      write(line);
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    for (const line of failureLines("open-wake-session", error)) console.error(line);
    process.exitCode = 1;
  });
}
