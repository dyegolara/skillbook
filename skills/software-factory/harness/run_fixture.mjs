#!/usr/bin/env node
/**
 * run_fixture.mjs — drive the real software-factory helpers against the
 * loopback fake Kepler API with a controlled environment.
 *
 * `runLaunchFixture` calls the launch helper's public `launchStage` seam with
 * an explicit `deps.env` (never the ambient environment), the fake API's
 * `apiBase` and a recording `spawnImpl` — so the terminal command's pins are
 * observed in the fake's captured `/terminal/input` body, and a silent
 * `nohup` fallback (which would run a real CLI) cannot hide. An injectable
 * `fetchImpl` lets a scenario reject at the connection level without touching
 * the network, so the detached fallback path is driven too. `runGrillFixture`
 * does the same for `openGrillSession`, observing the fake's captured agent
 * calls. The real helpers use global `fetch`; only `127.0.0.1` is contacted.
 *
 * Run it as a CLI to print every scenario's injected command or hard error:
 *   node skills/software-factory/harness/run_fixture.mjs
 *
 * Plain ESM per ADR-0002, zero dependencies beyond Node.
 */
import { fileURLToPath } from "node:url";
import { openGrillSession } from "../scripts/open-grill-session.mjs";
import { launchStage } from "../scripts/launch-stage.mjs";
import { startFakeKeplerApi } from "./fake_kepler_api.mjs";
import {
  FALLBACK_SCENARIO,
  FIXTURE,
  GRILL_SCENARIOS,
  INVALID_VALUE_CASES,
  LAUNCH_SCENARIOS,
  MISSING_KEY_CASES,
  launchRuns,
} from "./fixture_data.mjs";

/**
 * The stage's command as the retry wrapper embeds it: the text between the
 * `do ` that opens the attempt loop and its `; chain_status=$?;`. Reporting
 * and assertions read this, so "the injected command" is exact.
 */
export function injectedCommand(input) {
  return /do (.*?); chain_status=\$\?;/.exec(input)?.[1] ?? null;
}

/**
 * A fetch that rejects at the connection level without touching the network.
 * The helper classifies the rejection as a connection failure — the only
 * path to the detached `nohup` fallback.
 */
export function rejectingFetch(message) {
  return async () => {
    throw new Error(message);
  };
}

/**
 * Run one real stage launch against the fake API.
 *
 * @param {{ stage: string, env: Object, spec?: string, pointers?: string, ids?: Object, worktreePath?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ apiBase: string, calls: Array<Object>, inputs: Array<Object>, input: string|null, spawnCalls: Array<Array<unknown>>, result: Object|null, error: Error|null }>}
 */
export async function runLaunchFixture({
  stage,
  env,
  spec = FIXTURE.spec,
  pointers = FIXTURE.pointers,
  ids = FIXTURE.ids,
  worktreePath = FIXTURE.worktreePath,
  fetchImpl = fetch,
  terminalEnv = env,
}) {
  const api = await startFakeKeplerApi({ terminalEnv });
  const spawnCalls = [];
  const spawnImpl = (...args) => {
    spawnCalls.push(args);
    return { unref() {} };
  };
  let result = null;
  let error = null;
  try {
    try {
      result = await launchStage({
        stage,
        spec,
        pointers,
        flags: ids,
        deps: {
          apiBase: api.apiBase,
          env,
          worktreePath,
          spawnImpl,
          fetchImpl,
          // The fake executes the wrapper immediately; a no-op sleep keeps a
          // broken sentinel from stalling the fixture on real poll waits.
          sleepImpl: async () => {},
        },
      });
    } catch (cause) {
      error = cause;
    }
    return {
      apiBase: api.apiBase,
      calls: api.calls,
      inputs: api.inputs,
      input: api.inputs.at(-1)?.input ?? null,
      spawnCalls,
      result,
      error,
    };
  } finally {
    await api.close();
  }
}

/**
 * Run one real grill session against the fake agent API.
 *
 * @param {{ env: Object, spec?: string, prompt?: string, ids?: Object, worktreePath?: string }} options
 * @returns {Promise<{ apiBase: string, calls: Array<Object>, lines: Array<string>, result: Object }>}
 */
export async function runGrillFixture({
  env,
  spec = FIXTURE.spec,
  prompt = FIXTURE.reEntryPrompt,
  ids = FIXTURE.ids,
  worktreePath = FIXTURE.worktreePath,
}) {
  const api = await startFakeKeplerApi();
  const lines = [];
  try {
    const result = await openGrillSession({
      spec,
      prompt,
      flags: ids,
      deps: { apiBase: api.apiBase, env, worktreePath, write: (line) => lines.push(line) },
    });
    return { apiBase: api.apiBase, calls: api.calls, lines, result };
  } finally {
    await api.close();
  }
}

async function main() {
  for (const [name, scenario] of Object.entries(LAUNCH_SCENARIOS)) {
    for (const run of launchRuns(scenario)) {
      const out = await runLaunchFixture({ stage: run.stage, env: scenario.env });
      console.log(`=== launch/${name} (${run.stage})`);
      if (out.error) {
        console.error(`unexpected hard error: ${out.error.message}`);
        process.exitCode = 1;
        continue;
      }
      console.log(`injected command: ${injectedCommand(out.input)}`);
      console.log(`api path: ${out.result.path} (${out.calls.map((call) => `${call.method} ${call.path}`).join(", ")})`);
    }
  }

  for (const invalid of INVALID_VALUE_CASES) {
    const out = await runLaunchFixture({ stage: "dev-flow", env: invalid.env });
    console.log(`=== launch/invalid-${invalid.name}`);
    if (out.error) {
      console.log(`hard error: ${out.error.message}`);
    } else {
      console.error("expected a hard error, got none");
      process.exitCode = 1;
    }
  }

  for (const missing of MISSING_KEY_CASES) {
    const out = await runLaunchFixture({ stage: "dev-flow", env: missing.env });
    console.log(`=== launch/missing-key-${missing.name}`);
    if (out.error) {
      console.error(`unexpected hard error: ${out.error.message}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`path: ${out.result.path}`);
    if (out.result.path !== "api" || out.inputs.length === 0 || out.spawnCalls.length !== 0) {
      console.error("expected a successful API launch without credentials");
      process.exitCode = 1;
    }
    if (JSON.stringify(out.calls).includes(missing.keyVariable)) {
      console.error("provider key variable was sent to Kepler");
      process.exitCode = 1;
    }
  }

  {
    const out = await runLaunchFixture({
      stage: FALLBACK_SCENARIO.stage,
      env: FALLBACK_SCENARIO.env,
      ids: FALLBACK_SCENARIO.ids,
      fetchImpl: rejectingFetch(FALLBACK_SCENARIO.fetchError),
    });
    console.log(`=== launch/key-fallback (${FALLBACK_SCENARIO.stage})`);
    if (out.error) {
      console.error(`unexpected hard error: ${out.error.message}`);
      process.exitCode = 1;
    } else {
      const [, args, options] = out.spawnCalls[0] ?? [];
      const keyVariable = FALLBACK_SCENARIO.keyVariable;
      console.log(`path: ${out.result.path}`);
      console.log(`reason: ${out.result.reason}`);
      console.log(`spawned command: ${args?.[1] ?? "(none)"}`);
      console.log(`child env: ${keyVariable}=${options?.env?.[keyVariable] ? "<set>" : "<missing>"}`);
      if (out.result.path !== "nohup" || out.spawnCalls.length !== 1) {
        console.error("expected exactly one nohup spawn");
        process.exitCode = 1;
      }
    }
  }

  for (const [name, scenario] of Object.entries(GRILL_SCENARIOS)) {
    const out = await runGrillFixture(scenario);
    console.log(`=== grill/${name}`);
    console.log(`result: ${out.result.path}`);
    for (const call of out.calls) {
      console.log(`  ${call.method} ${call.path} ${JSON.stringify(call.body)}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
