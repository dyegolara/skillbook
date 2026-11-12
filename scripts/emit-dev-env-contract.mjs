#!/usr/bin/env node
/**
 * emit-dev-env-contract.mjs — the `DEV_ENV_*` contract as generated JSON.
 *
 * A consumer in another repo (the dashboard's settings surface) cannot import
 * `env-defaults.mjs`, and a hand copy of the lists already drifted once
 * (ADR-0010). So this script imports the module — the single source, never a
 * retyped copy — and writes `contracts/dev-env.contract.json`:
 *
 *   contractVersion  the artifact schema's version (integer, bumped only on a
 *                    breaking schema change)
 *   source           repo, path, commit, and the SHA-256 digest of the source
 *                    bytes. `source.repo` is `owner/name` from package.json's
 *                    `repository` field. `source.commit` is the last commit
 *                    that touched `env-defaults.mjs`, the commit that
 *                    introduced those bytes, not HEAD at generation time.
 *                    A consumer uses `source` to say which contract a saved
 *                    Stage assignment was validated against
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
 * plus a trailing newline, fields in the order above. `--check` is what
 * `npm run verify:contract` runs. It regenerates in memory from the committed
 * artifact's recorded `source.commit` and recorded `source.repo`, compares
 * every field, and validates `source.repo` against package.json's
 * `repository` field. It does not read `git remote`. It checks that
 * `source.commit` is a full 40-hex SHA, and it always checks that
 * `source.sha256` is the digest of today's `env-defaults.mjs`. The digest is
 * the verifiable source reference in every history. If the history is
 * rewritten, the digest still proves which source bytes the artifact was
 * generated from.
 *
 * The commit is recorded provenance, verified only when its object is
 * available. If it exists locally, `git show <commit>:<path>` must byte-match
 * today's `env-defaults.mjs`, so a stale recorded commit fails. After a squash
 * merge, a shallow clone, or a rebased history, the object may be gone. The
 * check then skips that verification rather than failing. The field-by-field
 * regeneration of the committed body and the digest are the drift guard, and
 * they survive those histories. A vanished commit pointer cannot be
 * re-authenticated after history is rewritten. That is why the digest exists.
 * Regenerating on any tree of the same history produces no diff by itself,
 * because `source.commit` follows the source file rather than HEAD. A hand
 * edit fails with a concrete diff. The check never writes.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const SOURCE_SHA256 = /^[0-9a-f]{64}$/;

/** Remediation shared by the check's problem strings that ask for a fresh artifact. */
const REGENERATE_ARTIFACT = "regenerate the artifact (npm run contract:emit)";

/** The hex SHA-256 of a source file's bytes — the artifact's source reference. */
function digestOf(source) {
  return createHash("sha256").update(source).digest("hex");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value as error text: `missing`, or the value's JSON form. */
function formatForError(value) {
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
 * The contract for one `source` record (repo, path, commit, sha256), the same
 * shape as the artifact field. A pure copy of the imported tables, so the
 * tests and the check regenerate it without touching the filesystem or a
 * network. Field order is the artifact's byte order.
 */
export function buildContract(source) {
  const { repo, path, commit, sha256 } = source;
  if (typeof commit !== "string" || commit.trim() === "") {
    throw new Error("the contract needs the source commit it was generated from");
  }
  if (typeof repo !== "string" || repo.trim() === "") {
    throw new Error("the contract needs the source repo (owner/name)");
  }
  if (typeof sha256 !== "string" || !SOURCE_SHA256.test(sha256)) {
    throw new Error("the contract needs the source file's hex SHA-256 digest");
  }
  return {
    contractVersion: CONTRACT_VERSION,
    source: { repo, path, commit, sha256 },
    defaultProvider: DEFAULTS.provider,
    providers: [...PROVIDERS],
    efforts: [...EFFORTS],
    agents: [...AGENTS],
    providerKeyVars: { ...PROVIDER_KEY_VARS },
    agentAdapters: Object.fromEntries(
      AGENTS.map((agent) => [agent, AGENT_COMMANDS[agent].adapterId])
    ),
    launchStages: { ...LAUNCH_STAGES },
    stages: Object.keys(DEFAULTS.stages).map((key) => {
      const launchName = launchNameFor(key);
      return {
        key,
        launchName,
        // A Stage in LAUNCH_STAGES is a CLI launch; the one DEFAULTS.stages key
        // with no launch name (GRILL) is the interactive Kepler session.
        interactive: launchName === null,
        defaults: { ...DEFAULTS.stages[key] },
      };
    }),
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
    problems.push(`${path}: committed ${formatForError(committed)} but the generator gives ${formatForError(regenerated)}`);
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
    throw new Error(`cannot parse a source repo from "${raw}"`);
  }
  return segments.slice(-2).join("/");
}

/** `owner/name` from package.json's `repository` string or `{ url }` object. */
function repoFromRepositoryField(field) {
  const url = typeof field === "string" ? field.trim() : isPlainObject(field) ? field.url : null;
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error(
      `package.json repository is malformed — source.repo is read from that field, got ${formatForError(field)}`
    );
  }
  try {
    return normalizeRepoUrl(url);
  } catch {
    throw new Error(
      `package.json repository is malformed — source.repo is read from that field, got ${formatForError(field)}`
    );
  }
}

/**
 * The artifact's `source.repo` (`owner/name`), from the checkout's
 * `package.json` `repository` field. A missing or malformed field is a hard
 * error naming `repository`. The origin remote is not consulted.
 */
export function resolveSourceRepo(root = REPO_ROOT) {
  const path = join(root, "package.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `package.json repository is missing or malformed — source.repo is read from that field (${error.message})`
    );
  }
  if (!isPlainObject(parsed) || !Object.hasOwn(parsed, "repository")) {
    throw new Error("package.json repository is missing — source.repo is read from that field");
  }
  return repoFromRepositoryField(parsed.repository);
}

/** Last commit that touched the source file. No such commit is a hard error. */
function sourceTouchingCommit(root) {
  const result = git(root, ["log", "-1", "--format=%H", "--", SOURCE_PATH]);
  const sha = result.stdout.trim();
  if (result.status !== 0 || !COMMIT_SHA.test(sha)) {
    const detail = result.stderr.trim();
    throw new Error(
      `${SOURCE_PATH} has no commit in ${root}` +
        (detail ? ` (${detail})` : "") +
        " — refusing to stamp a source.commit that never carried the file"
    );
  }
  return sha;
}

function assertSourceMatchesCommit(root, commit, currentSource) {
  const recorded = git(root, ["show", `${commit}:${SOURCE_PATH}`]);
  if (recorded.status !== 0 || recorded.stdout !== currentSource) {
    throw new Error(
      `${SOURCE_PATH} does not match commit ${commit} — commit the source change, then run npm run contract:emit`
    );
  }
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
      `${CONTRACT_FILE}: source.commit ${commit} carries no ${SOURCE_PATH} — ${REGENERATE_ARTIFACT}`
    );
  } else if (recorded.stdout !== currentSource) {
    problems.push(
      `${CONTRACT_FILE}: source.commit ${commit} carries a different ${SOURCE_PATH} than this tree — the artifact no longer reflects the source; ${REGENERATE_ARTIFACT}`
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
  const recordedDigest = committed.source?.sha256;
  const currentSource = readFileSync(join(root, SOURCE_PATH), "utf8");
  const currentDigest = digestOf(currentSource);
  if (recordedDigest !== currentDigest) {
    problems.push(
      `${CONTRACT_FILE}: source.sha256 ${formatForError(recordedDigest)} does not match today's ${SOURCE_PATH} (sha256 ${currentDigest}) — ${REGENERATE_ARTIFACT}`
    );
  }
  const commitLooksValid = typeof commit === "string" && COMMIT_SHA.test(commit);
  if (!commitLooksValid) {
    problems.push(
      `${CONTRACT_FILE}: source.commit ${formatForError(commit)} is not a full 40-hex commit SHA — ${REGENERATE_ARTIFACT}`
    );
  } else {
    try {
      problems.push(...sourceCommitProblems(root, commit, currentSource));
    } catch (error) {
      problems.push(error.message);
    }
  }

  let repoFromPackage = null;
  try {
    repoFromPackage = resolveSourceRepo(root);
  } catch (error) {
    problems.push(error.message);
  }
  // Rebuild from the recorded repo. package.json validates that field, and
  // the origin remote is not an input, so a fork checkout does not false-drift.
  const recordedRepo = committed.source?.repo;
  if (repoFromPackage !== null && recordedRepo !== repoFromPackage) {
    problems.push(
      `${CONTRACT_FILE}: source.repo ${formatForError(recordedRepo)} does not match package.json repository (${repoFromPackage}) — ${REGENERATE_ARTIFACT}`
    );
  }
  const repo = typeof recordedRepo === "string" && recordedRepo.trim() !== "" ? recordedRepo : null;
  if (repo !== null && typeof commit === "string" && commit.trim() !== "") {
    const regenerated = buildContract({
      repo,
      path: SOURCE_PATH,
      commit,
      sha256: currentDigest,
    });
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

export function generateContract({ root = REPO_ROOT } = {}) {
  const commit = sourceTouchingCommit(root);
  const source = readFileSync(join(root, SOURCE_PATH), "utf8");
  assertSourceMatchesCommit(root, commit, source);
  const repo = resolveSourceRepo(root);
  const sha256 = digestOf(source);
  const contract = buildContract({ repo, path: SOURCE_PATH, commit, sha256 });
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
  generateContract({ root: REPO_ROOT });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    process.exitCode = 1;
  }
}
