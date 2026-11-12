import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../skills/software-factory/scripts/env-defaults.mjs";
import {
  CONTRACT_FILE,
  SOURCE_PATH,
  buildContract,
  checkContract,
  diffContracts,
  generateContract,
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

/** The generator's output at a commit, with the repo and digest read from the checkout. */
function regenerate(commit) {
  return buildContract({
    commit,
    repo: resolveSourceRepo(ROOT),
    sha256: sourceDigest(readFileSync(join(ROOT, SOURCE_PATH), "utf8")),
  });
}

/** The hex SHA-256 of a source file's bytes. */
function sourceDigest(source) {
  return createHash("sha256").update(source).digest("hex");
}

/** The CLI's environment without the chain pins a parent session exports. */
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DEV_ENV_")));
}

/** A temporary checkout root, removed when the suite ends. */
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "dev-env-contract-"));
  TEMP_ROOTS.push(root);
  return root;
}

/** An empty git repo whose package.json names this repo. The origin remote is not the source of `source.repo`. */
function gitRoot() {
  const root = tempRoot();
  const initialized = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  writeInto(
    root,
    "package.json",
    `${JSON.stringify({
      repository: { type: "git", url: "https://github.com/dyegolara/skillbook.git" },
    })}\n`
  );
  return root;
}

/** Write a file under a root, creating its parent directories. */
function writeInto(root, relativePath, contents) {
  mkdirSync(join(root, dirname(relativePath)), { recursive: true });
  writeFileSync(join(root, relativePath), contents);
}

test("the committed artifact records the source-touching commit on this history", () => {
  const { source } = readCommitted();
  assert.equal(source.repo, "dyegolara/skillbook");
  assert.equal(source.commit, "d83ae673ec08a63cd0d70b961e90eadb7174c817");
  assert.equal(source.sha256, "fc8c1d17ab85c60751264c2e61587fe310b81663ae02809302e2ea81d8c9342e");

  const before = readFileSync(CONTRACT_PATH, "utf8");
  const emitted = spawnSync(process.execPath, [CLI], {
    cwd: ROOT,
    encoding: "utf8",
    env: cleanEnv(),
  });
  assert.equal(emitted.status, 0, emitted.stdout + emitted.stderr);
  assert.equal(readFileSync(CONTRACT_PATH, "utf8"), before);
});

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
  const root = tempRoot();
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

test("a hand edit fails: a faked source digest is drift the comparison names", () => {
  const committed = readCommitted();
  const handEdited = structuredClone(committed);
  handEdited.source.sha256 = "0".repeat(64);
  const problems = diffContracts(handEdited, regenerate(committed.source.commit));
  assert.ok(
    problems.some((problem) => problem.startsWith("source.sha256")),
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

test("source.commit is a full SHA and, when available, records the source file this tree carries", () => {
  const { source } = readCommitted();
  assert.equal(source.repo, "dyegolara/skillbook");
  assert.equal(source.path, SOURCE_PATH);
  assert.match(source.commit, /^[0-9a-f]{40}$/);
  assert.equal(source.sha256, sourceDigest(readFileSync(join(ROOT, SOURCE_PATH), "utf8")));

  // Provenance is verified when the object is available. After a squash merge
  // it may be absent; the body comparison is the drift guard in that case.
  const known = spawnSync("git", ["cat-file", "-e", `${source.commit}^{commit}`], { cwd: ROOT });
  if (known.status === 0) {
    const shown = spawnSync("git", ["show", `${source.commit}:${SOURCE_PATH}`], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(shown.stdout, readFileSync(join(ROOT, SOURCE_PATH), "utf8"));
  }
});

test("a squashed history passes: an absent recorded commit is provenance, not drift", () => {
  const root = gitRoot();
  // Copy the artifact and the source it names, but commit nothing: the
  // recorded commit object is exactly as absent as it is after a squash merge.
  writeInto(root, CONTRACT_FILE, readFileSync(CONTRACT_PATH, "utf8"));
  writeInto(root, SOURCE_PATH, readFileSync(join(ROOT, SOURCE_PATH), "utf8"));

  const { source } = readCommitted();
  const absent = spawnSync("git", ["cat-file", "-e", `${source.commit}^{commit}`], { cwd: root });
  assert.notEqual(absent.status, 0, "the recorded commit object must be absent from this fresh repo");

  assert.deepEqual(checkContract({ root }), { ok: true, problems: [] });
});

test("a recorded commit that exists but is not an ancestor of HEAD passes", () => {
  const root = gitRoot();
  const identity = ["-c", "user.name=Contract Test", "-c", "user.email=contract@test.invalid"];
  writeInto(root, SOURCE_PATH, readFileSync(join(ROOT, SOURCE_PATH), "utf8"));
  assert.equal(spawnSync("git", ["add", SOURCE_PATH], { cwd: root }).status, 0);
  const first = spawnSync("git", [...identity, "commit", "-m", "source"], { cwd: root, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

  // A second root commit keeps the recorded object in place but off HEAD's
  // history — the state a squash merge leaves when the old object still exists.
  const orphan = spawnSync("git", ["checkout", "--orphan", "unrelated"], { cwd: root, encoding: "utf8" });
  assert.equal(orphan.status, 0, orphan.stderr);
  const second = spawnSync("git", [...identity, "commit", "-m", "unrelated root"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(second.status, 0, second.stderr);
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: root });
  assert.notEqual(ancestor.status, 0, "the recorded commit must be off HEAD's history");

  const artifact = readCommitted();
  artifact.source.commit = sha;
  writeInto(root, CONTRACT_FILE, serializeContract(artifact));
  assert.deepEqual(checkContract({ root }), { ok: true, problems: [] });
});

test("a recorded commit that carries a different source file fails", () => {
  const root = gitRoot();
  const currentSource = readFileSync(join(ROOT, SOURCE_PATH), "utf8");
  // Commit a drifted copy, then leave this tree carrying the real source: the
  // object exists, so the source-at-commit comparison must name the file.
  writeInto(root, SOURCE_PATH, `${currentSource}\n// drifted copy\n`);
  const added = spawnSync("git", ["add", SOURCE_PATH], { cwd: root, encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
  const committed = spawnSync(
    "git",
    ["-c", "user.name=Contract Test", "-c", "user.email=contract@test.invalid", "commit", "-m", "drifted source"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(committed.status, 0, committed.stderr);
  writeInto(root, SOURCE_PATH, currentSource);

  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.match(sha, /^[0-9a-f]{40}$/);
  const artifact = readCommitted();
  artifact.source.commit = sha;
  writeInto(root, CONTRACT_FILE, serializeContract(artifact));

  const result = checkContract({ root });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((problem) => problem.includes(SOURCE_PATH)),
    result.problems.join("\n")
  );
});

test("contract:emit records the last commit that touched the source file, not HEAD", () => {
  const root = gitRoot();
  const source = "export const SOURCE_TOUCH = 1;\n";
  writeInto(root, SOURCE_PATH, source);
  assert.equal(spawnSync("git", ["add", SOURCE_PATH], { cwd: root }).status, 0);
  const introduced = spawnSync(
    "git",
    ["-c", "user.name=Contract Test", "-c", "user.email=contract@test.invalid", "commit", "-m", "introduce source"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(introduced.status, 0, introduced.stderr);
  const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

  writeInto(root, "README.md", "later commit\n");
  assert.equal(spawnSync("git", ["add", "README.md"], { cwd: root }).status, 0);
  const later = spawnSync(
    "git",
    ["-c", "user.name=Contract Test", "-c", "user.email=contract@test.invalid", "commit", "-m", "unrelated"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(later.status, 0, later.stderr);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.notEqual(head, sourceCommit);

  generateContract({ root });
  const artifact = JSON.parse(readFileSync(join(root, CONTRACT_FILE), "utf8"));
  assert.equal(artifact.source.commit, sourceCommit);
  assert.notEqual(artifact.source.commit, head);
  const shown = spawnSync("git", ["show", `${sourceCommit}:${SOURCE_PATH}`], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, source);
  assert.equal(artifact.source.sha256, sourceDigest(source));

  writeInto(root, "NOTES.md", "still later\n");
  assert.equal(spawnSync("git", ["add", "NOTES.md"], { cwd: root }).status, 0);
  const again = spawnSync(
    "git",
    ["-c", "user.name=Contract Test", "-c", "user.email=contract@test.invalid", "commit", "-m", "still unrelated"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(again.status, 0, again.stderr);
  const before = readFileSync(join(root, CONTRACT_FILE), "utf8");
  generateContract({ root });
  assert.equal(readFileSync(join(root, CONTRACT_FILE), "utf8"), before);
});

test("contract:emit fails when the source file has no commit and writes nothing", () => {
  const root = gitRoot();
  writeInto(root, "README.md", "no source yet\n");
  assert.equal(spawnSync("git", ["add", "README.md"], { cwd: root }).status, 0);
  const committed = spawnSync(
    "git",
    ["-c", "user.name=Contract Test", "-c", "user.email=contract@test.invalid", "commit", "-m", "unrelated"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(committed.status, 0, committed.stderr);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  writeInto(root, SOURCE_PATH, "export const NEVER_COMMITTED = 1;\n");

  assert.throws(() => generateContract({ root }), (error) => {
    assert.match(error.message, new RegExp(SOURCE_PATH.replaceAll(".", "\\.")));
    assert.doesNotMatch(error.message, new RegExp(head));
    return true;
  });
  assert.equal(existsSync(join(root, CONTRACT_FILE)), false);
});

test("contract:emit refuses uncommitted source changes against the commit it records", () => {
  const root = gitRoot();
  const source = "export const COMMITTED = 1;\n";
  writeInto(root, SOURCE_PATH, source);
  assert.equal(spawnSync("git", ["add", SOURCE_PATH], { cwd: root }).status, 0);
  const introduced = spawnSync(
    "git",
    ["-c", "user.name=Contract Test", "-c", "user.email=contract@test.invalid", "commit", "-m", "introduce source"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(introduced.status, 0, introduced.stderr);
  const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

  writeInto(root, "README.md", "later\n");
  assert.equal(spawnSync("git", ["add", "README.md"], { cwd: root }).status, 0);
  const later = spawnSync(
    "git",
    ["-c", "user.name=Contract Test", "-c", "user.email=contract@test.invalid", "commit", "-m", "unrelated"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(later.status, 0, later.stderr);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.notEqual(head, sourceCommit);
  writeInto(root, SOURCE_PATH, `${source}\n`);

  assert.throws(() => generateContract({ root }), (error) => {
    assert.match(error.message, new RegExp(sourceCommit));
    assert.doesNotMatch(error.message, /HEAD/);
    assert.match(error.message, /commit the source change/);
    return true;
  });
  assert.equal(existsSync(join(root, CONTRACT_FILE)), false);
});

test("contract:emit refuses a source change that is not in the recorded commit", () => {
  const root = gitRoot();
  const source = readFileSync(join(ROOT, SOURCE_PATH), "utf8");
  writeInto(root, SOURCE_PATH, source);
  assert.equal(spawnSync("git", ["add", SOURCE_PATH], { cwd: root }).status, 0);
  const committed = spawnSync(
    "git",
    ["-c", "user.name=Contract Test", "-c", "user.email=contract@test.invalid", "commit", "-m", "source"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(committed.status, 0, committed.stderr);
  writeInto(root, SOURCE_PATH, `${source}\n`);

  assert.throws(
    () => generateContract({ root }),
    /does not match commit [0-9a-f]{40} — commit the source change/
  );
  assert.equal(existsSync(join(root, CONTRACT_FILE)), false);
});

test("contract:emit reads source.repo from package.json, not from the origin remote", () => {
  const root = gitRoot();
  const remote = spawnSync(
    "git",
    ["remote", "add", "origin", "https://github.com/a-forker/skillbook.git"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(remote.status, 0, remote.stderr);
  writeInto(
    root,
    "package.json",
    `${JSON.stringify({
      repository: { type: "git", url: "https://github.com/dyegolara/skillbook.git" },
    })}\n`
  );
  writeInto(root, SOURCE_PATH, "export const REPO = 1;\n");
  assert.equal(spawnSync("git", ["add", SOURCE_PATH], { cwd: root }).status, 0);
  const committed = spawnSync(
    "git",
    ["-c", "user.name=Contract Test", "-c", "user.email=contract@test.invalid", "commit", "-m", "source"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(committed.status, 0, committed.stderr);

  generateContract({ root });
  const artifact = JSON.parse(readFileSync(join(root, CONTRACT_FILE), "utf8"));
  assert.equal(artifact.source.repo, "dyegolara/skillbook");
});

test("contract:emit fails when package.json has no repository field and writes nothing", () => {
  const root = gitRoot();
  writeInto(root, "package.json", "{}\n");
  writeInto(root, SOURCE_PATH, "export const REPO = 1;\n");
  assert.equal(spawnSync("git", ["add", SOURCE_PATH], { cwd: root }).status, 0);
  const committed = spawnSync(
    "git",
    ["-c", "user.name=Contract Test", "-c", "user.email=contract@test.invalid", "commit", "-m", "source"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(committed.status, 0, committed.stderr);

  assert.throws(() => generateContract({ root }), /repository/);
  assert.equal(existsSync(join(root, CONTRACT_FILE)), false);
});

test("contract:emit fails when package.json repository is malformed and writes nothing", () => {
  const root = gitRoot();
  writeInto(root, "package.json", `${JSON.stringify({ repository: { type: "git" } })}\n`);
  writeInto(root, SOURCE_PATH, "export const REPO = 1;\n");
  assert.equal(spawnSync("git", ["add", SOURCE_PATH], { cwd: root }).status, 0);
  const committed = spawnSync(
    "git",
    ["-c", "user.name=Contract Test", "-c", "user.email=contract@test.invalid", "commit", "-m", "source"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(committed.status, 0, committed.stderr);

  assert.throws(() => generateContract({ root }), /repository/);
  assert.equal(existsSync(join(root, CONTRACT_FILE)), false);
});

test("the check rebuilds from the recorded source.repo and names a bad repository field", () => {
  const root = gitRoot();
  writeInto(root, "package.json", "{}\n");
  writeInto(root, SOURCE_PATH, readFileSync(join(ROOT, SOURCE_PATH), "utf8"));
  const artifact = readCommitted();
  artifact.providers = artifact.providers.filter((provider) => provider !== PROVIDERS[PROVIDERS.length - 1]);
  writeInto(root, CONTRACT_FILE, serializeContract(artifact));

  const result = checkContract({ root });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((problem) => problem.includes("repository")),
    result.problems.join("\n")
  );
  assert.ok(
    result.problems.some((problem) => problem.includes("providers")),
    result.problems.join("\n")
  );
});

test("a fork checkout passes the check", () => {
  const root = gitRoot();
  const remote = spawnSync(
    "git",
    ["remote", "add", "origin", "https://github.com/a-forker/skillbook.git"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(remote.status, 0, remote.stderr);
  writeInto(root, SOURCE_PATH, readFileSync(join(ROOT, SOURCE_PATH), "utf8"));
  writeInto(root, CONTRACT_FILE, readFileSync(CONTRACT_PATH, "utf8"));

  assert.deepEqual(checkContract({ root }), { ok: true, problems: [] });
  const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
  assert.equal(origin.stdout.trim(), "https://github.com/a-forker/skillbook.git");
});

test("the check names package.json repository when the committed source.repo disagrees", () => {
  const root = gitRoot();
  writeInto(root, SOURCE_PATH, readFileSync(join(ROOT, SOURCE_PATH), "utf8"));
  const artifact = readCommitted();
  artifact.source.repo = "someone/fork";
  writeInto(root, CONTRACT_FILE, serializeContract(artifact));

  const result = checkContract({ root });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((problem) => problem.includes("repository") && problem.includes("someone/fork")),
    result.problems.join("\n")
  );
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
