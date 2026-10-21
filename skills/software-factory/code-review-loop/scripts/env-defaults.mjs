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
 * table (`PROVIDER_KEY_VARS`, each provider's own variable per spec #160),
 * the agent→launch table, and the resolution rules. Resolution is
 * environment-injectable: the functions take an `env` object defaulting to
 * `process.env`, so tests need no global mutation.
 *
 * Variables (spec #160): global `DEV_ENV_PROVIDER`; per stage
 * `DEV_ENV_MODEL_<STAGE>`, `DEV_ENV_EFFORT_<STAGE>`, `DEV_ENV_AGENT_<STAGE>`
 * for GRILL, DEV_FLOW, IMPLEMENT_SPEC, CODE_REVIEW_LOOP and CREATE_PR. API
 * keys are provider-environment scoped (amended 2026-10-21): each provider's
 * key lives in its own variable — the environment (docker) carries it.
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
 * The launch stages and their env-defaults keys, in one map: the kebab name
 * the helpers take and the SCREAMING key `DEFAULTS.stages` uses. `GRILL` is
 * deliberately absent — it is the grill helper's stage (`open-grill-session.mjs`
 * `grillPin`), which resolves it through this module without entering a launch
 * or wake path. The map owns the launch stage set and both spellings; the
 * launch guard and the fixture harness both read it.
 */
export const LAUNCH_STAGES = Object.freeze({
  "dev-flow": "DEV_FLOW",
  "implement-spec": "IMPLEMENT_SPEC",
  "code-review-loop": "CODE_REVIEW_LOOP",
  "create-pr": "CREATE_PR",
});

/**
 * The provider→key-variable table: each provider's API key lives in its own
 * environment variable, carried by the environment (docker) for that
 * provider's account. There is no universal fallback, and `OPENROUTER_API_KEY`
 * serves only `openrouter`.
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
  // --thinking <e>` (launch-stage.mjs `buildStageCommand` / ADR-0006). Flags
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
    // `cursor` is the local `GET /agent/adapters` registry's adapter id
    // (2026-10-16), not a CLI-doc fact.
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

/** The one unknown-stage error: the caller's stage argument and the expected names. */
function unknownStage(stage, expected) {
  return new Error(`unknown stage "${stage}" — expected one of ${expected.join(", ")}`);
}

/** The stage's default pin, or a hard error for a stage outside the chain. */
export function stageDefaults(stage) {
  const defaults = DEFAULTS.stages[stage];
  if (!defaults) throw unknownStage(stage, Object.keys(DEFAULTS.stages));
  return defaults;
}

/**
 * The env-defaults stage key for a launch-stage name: `code-review-loop`
 * resolves `CODE_REVIEW_LOOP`. This is the launch guard — the launch helper
 * calls it before any launch path, and the wake helper calls it (through
 * `launch-stage.mjs`) before any fetch — so the launch stage set and the
 * kebab⇄SCREAMING conversion have one source. An unknown stage emits the same
 * single error shape `stageDefaults` emits, naming the launch stages.
 */
export function stageKey(stage) {
  const name = String(stage).replaceAll("_", "-").toLowerCase();
  if (!Object.hasOwn(LAUNCH_STAGES, name)) throw unknownStage(stage, Object.keys(LAUNCH_STAGES));
  return LAUNCH_STAGES[name];
}

/** The run's provider: `DEV_ENV_PROVIDER`, defaulting to today's global pin. */
export function resolveProvider(env = process.env) {
  return resolveValue({ name: "DEV_ENV_PROVIDER", env, fallback: DEFAULTS.provider, allowed: PROVIDERS });
}

/**
 * The three per-stage pin fields in one table: each row is keyed by the field
 * it resolves in `DEFAULTS.stages[<STAGE>]` (the same name `stagePin` returns)
 * and carries that field's `DEV_ENV_<SUFFIX>_<STAGE>` variable suffix and the
 * `allowed` list. A null list means a free non-empty string — the model's
 * rule; v1 does not cross-validate the model against the provider (the
 * operator switching provider also sets that provider's models).
 */
const STAGE_FIELDS = {
  model: { suffix: "MODEL", allowed: null },
  effort: { suffix: "EFFORT", allowed: EFFORTS },
  agent: { suffix: "AGENT", allowed: AGENTS },
};

/**
 * The one stage-field resolver: the row's `DEV_ENV_<SUFFIX>_<STAGE>` variable
 * over the same `resolveValue` rule, the stage's `DEFAULTS` field as the
 * fallback. An unknown stage is a hard error before any variable is read.
 */
function resolveStageField(field, stage, env = process.env) {
  const { suffix, allowed } = STAGE_FIELDS[field];
  return resolveValue({
    name: `DEV_ENV_${suffix}_${stage}`,
    env,
    fallback: stageDefaults(stage)[field],
    allowed,
  });
}

/** The stage's model: `DEV_ENV_MODEL_<STAGE>`, defaulting to today's pin. */
export function resolveModel(stage, env = process.env) {
  return resolveStageField("model", stage, env);
}

/** The stage's effort: `DEV_ENV_EFFORT_<STAGE>`, checked against `EFFORTS`. */
export function resolveEffort(stage, env = process.env) {
  return resolveStageField("effort", stage, env);
}

/** The stage's agent: `DEV_ENV_AGENT_<STAGE>`, checked against `AGENTS`. */
export function resolveAgent(stage, env = process.env) {
  return resolveStageField("agent", stage, env);
}

/**
 * The provider's key: the provider's own variable, set and non-empty after
 * trim, is the key. Nothing else is consulted — no fallback chain, no
 * universal fallback — so a missing key is a hard error naming the provider
 * and the variable to set. Every allowed provider requires a key in v1; a
 * per-provider requires-key table is deferred until a keyless provider
 * exists (ADR-0006, amended 2026-10-21).
 */
export function resolveKey(provider, env = process.env) {
  if (!Object.hasOwn(PROVIDER_KEY_VARS, provider)) {
    throw new Error(`unknown provider "${provider}" — expected one of ${PROVIDERS.join(", ")}`);
  }
  const variable = PROVIDER_KEY_VARS[provider];
  const key = readEnv(env, variable);
  if (key !== null) return key;
  throw new Error(`provider "${provider}" requires a key: set ${variable}`);
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
