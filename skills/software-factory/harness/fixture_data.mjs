#!/usr/bin/env node
/**
 * fixture_data.mjs — the fixture harness's scenarios.
 *
 * The inputs (`stage`, `env`, ids, pointers) and the command each scenario
 * must produce. Default pin values come from `env-defaults.mjs`, never copied
 * (ticket #162's rule); the command shapes are the documented flag shapes the
 * helpers build through `AGENT_COMMANDS` — the `pi` shape is the pre-change
 * fixed-pin string the defaults scenario asserts byte-identically. Every
 * scenario carries its `env` explicitly, including `{}` for "nothing set", so
 * the ambient environment never leaks into a run.
 *
 * Plain ESM per ADR-0002, zero dependencies beyond Node.
 */
import {
  AGENT_COMMANDS,
  AGENTS,
  DEFAULTS,
  EFFORTS,
  PROVIDERS,
  PROVIDER_KEY_VARS,
} from "../scripts/env-defaults.mjs";

// The launch stages and their env-defaults keys. GRILL is not a launch stage:
// its route is `openGrillSession`, covered by GRILL_SCENARIOS.
const STAGE_KEY_BY_NAME = {
  "dev-flow": "DEV_FLOW",
  "implement-spec": "IMPLEMENT_SPEC",
  "code-review-loop": "CODE_REVIEW_LOOP",
  "create-pr": "CREATE_PR",
};

/** The fixture's fixed launch facts: spec, pointers, ids and worktree. */
export const FIXTURE = Object.freeze({
  spec: "164",
  pointers: "read ticket #164 and the review report at /reports/review-164.md",
  reEntryPrompt:
    "Re-enter the grill for spec #164: read skills/software-factory/grill-with-spec/SKILL.md and the review report at /reports/review-164.md.",
  ids: { repoId: "repo-fixture", worktreeId: "worktree-fixture", taskId: "task-fixture" },
  worktreePath: "/fixture/software-factory",
});

/** Every launch-stage name the harness drives, in the defaults table's order. */
export const LAUNCH_STAGE_NAMES = Object.keys(STAGE_KEY_BY_NAME);

/** The stage's default pins read from env-defaults: global provider + stage model/effort. */
export function defaultPin(stage) {
  const pin = DEFAULTS.stages[STAGE_KEY_BY_NAME[stage]];
  return { provider: DEFAULTS.provider, model: pin.model, effort: pin.effort };
}

/**
 * The fixture's provider key value. It is never injected: the environment
 * carries it under the provider's own variable.
 */
export const FIXTURE_KEY = "sk-fixture";

/**
 * The environment one provider's account travels in: its own key variable,
 * the way an environment (docker) carries it. `DEV_ENV_PROVIDER`, when the
 * scenario sets it, pairs with this environment.
 */
export function providerKeyEnv(provider = DEFAULTS.provider, key = FIXTURE_KEY) {
  return { [PROVIDER_KEY_VARS[provider]]: key };
}

/** The fixture env for the default provider: its own key variable, never injected. */
export const DEFAULT_KEY_ENV = providerKeyEnv();

/**
 * The pre-change fixed-pin `pi` command
 * (`pi --print --provider <p> --model <m> --thinking <e> '<pointers>'`), with
 * the values from the caller. This is the shape the defaults scenario asserts
 * byte-identically; the fixture's pointers are quote-free, so `'<pointers>'`
 * is their exact `shellQuote`.
 */
export function piCommand({ provider, model, effort }, pointers = FIXTURE.pointers) {
  return `pi --print --provider ${provider} --model ${model} --thinking ${effort} '${pointers}'`;
}

/** The stage's command with no `DEV_ENV_*` set: today's fixed pin. */
export function defaultCommand(stage) {
  return piCommand(defaultPin(stage));
}

/**
 * The launch scenarios: defaults, the per-docker provider-environment pattern,
 * a per-stage retune (the retuned stage plus a sibling sharing the same env)
 * and an agent switch through `AGENT_COMMANDS`.
 */
export const LAUNCH_SCENARIOS = {
  defaults: {
    stage: "dev-flow",
    env: { ...DEFAULT_KEY_ENV },
    expectedCommand: defaultCommand("dev-flow"),
  },
  "per-docker": {
    stage: "dev-flow",
    env: { DEV_ENV_PROVIDER: "openrouter", ...providerKeyEnv("openrouter") },
    // The environment carries the key under the provider's own variable; the
    // injected command is the provider's plain default-pin command.
    expectedCommand: piCommand({ ...defaultPin("dev-flow"), provider: "openrouter" }),
  },
  "per-stage-retune": {
    env: {
      ...DEFAULT_KEY_ENV,
      DEV_ENV_MODEL_DEV_FLOW: "anthropic/claude-opus-5",
      DEV_ENV_EFFORT_DEV_FLOW: "high",
    },
    runs: [
      {
        stage: "dev-flow",
        expectedCommand: piCommand({
          ...defaultPin("dev-flow"),
          model: "anthropic/claude-opus-5",
          effort: "high",
        }),
      },
      // The sibling stage keeps its own default pins under the same env.
      { stage: "create-pr", expectedCommand: defaultCommand("create-pr") },
    ],
  },
  "agent-switch": {
    stage: "dev-flow",
    env: { ...DEFAULT_KEY_ENV, DEV_ENV_AGENT_DEV_FLOW: "grok" },
    // Grok Build's documented headless shape: `grok -p --model <m> --effort <e>`.
    expectedCommand:
      `grok -p --model ${defaultPin("dev-flow").model} --effort ${defaultPin("dev-flow").effort} ` +
      `'${FIXTURE.pointers}'`,
  },
};

/**
 * The scenarios that must stop with a hard error instead of injecting a
 * command. `allowed` is the env-defaults list the message must name, so a
 * readable error lists exactly what the module permits.
 */
export const INVALID_VALUE_CASES = [
  {
    name: "provider",
    variable: "DEV_ENV_PROVIDER",
    env: { ...DEFAULT_KEY_ENV, DEV_ENV_PROVIDER: "wat" },
    badValue: "wat",
    allowed: PROVIDERS,
  },
  {
    name: "effort",
    variable: "DEV_ENV_EFFORT_DEV_FLOW",
    env: { ...DEFAULT_KEY_ENV, DEV_ENV_EFFORT_DEV_FLOW: "turbo" },
    badValue: "turbo",
    allowed: EFFORTS,
  },
  {
    name: "agent",
    variable: "DEV_ENV_AGENT_DEV_FLOW",
    env: { ...DEFAULT_KEY_ENV, DEV_ENV_AGENT_DEV_FLOW: "gemini" },
    badValue: "gemini",
    allowed: AGENTS,
  },
];

/** The launch runs of a scenario: a single `stage` or a `runs` list sharing one env. */
export function launchRuns(scenario) {
  return scenario.runs ?? [{ stage: scenario.stage, expectedCommand: scenario.expectedCommand }];
}

/**
 * The missing-key cases: the resolved provider's own key variable unset, and
 * whitespace-only (which reads as unset). The launch preflight stops with
 * `resolveKey`'s readable hard error naming the provider and the variable to
 * set, before any fetch, injection or spawn.
 */
function missingKeyCase(name, env) {
  const provider = DEFAULTS.provider;
  const keyVariable = PROVIDER_KEY_VARS[provider];
  return {
    name,
    env,
    provider,
    keyVariable,
    expectedMessage: `provider "${provider}" requires a key: set ${keyVariable}`,
  };
}

export const MISSING_KEY_CASES = [
  missingKeyCase("unset", {}),
  missingKeyCase("whitespace-only", { [PROVIDER_KEY_VARS[DEFAULTS.provider]]: "   " }),
];

/**
 * The key + fallback scenario: the provider's key variable is set, and the
 * terminal API is unreachable at the connection level. No bootstrap ids are
 * given, so the helper reaches the API to resolve them and the rejecting
 * fetch triggers `launchDetached`'s nohup fallback. The spawned child must
 * inherit the environment that carries the key under the provider's own
 * variable, and the command nohup receives must be launchable as written.
 */
export const FALLBACK_SCENARIO = {
  stage: "dev-flow",
  provider: DEFAULTS.provider,
  keyVariable: PROVIDER_KEY_VARS[DEFAULTS.provider],
  env: { ...DEFAULT_KEY_ENV },
  // No bootstrap flags: the helper asks the API for an anchor terminal.
  ids: {},
  fetchError: "fetch failed: ECONNREFUSED",
  expectedCommand: defaultCommand("dev-flow"),
};

/**
 * The grill route's scenarios: the default pin (model, effort, the grill
 * agent's adapterId) and an agent switch to `claude-code`. The default
 * adapterId is read through `AGENT_COMMANDS` — the same table the route reads
 * — so the assertion is about the wiring, not a copied pin.
 */
export const GRILL_SCENARIOS = {
  defaults: {
    env: {},
    expected: {
      label: `chain #${FIXTURE.spec}: grill-with-spec`,
      model: DEFAULTS.stages.GRILL.model,
      effort: DEFAULTS.stages.GRILL.effort,
      adapterId: AGENT_COMMANDS[DEFAULTS.stages.GRILL.agent].adapterId,
    },
  },
  "agent-switch": {
    env: {
      DEV_ENV_MODEL_GRILL: "anthropic/claude-opus-5",
      DEV_ENV_EFFORT_GRILL: "xhigh",
      DEV_ENV_AGENT_GRILL: "claude-code",
    },
    expected: {
      label: `chain #${FIXTURE.spec}: grill-with-spec`,
      model: "anthropic/claude-opus-5",
      effort: "xhigh",
      // The documented Kepler adapterId for `claude-code`.
      adapterId: "claude-code",
    },
  },
};
