import fs from "node:fs";
import path from "node:path";
import { SCENARIOS } from "./fixture_data.mjs";

/** Auto-advance mode (no PR_MONITOR_FIXTURE_TICK): one fixture tick per
 * distinct tick process. The tick process (fake OpenRouter, loaded in-process)
 * self-identifies through PR_MONITOR_FIXTURE_TICK_PID, which it inherits into
 * every fake `gh` child; each new owner claims the next index from a
 * monotonic counter. Callers inside one tick process therefore all see the
 * same index. */
function autoTickIndex(logDir) {
  const dir = path.join(logDir, "tick-index");
  fs.mkdirSync(dir, { recursive: true });
  const owner = process.env.PR_MONITOR_FIXTURE_TICK_PID || String(process.ppid);
  const indexFile = path.join(dir, `index-${owner}`);
  if (!fs.existsSync(indexFile)) {
    const counterFile = path.join(dir, "counter");
    const counter = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0;
    fs.writeFileSync(counterFile, String(counter + 1));
    fs.writeFileSync(indexFile, String(counter));
  }
  return Number(fs.readFileSync(indexFile, "utf8"));
}

function loadFixtureContext() {
  const scenarioName = process.env.PR_MONITOR_FIXTURE_SCENARIO;
  if (!scenarioName) throw new Error("PR_MONITOR_FIXTURE_SCENARIO is required");
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`Unknown fixture scenario: ${scenarioName}`);
  const explicitTick = process.env.PR_MONITOR_FIXTURE_TICK;
  const tickIndex = explicitTick !== undefined
    ? Number(explicitTick) - 1
    : autoTickIndex(process.env.PR_MONITOR_FIXTURE_LOG_DIR || ".");
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
