import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, PROVIDER_KEY_VARS } from "./scripts/env-defaults.mjs";
import {
  DEFAULT_KEY_ENV,
  FALLBACK_SCENARIO,
  FIXTURE,
  FIXTURE_KEY,
  GRILL_SCENARIOS,
  INVALID_VALUE_CASES,
  LAUNCH_SCENARIOS,
  LAUNCH_STAGE_NAMES,
  MISSING_KEY_CASES,
  defaultCommand,
  defaultPin,
  piCommand,
} from "./harness/fixture_data.mjs";
import {
  injectedCommand,
  rejectingFetch,
  runGrillFixture,
  runLaunchFixture,
} from "./harness/run_fixture.mjs";

// The fixture harness is the end-to-end behavior proof (spec #160, testing
// seam 3): a real `launchStage` / `openGrillSession` call, a controlled
// `deps.env`, a fake Kepler API bound to loopback, and no network beyond it.
// Default pin *values* come from env-defaults.mjs (ticket #162's rule); only
// deliberately explicit scenario values are literals.

/** The command carries no key: no variable name, no value, no assignment prefix. */
function assertNoKeyInjected(command, { keyVariable, keyValue }) {
  assert.equal(typeof command, "string");
  assert.ok(!command.includes(keyVariable), `no ${keyVariable} in the command`);
  assert.ok(!command.includes(keyValue), "no key value in the command");
  assert.doesNotMatch(command, /^\w+=/, "no VAR='key' prefix");
}

test("provider API keys are not sent to Kepler or injected into any launch stage", async () => {
  for (const stage of LAUNCH_STAGE_NAMES) {
    const out = await runLaunchFixture({ stage, env: DEFAULT_KEY_ENV });
    assert.equal(out.error, null, `${stage}: ${out.error?.message}`);
    assert.equal(out.result.path, "api", stage);
    assert.deepEqual(out.spawnCalls, [], `${stage}: the nohup fallback never runs`);
    assert.equal(out.inputs.length, 1, stage);
    assert.equal(injectedCommand(out.input), defaultCommand(stage), stage);
    assert.ok(!injectedCommand(out.input).includes("API_KEY"), `${stage}: no key variable is ever injected`);
    assert.ok(!out.input.includes(FIXTURE_KEY), `${stage}: no key value is ever injected`);
    assert.ok(!JSON.stringify(out.calls).includes("API_KEY"), `${stage}: no key variable is sent to Kepler`);
    assert.ok(!JSON.stringify(out.calls).includes(FIXTURE_KEY), `${stage}: no key value is sent to Kepler`);
  }
});

test("the fixture drives the real helper over loopback HTTP: start, input, buffer verification", async () => {
  const out = await runLaunchFixture({ stage: "dev-flow", env: DEFAULT_KEY_ENV });
  assert.match(out.apiBase, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(
    out.calls.map((call) => `${call.method} ${call.path}`),
    ["POST /terminal/start", "POST /terminal/input", "GET /terminal/buffer"]
  );
  assert.deepEqual(out.calls[0].body, {
    ...FIXTURE.ids,
    worktreePath: FIXTURE.worktreePath,
    label: `chain #${FIXTURE.spec}: dev-flow`,
  });
  assert.equal(out.result.terminalId, "term-fixture");
});

test("provider switch selects its model provider without sending its API key", async () => {
  const scenario = LAUNCH_SCENARIOS["provider-switch"];
  const provider = scenario.env.DEV_ENV_PROVIDER;
  const keyVariable = PROVIDER_KEY_VARS[provider];
  assert.equal(scenario.env[keyVariable], FIXTURE_KEY, "the fixture env carries the provider's own key variable");

  const out = await runLaunchFixture(scenario);
  assert.equal(out.error, null);
  assert.equal(out.result.path, "api");
  const command = injectedCommand(out.input);
  assert.equal(command, scenario.expectedCommand);
  assert.equal(
    command,
    piCommand({ ...defaultPin(scenario.stage), provider }),
    "the provider's default-pin command shape, unchanged"
  );
  assertNoKeyInjected(command, { keyVariable, keyValue: FIXTURE_KEY });
  assert.ok(!JSON.stringify(out.calls).includes(keyVariable));
  assert.ok(!JSON.stringify(out.calls).includes(FIXTURE_KEY));
  assert.deepEqual(out.spawnCalls, [], "the nohup fallback never runs");
});

test("per-stage retune: the stage's model and effort change only that stage's command", async () => {
  const scenario = LAUNCH_SCENARIOS["per-stage-retune"];
  const [retuned, sibling] = scenario.runs;
  const retunedOut = await runLaunchFixture({ stage: retuned.stage, env: scenario.env });
  const siblingOut = await runLaunchFixture({ stage: sibling.stage, env: scenario.env });

  assert.equal(injectedCommand(retunedOut.input), retuned.expectedCommand);
  assert.equal(injectedCommand(siblingOut.input), sibling.expectedCommand);
  assert.notEqual(retuned.expectedCommand, sibling.expectedCommand);
  assert.notEqual(retunedOut.input, siblingOut.input, "only the retuned stage's command changed");
});

test("agent switch: DEV_ENV_AGENT_DEV_FLOW=grok builds grok's documented command shape", async () => {
  const scenario = LAUNCH_SCENARIOS["agent-switch"];
  const out = await runLaunchFixture(scenario);
  assert.equal(out.error, null);
  assert.equal(injectedCommand(out.input), scenario.expectedCommand);
  assert.ok(
    injectedCommand(out.input).startsWith(
      `grok -p --model ${DEFAULTS.stages.DEV_FLOW.model} --effort ${DEFAULTS.stages.DEV_FLOW.effort} `
    )
  );
});

test("invalid value: a readable hard error names the variable and lists the allowed values", async () => {
  for (const { name, variable, env, badValue, allowed } of INVALID_VALUE_CASES) {
    const out = await runLaunchFixture({ stage: "dev-flow", env });
    assert.ok(out.error instanceof Error, name);
    assert.match(out.error.message, new RegExp(variable), name);
    assert.ok(out.error.message.includes(`"${badValue}"`), `${name}: ${out.error.message}`);
    assert.ok(out.error.message.includes(allowed.join(", ")), `${name}: ${out.error.message}`);
    assert.equal(out.inputs.length, 0, `${name}: nothing is injected`);
    assert.deepEqual(out.spawnCalls, [], `${name}: the nohup fallback never runs`);
  }
});

test("provider authentication remains user-managed when API-key env vars are unset or blank", async () => {
  for (const { name, env, keyVariable } of MISSING_KEY_CASES) {
    const out = await runLaunchFixture({ stage: "dev-flow", env });
    assert.equal(out.error, null, name);
    assert.equal(out.result.path, "api", name);
    assert.ok(out.inputs.length > 0, `${name}: stage command is injected`);
    assert.deepEqual(out.spawnCalls, [], `${name}: the nohup fallback never runs`);
    assert.ok(!JSON.stringify(out.calls).includes(keyVariable), `${name}: key variable is not sent to Kepler`);
  }
});

test("fallback launches without forwarding the provider API key to the agent", async () => {
  const scenario = FALLBACK_SCENARIO;
  const keyVariable = scenario.keyVariable;
  const keyValue = scenario.env[keyVariable];
  assert.equal(keyValue, FIXTURE_KEY, "the fixture env carries the provider's own key variable");

  const out = await runLaunchFixture({
    stage: scenario.stage,
    env: scenario.env,
    ids: scenario.ids,
    fetchImpl: rejectingFetch(scenario.fetchError),
  });

  assert.equal(out.error, null);
  assert.equal(out.result.path, "nohup");
  assert.equal(out.result.reason, scenario.fetchError);
  assert.equal(out.result.command, scenario.expectedCommand);
  assert.equal(out.result.log, `/tmp/skillbook-${scenario.stage}-pi.log`);
  assert.deepEqual(out.calls, [], "the injected fetch never reached the loopback fake");
  assert.deepEqual(out.inputs, [], "nothing is injected into a terminal");
  assert.equal(out.spawnCalls.length, 1, "exactly one detached spawn");

  const [command, args, options] = out.spawnCalls[0];
  assert.equal(command, "sh");
  assert.equal(args[0], "-c");
  assert.equal(
    args[1],
    `nohup ${scenario.expectedCommand} > /tmp/skillbook-${scenario.stage}-pi.log 2>&1 &`,
    "nohup receives the launchable command, not a key assignment"
  );
  assert.equal(args[1], `nohup ${defaultCommand(scenario.stage)} > /tmp/skillbook-${scenario.stage}-pi.log 2>&1 &`);
  assert.match(args[1], /^nohup pi --print --provider /, "nohup's command argument starts with the binary");
  assertNoKeyInjected(args[1], { keyVariable, keyValue });
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.env[keyVariable], undefined, "the child does not inherit the provider API key");
  assert.ok(!Object.values(options.env).includes(keyValue), "the child environment does not contain the key value");
});

test("grill route: the fake agent API receives the resolved model/effort options and the grill adapterId", async () => {
  const scenario = GRILL_SCENARIOS.defaults;
  const out = await runGrillFixture(scenario);
  assert.equal(out.result.path, "api");
  assert.equal(out.result.sessionId, "sess-fixture");
  assert.deepEqual(out.lines, [`open-grill-session: opened ${scenario.expected.label} as Kepler session sess-fixture`]);

  const create = out.calls.find((call) => call.path === "/agent/sessions");
  const rename = out.calls.find((call) => call.path === "/agent/rename-session");
  const configs = out.calls
    .filter((call) => call.path === "/agent/session-config-option")
    .map((call) => call.body);
  const prompt = out.calls.find((call) => call.path === "/agent/send-prompt");

  assert.equal(create.body.adapterId, scenario.expected.adapterId);
  assert.deepEqual(rename.body, { sessionId: "sess-fixture", name: scenario.expected.label });
  assert.deepEqual(configs, [
    { sessionId: "sess-fixture", configId: "model", value: scenario.expected.model },
    { sessionId: "sess-fixture", configId: "effort", value: scenario.expected.effort },
  ]);
  assert.deepEqual(prompt.body, { sessionId: "sess-fixture", prompt: FIXTURE.reEntryPrompt });
});

test("grill route: an agent switch uses the switched agent's adapterId with the resolved pins", async () => {
  const scenario = GRILL_SCENARIOS["agent-switch"];
  const out = await runGrillFixture(scenario);
  const create = out.calls.find((call) => call.path === "/agent/sessions");
  const configs = out.calls
    .filter((call) => call.path === "/agent/session-config-option")
    .map((call) => call.body);

  assert.equal(create.body.adapterId, scenario.expected.adapterId);
  assert.equal(create.body.adapterId, "claude-code");
  assert.deepEqual(configs, [
    { sessionId: "sess-fixture", configId: "model", value: scenario.expected.model },
    { sessionId: "sess-fixture", configId: "effort", value: scenario.expected.effort },
  ]);
});

test("fully offline: every captured request hit the loopback fake API and no fallback spawn ran", async () => {
  const launch = await runLaunchFixture({ stage: "dev-flow", env: DEFAULT_KEY_ENV });
  const grill = await runGrillFixture({ env: {} });

  for (const out of [launch, grill]) {
    assert.ok(out.calls.length > 0);
    const expectedHost = new URL(out.apiBase).host;
    for (const call of out.calls) {
      assert.equal(call.host, expectedHost, `${call.method} ${call.path} left loopback`);
    }
  }
  assert.equal(launch.result.path, "api");
  assert.deepEqual(launch.spawnCalls, []);
  assert.equal(grill.result.path, "api");
});
