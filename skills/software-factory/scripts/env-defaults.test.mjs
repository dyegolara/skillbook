import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENTS,
  AGENT_COMMANDS,
  DEFAULTS,
  EFFORTS,
  PROVIDERS,
  PROVIDER_KEY_VARS,
  buildAgentCommand,
  providerKeyVariableNames,
  providerKeyVariables,
  resolveAgent,
  resolveEffort,
  resolveModel,
  resolveProvider,
  resolveProviderKey,
  resolveValue,
} from "./env-defaults.mjs";

// Independent source of truth: ticket #161's pin list — today's pins.
const TODAYS_PINS = {
  provider: "opencode-go",
  stages: {
    GRILL: { model: "opencode-go/glm-5.3", effort: "max", agent: "opencode" },
    DEV_FLOW: { model: "opencode-go/glm-5.3", effort: "max", agent: "pi" },
    IMPLEMENT_SPEC: { model: "opencode-go/deepseek-v4.1-flash", effort: "max", agent: "pi" },
    CODE_REVIEW_LOOP: { model: "opencode-go/mimo-v2.6-pro", effort: "high", agent: "pi" },
    CREATE_PR: { model: "opencode-go/muse-spark-1.3-contributor", effort: "xhigh", agent: "pi" },
  },
};

test("DEFAULTS carries today's pins exactly", () => {
  assert.deepEqual(DEFAULTS, TODAYS_PINS);
});

test("the allowed lists are exactly the ticket's", () => {
  assert.deepEqual(PROVIDERS, ["openrouter", "opencode-go", "openai", "xai", "anthropic"]);
  assert.deepEqual(EFFORTS, ["max", "xhigh", "high"]);
  assert.deepEqual(AGENTS, ["pi", "opencode", "codex", "claude-code", "grok", "cursor-cli"]);
});

test("PROVIDER_KEY_VARS maps each provider to its documented key variable", () => {
  assert.deepEqual(PROVIDER_KEY_VARS, {
    openrouter: "OPENROUTER_API_KEY",
    "opencode-go": "OPENCODE_API_KEY",
    openai: "OPENAI_API_KEY",
    xai: "XAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  });
});

test("providerKeyVariables: the documented name first, then the deprecated alias", () => {
  assert.deepEqual(providerKeyVariables("opencode-go"), ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"]);
  assert.deepEqual(providerKeyVariables("anthropic"), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(providerKeyVariables("not-a-provider"), []);
});

test("providerKeyVariableNames carries every provider's documented name and alias", () => {
  const names = providerKeyVariableNames();
  for (const name of Object.values(PROVIDER_KEY_VARS)) assert.ok(names.includes(name), name);
  assert.ok(names.includes("OPENCODE_GO_API_KEY"), "the deprecated alias is stripped too");
});

test("resolveProviderKey: the documented name alone resolves", () => {
  assert.deepEqual(resolveProviderKey("opencode-go", { OPENCODE_API_KEY: "sk-documented" }), {
    name: "OPENCODE_API_KEY",
    value: "sk-documented",
  });
});

test("resolveProviderKey: the deprecated alias alone still resolves", () => {
  assert.deepEqual(resolveProviderKey("opencode-go", { OPENCODE_GO_API_KEY: "sk-legacy" }), {
    name: "OPENCODE_GO_API_KEY",
    value: "sk-legacy",
  });
});

test("resolveProviderKey: with both spellings set the documented name wins", () => {
  assert.deepEqual(
    resolveProviderKey("opencode-go", { OPENCODE_API_KEY: "sk-documented", OPENCODE_GO_API_KEY: "sk-legacy" }),
    { name: "OPENCODE_API_KEY", value: "sk-documented" }
  );
});

test("resolveProviderKey trims a set value and reads blank or whitespace-only as absent", () => {
  assert.deepEqual(resolveProviderKey("opencode-go", { OPENCODE_API_KEY: "  sk-documented  " }), {
    name: "OPENCODE_API_KEY",
    value: "sk-documented",
  });
  for (const raw of ["", "   ", "\t\n "]) {
    assert.equal(resolveProviderKey("opencode-go", { OPENCODE_API_KEY: raw }), null, JSON.stringify(raw));
    assert.deepEqual(
      resolveProviderKey("opencode-go", { OPENCODE_API_KEY: raw, OPENCODE_GO_API_KEY: "sk-legacy" }),
      { name: "OPENCODE_GO_API_KEY", value: "sk-legacy" },
      `a blank documented name falls through to the alias: ${JSON.stringify(raw)}`
    );
  }
});

test("resolveProviderKey: no key resolves to null, and an unknown provider has no names", () => {
  assert.equal(resolveProviderKey("opencode-go", {}), null);
  assert.equal(resolveProviderKey("not-a-provider", { OPENCODE_API_KEY: "sk-documented" }), null);
});

test("resolveValue uses the fallback when the variable is unset", () => {
  assert.equal(resolveValue({ name: "DEV_ENV_PROVIDER", env: {}, fallback: "opencode-go" }), "opencode-go");
});

test("resolveValue trims a set value and lets it win over the fallback", () => {
  assert.equal(
    resolveValue({ name: "DEV_ENV_PROVIDER", env: { DEV_ENV_PROVIDER: "  openai  " }, fallback: "opencode-go" }),
    "openai"
  );
});

test("an empty or whitespace-only value reads as unset and the fallback applies", () => {
  const fallback = "opencode-go";
  for (const raw of ["", "   ", "\t\n "]) {
    assert.equal(resolveValue({ name: "DEV_ENV_PROVIDER", env: { DEV_ENV_PROVIDER: raw }, fallback }), fallback);
  }
});

// Independent source of truth: spec #160's per-stage variable names.
const STAGE_ENV_NAMES = {
  GRILL: { model: "DEV_ENV_MODEL_GRILL", effort: "DEV_ENV_EFFORT_GRILL", agent: "DEV_ENV_AGENT_GRILL" },
  DEV_FLOW: { model: "DEV_ENV_MODEL_DEV_FLOW", effort: "DEV_ENV_EFFORT_DEV_FLOW", agent: "DEV_ENV_AGENT_DEV_FLOW" },
  IMPLEMENT_SPEC: { model: "DEV_ENV_MODEL_IMPLEMENT_SPEC", effort: "DEV_ENV_EFFORT_IMPLEMENT_SPEC", agent: "DEV_ENV_AGENT_IMPLEMENT_SPEC" },
  CODE_REVIEW_LOOP: { model: "DEV_ENV_MODEL_CODE_REVIEW_LOOP", effort: "DEV_ENV_EFFORT_CODE_REVIEW_LOOP", agent: "DEV_ENV_AGENT_CODE_REVIEW_LOOP" },
  CREATE_PR: { model: "DEV_ENV_MODEL_CREATE_PR", effort: "DEV_ENV_EFFORT_CREATE_PR", agent: "DEV_ENV_AGENT_CREATE_PR" },
};

test("a value outside the allowed list is a hard error naming the variable and the allowed values", () => {
  assert.throws(
    () =>
      resolveValue({
        name: "DEV_ENV_EFFORT_GRILL",
        env: { DEV_ENV_EFFORT_GRILL: "turbo" },
        fallback: "max",
        allowed: EFFORTS,
      }),
    (error) => {
      assert.match(error.message, /DEV_ENV_EFFORT_GRILL/);
      assert.match(error.message, /turbo/);
      for (const allowed of EFFORTS) assert.match(error.message, new RegExp(allowed));
      return true;
    }
  );
});

test("resolveProvider: default, set and off-list", () => {
  assert.equal(resolveProvider({}), "opencode-go");
  assert.equal(resolveProvider({ DEV_ENV_PROVIDER: "anthropic" }), "anthropic");
  assert.throws(
    () => resolveProvider({ DEV_ENV_PROVIDER: "wat" }),
    (error) => {
      assert.match(error.message, /DEV_ENV_PROVIDER/);
      assert.match(error.message, /wat/);
      for (const provider of PROVIDERS) assert.match(error.message, new RegExp(provider));
      return true;
    }
  );
});

test("resolveModel: each stage defaults to today's pin", () => {
  for (const [stage, pin] of Object.entries(TODAYS_PINS.stages)) {
    assert.equal(resolveModel(stage, {}), pin.model);
  }
});

test("resolveModel: a set value wins and is a free non-empty string (no provider cross-validation)", () => {
  assert.equal(
    resolveModel("DEV_FLOW", { DEV_ENV_MODEL_DEV_FLOW: "anthropic/claude-opus-5" }),
    "anthropic/claude-opus-5"
  );
  assert.equal(resolveModel("DEV_FLOW", { DEV_ENV_MODEL_DEV_FLOW: "   " }), TODAYS_PINS.stages.DEV_FLOW.model);
});

test("resolveEffort: each stage defaults to today's pin, a set value wins, off-list is a hard error", () => {
  for (const [stage, pin] of Object.entries(TODAYS_PINS.stages)) {
    const name = STAGE_ENV_NAMES[stage].effort;
    assert.equal(resolveEffort(stage, {}), pin.effort);
    assert.equal(resolveEffort(stage, { [name]: "high" }), "high");
    assert.throws(() => resolveEffort(stage, { [name]: "highest" }), new RegExp(name));
  }
});

test("resolveAgent: each stage defaults to today's pin, a set value wins, off-list is a hard error", () => {
  for (const [stage, pin] of Object.entries(TODAYS_PINS.stages)) {
    const name = STAGE_ENV_NAMES[stage].agent;
    assert.equal(resolveAgent(stage, {}), pin.agent);
    assert.equal(resolveAgent(stage, { [name]: "codex" }), "codex");
    assert.throws(() => resolveAgent(stage, { [name]: "gemini" }), new RegExp(name));
  }
});

test("an unknown stage is a hard error on every stage resolver", () => {
  for (const resolver of [resolveModel, resolveEffort, resolveAgent]) {
    assert.throws(() => resolver("GRILL_WITH_SPEC", {}), /unknown stage/i);
  }
});

test("the pi row builds today's exact pinned-command shape", () => {
  assert.deepEqual(
    buildAgentCommand("pi", {
      provider: "opencode-go",
      model: "opencode-go/glm-5.3",
      effort: "max",
      pointers: "the pointers",
    }),
    ["pi", "--print", "--provider", "opencode-go", "--model", "opencode-go/glm-5.3", "--thinking", "max", "the pointers"]
  );
});

test("the pointers travel as one argv element, verbatim", () => {
  const pointers = "read the report at /tmp/review report's path.md";
  const command = buildAgentCommand("pi", { provider: "opencode-go", model: "m", effort: "high", pointers });
  assert.equal(command.at(-1), pointers);
});

test("every AGENT_COMMANDS row carries a binary, a Kepler adapterId, a doc source and an args builder", () => {
  assert.deepEqual(Object.keys(AGENT_COMMANDS), AGENTS);
  const expected = {
    pi: { binary: "pi", adapterId: "pi" },
    opencode: { binary: "opencode", adapterId: "opencode" },
    codex: { binary: "codex", adapterId: "codex" },
    "claude-code": { binary: "claude", adapterId: "claude-code" },
    grok: { binary: "grok", adapterId: "grok" },
    "cursor-cli": { binary: "agent", adapterId: "cursor" },
  };
  for (const agent of AGENTS) {
    const row = AGENT_COMMANDS[agent];
    assert.equal(row.binary, expected[agent].binary, agent);
    assert.equal(row.adapterId, expected[agent].adapterId, agent);
    assert.ok(Array.isArray(row.docs) && row.docs.length > 0, `${agent} has no doc source`);
    assert.ok(row.docs.every((doc) => typeof doc === "string" && doc.length > 0), `${agent} doc sources must be strings`);
    assert.equal(typeof row.args, "function", `${agent} args must be a builder`);
  }
});

test("each external row builds its documented headless command from the pins", () => {
  const pin = { provider: "opencode-go", model: "vendor/model-x", effort: "high", pointers: "p" };
  assert.deepEqual(buildAgentCommand("opencode", pin), [
    "opencode", "run", "--model", "vendor/model-x", "--variant", "high", "p",
  ]);
  assert.deepEqual(buildAgentCommand("codex", pin), [
    "codex", "exec", "--model", "vendor/model-x", "-c", "model_reasoning_effort=high", "p",
  ]);
  assert.deepEqual(buildAgentCommand("claude-code", pin), [
    "claude", "-p", "--model", "vendor/model-x", "--effort", "high", "p",
  ]);
  assert.deepEqual(buildAgentCommand("grok", pin), [
    "grok", "-p", "--model", "vendor/model-x", "--effort", "high", "p",
  ]);
  assert.deepEqual(buildAgentCommand("cursor-cli", pin), [
    "agent", "-p", "--model", "vendor/model-x", "p",
  ]);
});

test("cursor-cli does not invent an effort flag the official docs do not document", () => {
  const argv = buildAgentCommand("cursor-cli", { model: "m", effort: "max", pointers: "p" });
  assert.ok(!argv.includes("--effort"));
  assert.ok(!argv.includes("--thinking"));
  assert.ok(!argv.join(" ").includes("max"));
});

test("an unknown agent is a hard error", () => {
  assert.throws(() => buildAgentCommand("gemini", { model: "m", pointers: "p" }), /unknown agent/i);
});

test("every stage's resolved pins compose into its agent's command", () => {
  for (const stage of Object.keys(TODAYS_PINS.stages)) {
    const argv = buildAgentCommand(resolveAgent(stage, {}), {
      provider: resolveProvider({}),
      model: resolveModel(stage, {}),
      effort: resolveEffort(stage, {}),
      pointers: "p",
    });
    assert.ok(argv.includes(TODAYS_PINS.stages[stage].model), stage);
    assert.equal(argv.at(-1), "p", stage);
  }
});
