import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ConnectionError,
  KEPLER_DATA_DIR,
  RETRY_ATTEMPTS,
  RETRY_SLEEPS_SECONDS,
  SENTINEL_PREFIX,
  VERIFY_MAX_RELAUNCHES,
  VERIFY_POLL_INTERVAL_MS,
  VERIFY_TIMEOUT_MS,
  agentEnvironment,
  buildResumeCommand,
  buildRetryWrapper,
  buildStageCommand,
  buildTerminalInput,
  chainCore,
  chainLabel,
  commandWithPointer,
  createLabeledSession,
  failureLines,
  isConnectionError,
  launchHelperPath,
  main,
  parseIdFlags,
  pickAnchor,
  reachApi,
  readKeplerApiBase,
  resolveIds,
  runPinEnvironment,
  runSessionHelper,
  sentinelSeen,
  shellQuote,
  stageLabel,
  stagePin,
  stageSentinel,
  stripAnsi,
  wakeHelperPath,
} from "./launch-stage.mjs";
import { AGENTS, AGENT_COMMANDS, DEFAULTS, PROVIDER_KEY_VARS, stageKey } from "./env-defaults.mjs";
import { grillPin } from "./open-grill-session.mjs";

// The env-defaults stage key for each launch stage. Every pin value in these
// tests comes from the defaults module — the tests carry no pin literals.
const STAGE_KEY_BY_NAME = {
  "dev-flow": "DEV_FLOW",
  "implement-spec": "IMPLEMENT_SPEC",
  "code-review-loop": "CODE_REVIEW_LOOP",
  "create-pr": "CREATE_PR",
};
const LAUNCH_STAGES = Object.keys(STAGE_KEY_BY_NAME);

/** The stage's default pins in `stagePin`'s shape, read from the defaults module. */
function defaultPin(stage) {
  const pin = DEFAULTS.stages[STAGE_KEY_BY_NAME[stage]];
  return { provider: DEFAULTS.provider, model: pin.model, effort: pin.effort, agent: pin.agent };
}

/** Today's exact `pi` command shape, expressed from the defaults module's values. */
function piCommand(stage, pointers) {
  const pin = defaultPin(stage);
  return `pi --print --provider ${pin.provider} --model ${pin.model} --thinking ${pin.effort} ${shellQuote(pointers)}`;
}

// The worktree the wrapper tests resume from; the resume command cds into it.
const WORKTREE_PATH = "/work/tree";

/** Tests resolve pins hermetically: an explicit `{}` env, never the ambient one. */
const NO_ENV = {};

/** A hostile caller env used to prove API keys are not forwarded to agents. */
const LAUNCH_ENV = { [PROVIDER_KEY_VARS[DEFAULTS.provider]]: "sk-test" };

function resumeCommand(stage, spec, pointers) {
  return buildResumeCommand({ stage, spec, pointers, worktreePath: WORKTREE_PATH });
}

// --- the pins: env-defaults plus DEV_ENV_* ---

test("stageKey maps every launch stage to its env-defaults key and rejects the rest", () => {
  for (const [stage, key] of Object.entries(STAGE_KEY_BY_NAME)) assert.equal(stageKey(stage), key);
  assert.throws(() => stageKey("grill-with-spec"), /unknown stage/i);
  assert.throws(() => stageKey("made-up"), /unknown stage/i);
});

test("the launch helper does not re-export the stage guard", async () => {
  const launch = await import("./launch-stage.mjs");
  assert.equal(Object.hasOwn(launch, "stageKey"), false); // the wake helper imports the real target
});

test("the launch guard rejects the grill stage while the grill helper's grillPin still resolves it", () => {
  // The regression: #162's guard validated against all of DEFAULTS.stages, so
  // `grill` built a launch command instead of erroring. The launch helper's
  // stage set is the four launch stages; GRILL belongs to grillPin.
  assert.throws(
    () => stageKey("grill"),
    /unknown stage "grill" — expected one of dev-flow, implement-spec, code-review-loop, create-pr/
  );
  assert.throws(() => stageKey("GRILL"), /unknown stage/i);
  assert.throws(() => stagePin("grill", NO_ENV), /unknown stage/i);
  assert.throws(() => buildStageCommand("grill", "pointers", NO_ENV), /unknown stage/i);

  // The split guard: the grill helper resolves GRILL through the same
  // env-defaults tables, including the stage's model, effort and adapterId.
  assert.deepEqual(grillPin(NO_ENV), {
    model: DEFAULTS.stages.GRILL.model,
    effort: DEFAULTS.stages.GRILL.effort,
    adapterId: AGENT_COMMANDS[DEFAULTS.stages.GRILL.agent].adapterId,
  });
});

test("stagePin resolves each stage to the defaults module's pins with no DEV_ENV_* set", () => {
  for (const stage of LAUNCH_STAGES) assert.deepEqual(stagePin(stage, NO_ENV), defaultPin(stage));
});

test("a set DEV_ENV_ wins for provider, model, effort and agent", () => {
  assert.deepEqual(
    stagePin("dev-flow", {
      DEV_ENV_PROVIDER: "anthropic",
      DEV_ENV_MODEL_DEV_FLOW: "anthropic/claude-opus-5",
      DEV_ENV_EFFORT_DEV_FLOW: "high",
      DEV_ENV_AGENT_DEV_FLOW: "claude-code",
    }),
    { provider: "anthropic", model: "anthropic/claude-opus-5", effort: "high", agent: "claude-code" }
  );
});

test("whitespace-only DEV_ENV_ values read as unset and the defaults apply", () => {
  assert.deepEqual(
    stagePin("dev-flow", {
      DEV_ENV_PROVIDER: "  ",
      DEV_ENV_MODEL_DEV_FLOW: "\t",
      DEV_ENV_EFFORT_DEV_FLOW: " ",
      DEV_ENV_AGENT_DEV_FLOW: "\n",
    }),
    defaultPin("dev-flow")
  );
});

test("an off-list provider, effort or agent is a hard error naming the variable", () => {
  assert.throws(() => buildStageCommand("dev-flow", "pointers", { DEV_ENV_PROVIDER: "wat" }), /DEV_ENV_PROVIDER/);
  assert.throws(
    () => buildStageCommand("dev-flow", "pointers", { DEV_ENV_EFFORT_DEV_FLOW: "turbo" }),
    /DEV_ENV_EFFORT_DEV_FLOW/
  );
  assert.throws(
    () => buildStageCommand("dev-flow", "pointers", { DEV_ENV_AGENT_DEV_FLOW: "gemini" }),
    /DEV_ENV_AGENT_DEV_FLOW/
  );
});

test("an unknown stage is a hard error before any environment is read", () => {
  assert.throws(() => stagePin("grill-with-spec", { DEV_ENV_PROVIDER: "wat" }), /unknown stage/i);
  assert.throws(() => buildStageCommand("made-up", "pointers", NO_ENV), /unknown stage/i);
});

// --- the command: built through the resolved agent's AGENT_COMMANDS row ---

test("commandWithPointer names the pointers: a call that misses them is a readable error, not the quoted literal 'undefined'", () => {
  assert.throws(
    () => commandWithPointer(["pi", "--print", "--model", "glm-4.6"]),
    { message: 'commandWithPointer: the argv must end with the pointers — got "glm-4.6", pointers undefined' },
    "the pointers omitted"
  );
  assert.throws(
    () => commandWithPointer(["pi", "--print", undefined], "pointers"),
    { message: 'commandWithPointer: the argv must end with the pointers — got undefined, pointers "pointers"' },
    "the argv's last element is not the pointers (the old 'undefined' case)"
  );
});

test("commandWithPointer quotes the explicit pointers and shell-tokenizes the rest", () => {
  const pointers = "the maintainer's pointers";
  assert.equal(
    commandWithPointer(["pi", "--print", "--model", "glm-4.6", pointers], pointers),
    "pi --print --model glm-4.6 'the maintainer'\\''s pointers'"
  );
});

test("buildStageCommand pins provider, model, effort and quotes the pointers", () => {
  assert.equal(
    buildStageCommand("code-review-loop", "the maintainer's pointers", NO_ENV),
    piCommand("code-review-loop", "the maintainer's pointers")
  );
});

test("pointers with an embedded single quote are shell-quoted safely", () => {
  assert.equal(shellQuote("it's #55"), "'it'\\''s #55'");
  assert.equal(
    buildStageCommand("create-pr", "the maintainer's pointers", NO_ENV),
    piCommand("create-pr", "the maintainer's pointers")
  );
});

test("a DEV_ENV_-set environment builds the command from the resolved pins through that agent's row", () => {
  const env = {
    DEV_ENV_PROVIDER: "anthropic",
    DEV_ENV_MODEL_DEV_FLOW: "anthropic/claude-opus-5",
    DEV_ENV_EFFORT_DEV_FLOW: "xhigh",
    DEV_ENV_AGENT_DEV_FLOW: "claude-code",
    ANTHROPIC_API_KEY: "sk-ant",
  };
  assert.equal(
    buildStageCommand("dev-flow", "pointers", env),
    "claude -p --model anthropic/claude-opus-5 --effort xhigh 'pointers'"
  );
});

test("every AGENT_COMMANDS row builds the stage command from its binary and args", () => {
  for (const agent of AGENTS) {
    const pin = defaultPin("dev-flow");
    const argv = [
      AGENT_COMMANDS[agent].binary,
      ...AGENT_COMMANDS[agent].args({
        provider: pin.provider,
        model: pin.model,
        effort: pin.effort,
        pointers: "pointers",
      }),
    ];
    assert.equal(
      buildStageCommand("dev-flow", "pointers", { DEV_ENV_AGENT_DEV_FLOW: agent }),
      `${argv.slice(0, -1).join(" ")} 'pointers'`,
      agent
    );
  }
});

test("the pointers travel as one shell-quoted argument for every agent row", () => {
  const pointers = "read the report at /tmp/review report's path.md";
  for (const agent of AGENTS) {
    assert.ok(
      buildStageCommand("dev-flow", pointers, { DEV_ENV_AGENT_DEV_FLOW: agent }).endsWith(shellQuote(pointers)),
      agent
    );
  }
});

// --- provider authentication remains user-managed ---

test("the built command carries no key and no variable prefix, whatever the environment holds", () => {
  const keyVariable = PROVIDER_KEY_VARS[DEFAULTS.provider];
  const keyed = buildStageCommand("dev-flow", "pointers", { [keyVariable]: "sk-test" });
  assert.equal(keyed, piCommand("dev-flow", "pointers"));
  assert.equal(keyed, buildStageCommand("dev-flow", "pointers", NO_ENV), "the key's presence changes nothing");
  assert.ok(!keyed.includes("API_KEY"), "no key variable rides the command");
  assert.ok(!keyed.includes("sk-test"), "no key value rides the command");
});

test("every stage's command is byte-identical whether the provider's key resolves or not", () => {
  const keyVariable = PROVIDER_KEY_VARS[DEFAULTS.provider];
  for (const stage of LAUNCH_STAGES) {
    assert.equal(
      buildStageCommand(stage, "pointers", {}),
      buildStageCommand(stage, "pointers", { [keyVariable]: "sk-test" }),
      stage
    );
  }
});

test("agentEnvironment strips provider API keys but preserves ordinary variables", () => {
  const env = {
    PATH: "/bin",
    DEV_ENV_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "sk-ant",
    OPENAI_API_KEY: "sk-openai",
    DEV_ENV_API_KEY: "legacy-key",
    GITHUB_TOKEN: "github-token",
  };
  assert.deepEqual(agentEnvironment(env), { PATH: "/bin", DEV_ENV_PROVIDER: "anthropic" });
});

test("an API launch does not require the caller's API key; authentication is user-managed by Kepler", async () => {
  const { fetchImpl } = mockKeplerApi({ terminalId: "term-auth" });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  const result = await main(
    ["dev-flow", "55", "pointers", "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"],
    {
      env: NO_ENV,
      apiBase: "http://api.test",
      fetchImpl,
      spawnImpl,
      write: () => {},
    }
  );
  assert.equal(result.path, "api");
  assert.equal(result.terminalId, "term-auth");
  assert.equal(spawnCalls.length, 0);
});

test("a whitespace-only provider API key does not block the user-managed offline fallback", async () => {
  const keyVariable = PROVIDER_KEY_VARS[DEFAULTS.provider];
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  const result = await main(["dev-flow", "55", "pointers"], {
    env: { [keyVariable]: "   " },
    apiBase: "http://127.0.0.1:1",
    fetchImpl: async () => {
      throw new Error("fetch failed");
    },
    spawnImpl,
    write: () => {},
  });
  assert.equal(result.path, "nohup");
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][2].env[keyVariable], undefined);
});

test("buildTerminalInput terminates the injected retry wrapper with a newline", () => {
  assert.equal(
    buildTerminalInput("dev-flow", "55", "pointers", WORKTREE_PATH, NO_ENV),
    `${buildRetryWrapper("dev-flow", "55", "pointers", WORKTREE_PATH, NO_ENV)}\n`
  );
});

// --- the helper's post-injection check: the execution sentinel ---

test("chainCore builds the chain #<spec> <stage> core the sentinel and the FAILED marker use", () => {
  assert.equal(chainCore("55", "dev-flow"), "chain #55 dev-flow");
  assert.equal(chainCore(77, "code-review-loop"), "chain #77 code-review-loop");
  assert.throws(() => chainCore("abc", "dev-flow"), { message: 'spec must be a number — got "abc"' });
  assert.ok(stageSentinel("55", "dev-flow").includes(chainCore("55", "dev-flow")));
  assert.ok(
    buildRetryWrapper("dev-flow", "55", "pointers", WORKTREE_PATH, NO_ENV).includes(
      `FAILED: ${chainCore("55", "dev-flow")} gave up after ${RETRY_ATTEMPTS} attempts`
    )
  );
});

test("chainLabel builds the chain #<spec>: <stage> terminal label — the named label shape", () => {
  assert.equal(chainLabel("55", "dev-flow"), "chain #55: dev-flow");
  assert.equal(chainLabel(77, "code-review-loop"), "chain #77: code-review-loop");
  assert.throws(() => chainLabel("abc", "dev-flow"), { message: 'spec must be a number — got "abc"' });
});

test("stageSentinel is the documented CHAIN-STAGE-START line and guards the spec", () => {
  assert.equal(SENTINEL_PREFIX, "CHAIN-STAGE-START:");
  assert.equal(stageSentinel("55", "dev-flow"), "CHAIN-STAGE-START: chain #55 dev-flow");
  assert.throws(() => stageSentinel("spec-55", "dev-flow"), /spec/i);
});

test("the wrapper prints the sentinel as its first action, before attempt 1", () => {
  const wrapper = buildRetryWrapper("dev-flow", "55", "pointers", WORKTREE_PATH, NO_ENV);
  const assignments = Object.entries(runPinEnvironment(NO_ENV))
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  assert.ok(
    wrapper.startsWith(
      `printf '%s\\n' ${shellQuote(stageSentinel("55", "dev-flow"))}; export ${assignments}; chain_attempt=1;`
    )
  );
});

test("sentinelSeen counts only a standalone sentinel line, never the echoed injection", () => {
  const sentinel = stageSentinel("55", "dev-flow");
  const echoed = `user@host:~/worktree$ ${buildTerminalInput("dev-flow", "55", "pointers", WORKTREE_PATH, NO_ENV)}`;
  assert.equal(sentinelSeen(echoed, sentinel), false);
  assert.equal(sentinelSeen(`user@host:~/worktree$ \r\n${sentinel}\r\n`, sentinel), true);
  assert.equal(stripAnsi(`\u001b[32m${sentinel}\u001b[0m\r\n`), `${sentinel}\r\n`);
});

test("the verification constants are the recorded choices: 250 ms poll, 5000 ms timeout, one relaunch", () => {
  assert.equal(VERIFY_POLL_INTERVAL_MS, 250);
  assert.equal(VERIFY_TIMEOUT_MS, 5000);
  assert.equal(VERIFY_MAX_RELAUNCHES, 1);
});

// --- the retry wrapper ---

test("the retry wrapper attempts the command 5 times with doubling sleeps over a 10-minute window", () => {
  const wrapper = buildRetryWrapper("dev-flow", "55", "pointers", WORKTREE_PATH, NO_ENV);
  assert.equal(RETRY_ATTEMPTS, 5);
  assert.deepEqual(RETRY_SLEEPS_SECONDS, [40, 80, 160, 320]);
  assert.equal(RETRY_SLEEPS_SECONDS.reduce((total, seconds) => total + seconds, 0), 600);
  assert.ok(wrapper.includes('chain_attempt=1; chain_status=0; while [ "$chain_attempt" -le 5 ]; do '));
  assert.ok(
    wrapper.includes('case "$chain_attempt" in 1) sleep 40;; 2) sleep 80;; 3) sleep 160;; 4) sleep 320;; esac;')
  );
});

test("the pinned command sits inside the wrapper unchanged", () => {
  const wrapper = buildRetryWrapper("dev-flow", "55", "pointers", WORKTREE_PATH, NO_ENV);
  assert.ok(wrapper.includes(`do ${buildStageCommand("dev-flow", "pointers", NO_ENV)}; chain_status=$?;`));
});

test("the resume command re-enters the protected launch route from the worktree", () => {
  assert.equal(launchHelperPath(), fileURLToPath(new URL("./launch-stage.mjs", import.meta.url)));
  const assignments = Object.entries(runPinEnvironment(NO_ENV))
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  assert.equal(
    buildResumeCommand({
      stage: "dev-flow",
      spec: "55",
      pointers: "pointers",
      worktreePath: WORKTREE_PATH,
      env: NO_ENV,
    }),
    `cd '${WORKTREE_PATH}' && export ${assignments} && node '${launchHelperPath()}' dev-flow 55 'pointers'`
  );
});

test("only allowlisted non-secret pin overrides reach stage children and resume commands", () => {
  const env = {
    DEV_ENV_PROVIDER: "anthropic",
    DEV_ENV_MODEL_IMPLEMENT_SPEC: "anthropic/claude-opus-5",
    DEV_ENV_EFFORT_IMPLEMENT_SPEC: "high",
    DEV_ENV_AGENT_IMPLEMENT_SPEC: "claude-code",
    DEV_ENV_UNKNOWN: "ignored",
    DEV_ENV_API_KEY: "must-not-leak",
    ANTHROPIC_API_KEY: "also-must-not-leak",
  };
  const pins = runPinEnvironment(env);
  const pinNames = [
    "DEV_ENV_PROVIDER",
    ...Object.keys(DEFAULTS.stages).flatMap((stage) =>
      ["MODEL", "EFFORT", "AGENT"].map((field) => `DEV_ENV_${field}_${stage}`)
    ),
  ];
  assert.deepEqual(
    pins,
    Object.fromEntries(pinNames.map((name) => [name, env[name] === undefined ? "" : env[name].trim()]))
  );

  const exported = Object.entries(pins).map(([name, value]) => `${name}=${shellQuote(value)}`).join(" ");
  const wrapper = buildRetryWrapper("dev-flow", "55", "pointers", WORKTREE_PATH, env);
  assert.ok(wrapper.includes(`; export ${exported}; chain_attempt=1;`));
  assert.ok(!wrapper.includes("must-not-leak"));
  assert.ok(!wrapper.includes("ANTHROPIC_API_KEY"));

  const resume = buildResumeCommand({
    stage: "dev-flow",
    spec: "55",
    pointers: "pointers",
    worktreePath: WORKTREE_PATH,
    env,
  });
  assert.ok(resume.startsWith(`cd '${WORKTREE_PATH}' && export ${exported} && node `));
  assert.ok(!resume.includes("must-not-leak"));
  assert.ok(!resume.includes("ANTHROPIC_API_KEY"));
});

test("empty caller pins clear conflicting server overrides in child and resume environments", () => {
  const serverEnv = {
    DEV_ENV_PROVIDER: "openai",
    DEV_ENV_MODEL_DEV_FLOW: "openai/server-model",
    DEV_ENV_EFFORT_DEV_FLOW: "high",
    DEV_ENV_AGENT_DEV_FLOW: "codex",
  };
  const callerPins = runPinEnvironment({
    DEV_ENV_PROVIDER: " ",
    DEV_ENV_MODEL_DEV_FLOW: "",
    DEV_ENV_EFFORT_DEV_FLOW: "\t",
    DEV_ENV_AGENT_DEV_FLOW: undefined,
  });
  const childEnv = { ...serverEnv, ...callerPins };

  assert.equal(buildStageCommand("dev-flow", "pointers", childEnv), buildStageCommand("dev-flow", "pointers", NO_ENV));
  const resume = buildResumeCommand({
    stage: "dev-flow",
    spec: "55",
    pointers: "pointers",
    worktreePath: WORKTREE_PATH,
    env: { DEV_ENV_PROVIDER: " ", DEV_ENV_AGENT_DEV_FLOW: "" },
  });
  assert.ok(resume.includes("DEV_ENV_PROVIDER=''"));
  assert.ok(resume.includes("DEV_ENV_AGENT_DEV_FLOW=''"));
});

test("the give-up marker names the spec, the stage and the launch-helper resume command on one line each", () => {
  const wrapper = buildRetryWrapper("code-review-loop", "55", "pointers", WORKTREE_PATH, NO_ENV);
  const resume = buildResumeCommand({
    stage: "code-review-loop",
    spec: "55",
    pointers: "pointers",
    worktreePath: WORKTREE_PATH,
    env: NO_ENV,
  });
  assert.ok(wrapper.includes(shellQuote("FAILED: chain #55 code-review-loop gave up after 5 attempts")));
  assert.ok(wrapper.includes(shellQuote(`FAILED: resume with: ${resume}`)));
  assert.ok(
    !wrapper.includes(
      shellQuote(
        `FAILED: resume with: ${piCommand("code-review-loop", "pointers")}`
      )
    ),
    "the resume line is the launch invocation, not the bare pinned command"
  );
});

test("the wrapper actuates the wake through the sibling helper's absolute path and the resume command", () => {
  const wrapper = buildRetryWrapper("dev-flow", "55", "pointers", WORKTREE_PATH, NO_ENV);
  const wakePath = wakeHelperPath();
  assert.equal(wakePath, fileURLToPath(new URL("./open-wake-session.mjs", import.meta.url)));
  assert.ok(
    wrapper.includes(`node ${shellQuote(wakePath)} dev-flow 55 ${shellQuote(resumeCommand("dev-flow", "55", "pointers"))};`)
  );
  assert.ok(!wrapper.includes(`node ${shellQuote(wakePath)} dev-flow 55 ${shellQuote(buildStageCommand("dev-flow", "pointers", NO_ENV))};`));
});

test("each launching skill runs its helpers from an isolated installed folder", async () => {
  const installed = mkdtempSync(join(tmpdir(), "software-factory-installed-"));
  try {
    for (const skill of ["grill-with-spec", "dev-flow", "code-review-loop"]) {
      const folder = join(installed, skill);
      cpSync(new URL(`../${skill}/`, import.meta.url), folder, { recursive: true });
      const { main: installedMain } = await import(pathToFileURL(join(folder, "scripts/launch-stage.mjs")));
      const { fetchImpl, calls } = mockKeplerApi({ terminals: [] });
      await installedMain(
        ["dev-flow", "55", "pointers", "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"],
        { env: LAUNCH_ENV, apiBase: "http://api.test", fetchImpl, worktreePath: "/work/tree", write: () => {} }
      );
      assert.equal(calls[0].body.worktreePath, "/work/tree");
      const wake = await import(pathToFileURL(join(folder, "scripts/open-wake-session.mjs")));
      assert.equal(typeof wake.main, "function");
      if (skill === "code-review-loop") {
        const grill = await import(pathToFileURL(join(folder, "scripts/open-grill-session.mjs")));
        assert.equal(typeof grill.main, "function");
      }
    }
  } finally {
    rmSync(installed, { recursive: true, force: true });
  }
});

test("direct helper entrypoints execute when invoked through symlinked skill installs", () => {
  const installed = mkdtempSync(join(tmpdir(), "software-factory-symlink-"));
  try {
    const launchLink = join(installed, "launch-stage.mjs");
    const wakeLink = join(installed, "open-wake-session.mjs");
    symlinkSync(fileURLToPath(new URL("./launch-stage.mjs", import.meta.url)), launchLink);
    symlinkSync(fileURLToPath(new URL("./open-wake-session.mjs", import.meta.url)), wakeLink);

    const launch = spawnSync(process.execPath, [launchLink], { encoding: "utf8" });
    assert.equal(launch.status, 1);
    assert.match(launch.stderr, /usage: launch-stage\.mjs/);

    const wake = spawnSync(process.execPath, [wakeLink], { encoding: "utf8" });
    assert.equal(wake.status, 1);
    assert.match(wake.stderr, /open-wake-session: usage:/);
  } finally {
    rmSync(installed, { recursive: true, force: true });
  }
});

test("the shared fresh/re-entry status request encodes all required fields safely", () => {
  const text = readFileSync(new URL("../grill-with-spec/SKILL.md", import.meta.url), "utf8");
  const command = /-d "\$\((jq -n[\s\S]*?)\)" \\/.exec(text)?.[1];
  assert.ok(command, "the status terminal body must be constructed with jq");
  const worktreePath = '/work/a "quoted"\\tree';
  const result = spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, REPO_ID: "r", WORKTREE_ID: "w", TASK_ID: "t", WORKTREE: worktreePath, SPEC: "55" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    repoId: "r", worktreeId: "w", taskId: "t", worktreePath, label: "chain #55: status",
  });
});

test("the status loop surfaces printed FAILED markers and ignores the wrapper's quoted echo", () => {
  const text = readFileSync(new URL("../grill-with-spec/SKILL.md", import.meta.url), "utf8");
  assert.ok(text.includes("terminal/buffer?terminalId=$tid"), "the loop reads each chain terminal's buffer");
  const pattern = /\| grep -Eq "([^"]+)"/.exec(text)?.[1];
  assert.ok(pattern, "the loop must grep the stripped buffer for the FAILED marker");
  assert.ok(text.includes("and .label != $status"), "the loop must skip the status terminal's own buffer");
  const marker = pattern.replace("$SPEC", "55");
  const matches = (sample) => spawnSync("grep", ["-Eq", marker], { input: sample }).status === 0;
  assert.equal(matches("\rFAILED: chain #55 dev-flow gave up after 5 attempts\r\n"), true);
  assert.equal(
    matches("$ printf '%s\\n' 'FAILED: chain #55 dev-flow gave up after 5 attempts' 'FAILED: resume with: pi --print ...'\n"),
    false
  );
  assert.equal(matches("FAILED: resume with: pi --print ...\n"), false);
});

test("the status loop passes worktree values as quoted shell assignments", () => {
  const text = readFileSync(new URL("../grill-with-spec/SKILL.md", import.meta.url), "utf8");
  assert.ok(text.includes('git -C "$WORKTREE"'), "the loop uses the WORKTREE variable");
  assert.ok(text.includes('curl -s "$API/terminal/list"'), "the loop uses the API variable");
  assert.ok(text.includes('FAILED: chain #$SPEC '), "the loop uses the SPEC variable");
  assert.ok(!/__WORKTREE__|__API__|__SPEC__/.test(text), "the loop does not substitute values into code");
  assert.match(
    text,
    /LOOP=\$\(printf 'WORKTREE=%q\\nAPI=%q\\nSPEC=%q\\n%s' "\$WORKTREE" "\$API" "\$SPEC" "\$LOOP"\)/
  );

  const marker = join(tmpdir(), `software-factory-injection-${process.pid}`);
  rmSync(marker, { force: true });
  const worktreePath = `/work/tree & "$(touch ${marker})"`;
  const render = [
    "LOOP=$(printf 'WORKTREE=%q\\nAPI=%q\\nSPEC=%q\\n%s' \"$WORKTREE\" \"$API\" \"$SPEC\" \"$LOOP_BODY\")",
    'eval "$LOOP"',
  ].join("\n");
  const result = spawnSync("bash", ["-c", render], {
    encoding: "utf8",
    env: {
      ...process.env,
      WORKTREE: worktreePath,
      API: "http://api.test",
      SPEC: "55",
      LOOP_BODY: 'printf "%s" "$WORKTREE"; break',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, worktreePath);
  assert.equal(existsSync(marker), false);
});

test("stageLabel delegates to chainLabel for the packaged helpers", () => {
  assert.equal(stageLabel(77, "code-review-loop"), "chain #77: code-review-loop");
  assert.equal(stageLabel("55", "dev-flow"), "chain #55: dev-flow");
  assert.throws(() => stageLabel("not-a-number", "dev-flow"), /spec/i);
});

// --- the four-piece contract: explicit id flags ---

test("parseIdFlags returns undefined fields when no id flags are given", () => {
  assert.deepEqual(parseIdFlags(["dev-flow", "55", "pointers"]), {
    repoId: undefined,
    worktreeId: undefined,
    taskId: undefined,
  });
});

test("parseIdFlags reads the three id flags", () => {
  assert.deepEqual(
    parseIdFlags(["dev-flow", "55", "pointers", "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"]),
    { repoId: "r", worktreeId: "w", taskId: "t" }
  );
});

test("parseIdFlags throws on a partial id set", () => {
  assert.throws(() => parseIdFlags(["dev-flow", "55", "pointers", "--repo-id", "r"]), /--repo-id/);
  assert.throws(() => parseIdFlags(["--worktree-id", "w"]), /--repo-id/);
});

test("parseIdFlags throws when a flag value is missing", () => {
  assert.throws(() => parseIdFlags(["dev-flow", "55", "pointers", "--task-id"]), /--task-id/);
});

// --- the four-piece contract: anchor preference ---

test("pickAnchor prefers a chain-labeled terminal on the worktree", () => {
  const worktreePath = "/work/tree";
  const terminals = [
    { worktreePath, label: "Terminal 1", repoId: "plain", worktreeId: "plain", taskId: "plain" },
    { worktreePath, label: "chain #55: implement-spec", repoId: "chain", worktreeId: "chain", taskId: "chain" },
  ];
  assert.equal(pickAnchor(terminals, worktreePath).repoId, "chain");
});

test("pickAnchor accepts any terminal on the worktree when none is chain-labeled", () => {
  const worktreePath = "/work/tree";
  const terminals = [
    { worktreePath: "/somewhere/else", label: "chain #41: dev-flow" },
    { worktreePath, label: "Terminal 1", repoId: "plain", worktreeId: "plain", taskId: "plain" },
  ];
  assert.equal(pickAnchor(terminals, worktreePath).repoId, "plain");
});

test("pickAnchor returns null when the worktree has no terminal", () => {
  assert.equal(pickAnchor([{ worktreePath: "/elsewhere", label: "chain #41: dev-flow" }], "/work/tree"), null);
  assert.equal(pickAnchor([], "/work/tree"), null);
  assert.equal(pickAnchor(undefined, "/work/tree"), null);
});

test("resolveIds returns the explicit flags without touching the API", async () => {
  const ids = await resolveIds({
    apiBase: "http://api.test",
    fetchImpl: async () => {
      throw new Error("the API must not be called");
    },
    worktreePath: "/work/tree",
    flags: { repoId: "r", worktreeId: "w", taskId: "t" },
  });
  assert.deepEqual(ids, { repoId: "r", worktreeId: "w", taskId: "t" });
});

test("resolveIds derives ids from a terminal on the worktree when no flags are given", async () => {
  const { fetchImpl } = mockKeplerApi({
    terminals: [{ worktreePath: "/work/tree", label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
  });
  const ids = await resolveIds({ apiBase: "http://api.test", fetchImpl, worktreePath: "/work/tree" });
  assert.deepEqual(ids, { repoId: "r", worktreeId: "w", taskId: "t" });
});

test("resolveIds throws when there are no flags and no anchor", async () => {
  const { fetchImpl } = mockKeplerApi({ terminals: [] });
  await assert.rejects(
    resolveIds({ apiBase: "http://api.test", fetchImpl, worktreePath: "/work/tree" }),
    /no terminal on/
  );
});

// --- reachApi: the one reach-the-API step ---

test("reachApi resolves the explicit flags against the injected base without touching the API", async () => {
  const reached = await reachApi({
    apiBase: "http://api.test",
    fetchImpl: async () => {
      throw new Error("the API must not be called");
    },
    worktreePath: "/work/tree",
    flags: { repoId: "r", worktreeId: "w", taskId: "t" },
  });
  assert.deepEqual(reached, {
    ok: true,
    apiBase: "http://api.test",
    ids: { repoId: "r", worktreeId: "w", taskId: "t" },
  });
});

test("reachApi derives the base from the data dir and the ids from the anchor terminal", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "reach-api-"));
  const worktreePath = "/work/tree";
  const { fetchImpl, calls } = mockKeplerApi({
    terminals: [{ worktreePath, label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
  });
  try {
    writeFileSync(join(dataDir, "server.host"), "127.0.0.1\n");
    writeFileSync(join(dataDir, "server.port"), "36325\n");
    const reached = await reachApi({ dataDir, fetchImpl, worktreePath });
    assert.deepEqual(reached, {
      ok: true,
      apiBase: "http://127.0.0.1:36325",
      ids: { repoId: "r", worktreeId: "w", taskId: "t" },
    });
    assert.deepEqual(calls.map((call) => call.url), ["http://127.0.0.1:36325/terminal/list"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("reachApi classifies a missing API location as connection-level with the read error preserved", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "reach-api-missing-"));
  try {
    const reached = await reachApi({
      dataDir,
      fetchImpl: async () => {
        throw new Error("the API must not be called");
      },
      worktreePath: "/work/tree",
    });
    assert.equal(reached.ok, false);
    assert.match(reached.error.message, /ENOENT/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("reachApi classifies a connection-level id resolution and preserves the message", async () => {
  const { fetchImpl } = mockKeplerApi({
    handlers: {
      list: () => {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    },
  });
  const reached = await reachApi({ apiBase: "http://127.0.0.1:1", fetchImpl, worktreePath: "/work/tree" });
  assert.equal(reached.ok, false);
  assert.ok(isConnectionError(reached.error));
  assert.equal(reached.error.message, "fetch failed: ECONNREFUSED");
});

test("reachApi throws an anchorless hard error from a reachable API — never a classification", async () => {
  const { fetchImpl } = mockKeplerApi({ terminals: [] });
  await assert.rejects(
    reachApi({ apiBase: "http://api.test", fetchImpl, worktreePath: "/work/tree" }),
    /no terminal on/
  );
});

test("reachApi throws an HTTP error from a reachable API — never a classification", async () => {
  const { fetchImpl } = mockKeplerApi({ handlers: { list: () => errorResponse(500) } });
  await assert.rejects(
    reachApi({ apiBase: "http://api.test", fetchImpl, worktreePath: "/work/tree" }),
    /HTTP 500/
  );
});

// --- the session routes' shared failure report ---

test("failureLines names the route's tool, the error and the created session's id", () => {
  assert.deepEqual(failureLines("open-grill-session", { message: "HTTP 500", sessionId: "sess-1" }), [
    "open-grill-session: HTTP 500",
    "open-grill-session: session sess-1 was already created — terminate it or reuse it",
  ]);
  assert.deepEqual(failureLines("open-wake-session", { message: "fetch failed: ECONNREFUSED" }), [
    "open-wake-session: fetch failed: ECONNREFUSED",
  ]);
});

// --- the session routes' shared create orchestration ---

test("createLabeledSession creates, renames, runs the route's pre-send step, then sends the prompt", async () => {
  const { fetchImpl, calls } = mockAgentApi();
  const preSend = [];
  const result = await createLabeledSession({
    label: "chain #55: grill-with-spec",
    prompt: "Re-enter the grill for spec #55.",
    ids: { repoId: "r", worktreeId: "w", taskId: "t" },
    worktreePath: "/work/tree",
    apiBase: "http://api.test",
    fetchImpl,
    beforeSend: async (sessionId) => {
      preSend.push(sessionId);
    },
  });

  assert.deepEqual(result, { sessionId: "sess-new", label: "chain #55: grill-with-spec" });
  assert.deepEqual(preSend, ["sess-new"]);
  assert.deepEqual(calls, [
    {
      url: "http://api.test/agent/sessions",
      method: "POST",
      body: { adapterId: "opencode", worktreePath: "/work/tree", repoId: "r", worktreeId: "w", taskId: "t" },
    },
    {
      url: "http://api.test/agent/rename-session",
      method: "POST",
      body: { sessionId: "sess-new", name: "chain #55: grill-with-spec" },
    },
    {
      url: "http://api.test/agent/send-prompt",
      method: "POST",
      body: { sessionId: "sess-new", prompt: "Re-enter the grill for spec #55." },
    },
  ]);
});

test("createLabeledSession hard-errors when the create response carries no sessionId", async () => {
  const { fetchImpl, calls } = mockAgentApi({ handlers: { sessions: () => okResponse({}) } });
  await assert.rejects(
    createLabeledSession({
      label: "chain #55: wake — dev-flow",
      prompt: "WAKE NOTICE",
      ids: { repoId: "r", worktreeId: "w", taskId: "t" },
      worktreePath: "/work/tree",
      apiBase: "http://api.test",
      fetchImpl,
    }),
    /sessionId/
  );
  assert.deepEqual(calls.map((call) => call.url), ["http://api.test/agent/sessions"]);
});

test("createLabeledSession tags every failure after creation with the session id", async () => {
  const base = {
    label: "chain #55: wake — dev-flow",
    prompt: "WAKE NOTICE",
    ids: { repoId: "r", worktreeId: "w", taskId: "t" },
    worktreePath: "/work/tree",
    apiBase: "http://api.test",
  };

  const rename = mockAgentApi({ handlers: { rename: () => errorResponse(500) } });
  await assert.rejects(createLabeledSession({ ...base, fetchImpl: rename.fetchImpl }), (error) => {
    assert.match(error.message, /HTTP 500/);
    assert.equal(error.sessionId, "sess-new");
    return true;
  });

  const preSend = mockAgentApi();
  await assert.rejects(
    createLabeledSession({
      ...base,
      fetchImpl: preSend.fetchImpl,
      beforeSend: async () => {
        throw new Error("pin failed");
      },
    }),
    (error) => {
      assert.match(error.message, /pin failed/);
      assert.equal(error.sessionId, "sess-new");
      return true;
    }
  );
});

// --- the session routes' shared shell ---

test("runSessionHelper creates through the route's step and emits the route's success line", async () => {
  const lines = [];
  const contexts = [];
  const result = await runSessionHelper({
    label: "chain #55: grill-with-spec",
    prompt: "Re-enter the grill for spec #55.",
    flags: { repoId: "r", worktreeId: "w", taskId: "t" },
    deps: { env: NO_ENV, apiBase: "http://api.test", worktreePath: "/work/tree", write: (line) => lines.push(line) },
    successLine: (created) => `open-grill-session: opened ${created.label} as Kepler session ${created.sessionId}`,
    fallbackLines: () => assert.fail("the fallback must not be emitted on the API path"),
    create: async (context) => {
      contexts.push(context);
      return { sessionId: "sess-1", label: context.label };
    },
  });

  assert.deepEqual(result, { path: "api", sessionId: "sess-1", label: "chain #55: grill-with-spec" });
  assert.deepEqual(lines, ["open-grill-session: opened chain #55: grill-with-spec as Kepler session sess-1"]);
  assert.deepEqual(contexts, [
    {
      label: "chain #55: grill-with-spec",
      prompt: "Re-enter the grill for spec #55.",
      ids: { repoId: "r", worktreeId: "w", taskId: "t" },
      worktreePath: "/work/tree",
      apiBase: "http://api.test",
      fetchImpl: fetch,
    },
  ]);
});

test("runSessionHelper falls back on a connection-level failure before any session exists", async () => {
  const lines = [];
  const result = await runSessionHelper({
    label: "chain #55: wake — code-review-loop",
    prompt: "WAKE NOTICE",
    fallbackExtra: { resumeCommand: "cd '/work/tree' && node launch-stage.mjs dev-flow 55 'pointers'" },
    deps: {
      env: NO_ENV,
      apiBase: "http://127.0.0.1:1",
      fetchImpl: async () => {
        throw new Error("fetch failed: ECONNREFUSED");
      },
      worktreePath: "/work/tree",
      write: (line) => lines.push(line),
    },
    successLine: () => assert.fail("the success line must not be emitted on the fallback path"),
    fallbackLines: (fellBack) => [
      `open-wake-session: ${fellBack.reason} — wake session not opened`,
      `open-wake-session: ${fellBack.resumeCommand}`,
    ],
    create: async () => assert.fail("a connection-level failure before creation never reaches create"),
  });

  assert.deepEqual(result, {
    path: "fallback",
    label: "chain #55: wake — code-review-loop",
    reason: "fetch failed: ECONNREFUSED",
    resumeCommand: "cd '/work/tree' && node launch-stage.mjs dev-flow 55 'pointers'",
  });
  assert.deepEqual(lines, [
    "open-wake-session: fetch failed: ECONNREFUSED — wake session not opened",
    "open-wake-session: cd '/work/tree' && node launch-stage.mjs dev-flow 55 'pointers'",
  ]);
});

test("runSessionHelper falls back when the route's create step fails before any session exists", async () => {
  const lines = [];
  const result = await runSessionHelper({
    label: "chain #55: wake — dev-flow",
    prompt: "WAKE NOTICE",
    flags: { repoId: "r", worktreeId: "w", taskId: "t" },
    deps: { env: NO_ENV, apiBase: "http://api.test", worktreePath: "/work/tree", write: (line) => lines.push(line) },
    successLine: () => assert.fail("the success line must not be emitted on the fallback path"),
    fallbackLines: (fellBack) => [`open-wake-session: ${fellBack.reason} — wake session not opened`],
    create: async () => {
      throw new ConnectionError("fetch failed: socket hang up");
    },
  });

  assert.deepEqual(result, {
    path: "fallback",
    label: "chain #55: wake — dev-flow",
    reason: "fetch failed: socket hang up",
  });
  assert.deepEqual(lines, ["open-wake-session: fetch failed: socket hang up — wake session not opened"]);
});

test("runSessionHelper hard-errors on a non-connection create failure — never a fallback", async () => {
  const lines = [];
  await assert.rejects(
    runSessionHelper({
      label: "chain #55: grill-with-spec",
      prompt: "Re-enter the grill for spec #55.",
      flags: { repoId: "r", worktreeId: "w", taskId: "t" },
      deps: { env: NO_ENV, apiBase: "http://api.test", worktreePath: "/work/tree", write: (line) => lines.push(line) },
      successLine: () => assert.fail("the success line must not be emitted"),
      fallbackLines: () => assert.fail("a reachable API failure never falls back"),
      create: async () => {
        throw new Error("POST /agent/sessions -> HTTP 500");
      },
    }),
    /HTTP 500/
  );
  assert.deepEqual(lines, []);
});

test("runSessionHelper never falls back once a session exists — the error carries the session id", async () => {
  const lines = [];
  const failure = new ConnectionError("fetch failed: socket hang up");
  failure.sessionId = "sess-created";
  await assert.rejects(
    runSessionHelper({
      label: "chain #55: grill-with-spec",
      prompt: "Re-enter the grill for spec #55.",
      flags: { repoId: "r", worktreeId: "w", taskId: "t" },
      deps: { env: NO_ENV, apiBase: "http://api.test", worktreePath: "/work/tree", write: (line) => lines.push(line) },
      successLine: () => assert.fail("the success line must not be emitted"),
      fallbackLines: () => assert.fail("a failure after creation never falls back"),
      create: async () => {
        throw failure;
      },
    }),
    (error) => {
      assert.equal(error, failure);
      assert.equal(error.sessionId, "sess-created");
      return true;
    }
  );
  assert.deepEqual(lines, []);
});

test("the session routes' shared CLI boot reports a hard error through failureLines", () => {
  for (const [helper, toolName] of [
    ["open-grill-session.mjs", "open-grill-session"],
    ["open-wake-session.mjs", "open-wake-session"],
  ]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(`./${helper}`, import.meta.url))], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`^${toolName}: usage: ${toolName}\\.mjs`));
  }
});

// --- the API path ---

test("the spec argument builds the label — never the anchor terminal's label", async () => {
  const worktreePath = "/work/tree";
  const terminals = [
    {
      worktreePath,
      label: "chain #55: implement-spec",
      repoId: "repo-55",
      worktreeId: "worktree-55",
      taskId: "task-55",
    },
  ];
  const { fetchImpl, calls } = mockKeplerApi({ terminals, terminalId: "term-new" });
  const lines = [];

  const result = await main(["code-review-loop", "77", "the maintainer's pointers"], {
    env: LAUNCH_ENV,
    apiBase: "http://api.test",
    fetchImpl,
    worktreePath,
    write: (line) => lines.push(line),
  });

  assert.equal(result.path, "api");
  assert.equal(result.terminalId, "term-new");
  assert.equal(result.label, "chain #77: code-review-loop");
  assert.deepEqual(lines, ["launch-stage: launched chain #77: code-review-loop in Kepler terminal term-new"]);

  const [list, start, input] = calls;
  assert.deepEqual(list, { url: "http://api.test/terminal/list", method: "GET", body: undefined });
  assert.equal(start.url, "http://api.test/terminal/start");
  assert.equal(start.method, "POST");
  assert.deepEqual(start.body, {
    repoId: "repo-55",
    worktreeId: "worktree-55",
    taskId: "task-55",
    worktreePath,
    label: "chain #77: code-review-loop",
  });
  assert.equal(input.url, "http://api.test/terminal/input");
  assert.deepEqual(input.body, {
    terminalId: "term-new",
    input: buildTerminalInput("code-review-loop", "77", "the maintainer's pointers", worktreePath, NO_ENV),
  });
});

test("caller API keys never ride the API request or launched input", async () => {
  const worktreePath = "/work/tree";
  const terminals = [{ worktreePath, label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }];
  const { fetchImpl, calls } = mockKeplerApi({ terminals });
  const env = {
    DEV_ENV_PROVIDER: "anthropic",
    DEV_ENV_MODEL_DEV_FLOW: "anthropic/opus",
    DEV_ENV_EFFORT_DEV_FLOW: "high",
    DEV_ENV_AGENT_DEV_FLOW: "claude-code",
    ANTHROPIC_API_KEY: "sk-ant",
  };

  const result = await main(["dev-flow", "55", "pointers"], {
    env,
    apiBase: "http://api.test",
    fetchImpl,
    worktreePath,
    write: () => {},
  });

  assert.equal(result.path, "api");
  const input = calls.find((call) => call.url.endsWith("/terminal/input")).body.input;
  assert.ok(
    input.includes("claude -p --model anthropic/opus --effort high 'pointers'"),
    "the launched command is the resolved provider's plain command"
  );
  assert.ok(!input.includes("ANTHROPIC_API_KEY"), "no key variable rides the launched input");
  assert.ok(!input.includes("sk-ant"), "the key value never reaches the injected command");
  const requests = JSON.stringify(calls);
  assert.ok(!requests.includes("ANTHROPIC_API_KEY"), "the key variable is not sent to Kepler");
  assert.ok(!requests.includes("sk-ant"), "the key value is not sent to Kepler");
  const resume = buildResumeCommand({ stage: "dev-flow", spec: "55", pointers: "pointers", worktreePath, env });
  assert.ok(
    input.includes(shellQuote(`FAILED: resume with: ${resume}`)),
    "the resume command re-enters the launch helper"
  );
});

test("the API path prefers the chain-labeled terminal on the worktree", async () => {
  const worktreePath = "/work/tree";
  const terminals = [
    { worktreePath, label: "Terminal 1", repoId: "repo-plain", worktreeId: "worktree-plain", taskId: "task-plain" },
    {
      worktreePath,
      label: "chain #55: dev-flow",
      repoId: "repo-chain",
      worktreeId: "worktree-chain",
      taskId: "task-chain",
    },
    {
      worktreePath: "/somewhere/else",
      label: "chain #41: dev-flow",
      repoId: "repo-other",
      worktreeId: "worktree-other",
      taskId: "task-other",
    },
  ];
  const { fetchImpl, calls } = mockKeplerApi({ terminals });
  const lines = [];

  const result = await main(["create-pr", "55", "pointers"], {
    env: LAUNCH_ENV,
    apiBase: "http://api.test",
    fetchImpl,
    worktreePath,
    write: (line) => lines.push(line),
  });

  assert.equal(result.path, "api");
  assert.equal(result.label, "chain #55: create-pr");
  const start = calls.find((call) => call.url.endsWith("/terminal/start"));
  assert.deepEqual(start.body, {
    repoId: "repo-chain",
    worktreeId: "worktree-chain",
    taskId: "task-chain",
    worktreePath,
    label: "chain #55: create-pr",
  });
});

test("a reachable API with a non-chain terminal on the worktree uses it as the anchor and launches", async () => {
  const { fetchImpl, calls } = mockKeplerApi({
    terminals: [{ worktreePath: "/work/tree", label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  const lines = [];

  const result = await main(["create-pr", "55", "pointers"], {
    env: LAUNCH_ENV,
    apiBase: "http://api.test",
    fetchImpl,
    worktreePath: "/work/tree",
    spawnImpl,
    write: (line) => lines.push(line),
  });

  assert.equal(result.path, "api");
  assert.equal(result.label, "chain #55: create-pr");
  assert.equal(spawnCalls.length, 0);
  const start = calls.find((call) => call.url.endsWith("/terminal/start"));
  assert.deepEqual(start.body, { repoId: "r", worktreeId: "w", taskId: "t", worktreePath: "/work/tree", label: "chain #55: create-pr" });
});

test("a reachable API with no anchor and no flags is a hard error — no fallback", async () => {
  const { fetchImpl } = mockKeplerApi({
    terminals: [{ worktreePath: "/elsewhere", label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["create-pr", "55", "pointers"], {
      env: LAUNCH_ENV,
      apiBase: "http://api.test",
      fetchImpl,
      worktreePath: "/work/tree",
      spawnImpl,
      write: () => {},
    }),
    /no terminal on/
  );
  assert.equal(spawnCalls.length, 0);
});

test("explicit id flags bootstrap a fresh run with no anchor and no list call", async () => {
  const { fetchImpl, calls } = mockKeplerApi({
    terminals: [],
    handlers: {
      list: () => {
        throw new Error("terminal/list must not be called with id flags");
      },
    },
    terminalId: "term-fresh",
  });
  const lines = [];

  const result = await main(
    ["dev-flow", "55", "pointers", "--repo-id", "r", "--worktree-id", "w", "--task-id", "t"],
    { env: LAUNCH_ENV, apiBase: "http://api.test", fetchImpl, worktreePath: '/work/a "quoted"\\tree', write: (line) => lines.push(line) }
  );

  assert.equal(result.path, "api");
  assert.equal(result.label, "chain #55: dev-flow");
  assert.equal(result.terminalId, "term-fresh");
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "http://api.test/terminal/start",
      "http://api.test/terminal/input",
      "http://api.test/terminal/buffer?terminalId=term-fresh",
    ]
  );
  assert.deepEqual(calls[0].body, { repoId: "r", worktreeId: "w", taskId: "t", worktreePath: '/work/a "quoted"\\tree', label: "chain #55: dev-flow" });
});

test("a partial id set is a hard usage error before any fetch or spawn", async () => {
  let fetched = false;
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["dev-flow", "55", "pointers", "--repo-id", "r"], {
      env: NO_ENV,
      apiBase: "http://api.test",
      fetchImpl: async () => {
        fetched = true;
        return okResponse([]);
      },
      spawnImpl,
      write: () => {},
    }),
    /--repo-id/
  );
  assert.equal(fetched, false);
  assert.equal(spawnCalls.length, 0);
});

test("an unknown stage fails hard before any launch path is taken", async () => {
  let fetched = false;
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  await assert.rejects(
    main(["grill-with-spec", "55", "pointers"], {
      env: NO_ENV,
      apiBase: "http://127.0.0.1:1",
      fetchImpl: async () => {
        fetched = true;
        throw new Error("fetch failed");
      },
      spawnImpl,
      write: () => {},
    }),
    /unknown stage/i
  );
  assert.equal(fetched, false);
  assert.equal(spawnCalls.length, 0);
});

test("invalid stage pins fail before any API request or spawn", async () => {
  for (const env of [
    { ...LAUNCH_ENV, DEV_ENV_EFFORT_DEV_FLOW: "turbo" },
    { ...LAUNCH_ENV, DEV_ENV_AGENT_DEV_FLOW: "gemini" },
  ]) {
    let fetched = false;
    const { spawnImpl, calls: spawnCalls } = spawnRecorder();
    await assert.rejects(
      main(["dev-flow", "55", "pointers"], {
        env,
        apiBase: "http://api.test",
        fetchImpl: async () => {
          fetched = true;
          return okResponse([]);
        },
        spawnImpl,
        write: () => {},
      }),
      /DEV_ENV_(EFFORT|AGENT)_DEV_FLOW/
    );
    assert.equal(fetched, false);
    assert.equal(spawnCalls.length, 0);
  }
});

test("the grill stage is not a launch stage and fails hard before any launch path is taken", async () => {
  let fetched = false;
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  await assert.rejects(
    main(["grill", "55", "pointers"], {
      env: NO_ENV,
      apiBase: "http://127.0.0.1:1",
      fetchImpl: async () => {
        fetched = true;
        throw new Error("fetch failed");
      },
      spawnImpl,
      write: () => {},
    }),
    /unknown stage "grill" — expected one of dev-flow, implement-spec, code-review-loop, create-pr/
  );
  assert.equal(fetched, false);
  assert.equal(spawnCalls.length, 0);
});

test("an invalid spec argument fails hard before any launch path is taken", async () => {
  let fetched = false;
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  await assert.rejects(
    main(["dev-flow", "spec-55", "pointers"], {
      env: NO_ENV,
      apiBase: "http://api.test",
      fetchImpl: async () => {
        fetched = true;
        return okResponse([]);
      },
      spawnImpl,
      write: () => {},
    }),
    /spec/i
  );
  assert.equal(fetched, false);
  assert.equal(spawnCalls.length, 0);
});

test("missing positional arguments are a hard usage error", async () => {
  await assert.rejects(main(["dev-flow", "55"]), /usage/i);
  await assert.rejects(main(["dev-flow"]), /usage/i);
});

// --- connection-level fallback only ---

test("a connection-level fetch rejection falls back to nohup and preserves error.message", async () => {
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  const lines = [];

  const result = await main(["dev-flow", "55", "pointers"], {
    env: LAUNCH_ENV,
    apiBase: "http://127.0.0.1:1",
    fetchImpl: async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    },
    spawnImpl,
    write: (line) => lines.push(line),
    worktreePath: "/work/tree",
  });

  assert.equal(result.path, "nohup");
  assert.equal(result.reason, "fetch failed: ECONNREFUSED");
  assert.deepEqual(lines, ["launch-stage: fetch failed: ECONNREFUSED — used nohup fallback"]);
  assert.equal(spawnCalls.length, 1);
  const [command, args, options] = spawnCalls[0];
  assert.equal(command, "sh");
  assert.equal(args[0], "-c");
  assert.equal(args[1], `nohup ${buildStageCommand("dev-flow", "pointers", LAUNCH_ENV)} > /tmp/skillbook-dev-flow-pi.log 2>&1 &`);
  assert.equal(options.detached, true);
  assert.equal(options.env[PROVIDER_KEY_VARS[DEFAULTS.provider]], undefined);
});

test("a missing Kepler data dir falls back to nohup with the read error's message", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "launch-stage-missing-"));
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  const lines = [];
  try {
    const result = await main(["dev-flow", "55", "pointers"], {
      dataDir,
      env: LAUNCH_ENV,
      spawnImpl,
      write: (line) => lines.push(line),
    });

    assert.equal(result.path, "nohup");
    assert.match(result.reason, /ENOENT/);
    assert.deepEqual(lines, [`launch-stage: ${result.reason} — used nohup fallback`]);
    assert.equal(spawnCalls.length, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an HTTP error from a reachable API is a hard error with zero spawns", async () => {
  const { fetchImpl } = mockKeplerApi({ handlers: { list: () => errorResponse(500) } });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["dev-flow", "55", "pointers"], {
      env: LAUNCH_ENV,
      apiBase: "http://api.test",
      fetchImpl,
      spawnImpl,
      write: () => {},
    }),
    /HTTP 500/
  );
  assert.equal(spawnCalls.length, 0);
});

test("an HTTP error from terminal/start is a hard error with zero spawns", async () => {
  const { fetchImpl } = mockKeplerApi({
    terminals: [{ worktreePath: process.cwd(), label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
    handlers: { start: () => errorResponse(500) },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["dev-flow", "55", "pointers"], {
      env: LAUNCH_ENV,
      apiBase: "http://api.test",
      fetchImpl,
      spawnImpl,
      write: () => {},
    }),
    /HTTP 500/
  );
  assert.equal(spawnCalls.length, 0);
});

test("a malformed terminal list response is a hard error with zero spawns", async () => {
  const { fetchImpl } = mockKeplerApi({
    handlers: { list: () => ({ ok: true, status: 200, text: async () => "{not json" }) },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["dev-flow", "55", "pointers"], {
      env: LAUNCH_ENV,
      apiBase: "http://api.test",
      fetchImpl,
      spawnImpl,
      write: () => {},
    })
  );
  assert.equal(spawnCalls.length, 0);
});

test("a failure after terminal/start succeeded is a hard error with zero spawns — never double-launch", async () => {
  const worktreePath = "/work/tree";
  const { fetchImpl, calls: apiCalls } = mockKeplerApi({
    terminals: [{ worktreePath, label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
    handlers: { input: () => errorResponse(500) },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["dev-flow", "55", "pointers"], {
      env: LAUNCH_ENV,
      apiBase: "http://api.test",
      fetchImpl,
      worktreePath,
      spawnImpl,
      write: () => {},
    }),
    /HTTP 500/
  );
  assert.equal(spawnCalls.length, 0);
  assert.equal(apiCalls.filter((call) => call.url.endsWith("/terminal/start")).length, 1);
});

test("a connection-level failure on terminal/input after start is still a hard error", async () => {
  const worktreePath = "/work/tree";
  const { fetchImpl } = mockKeplerApi({
    terminals: [{ worktreePath, label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" }],
    handlers: {
      input: () => {
        throw new Error("socket hang up");
      },
    },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();

  await assert.rejects(
    main(["dev-flow", "55", "pointers"], {
      env: LAUNCH_ENV,
      apiBase: "http://api.test",
      fetchImpl,
      worktreePath,
      spawnImpl,
      write: () => {},
    }),
    /socket hang up/
  );
  assert.equal(spawnCalls.length, 0);
});

// --- the helper's post-injection check: sentinel present, wedge recovery, hard failures ---

const VERIFY_TERMINAL = { worktreePath: "/work/tree", label: "Terminal 1", repoId: "r", worktreeId: "w", taskId: "t" };

/** The `main` deps for the helper's post-injection check tests: instant polls, no real waiting. */
function verifyDeps({ fetchImpl, spawnImpl } = {}) {
  return {
    env: LAUNCH_ENV,
    apiBase: "http://api.test",
    fetchImpl,
    worktreePath: "/work/tree",
    spawnImpl,
    write: () => {},
    sleepImpl: async () => {},
  };
}

test("the helper's post-injection check: a sentinel present on the first poll launches with no relaunch", async () => {
  const { fetchImpl, calls, inputs } = mockKeplerApi({ terminals: [VERIFY_TERMINAL] });
  const result = await main(["dev-flow", "55", "pointers"], verifyDeps({ fetchImpl }));
  assert.equal(result.path, "api");
  assert.equal(inputs().length, 1);
  assert.equal(calls.filter((call) => call.url.includes("/terminal/buffer")).length, 1);
});

test("the helper's post-injection check: a wedged terminal is closed and relaunched once, and the new terminal passes verification", async () => {
  const { fetchImpl, calls, inputs, bufferText } = mockKeplerApi({
    terminals: [VERIFY_TERMINAL],
    handlers: {
      // The PTY echo is present, the sentinel was never executed: a wedge
      // until the relaunched terminal's input lands.
      buffer: () => okResponse(inputs().length >= 2 ? bufferText() : "dev-flow@host$ printf '%s\\n' ...\r\n"),
    },
  });
  const result = await main(["dev-flow", "55", "pointers"], verifyDeps({ fetchImpl }));

  assert.equal(result.path, "api");
  assert.equal(result.terminalId, "term-new-2");
  assert.deepEqual(
    inputs().map((body) => body.terminalId),
    ["term-new", "term-new-2"],
    "the old terminal never receives a second input"
  );
  assert.deepEqual(inputs()[0].input, inputs()[1].input, "the relaunched terminal receives the same input");

  const events = calls.map((call) => `${call.method} ${call.url.replace("http://api.test", "")}`);
  const closeAt = events.findIndex((event) => event === "POST /terminal/close");
  const startAts = events.flatMap((event, index) => (event === "POST /terminal/start" ? [index] : []));
  assert.equal(startAts.length, 2, "one initial start and one relaunch");
  assert.ok(closeAt > startAts[0] && closeAt < startAts[1], "the wedged terminal is closed before the new one starts");
  assert.deepEqual(calls[closeAt].body, { terminalId: "term-new" });
});

test("the helper's post-injection check: a second timeout after the relaunch is a hard error, never a silent pass", async () => {
  const { fetchImpl, calls, inputs } = mockKeplerApi({
    terminals: [VERIFY_TERMINAL],
    handlers: { buffer: () => okResponse("echoed, never executed\r\n") },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  await assert.rejects(
    main(["dev-flow", "55", "pointers"], verifyDeps({ fetchImpl, spawnImpl })),
    (error) => {
      assert.match(error.message, /terminal term-new-2 did not show "CHAIN-STAGE-START: chain #55 dev-flow"/);
      assert.match(error.message, /after one relaunch/);
      return true;
    }
  );
  assert.deepEqual(inputs().map((body) => body.terminalId), ["term-new", "term-new-2"]);
  assert.equal(calls.filter((call) => call.url.endsWith("/terminal/close")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/terminal/start")).length, 2);
  assert.equal(spawnCalls.length, 0);
});

test("the helper's post-injection check: a close failure after a wedge is a hard error and the relaunch never starts", async () => {
  const { fetchImpl, calls, inputs } = mockKeplerApi({
    terminals: [VERIFY_TERMINAL],
    handlers: {
      buffer: () => okResponse("echoed, never executed\r\n"),
      close: () => errorResponse(500),
    },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  await assert.rejects(main(["dev-flow", "55", "pointers"], verifyDeps({ fetchImpl, spawnImpl })), /HTTP 500/);
  assert.equal(inputs().length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/terminal/start")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/terminal/close")).length, 1);
  assert.equal(spawnCalls.length, 0);
});

test("the helper's post-injection check: a start failure after a wedge is a hard error, never a silent pass", async () => {
  let starts = 0;
  const { fetchImpl, calls, inputs } = mockKeplerApi({
    terminals: [VERIFY_TERMINAL],
    handlers: {
      buffer: () => okResponse("echoed, never executed\r\n"),
      start: () => (++starts === 1 ? okResponse({ terminalId: "term-new" }) : errorResponse(500)),
    },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  await assert.rejects(main(["dev-flow", "55", "pointers"], verifyDeps({ fetchImpl, spawnImpl })), /HTTP 500/);
  assert.equal(inputs().length, 1);
  assert.equal(starts, 2, "the relaunch start was attempted");
  assert.equal(calls.filter((call) => call.url.endsWith("/terminal/close")).length, 1);
  assert.equal(spawnCalls.length, 0);
});

test("the helper's post-injection check: the buffer poll waits for the sentinel before it declares success", async () => {
  const { fetchImpl, inputs, bufferText } = mockKeplerApi({
    terminals: [VERIFY_TERMINAL],
    handlers: {
      buffer: (() => {
        let reads = 0;
        return () => (reads++ < 2 ? okResponse("") : okResponse(bufferText()));
      })(),
    },
  });
  const result = await main(["dev-flow", "55", "pointers"], verifyDeps({ fetchImpl }));
  assert.equal(result.path, "api");
  assert.equal(inputs().length, 1);
});

test("the helper's post-injection check: ANSI escapes in the buffer are stripped before matching", async () => {
  const { fetchImpl, inputs, bufferText } = mockKeplerApi({
    terminals: [VERIFY_TERMINAL],
    handlers: { buffer: () => okResponse(`\u001b[33m${bufferText()}\u001b[0m`) },
  });
  const result = await main(["dev-flow", "55", "pointers"], verifyDeps({ fetchImpl }));
  assert.equal(result.path, "api");
  assert.equal(inputs().length, 1);
});

test("the helper's post-injection check: a buffer-read HTTP error is a hard error with no relaunch", async () => {
  const { fetchImpl, inputs } = mockKeplerApi({
    terminals: [VERIFY_TERMINAL],
    handlers: { buffer: () => errorResponse(500) },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  await assert.rejects(main(["dev-flow", "55", "pointers"], verifyDeps({ fetchImpl, spawnImpl })), /HTTP 500/);
  assert.equal(inputs().length, 1);
  assert.equal(spawnCalls.length, 0);
});

test("the helper's post-injection check: a connection-level buffer failure is a hard error with no relaunch", async () => {
  const { fetchImpl, inputs } = mockKeplerApi({
    terminals: [VERIFY_TERMINAL],
    handlers: {
      buffer: () => {
        throw new Error("socket hang up");
      },
    },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  await assert.rejects(
    main(["dev-flow", "55", "pointers"], verifyDeps({ fetchImpl, spawnImpl })),
    /socket hang up/
  );
  assert.equal(inputs().length, 1);
  assert.equal(spawnCalls.length, 0);
});

test("the helper's post-injection check: a malformed buffer body is a hard error with no relaunch", async () => {
  const { fetchImpl, inputs } = mockKeplerApi({
    terminals: [VERIFY_TERMINAL],
    handlers: { buffer: () => ({ ok: true, status: 200, text: async () => "{not json" }) },
  });
  const { spawnImpl, calls: spawnCalls } = spawnRecorder();
  await assert.rejects(main(["dev-flow", "55", "pointers"], verifyDeps({ fetchImpl, spawnImpl })));
  assert.equal(inputs().length, 1);
  assert.equal(spawnCalls.length, 0);
});

// --- the data dir ---

test("readKeplerApiBase reads the host and port files instead of hardcoding them", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "launch-stage-api-"));
  try {
    writeFileSync(join(dataDir, "server.host"), "127.0.0.1\n");
    writeFileSync(join(dataDir, "server.port"), "36325\n");
    assert.equal(readKeplerApiBase({ dataDir }), "http://127.0.0.1:36325");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the Kepler data dir is derived home-relative, not hardcoded", () => {
  assert.equal(KEPLER_DATA_DIR, join(homedir(), ".kepler-server", "data"));
  const source = readFileSync(new URL("./launch-stage.mjs", import.meta.url), "utf8");
  assert.match(source, /homedir\(\)/);
  assert.ok(!source.includes('"/config/.kepler-server'));
});

// --- the wrapper executes: the give-up path against a stubbed environment ---

function writeStub(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

/**
 * A PATH whose `pi`, `sleep` and `node` are stubs: every invocation lands in
 * one event log, sleeps return immediately, and `pi` fails its first
 * `failTimes` calls. `node` (the wake helper) is stubbed too, so the wrapper's
 * wake line is observable without creating a Kepler session.
 */
function stubEnvironment({ failTimes = 0, wakeStatus = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "launch-stage-stub-"));
  const log = join(dir, "events.log");
  const count = join(dir, "pi.count");
  writeStub(
    dir,
    "pi",
    `#!/bin/sh\nn=0\n[ -f ${shellQuote(count)} ] && n=$(cat ${shellQuote(count)})\nn=$((n + 1))\necho "$n" > ${shellQuote(count)}\necho "pi attempt $n" >> ${shellQuote(log)}\n[ "$n" -le ${failTimes} ] && exit 1\nexit 0\n`
  );
  writeStub(dir, "sleep", `#!/bin/sh\necho "sleep $1" >> ${shellQuote(log)}\nexit 0\n`);
  writeStub(
    dir,
    "node",
    `#!/bin/sh\necho "wake $*" >> ${shellQuote(log)}\necho "wake-stub" >&2\nexit ${wakeStatus}\n`
  );
  return {
    dir,
    log,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  };
}

function runWrapper(stage, spec, pointers, env) {
  return spawnSync("bash", ["-c", buildRetryWrapper(stage, spec, pointers, WORKTREE_PATH, NO_ENV)], { encoding: "utf8", env });
}

test("after 5 failed attempts the wrapper prints the marker and actuates the wake", () => {
  const { dir, log, env } = stubEnvironment({ failTimes: 5 });
  try {
    const result = runWrapper("dev-flow", "55", "pointers", env);
    const resume = resumeCommand("dev-flow", "55", "pointers");
    assert.equal(result.status, 0);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "pi attempt 1",
      "sleep 40",
      "pi attempt 2",
      "sleep 80",
      "pi attempt 3",
      "sleep 160",
      "pi attempt 4",
      "sleep 320",
      "pi attempt 5",
      `wake ${wakeHelperPath()} dev-flow 55 ${resume}`,
    ]);
    assert.equal(
      result.stdout,
      `${stageSentinel("55", "dev-flow")}\nFAILED: chain #55 dev-flow gave up after 5 attempts\nFAILED: resume with: ${resume}\n`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an attempt that succeeds stops the retries and leaves no marker", () => {
  const { dir, log, env } = stubEnvironment({ failTimes: 2 });
  try {
    const result = runWrapper("dev-flow", "55", "pointers", env);
    assert.equal(result.status, 0);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "pi attempt 1",
      "sleep 40",
      "pi attempt 2",
      "sleep 80",
      "pi attempt 3",
    ]);
    assert.equal(result.stdout, `${stageSentinel("55", "dev-flow")}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed wake leaves the marker printed and the helper's failure visible", () => {
  const { dir, log, env } = stubEnvironment({ failTimes: 5, wakeStatus: 7 });
  try {
    const result = runWrapper("dev-flow", "55", "pointers", env);
    assert.equal(result.status, 7);
    assert.ok(result.stdout.startsWith(`${stageSentinel("55", "dev-flow")}\n`));
    assert.match(result.stdout, /FAILED: chain #55 dev-flow gave up after 5 attempts\n/);
    assert.match(result.stdout, /FAILED: resume with: cd '\/work\/tree' && export DEV_ENV_PROVIDER='' .* && node '.*launch-stage\.mjs' dev-flow 55 /);
    assert.match(result.stderr, /wake-stub/);
    assert.match(readFileSync(log, "utf8"), /wake .*open-wake-session\.mjs dev-flow 55 cd '\/work\/tree' && export DEV_ENV_PROVIDER='' .* && node '.*launch-stage\.mjs'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- helpers ---

function okResponse(value) {
  return { ok: true, status: 200, text: async () => (value === null ? "" : JSON.stringify(value)) };
}

function errorResponse(status) {
  return { ok: false, status, text: async () => "" };
}

function mockKeplerApi({ terminals, terminalId = "term-new", handlers = {} }) {
  const calls = [];
  const inputBodies = [];
  let buffer = "";
  let starts = 0;
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const call = { url, method, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (method === "GET" && url.endsWith("/terminal/list")) {
      return handlers.list ? handlers.list(call) : okResponse(terminals);
    }
    if (method === "POST" && url.endsWith("/terminal/start")) {
      starts += 1;
      return handlers.start ? handlers.start(call) : okResponse({ terminalId: starts === 1 ? terminalId : `${terminalId}-${starts}` });
    }
    if (method === "POST" && url.endsWith("/terminal/close")) {
      return handlers.close ? handlers.close(call) : okResponse(null);
    }
    if (method === "POST" && url.endsWith("/terminal/input")) {
      inputBodies.push(call.body);
      buffer += call.body.input;
      // A working launch executes the wrapper; its first action prints the sentinel on its own line.
      const sentinel = /CHAIN-STAGE-START: chain #\d+ [\w-]+/.exec(call.body.input)?.[0];
      if (sentinel) buffer += `\r\n${sentinel}\r\n`;
      return handlers.input ? handlers.input(call) : okResponse(null);
    }
    if (method === "GET" && url.includes("/terminal/buffer")) {
      return handlers.buffer ? handlers.buffer(call) : okResponse(buffer);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetchImpl, calls, inputs: () => inputBodies, bufferText: () => buffer };
}

function spawnRecorder() {
  const calls = [];
  return {
    calls,
    spawnImpl: (...args) => {
      calls.push(args);
      return { unref() {} };
    },
  };
}

function mockAgentApi({ sessionId = "sess-new", handlers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const call = { url, method, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (method === "POST" && url.endsWith("/agent/sessions")) {
      return handlers.sessions ? handlers.sessions(call) : okResponse({ sessionId });
    }
    if (method === "POST" && url.endsWith("/agent/rename-session")) {
      return handlers.rename ? handlers.rename(call) : okResponse(null);
    }
    if (method === "POST" && url.endsWith("/agent/send-prompt")) {
      return handlers.send ? handlers.send(call) : okResponse(null);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetchImpl, calls };
}
