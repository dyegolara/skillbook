#!/usr/bin/env node
/**
 * launch-stage.mjs — launch a software-factory chain stage.
 *
 * Per ADR-0006 (amended 2026-10-10) a finishing stage launches the next one
 * in a visible Kepler terminal: the helper derives the terminal's
 * repo/worktree/task ids from an existing terminal on the same worktree
 * (`GET /terminal/list`, preferring a chain-labeled one) or from explicit
 * `--repo-id/--worktree-id/--task-id` flags — the fresh-run bootstrap, where
 * grill-with-spec is the one stage holding the ids. It creates a terminal
 * labeled `chain #<spec>: <stage>` with the spec number taken from the
 * explicit argument (never parsed from another label), injects the stage's
 * pinned `pi` command, and prints the terminal id. The terminal stays open
 * after the stage exits; its buffer is the stage log. The detached `nohup`
 * fallback fires only on a connection-level failure to the terminal API —
 * never after `POST /terminal/start` succeeded, so a reachable API never
 * silently degrades — and it preserves `error.message` while reporting which
 * path it took.
 *
 * Plain ESM per ADR-0002, zero dependencies beyond Node.
 *
 * Usage:
 *   node skills/software-factory/scripts/launch-stage.mjs <stage> <spec> '<thin pointers>'
 *     [--repo-id <id> --worktree-id <id> --task-id <id>]
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const KEPLER_DATA_DIR = join(homedir(), ".kepler-server", "data");

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

export function stageLabel(spec, stage) {
  const text = String(spec ?? "");
  if (!/^\d+$/.test(text)) {
    throw new Error(`spec must be a number — got "${spec}"`);
  }
  return `chain #${text}: ${stage}`;
}

export function readKeplerApiBase({ dataDir = KEPLER_DATA_DIR } = {}) {
  const host = readFileSync(join(dataDir, "server.host"), "utf8").trim();
  const port = readFileSync(join(dataDir, "server.port"), "utf8").trim();
  if (host === "" || port === "") {
    throw new Error(`Kepler server host/port missing in ${dataDir}`);
  }
  return `http://${host}:${port}`;
}

const CHAIN_LABEL = /^chain #\d+: /;
const ID_FLAG_HINT = "--repo-id/--worktree-id/--task-id";

/**
 * Pick the terminal whose repo/worktree/task ids the new terminal reuses: a
 * chain-labeled entry on the same worktree is preferred (task-correctness),
 * any other entry on that worktree is accepted, and an unrelated worktree is
 * ignored. Returns the chosen entry or null.
 */
export function pickAnchor(terminals, worktreePath) {
  const onWorktree = (terminals ?? []).filter((entry) => entry && entry.worktreePath === worktreePath);
  const chain = onWorktree.find((entry) => CHAIN_LABEL.test(String(entry.label ?? "")));
  return chain ?? onWorktree[0] ?? null;
}

/**
 * Parse the fresh-run bootstrap ids from argv. All three flags together or
 * none: a partial set is a hard usage error. Returns `{ repoId, worktreeId,
 * taskId }` with undefined fields when no flags are present.
 */
export function parseIdFlags(argv = []) {
  const idFlags = {
    "--repo-id": "repoId",
    "--worktree-id": "worktreeId",
    "--task-id": "taskId",
  };
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const field = idFlags[argv[i]];
    if (!field) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${argv[i]}`);
    }
    if (flags[field] !== undefined) {
      throw new Error(`duplicate ${argv[i]}`);
    }
    flags[field] = value;
    i += 1;
  }
  const present = [flags.repoId, flags.worktreeId, flags.taskId].filter((value) => value !== undefined);
  if (present.length !== 0 && present.length !== 3) {
    throw new Error(`id flags must be given together: ${ID_FLAG_HINT}`);
  }
  return { repoId: flags.repoId, worktreeId: flags.worktreeId, taskId: flags.taskId };
}

/** A failure to reach the terminal API at the connection level. */
export class ConnectionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ConnectionError";
    this.code = "TERMINAL_API_UNREACHABLE";
  }
}

export function isConnectionError(error) {
  return error?.code === "TERMINAL_API_UNREACHABLE";
}

async function requestJson(fetchImpl, url, init) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (cause) {
    throw new ConnectionError(cause?.message ?? String(cause), { cause });
  }
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} -> HTTP ${response.status}`);
  }
  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw new ConnectionError(cause?.message ?? String(cause), { cause });
  }
  return text === "" ? null : JSON.parse(text);
}

/**
 * Resolve the repo/worktree/task ids: explicit flags win, otherwise derive
 * them from an anchor terminal on the worktree. Throws a clear error when
 * neither yields ids. Connection-level failures are tagged so callers can
 * classify them; every other failure is a hard error.
 */
export async function resolveIds({ apiBase, fetchImpl = fetch, worktreePath, flags = {} }) {
  const explicit = { repoId: flags?.repoId, worktreeId: flags?.worktreeId, taskId: flags?.taskId };
  const present = Object.values(explicit).filter((value) => value !== undefined);
  if (present.length === 3) return explicit;
  if (present.length !== 0) {
    throw new Error(`id flags must be given together: ${ID_FLAG_HINT}`);
  }

  const terminals = await requestJson(fetchImpl, `${apiBase}/terminal/list`);
  const anchor = pickAnchor(terminals, worktreePath);
  if (!anchor) {
    throw new Error(`no terminal on ${worktreePath} and no ${ID_FLAG_HINT} flags — cannot derive ids`);
  }
  return { repoId: anchor.repoId, worktreeId: anchor.worktreeId, taskId: anchor.taskId };
}

/**
 * The reachable-API path: start the labeled terminal with the resolved ids,
 * then inject the pinned command. Any failure here is a hard error — once
 * `POST /terminal/start` may have created a terminal, the caller must never
 * fall back to `nohup` (that would double-launch the stage).
 */
export async function launchInTerminal({ stage, label, pointers, ids, apiBase, fetchImpl = fetch }) {
  const started = await requestJson(fetchImpl, `${apiBase}/terminal/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...ids, label }),
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

export async function launchStage({ stage, spec, pointers, flags, deps = {} }) {
  const { fetchImpl = fetch, spawnImpl = spawn, worktreePath = process.cwd() } = deps;
  stagePin(stage); // unknown stage is a hard error, before any launch path
  const label = stageLabel(spec, stage); // spec comes from the argument, never a label

  const fallback = (error) => ({ ...launchDetached({ stage, pointers, spawnImpl }), reason: error.message });

  let apiBase;
  try {
    apiBase = deps.apiBase ?? readKeplerApiBase({ dataDir: deps.dataDir });
  } catch (error) {
    return fallback(error); // the API location is unknown: connection-level
  }

  let ids;
  try {
    ids = await resolveIds({ apiBase, fetchImpl, worktreePath, flags });
  } catch (error) {
    if (!isConnectionError(error)) throw error; // reachable API, bad response: hard error
    return fallback(error);
  }

  // From here the terminal may already exist: every failure is a hard error.
  const launched = await launchInTerminal({ stage, label, pointers, ids, apiBase, fetchImpl });
  return { path: "api", ...launched };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const [stage, spec, pointers] = argv;
  if (!stage || spec === undefined || pointers === undefined) {
    throw new Error(
      "usage: launch-stage.mjs <stage> <spec> '<thin pointers>' [--repo-id <id> --worktree-id <id> --task-id <id>]"
    );
  }
  const flags = parseIdFlags(argv.slice(3));
  const write = deps.write ?? ((line) => process.stdout.write(`${line}\n`));
  const result = await launchStage({ stage, spec, pointers, flags, deps });
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
