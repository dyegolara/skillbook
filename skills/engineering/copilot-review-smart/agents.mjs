/**
 * agents.mjs — layer 2 of the decision-source resolution chain (ADR-0007):
 * discover the agent session this Tick runs under and synthesize that agent's
 * own CLI as the decision command (layer 1's universal adapter: the decision
 * request arrives on stdin, a JSON decision comes back on stdout).
 *
 * An adapter unit is a plain object:
 *   name          label used in the report's decision_source
 *   cli           executable the synthesized command invokes; the unit only
 *                 matches when it resolves on PATH
 *   helpArgs      argv for the offline contract check (`--help`)
 *   detect(env)   true when the environment carries this agent's markers
 *   modelPin(env) { provider, model } the host exposes, or null — an exposed
 *                 model is always pinned explicitly in the command
 *   buildCommand(env) the synthesized decision command
 *
 * Adding an agent is appending one unit to AGENT_ADAPTERS: nothing in
 * pr_monitor.mjs or decision.mjs changes. Registry order is the precedence
 * when several session markers coexist (a nested agent session inherits the
 * outer agent's markers).
 *
 * The skill never reads or prints another tool's credentials: units read only
 * their own markers and exposed model, and each agent CLI resolves its own
 * authentication. Zero dependencies, plain ESM (ADR-0008).
 */

import fs from "node:fs";
import path from "node:path";
import { autoDecisionSource } from "./decision_source.mjs";

const DECISION_INSTRUCTION =
  "You are the decision step of a GitHub PR watchdog. The JSON decision " +
  "request is on stdin, after this message. Reply with ONLY one JSON object " +
  'and nothing else: {"action":"request_review|request_fix|notify_ready|wait",' +
  '"reason":"short reason"}';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The model a host exposes to an opencode process it launches with inline
 * config (`OPENCODE_CONFIG_CONTENT`); opencode itself exports no session
 * model to child processes. Never log or report the config payload itself. */
function opencodeConfiguredModel(env) {
  const raw = env.OPENCODE_CONFIG_CONTENT;
  if (!raw) return null;
  try {
    const model = JSON.parse(raw)?.model;
    return typeof model === "string" && model.trim() ? model.trim() : null;
  } catch {
    return null;
  }
}

const pi = {
  name: "pi",
  cli: "pi",
  helpArgs: ["--help"],
  detect: (env) => env.PI_CODING_AGENT === "true" || env.AI_AGENT === "pi",
  modelPin: (env) =>
    env.PI_MODEL ? { provider: env.PI_PROVIDER || null, model: env.PI_MODEL } : null,
  buildCommand(env) {
    const parts = ["pi", "--print"];
    if (env.PI_PROVIDER) parts.push("--provider", shellQuote(env.PI_PROVIDER));
    if (env.PI_MODEL) parts.push("--model", shellQuote(env.PI_MODEL));
    parts.push(shellQuote(DECISION_INSTRUCTION));
    return parts.join(" ");
  },
};

const claudeCode = {
  name: "claude",
  cli: "claude",
  helpArgs: ["--help"],
  detect: (env) =>
    env.CLAUDECODE === "1" || String(env.AI_AGENT || "").startsWith("claude-code"),
  // Where the host exposes a session model it lands in ANTHROPIC_MODEL
  // (Claude Code reads it); otherwise the CLI's configured default applies.
  modelPin: (env) =>
    env.ANTHROPIC_MODEL ? { provider: null, model: env.ANTHROPIC_MODEL } : null,
  // UNCONFIRMED (spec #105): the non-interactive command contract is verified
  // in this environment, but authentication through a Teams seat was not.
  // Confirm auth in the Teams-seat environment before relying on this adapter.
  buildCommand(env) {
    const parts = ["claude", "--print"];
    if (env.ANTHROPIC_MODEL) parts.push("--model", shellQuote(env.ANTHROPIC_MODEL));
    parts.push(shellQuote(DECISION_INSTRUCTION));
    return parts.join(" ");
  },
};

const opencode = {
  name: "opencode",
  cli: "opencode",
  helpArgs: ["run", "--help"],
  detect: (env) => env.OPENCODE === "1" || Boolean(env.OPENCODE_CLIENT),
  // opencode exports no session model; a host that launches it with inline
  // config exposes `model` there.
  modelPin: (env) => {
    const model = opencodeConfiguredModel(env);
    return model ? { provider: null, model } : null;
  },
  buildCommand(env) {
    const model = opencodeConfiguredModel(env);
    const parts = ["opencode", "run"];
    if (model) parts.push("--model", shellQuote(model));
    parts.push(shellQuote(DECISION_INSTRUCTION));
    return parts.join(" ");
  },
};

export const AGENT_ADAPTERS = [pi, claudeCode, opencode];

/** Is `name` an executable on this environment's PATH? */
export function cliOnPath(name, env = process.env) {
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      // not here — keep looking
    }
  }
  return false;
}

/** The innermost registered agent whose marker is set and whose CLI is
 * runnable, or null when no agent session surrounds this process. */
export function discoverAgent({ env = process.env, cliExists, adapters = AGENT_ADAPTERS } = {}) {
  const exists = cliExists || ((name) => cliOnPath(name, env));
  return adapters.find((unit) => unit.detect(env) && exists(unit.cli)) || null;
}

/** Resolve the auto layer: `{ adapter, command }` for the discovered agent,
 * or null so the chain falls through to the handled none case. */
export function resolveAutoDecisionSource({
  env = process.env,
  cliExists,
  adapters = AGENT_ADAPTERS,
} = {}) {
  const adapter = discoverAgent({ env, cliExists, adapters });
  if (!adapter) return null;
  const pin = adapter.modelPin(env);
  const model = pin ? [pin.provider, pin.model].filter(Boolean).join("/") : null;
  return {
    adapter: autoDecisionSource(adapter.name, model),
    command: adapter.buildCommand(env),
  };
}
