#!/usr/bin/env node
/**
 * env-defaults.mjs — the software-factory chain's single source of pins.
 *
 * Plain ESM per ADR-0002, zero dependencies beyond Node. The launch helper
 * (`launch-stage.mjs`) and the grill helper (`open-grill-session.mjs`) import
 * it: every pin resolves from here plus `DEV_ENV_*`, and the literal
 * `STAGE_PINS`/`GRILL_PIN` tables are gone (ticket #162).
 *
 * Every pin the chain resolves lives here: the defaults (today's pins, per
 * ticket #161 and ADR-0006), the allowed values, the provider→key-variable
 * table (`DEV_ENV_` variables per spec #160), the agent→launch table, and the
 * resolution rules. Resolution is environment-injectable: the functions take
 * an `env` object defaulting to `process.env`, so tests need no global
 * mutation.
 *
 * Variables (spec #160): global `DEV_ENV_PROVIDER` and `DEV_ENV_API_KEY`; per
 * stage `DEV_ENV_MODEL_<STAGE>`, `DEV_ENV_EFFORT_<STAGE>`, `DEV_ENV_AGENT_<STAGE>`
 * for GRILL, DEV_FLOW, IMPLEMENT_SPEC, CODE_REVIEW_LOOP and CREATE_PR.
 */

/** Allowed providers for `DEV_ENV_PROVIDER`, in one list. */
export const PROVIDERS = ["openrouter", "opencode-go", "openai", "xai", "anthropic"];

/** Allowed effort values for `DEV_ENV_EFFORT_<STAGE>`, in one list. */
export const EFFORTS = ["max", "xhigh", "high"];

/** Allowed agents for `DEV_ENV_AGENT_<STAGE>`, in one list. */
export const AGENTS = ["pi", "opencode", "codex", "claude-code", "grok", "cursor-cli"];

/**
 * Today's pins per ticket #161 / ADR-0006: the global provider and each
 * stage's model, effort and agent. Unset `DEV_ENV_` variables resolve to
 * these, so a bare environment behaves exactly as the chain does today.
 */
export const DEFAULTS = {
  provider: "opencode-go",
  stages: {
    GRILL: { model: "opencode-go/glm-5.3", effort: "max", agent: "opencode" },
    DEV_FLOW: { model: "opencode-go/glm-5.3", effort: "max", agent: "pi" },
    IMPLEMENT_SPEC: { model: "opencode-go/deepseek-v4.1-flash", effort: "max", agent: "pi" },
    CODE_REVIEW_LOOP: { model: "opencode-go/mimo-v2.6-pro", effort: "high", agent: "pi" },
    CREATE_PR: { model: "opencode-go/muse-spark-1.3-contributor", effort: "xhigh", agent: "pi" },
  },
};

/**
 * The provider→key-variable table (spec #160): the provider's specific
 * variable is tried first, `DEV_ENV_API_KEY` is the only fallback, and
 * `OPENROUTER_API_KEY` serves only `openrouter` — never another provider.
 */
export const PROVIDER_KEY_VARS = {
  openrouter: "OPENROUTER_API_KEY",
  "opencode-go": "OPENCODE_GO_API_KEY",
  openai: "OPENAI_API_KEY",
  xai: "XAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/**
 * The agent→launch table: each row names the CLI binary, Kepler's adapter id,
 * the doc that verifies its flags, and builds the argv after the binary from
 * the stage pins (`provider`, `model`, `effort`, `pointers`). `buildAgentCommand`
 * prepends the binary. Binaries verified 2026-10-16 (ticket #161): `pi→pi`,
 * `opencode→opencode` (v2), `codex→codex`, `claude-code→claude`, `grok→grok`,
 * `cursor-cli→agent` (legacy alias `cursor-agent` accepted). Kepler adapterIds
 * verified against the local `GET /agent/adapters` registry (2026-10-16):
 * pi, opencode, codex, claude-code, grok, cursor — `cursor-cli` maps to
 * Kepler's `cursor` adapter.
 */
export const AGENT_COMMANDS = {
  // Today's exact pinned shape: `pi --print --provider <p> --model <m>
  // --thinking <e>` (launch-stage.mjs `buildPiCommand` / ADR-0006). Flags
  // verified against `pi --help` (pi 1.3.0, 2026-10-16): `--print`,
  // `--provider`, `--model`, `--thinking`.
  pi: {
    binary: "pi",
    adapterId: "pi",
    docs: ["pi --help (pi 1.3.0)"],
    args: ({ provider, model, effort, pointers }) => [
      "--print",
      "--provider",
      provider,
      "--model",
      model,
      "--thinking",
      effort,
      pointers,
    ],
  },
  // `opencode run` is the documented non-interactive command; `--model` takes
  // the `provider/model` id and `--variant` selects the provider-specific
  // reasoning effort. Docs (2026-10-16): https://opencode.ai/docs/cli/ (run
  // flags) and https://opencode.ai/docs/models/ (built-in variants include
  // `high`, `xhigh`, `max`).
  opencode: {
    binary: "opencode",
    adapterId: "opencode",
    docs: ["https://opencode.ai/docs/cli/", "https://opencode.ai/docs/models/"],
    args: ({ model, effort, pointers }) => ["run", "--model", model, "--variant", effort, pointers],
  },
  // `codex exec` is the documented non-interactive command; `--model`
  // overrides the model and `-c key=value` overrides config inline; the
  // effort level is the `model_reasoning_effort` config key with levels
  // low/medium/high/xhigh/max/ultra. Docs (2026-10-16):
  // https://developers.openai.com/codex/cli/reference (`codex exec` options)
  // and https://developers.openai.com/codex/config-reference.
  codex: {
    binary: "codex",
    adapterId: "codex",
    docs: [
      "https://developers.openai.com/codex/cli/reference",
      "https://developers.openai.com/codex/config-reference",
    ],
    args: ({ model, effort, pointers }) => [
      "exec",
      "--model",
      model,
      "-c",
      `model_reasoning_effort=${effort}`,
      pointers,
    ],
  },
  // `claude -p` prints non-interactively; `--model` sets the model and
  // `--effort` the reasoning effort (low/medium/high/xhigh/max/ultracode).
  // Docs (2026-10-16): https://docs.claude.com/en/docs/claude-code/cli-reference.
  "claude-code": {
    binary: "claude",
    adapterId: "claude-code",
    docs: ["https://docs.claude.com/en/docs/claude-code/cli-reference"],
    args: ({ model, effort, pointers }) => ["-p", "--model", model, "--effort", effort, pointers],
  },
  // `grok -p` sends one prompt headlessly; `-m/--model` picks the model and
  // `--effort` the reasoning effort. Docs (2026-10-16):
  // https://docs.x.ai/build/cli/headless-scripting (`-p`, `--model`) and
  // https://docs.x.ai/build/cli/reference (`--effort`).
  grok: {
    binary: "grok",
    adapterId: "grok",
    docs: ["https://docs.x.ai/build/cli/headless-scripting", "https://docs.x.ai/build/cli/reference"],
    args: ({ model, effort, pointers }) => ["-p", "--model", model, "--effort", effort, pointers],
  },
  // `agent -p` prints non-interactively and `--model` picks the model. The
  // official CLI reference documents no reasoning-effort/thinking flag
  // (https://cursor.com/docs/cli/reference/parameters, 2026-10-16), so this
  // row carries no effort flag — v1 does not invent flags. Binary `agent`
  // (legacy alias `cursor-agent` accepted) and print mode:
  // https://cursor.com/docs/cli/headless.
  "cursor-cli": {
    binary: "agent",
    adapterId: "cursor",
    docs: ["https://cursor.com/docs/cli/reference/parameters", "https://cursor.com/docs/cli/headless"],
    args: ({ model, pointers }) => ["-p", "--model", model, pointers],
  },
};

/**
 * Read one variable the way every rule here does: unset, nullish, empty and
 * whitespace-only all read as absent; any other value is trimmed.
 */
function readEnv(env, name) {
  const raw = env?.[name];
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  return value === "" ? null : value;
}

/**
 * The general value rule (spec #160): a set, non-empty value after trim wins;
 * empty or whitespace-only reads as unset and the fallback applies; a value
 * outside `allowed` is a hard error naming the variable and listing the
 * allowed values. A missing `allowed` list means a free non-empty string —
 * the model's rule; v1 does not cross-validate it against the provider.
 */
export function resolveValue({ name, env = process.env, fallback, allowed = null }) {
  const value = readEnv(env, name);
  if (value === null) return fallback;
  if (allowed && !allowed.includes(value)) {
    throw new Error(`${name}="${value}" is not allowed — expected one of ${allowed.join(", ")}`);
  }
  return value;
}

/** The stage's default pin, or a hard error for a stage outside the chain. */
export function stageDefaults(stage) {
  const defaults = DEFAULTS.stages[stage];
  if (!defaults) {
    throw new Error(`unknown stage "${stage}" — expected one of ${Object.keys(DEFAULTS.stages).join(", ")}`);
  }
  return defaults;
}

/** The run's provider: `DEV_ENV_PROVIDER`, defaulting to today's global pin. */
export function resolveProvider(env = process.env) {
  return resolveValue({ name: "DEV_ENV_PROVIDER", env, fallback: DEFAULTS.provider, allowed: PROVIDERS });
}

/**
 * The stage's model: `DEV_ENV_MODEL_<STAGE>`, defaulting to today's pin. A
 * free non-empty string — v1 does not cross-validate it against the provider
 * (the operator switching provider also sets that provider's models).
 */
export function resolveModel(stage, env = process.env) {
  return resolveValue({ name: `DEV_ENV_MODEL_${stage}`, env, fallback: stageDefaults(stage).model });
}

/** The stage's effort: `DEV_ENV_EFFORT_<STAGE>`, checked against `EFFORTS`. */
export function resolveEffort(stage, env = process.env) {
  return resolveValue({
    name: `DEV_ENV_EFFORT_${stage}`,
    env,
    fallback: stageDefaults(stage).effort,
    allowed: EFFORTS,
  });
}

/** The stage's agent: `DEV_ENV_AGENT_<STAGE>`, checked against `AGENTS`. */
export function resolveAgent(stage, env = process.env) {
  return resolveValue({
    name: `DEV_ENV_AGENT_${stage}`,
    env,
    fallback: stageDefaults(stage).agent,
    allowed: AGENTS,
  });
}

/**
 * The provider's key (spec #160), with no universal fallback: the provider's
 * own variable first (set and non-empty after trim), then `DEV_ENV_API_KEY`,
 * then a hard error naming the provider and both variables. Every allowed
 * provider requires a key in v1; `OPENROUTER_API_KEY` is looked up only for
 * `openrouter`.
 */
export function resolveKey(provider, env = process.env) {
  if (!Object.hasOwn(PROVIDER_KEY_VARS, provider)) {
    throw new Error(`unknown provider "${provider}" — expected one of ${PROVIDERS.join(", ")}`);
  }
  const specificVar = PROVIDER_KEY_VARS[provider];
  const specific = readEnv(env, specificVar);
  if (specific !== null) return specific;
  const generic = readEnv(env, "DEV_ENV_API_KEY");
  if (generic !== null) return generic;
  throw new Error(`provider "${provider}" requires a key: set ${specificVar} or DEV_ENV_API_KEY`);
}

/**
 * Build an agent's launch argv from a stage's pins. The command construction
 * goes through `AGENT_COMMANDS`; an unknown agent is a hard error.
 */
export function buildAgentCommand(agent, pin) {
  const row = AGENT_COMMANDS[agent];
  if (!row) {
    throw new Error(`unknown agent "${agent}" — expected one of ${AGENTS.join(", ")}`);
  }
  return [row.binary, ...row.args(pin)];
}
