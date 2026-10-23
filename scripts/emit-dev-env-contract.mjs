#!/usr/bin/env node
/**
 * emit-dev-env-contract.mjs — the `DEV_ENV_*` contract as generated JSON.
 *
 * A consumer in another repo (the dashboard's settings surface) cannot import
 * `env-defaults.mjs`, and a hand copy of the lists already drifted once
 * (ADR-0010). So this script imports the module — the single source, never a
 * retyped copy — and writes `contracts/dev-env.contract.json`, the artifact
 * consumers pin:
 *
 *   contractVersion  the artifact schema's version (integer, bumped only on a
 *                    breaking schema change)
 *   source           the repo (owner/name), the path and the commit the
 *                    artifact was generated from, so a consumer can say which
 *                    contract a saved Stage assignment was validated against
 *   defaultProvider  `DEFAULTS.provider`
 *   providers        `PROVIDERS`, the allowed Providers
 *   efforts          `EFFORTS`, the allowed Effort values
 *   agents           `AGENTS`, the allowed agents
 *   providerKeyVars  `PROVIDER_KEY_VARS`, each Provider's documented Provider
 *                    key variable (no deprecated aliases: the alias is an
 *                    env-resolution detail, not a contract value)
 *   agentAdapters    each agent's Kepler adapter id, from `AGENT_COMMANDS`
 *   launchStages     `LAUNCH_STAGES`, the launch stage set and both spellings
 *   stages           every Stage in `DEFAULTS.stages` order: its key, launch
 *                    name (`null` for the grill stage), whether it is an
 *                    interactive session, and its default Stage assignment
 *
 * Generation is offline and deterministic: `JSON.stringify(contract, null, 2)`
 * plus a trailing newline, fields in the order above. `--check` is the drift
 * check `npm run verify:contract` runs: it regenerates in memory from the
 * committed artifact's recorded `source.commit`, compares every field of the
 * committed file, and validates that `source.commit` is a full 40-hex SHA.
 * The commit is recorded provenance, verified when it is available: if the
 * object exists locally, `git show <commit>:<path>` must byte-match today's
 * `env-defaults.mjs`, so a stale recorded commit fails. After a squash merge,
 * a shallow clone or a rebased history the object may be gone; the check then
 * skips that verification rather than failing, because the field-by-field
 * regeneration of the committed body is the drift guard and survives those
 * histories. Regenerating at the same tree therefore produces no diff by
 * itself, while a hand edit fails with a concrete diff. It never writes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGENTS,
  AGENT_COMMANDS,
  DEFAULTS,
  EFFORTS,
  LAUNCH_STAGES,
  PROVIDERS,
  PROVIDER_KEY_VARS,
} from "../skills/software-factory/scripts/env-defaults.mjs";

/** The artifact's schema version; bump only on a breaking schema change. */
export const CONTRACT_VERSION = 1;

/** The generated artifact, relative to the repo root. */
export const CONTRACT_FILE = "contracts/dev-env.contract.json";

/** The single source the artifact is generated from, relative to the repo root. */
export const SOURCE_PATH = "skills/software-factory/scripts/env-defaults.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT_SHA = /^[0-9a-f]{40}$/;
// The one Stage that is an interactive Kepler session rather than a CLI launch
// (LAUNCH_STAGES omits it; `open-grill-session.mjs` opens it).
const INTERACTIVE_STAGES = new Set(["GRILL"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value) {
  return value === undefined ? "missing" : JSON.stringify(value);
}

/**
 * The kebab launch name `LAUNCH_STAGES` gives a Stage key, or `null` for a
 * Stage outside the launch set (the grill stage).
 */
function launchNameFor(stageKey) {
  for (const [name, key] of Object.entries(LAUNCH_STAGES)) {
    if (key === stageKey) return name;
  }
  return null;
}

/**
 * The contract for a source commit: a pure copy of the imported tables, so
 * the tests and the check regenerate it without touching the filesystem or a
 * network. Field order is the artifact's byte order.
 */
export function buildContract({ commit, repo }) {
  if (typeof commit !== "string" || commit.trim() === "") {
    throw new Error("the contract needs the source commit it was generated from");
  }
  if (typeof repo !== "string" || repo.trim() === "") {
    throw new Error("the contract needs the source repo (owner/name)");
  }
  return {
    contractVersion: CONTRACT_VERSION,
    source: { repo, path: SOURCE_PATH, commit },
    defaultProvider: DEFAULTS.provider,
    providers: [...PROVIDERS],
    efforts: [...EFFORTS],
    agents: [...AGENTS],
    providerKeyVars: { ...PROVIDER_KEY_VARS },
    agentAdapters: Object.fromEntries(
      AGENTS.map((agent) => [agent, AGENT_COMMANDS[agent].adapterId])
    ),
    launchStages: { ...LAUNCH_STAGES },
    stages: Object.keys(DEFAULTS.stages).map((key) => ({
      key,
      launchName: launchNameFor(key),
      interactive: INTERACTIVE_STAGES.has(key),
      defaults: { ...DEFAULTS.stages[key] },
    })),
  };
}

/** The artifact's deterministic bytes. */
export function serializeContract(contract) {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

function walkDiff(path, committed, regenerated, problems) {
  if (isPlainObject(committed) && isPlainObject(regenerated)) {
    const keys = [
      ...Object.keys(committed),
      ...Object.keys(regenerated).filter((key) => !Object.hasOwn(committed, key)),
    ];
    for (const key of keys) {
      walkDiff(path === "" ? key : `${path}.${key}`, committed[key], regenerated[key], problems);
    }
    return;
  }
  if (Array.isArray(committed) && Array.isArray(regenerated)) {
    if (committed.length !== regenerated.length) {
      problems.push(
        `${path}: committed ${committed.length} entries but the generator gives ${regenerated.length}`
      );
    }
    const length = Math.max(committed.length, regenerated.length);
    for (let index = 0; index < length; index += 1) {
      walkDiff(`${path}[${index}]`, committed[index], regenerated[index], problems);
    }
    return;
  }
  if (JSON.stringify(committed) !== JSON.stringify(regenerated)) {
    problems.push(`${path}: committed ${describe(committed)} but the generator gives ${describe(regenerated)}`);
  }
}

/**
 * Every field of a committed contract that the generator's output disagrees
 * with, as one problem per drifted value. Pure: the check's test seam.
 */
export function diffContracts(committed, regenerated) {
  const problems = [];
  walkDiff("", committed, regenerated, problems);
  return problems;
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`cannot run git in ${root} — the DEV_ENV contract check needs a git checkout (${result.error.message})`);
  }
  return result;
}

function normalizeRepoUrl(rawUrl) {
  const raw = String(rawUrl ?? "").trim();
  const shape = "expected an origin like https://github.com/<owner>/<repo>.git";
  let path = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const { hostname, pathname } = new URL(raw);
      if (hostname.includes(".")) path = pathname;
    } catch {
      path = null;
    }
  } else {
    const scp = raw.match(/^[^@/]+@[^:/]+:(.+)$/);
    if (scp) path = scp[1];
  }
  const segments =
    path === null
      ? []
      : path
          .replace(/^\/+/, "")
          .replace(/\/+$/, "")
          .replace(/\.git$/, "")
          .split("/")
          .filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`cannot derive the contract's source repo from origin "${raw}" — ${shape}`);
  }
  return segments.slice(-2).join("/");
}

/**
 * The normalized `origin` remote of a checkout (`owner/name`): the artifact's
 * `source.repo`. A missing or unparseable remote is a clear error, since a
 * consumer would otherwise pin an artifact that names no source.
 */
export function resolveSourceRepo(root = REPO_ROOT) {
  const result = git(root, ["remote", "get-url", "origin"]);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit ${result.status}`;
    throw new Error(
      `cannot derive the contract's source repo — \`git remote get-url origin\` failed in ${root}: ${detail}`
    );
  }
  return normalizeRepoUrl(result.stdout);
}

/** The commit generation records: `HEAD` at generation time. */
function headCommit(root) {
  const result = git(root, ["rev-parse", "HEAD"]);
  const sha = result.stdout.trim();
  if (result.status !== 0 || !COMMIT_SHA.test(sha)) {
    const detail = result.stderr.trim() || `exit ${result.status}`;
    throw new Error(`cannot record the contract's source commit — \`git rev-parse HEAD\` failed in ${root}: ${detail}`);
  }
  return sha;
}

/**
 * Verify recorded provenance when it is available: if the recorded commit
 * exists in this checkout, it must carry the very `env-defaults.mjs` this
 * tree has. An absent object is normal — a squash merge drops the branch
 * commits, and a shallow clone or a rebased history lacks them — so it is not
 * a problem; the field-by-field regeneration against the committed body is the
 * drift guard that survives those histories. Ancestry is deliberately not
 * required: after a squash merge the recorded commit is no longer an ancestor
 * of `HEAD` even when the object still exists.
 */
function sourceCommitProblems(root, commit, currentSource) {
  const known = git(root, ["cat-file", "-e", `${commit}^{commit}`]);
  if (known.status !== 0) return [];
  const problems = [];
  const recorded = git(root, ["show", `${commit}:${SOURCE_PATH}`]);
  if (recorded.status !== 0) {
    problems.push(
      `${CONTRACT_FILE}: source.commit ${commit} carries no ${SOURCE_PATH} — regenerate the artifact (npm run contract:emit)`
    );
  } else if (recorded.stdout !== currentSource) {
    problems.push(
      `${CONTRACT_FILE}: source.commit ${commit} carries a different ${SOURCE_PATH} than this tree — the artifact no longer reflects the source; regenerate it (npm run contract:emit)`
    );
  }
  return problems;
}

/**
 * Check a checkout's committed artifact against a fresh in-memory
 * regeneration from its recorded source commit: `{ ok, problems }`, no write,
 * no network. Used by the CLI's `--check` and by the tests.
 */
export function checkContract({ root = REPO_ROOT } = {}) {
  const path = join(root, CONTRACT_FILE);
  if (!existsSync(path)) {
    return { ok: false, problems: [`${CONTRACT_FILE}: missing — run npm run contract:emit`] };
  }
  const text = readFileSync(path, "utf8");
  let committed;
  try {
    committed = JSON.parse(text);
  } catch (error) {
    return { ok: false, problems: [`${CONTRACT_FILE}: not valid JSON — ${error.message}`] };
  }
  if (!isPlainObject(committed)) {
    return { ok: false, problems: [`${CONTRACT_FILE}: expected a JSON object — run npm run contract:emit`] };
  }

  const problems = [];
  const commit = committed.source?.commit;
  const currentSource = readFileSync(join(root, SOURCE_PATH), "utf8");
  const commitLooksValid = typeof commit === "string" && COMMIT_SHA.test(commit);
  if (!commitLooksValid) {
    problems.push(
      `${CONTRACT_FILE}: source.commit ${describe(commit)} is not a full 40-hex commit SHA — regenerate the artifact (npm run contract:emit)`
    );
  } else {
    try {
      problems.push(...sourceCommitProblems(root, commit, currentSource));
    } catch (error) {
      problems.push(error.message);
    }
  }

  let repo = null;
  try {
    repo = resolveSourceRepo(root);
  } catch (error) {
    problems.push(error.message);
  }
  if (repo !== null && typeof commit === "string" && commit.trim() !== "") {
    const regenerated = buildContract({ commit, repo });
    const drift = diffContracts(committed, regenerated);
    for (const problem of drift) problems.push(`${CONTRACT_FILE}: ${problem}`);
    if (drift.length === 0 && serializeContract(regenerated) !== text) {
      problems.push(
        `${CONTRACT_FILE}: content matches the generator but the bytes do not — run npm run contract:emit (deterministic JSON: two-space indent, trailing newline)`
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

function generate(root) {
  const commit = headCommit(root);
  const repo = resolveSourceRepo(root);
  const contract = buildContract({ commit, repo });
  const path = join(root, CONTRACT_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeContract(contract));
  console.log(`[OK  ] wrote ${CONTRACT_FILE} (source commit ${commit})`);
}

function check(root) {
  const { ok, problems } = checkContract({ root });
  for (const problem of problems) console.log(`[FAIL] ${problem}`);
  if (!ok) {
    console.log(
      `\n${problems.length} problem(s): ${CONTRACT_FILE} is generated output — run \`npm run contract:emit\` and commit the result.`
    );
    process.exitCode = 1;
    return;
  }
  const { source } = JSON.parse(readFileSync(join(root, CONTRACT_FILE), "utf8"));
  console.log(`[OK  ] ${CONTRACT_FILE} is the generator's output for ${source.repo}@${source.commit}`);
}

function main(argv) {
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    console.error(
      `unknown argument(s): ${unknown.join(" ")} — usage: node scripts/emit-dev-env-contract.mjs [--check]`
    );
    process.exitCode = 2;
    return;
  }
  if (argv.includes("--check")) {
    check(REPO_ROOT);
    return;
  }
  generate(REPO_ROOT);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    process.exitCode = 1;
  }
}
