#!/usr/bin/env node
/**
 * launch-stage.mjs — launch a software-factory chain stage.
 *
 * Per ADR-0006 (amended 2026-10-08) a finishing stage launches the next one
 * in a visible Kepler terminal: the helper derives the terminal's
 * repo/worktree/task ids from an existing chain terminal on the same
 * worktree, creates a `chain #<spec>: <stage>` terminal through Kepler's
 * loopback HTTP API (no auth), injects the stage's pinned `pi` command, and
 * prints the terminal id. The terminal stays open after the stage exits; its
 * buffer is the stage log. When the API is unreachable the helper falls back
 * to the detached `nohup pi` launch and reports which path it took.
 *
 * Plain ESM per ADR-0002, zero dependencies beyond Node.
 *
 * Usage: node skills/software-factory/scripts/launch-stage.mjs <stage> '<thin pointers>'
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const KEPLER_DATA_DIR = "/config/.kepler-server/data";

// Pins per ADR-0006: the three own pi stages are mirrored from their SKILL.md
// frontmatter; implement-spec is referenced and its pin is recorded in ADR-0006.
export const STAGE_PINS = {
  "dev-flow": { provider: "opencode-go", model: "opencode-go/glm-5.3", thinking: "max" },
  "implement-spec": { provider: "opencode-go", model: "opencode-go/deepseek-v4.1-flash", thinking: "max" },
  "code-review-loop": { provider: "opencode-go", model: "opencode-go/mimo-v2.6-pro", thinking: "high" },
  "create-pr": { provider: "opencode-go", model: "opencode-go/muse-spark-1.3-contributor", thinking: "xhigh" },
};

export function stagePin(stage) {
  const pin = STAGE_PINS[stage];
  if (!pin) {
    throw new Error(`unknown stage "${stage}" — expected one of ${Object.keys(STAGE_PINS).join(", ")}`);
  }
  return pin;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function buildPiCommand(stage, pointers) {
  const pin = stagePin(stage);
  return `pi --print --provider ${pin.provider} --model ${pin.model} --thinking ${pin.thinking} ${shellQuote(pointers)}`;
}

export function buildTerminalInput(stage, pointers) {
  return `${buildPiCommand(stage, pointers)}\n`;
}

export function readKeplerApiBase({ dataDir = KEPLER_DATA_DIR } = {}) {
  const host = readFileSync(join(dataDir, "server.host"), "utf8").trim();
  const port = readFileSync(join(dataDir, "server.port"), "utf8").trim();
  if (host === "" || port === "") {
    throw new Error(`Kepler server host/port missing in ${dataDir}`);
  }
  return `http://${host}:${port}`;
}

/**
 * Pick the terminal whose ids the new terminal reuses: an entry on the same
 * worktree whose label is `chain #<n>: <stage>`, so `<n>` becomes the new
 * label's spec number.
 */
export function pickChainTerminal(terminals, worktreePath) {
  const onWorktree = (terminals ?? []).filter((entry) => entry && entry.worktreePath === worktreePath);
  const chain = onWorktree.find((entry) => /^chain #\d+: /.test(String(entry.label ?? "")));
  if (!chain) return null;
  const match = /^chain #(\d+): /.exec(chain.label);
  return { ...chain, spec: Number(match[1]) };
}

export function stageLabel(spec, stage) {
  return `chain #${spec}: ${stage}`;
}

async function requestJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} -> HTTP ${response.status}`);
  }
  const text = await response.text();
  return text === "" ? null : JSON.parse(text);
}

/**
 * The reachable-API path: list terminals, derive ids, start the labeled
 * terminal, inject the pinned command. Throws on any failure so the caller
 * can fall back.
 */
export async function launchInTerminal({ stage, pointers, apiBase, fetchImpl = fetch, worktreePath = process.cwd() }) {
  const terminals = await requestJson(fetchImpl, `${apiBase}/terminal/list`);
  const anchor = pickChainTerminal(terminals, worktreePath);
  if (!anchor) {
    const error = new Error(`no chain terminal on ${worktreePath} to derive ids from`);
    error.code = "NO_CHAIN_TERMINAL";
    throw error;
  }

  const label = stageLabel(anchor.spec, stage);
  const started = await requestJson(fetchImpl, `${apiBase}/terminal/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repoId: anchor.repoId,
      worktreeId: anchor.worktreeId,
      taskId: anchor.taskId,
      label,
    }),
  });
  const terminalId = started?.terminalId;
  if (!terminalId) throw new Error("Kepler terminal start returned no terminalId");

  await requestJson(fetchImpl, `${apiBase}/terminal/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalId, input: buildTerminalInput(stage, pointers) }),
  });

  return { terminalId, label };
}

/**
 * The fallback path: the detached `nohup pi` launch, stdout/stderr in
 * /tmp/skillbook-<stage>-pi.log.
 */
export function launchDetached({ stage, pointers, spawnImpl = spawn }) {
  const command = buildPiCommand(stage, pointers);
  const log = `/tmp/skillbook-${stage}-pi.log`;
  const child = spawnImpl("sh", ["-c", `nohup ${command} > ${log} 2>&1 &`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref?.();
  return { path: "nohup", command, log };
}

export async function launchStage({ stage, pointers, deps = {} }) {
  const { fetchImpl = fetch, spawnImpl = spawn, worktreePath = process.cwd() } = deps;
  stagePin(stage); // unknown stage is a hard error, before any launch path

  let reason;
  try {
    const apiBase = deps.apiBase ?? readKeplerApiBase();
    const launched = await launchInTerminal({ stage, pointers, apiBase, fetchImpl, worktreePath });
    return { path: "api", ...launched };
  } catch (error) {
    reason = error.code === "NO_CHAIN_TERMINAL" ? error.message : "terminal API unreachable";
  }

  return { ...launchDetached({ stage, pointers, spawnImpl }), reason };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const [stage, pointers] = argv;
  if (!stage || pointers === undefined) {
    throw new Error("usage: launch-stage.mjs <stage> '<thin pointers>'");
  }
  const write = deps.write ?? ((line) => process.stdout.write(`${line}\n`));
  const result = await launchStage({ stage, pointers, deps });
  if (result.path === "api") {
    write(`launch-stage: launched ${result.label} in Kepler terminal ${result.terminalId}`);
  } else {
    write(`launch-stage: ${result.reason} — used nohup fallback`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`launch-stage: ${error.message}`);
    process.exitCode = 1;
  });
}
