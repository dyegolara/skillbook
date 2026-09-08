import fs from "node:fs";
import { SCENARIOS } from "./fixture_data.mjs";

function loadFixtureContext() {
  const scenarioName = process.env.PR_MONITOR_FIXTURE_SCENARIO;
  if (!scenarioName) throw new Error("PR_MONITOR_FIXTURE_SCENARIO is required");
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`Unknown fixture scenario: ${scenarioName}`);
  const tickIndex = Number(process.env.PR_MONITOR_FIXTURE_TICK || "1") - 1;
  if (!Number.isInteger(tickIndex) || tickIndex < 0 || tickIndex >= scenario.ticks.length) {
    throw new Error(`Scenario ${scenarioName} has no tick ${tickIndex + 1}`);
  }
  const tick = scenario.ticks[tickIndex];
  return { scenarioName, scenario, tickIndex, tick };
}

function appendLog(kind, payload) {
  const dir = process.env.PR_MONITOR_FIXTURE_LOG_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    `${dir}/${kind}.jsonl`,
    JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n"
  );
}

export { appendLog, loadFixtureContext };
