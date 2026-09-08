#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./fixture_data.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(__dirname);
const PR_MONITOR = path.join(SKILL_DIR, "pr_monitor.mjs");
const FAKE_OPENROUTER = path.join(__dirname, "fake_openrouter.mjs");
const BIN_DIR = path.join(__dirname, "bin");

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function parseJsonLines(stdout) {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

function createTempDir(prefix = "copilot-review-smart-fixture-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeInitialState(statePath, initialState = {}) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(initialState, null, 2));
}

function runNodeProcess(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runFixtureTick(name, {
  tick = 1,
  statePath,
  logDir,
  preserveState = true,
} = {}) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown fixture scenario: ${name}`);
  const runtimeDir = path.dirname(statePath);
  if (!preserveState || !fs.existsSync(statePath)) {
    writeInitialState(statePath, scenario.initialState || {});
  }
  fs.mkdirSync(logDir, { recursive: true });
  const env = {
    ...process.env,
    DRY_RUN: scenario.dryRun ? "1" : "0",
    PR_MONITOR_STATE_PATH: statePath,
    PR_MONITOR_FIXTURE_SCENARIO: name,
    PR_MONITOR_FIXTURE_TICK: String(tick),
    PR_MONITOR_FIXTURE_LOG_DIR: logDir,
    PR_MONITOR_FIXTURE_LLM_CALLS: "0",
    OPENROUTER_API_KEY: "fixture-key",
    PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH || ""}`,
    HOME: runtimeDir,
  };
  const result = await runNodeProcess(["--import", FAKE_OPENROUTER, PR_MONITOR, ...scenario.args], env);
  const ghLog = readJsonLines(path.join(logDir, "gh.jsonl"));
  const fetchLog = readJsonLines(path.join(logDir, "fetch.jsonl"));
  return {
    ...result,
    runtimeDir,
    statePath,
    logDir,
    state: fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null,
    jsonLines: parseJsonLines(result.stdout),
    ghLog,
    fetchLog,
  };
}

async function runFixtureScenario(name, options = {}) {
  const runtimeDir = options.runtimeDir || createTempDir();
  const statePath = options.statePath || path.join(runtimeDir, "state.json");
  const logDir = options.logDir || path.join(runtimeDir, "logs");
  return runFixtureTick(name, { ...options, tick: options.tick || 1, statePath, logDir });
}

async function runFixtureLoop(name, options = {}) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown fixture scenario: ${name}`);
  const runtimeDir = options.runtimeDir || createTempDir();
  const statePath = options.statePath || path.join(runtimeDir, "state.json");
  const ticks = [];
  for (let tick = 1; tick <= scenario.ticks.length; tick++) {
    const logDir = path.join(runtimeDir, `tick-${tick}-logs`);
    const result = await runFixtureTick(name, {
      tick,
      statePath,
      logDir,
      preserveState: tick > 1,
    });
    ticks.push(result);
    const overall = result.jsonLines.at(-1);
    if (overall?.type === "overall" && overall.done) break;
  }
  return { runtimeDir, statePath, ticks };
}

async function main() {
  const [scenarioName, mode] = process.argv.slice(2);
  if (!scenarioName) {
    console.error(`Usage: node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))} <scenario> [--loop]`);
    process.exit(1);
  }
  const result = mode === "--loop"
    ? await runFixtureLoop(scenarioName)
    : { ticks: [await runFixtureScenario(scenarioName)] };
  for (const tick of result.ticks) {
    process.stdout.write(tick.stdout);
    if (tick.stderr) process.stderr.write(tick.stderr);
  }
}

export { runFixtureLoop, runFixtureScenario };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}
