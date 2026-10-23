import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENTS,
  AGENT_COMMANDS,
  DEFAULTS,
  EFFORTS,
  LAUNCH_STAGES,
  PROVIDERS,
  PROVIDER_KEY_VARS,
} from "../skills/software-factory/scripts/env-defaults.mjs";
import {
  CONTRACT_FILE,
  CONTRACT_VERSION,
  SOURCE_PATH,
  buildContract,
  checkContract,
  diffContracts,
  resolveSourceRepo,
  serializeContract,
} from "./emit-dev-env-contract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = join(ROOT, CONTRACT_FILE);
const CLI = join(ROOT, "scripts", "emit-dev-env-contract.mjs");
const TEMP_ROOTS = [];

after(() => {
  for (const root of TEMP_ROOTS) rmSync(root, { recursive: true, force: true });
});

/** The committed artifact, parsed — the pinned contract a consumer reads. */
function readCommitted() {
  return JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
}

/** The generator's output at a commit, with the repo read from the checkout. */
function regenerate(commit) {
  return buildContract({ commit, repo: resolveSourceRepo(ROOT) });
}

/** The CLI's environment without the chain pins a parent session exports. */
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DEV_ENV_")));
}

test("the committed artifact is the generator's output for its recorded source commit", () => {
  const committed = readCommitted();
  const regenerated = regenerate(committed.source.commit);
  assert.deepEqual(committed, regenerated);
  assert.equal(readFileSync(CONTRACT_PATH, "utf8"), serializeContract(regenerated));
});

test("checkContract reports the committed artifact clean", () => {
  assert.deepEqual(checkContract({ root: ROOT }), { ok: true, problems: [] });
});

test("checkContract reports a missing artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "dev-env-contract-"));
  TEMP_ROOTS.push(root);
  const result = checkContract({ root });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((problem) => problem.includes(CONTRACT_FILE) && problem.includes("missing")),
    result.problems.join("\n")
  );
});

test("a hand edit fails: removing a Provider is drift the comparison names", () => {
  const committed = readCommitted();
  const handEdited = structuredClone(committed);
  handEdited.providers = handEdited.providers.filter(
    (provider) => provider !== PROVIDERS[PROVIDERS.length - 1]
  );
  const problems = diffContracts(handEdited, regenerate(committed.source.commit));
  assert.ok(
    problems.some((problem) => problem.startsWith("providers")),
    problems.join("\n")
  );
});

test("a hand edit fails: a changed Stage default is drift the comparison names", () => {
  const committed = readCommitted();
  const handEdited = structuredClone(committed);
  const stage = handEdited.stages.find(({ key }) => key === "DEV_FLOW");
  stage.defaults.effort = "low";
  const problems = diffContracts(handEdited, regenerate(committed.source.commit));
  assert.ok(
    problems.some((problem) => problem.startsWith("stages") && problem.includes("effort")),
    problems.join("\n")
  );
});

test("a hand edit fails: a faked source commit is drift the comparison names", () => {
  const committed = readCommitted();
  const handEdited = structuredClone(committed);
  handEdited.source.commit = "0".repeat(40);
  const problems = diffContracts(handEdited, regenerate(committed.source.commit));
  assert.ok(
    problems.some((problem) => problem.startsWith("source.commit")),
    problems.join("\n")
  );
});

test("regeneration is idempotent and the check never rewrites the artifact", () => {
  const committed = readCommitted();
  const first = serializeContract(regenerate(committed.source.commit));
  const second = serializeContract(regenerate(committed.source.commit));
  assert.equal(first, second);
  assert.equal(first, readFileSync(CONTRACT_PATH, "utf8"));

  const before = statSync(CONTRACT_PATH);
  assert.deepEqual(checkContract({ root: ROOT }), { ok: true, problems: [] });
  const afterCheck = statSync(CONTRACT_PATH);
  assert.equal(readFileSync(CONTRACT_PATH, "utf8"), first);
  assert.equal(afterCheck.mtimeMs, before.mtimeMs);
});

test("source.commit is a full SHA and records the source file this tree carries", () => {
  const { source } = readCommitted();
  assert.equal(source.repo, "dyegolara/skillbook");
  assert.equal(source.path, SOURCE_PATH);
  assert.match(source.commit, /^[0-9a-f]{40}$/);

  const shown = spawnSync("git", ["show", `${source.commit}:${SOURCE_PATH}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, readFileSync(join(ROOT, SOURCE_PATH), "utf8"));

  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", source.commit, "HEAD"], {
    cwd: ROOT,
  });
  assert.equal(ancestor.status, 0, `source.commit ${source.commit} must be an ancestor of HEAD`);
});

test("the artifact carries the imported contract tables, not copies", () => {
  const committed = readCommitted();
  assert.equal(committed.contractVersion, CONTRACT_VERSION);
  assert.equal(committed.defaultProvider, DEFAULTS.provider);
  assert.deepEqual(committed.providers, PROVIDERS);
  assert.deepEqual(committed.efforts, EFFORTS);
  assert.deepEqual(committed.agents, AGENTS);
  assert.deepEqual(committed.providerKeyVars, { ...PROVIDER_KEY_VARS });
  assert.deepEqual(
    committed.agentAdapters,
    Object.fromEntries(AGENTS.map((agent) => [agent, AGENT_COMMANDS[agent].adapterId]))
  );
  assert.deepEqual(committed.launchStages, { ...LAUNCH_STAGES });
  assert.deepEqual(
    committed.stages.map(({ key }) => key),
    Object.keys(DEFAULTS.stages)
  );
  for (const stage of committed.stages) {
    assert.deepEqual(stage.defaults, DEFAULTS.stages[stage.key]);
    assert.equal(
      stage.launchName,
      Object.keys(LAUNCH_STAGES).find((name) => LAUNCH_STAGES[name] === stage.key) ?? null
    );
    // Only the grill stage is an interactive session; the launch stages are CLI launches.
    assert.equal(stage.interactive, stage.key === "GRILL");
  }
});

test("the --check CLI exits 0 on the committed tree without touching it", () => {
  const before = readFileSync(CONTRACT_PATH, "utf8");
  const result = spawnSync(process.execPath, [CLI, "--check"], {
    cwd: ROOT,
    encoding: "utf8",
    env: cleanEnv(),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /\[OK/);
  assert.equal(readFileSync(CONTRACT_PATH, "utf8"), before);
});
