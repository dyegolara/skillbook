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
 * notice on the task, not an agent stage — the pin-every-spawn rule governs
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
import {
  createLabeledSession,
  parseIdFlags,
  runSessionCli,
  runSessionHelper,
  stageKey,
  stageLabel,
} from "./launch-stage.mjs";

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
 * The wake's route shell: its label and prompt (the no-pin notice semantics —
 * a plain labeled session, no pre-send step), handed to the shared
 * `runSessionHelper`. `stageKey` is the stage guard, not a pin step: the wake
 * resolves no pins — it is a notice on the task, not an agent stage — and
 * creates its session through the shared default (the opencode adapter).
 *
 * @param {{ stage: string, spec: number|string, resumeCommand: string, flags?: Object, deps?: Object }} options
 */
export async function openWakeSession({ stage, spec, resumeCommand, flags, deps = {} }) {
  stageKey(stage); // a bad stage is a hard error before any fetch
  return runSessionHelper({
    label: wakeLabel(spec, stage), // a bad spec too
    prompt: buildWakePrompt({ stage, spec, resumeCommand }),
    flags,
    deps,
    fallbackExtra: { resumeCommand },
    create: createLabeledSession,
    successLine: (result) => `open-wake-session: woke ${result.label} as Kepler session ${result.sessionId}`,
    fallbackLines: (result) => buildWakeFallbackLines({ reason: result.reason, resumeCommand }),
  });
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
  return openWakeSession({ stage, spec, resumeCommand, flags: parseIdFlags(argv.slice(3)), deps });
}

runSessionCli({ toolName: "open-wake-session", moduleUrl: import.meta.url, main });
