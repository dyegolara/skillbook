#!/usr/bin/env node
import { appendLog, loadFixtureContext } from "./fixture_runtime.mjs";

const args = process.argv.slice(2);
if (args[0] !== "api") {
  console.error(`unsupported gh command: ${args.join(" ")}`);
  process.exit(1);
}

const endpoint = args[1];
const methodIndex = args.indexOf("-X");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";

const { scenarioName, tickIndex, tick } = loadFixtureContext();
appendLog("gh", {
  scenario: scenarioName,
  tick: tickIndex + 1,
  method,
  args,
});

if (method === "POST") {
  process.stdout.write("{}\n");
  process.exit(0);
}

const payload = tick.gh?.[endpoint];
if (payload === undefined) {
  console.error(`No fixture response for ${scenarioName} tick ${tickIndex + 1}: ${endpoint}`);
  process.exit(1);
}

if (typeof payload === "string") {
  process.stdout.write(payload.endsWith("\n") ? payload : `${payload}\n`);
} else {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
