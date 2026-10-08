import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { verifySoftwareFactoryPack } from "./verify-software-factory.mjs";

const CHAIN_PINS = {
  "grill-with-spec": { model: "opencode-go/glm-5.3", thinking: "max" },
  "dev-flow": { model: "opencode-go/glm-5.3", thinking: "max" },
  "code-review-loop": { model: "opencode-go/mimo-v2.6-pro", thinking: "high" },
  "create-pr": { model: "opencode-go/muse-spark-1.3-contributor", thinking: "xhigh" },
};

const readme = [
  "# Skillbook",
  "",
  "## What's inside",
  "",
  "| Skill | Source | Category | What it does |",
  "|---|---|---|---|",
  "| `software-factory` pack | **in-repo** (`./skills/software-factory`) | software-factory | Four chain skills. |",
  "| Matt Pocock pack | [mattpocock/skills](https://github.com/mattpocock/skills) (skills.sh) | software-factory | Spec-driven pack. |",
  "",
  "## Installation",
  "",
].join("\n");

const agents = [
  "# Dojo Mojo Skillbook",
  "",
  "### Own skills",
  "",
  "| Skill | Category | What it does |",
  "|---|---|---|",
  "| `software-factory` pack | software-factory | Four chain skills. |",
  "",
  "### Referenced skills (published channels)",
  "",
  "| Skill | Source | Category | What it does |",
  "|---|---|---|---|",
  "| Matt Pocock pack | `mattpocock/skills` (skills.sh) | software-factory | Spec-driven pack. |",
  "",
].join("\n");

const publishing = [
  "const refs = [",
  '  ["skills.sh page", "https://skills.sh/mattpocock/skills"],',
  '  ["GitHub repo", "https://github.com/mattpocock/skills"],',
  "];",
  "",
].join("\n");

const roots = [];

function write(root, rel, content) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function skillFrontmatter(name, overrides = {}) {
  const pin = CHAIN_PINS[name];
  const fields = {
    name,
    description: `Chain skill ${name}.`,
    model: pin.model,
    thinking: pin.thinking,
    ...overrides,
  };
  return [
    "---",
    `name: ${fields.name}`,
    `description: "${fields.description}"`,
    "disable-model-invocation: true",
    "license: MIT",
    "metadata:",
    `  model: ${fields.model}`,
    `  thinking: ${fields.thinking}`,
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

function makeRepo({
  skillOverrides = {},
  omitSkill = null,
  pluginSkills,
  skipPackReadme = false,
  readmeText = readme,
  agentsText = agents,
  publishingText = publishing,
  skillsInstall = "npx skills@latest add mattpocock/skills",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "software-factory-verify-"));
  roots.push(root);
  for (const name of Object.keys(CHAIN_PINS)) {
    if (name === omitSkill) continue;
    write(root, `skills/software-factory/${name}/SKILL.md`, skillFrontmatter(name, skillOverrides[name]));
  }
  if (!skipPackReadme) write(root, "skills/software-factory/README.md", "# software-factory pack\n");
  write(
    root,
    ".claude-plugin/plugin.json",
    JSON.stringify({
      skills:
        pluginSkills ??
        Object.keys(CHAIN_PINS).map((name) => `./skills/software-factory/${name}`),
    })
  );
  write(root, "README.md", readmeText);
  write(root, "AGENTS.md", agentsText);
  write(root, "scripts/verify-publishing.mjs", publishingText);
  write(root, "package.json", JSON.stringify({ scripts: { "skills:install": skillsInstall } }));
  return join(root, "skills", "software-factory");
}

function verify(packDir) {
  return verifySoftwareFactoryPack(packDir);
}

function withoutRow(text, prefix) {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(prefix))
    .join("\n");
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("a conforming fixture pack has no problems", () => {
  assert.deepEqual(verify(makeRepo()), []);
});

test("rejects a missing chain skill", () => {
  const problems = verify(makeRepo({ omitSkill: "dev-flow" }));
  assert.ok(
    problems.some((problem) =>
      problem.includes("skills/software-factory/dev-flow/SKILL.md: missing")
    )
  );
});

test("rejects a name that does not match its folder", () => {
  const problems = verify(
    makeRepo({ skillOverrides: { "dev-flow": { name: "tickets-flow" } } })
  );
  assert.ok(problems.some((problem) => problem.includes("does not match folder")));
});

test("rejects a missing description", () => {
  const problems = verify(
    makeRepo({ skillOverrides: { "create-pr": { description: "" } } })
  );
  assert.ok(problems.some((problem) => problem.includes("missing description")));
});

test("rejects a description longer than 1024 characters", () => {
  const problems = verify(
    makeRepo({ skillOverrides: { "grill-with-spec": { description: "x".repeat(1025) } } })
  );
  assert.ok(problems.some((problem) => problem.includes("longer than 1024 characters")));
});

test("rejects a model pin that does not match the pinned chain contract", () => {
  const problems = verify(
    makeRepo({ skillOverrides: { "grill-with-spec": { model: "opencode-go/gpt-9" } } })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes('model pin "opencode-go/gpt-9" does not match the pinned chain contract "opencode-go/glm-5.3"')
    )
  );
});

test("rejects a thinking pin that does not match the pinned chain contract", () => {
  const problems = verify(
    makeRepo({ skillOverrides: { "create-pr": { thinking: "high" } } })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes('thinking pin "high" does not match the pinned chain contract "xhigh"')
    )
  );
});

test("rejects a chain skill missing from the plugin manifest", () => {
  const problems = verify(
    makeRepo({ pluginSkills: ["./skills/software-factory/grill-with-spec"] })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes("skills/software-factory/dev-flow/SKILL.md: not registered in the plugin manifest")
    )
  );
});

test("rejects a missing pack README", () => {
  const problems = verify(makeRepo({ skipPackReadme: true }));
  assert.ok(problems.some((problem) => problem.includes("skills/software-factory/README.md: missing")));
});

test("rejects a missing software-factory row in README What's inside", () => {
  const problems = verify(
    makeRepo({ readmeText: withoutRow(readme, "| `software-factory` pack ") })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes('README.md: missing the software-factory pack row in "What\'s inside"')
    )
  );
});

test("rejects a missing software-factory row in AGENTS Own skills", () => {
  const problems = verify(
    makeRepo({ agentsText: withoutRow(agents, "| `software-factory` pack ") })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes('AGENTS.md: missing the software-factory pack row in "Own skills"')
    )
  );
});

test("rejects a missing Matt Pocock row in README What's inside", () => {
  const problems = verify(makeRepo({ readmeText: withoutRow(readme, "| Matt Pocock pack ") }));
  assert.ok(
    problems.some((problem) =>
      problem.includes('README.md: missing the Matt Pocock pack row in "What\'s inside"')
    )
  );
});

test("rejects a missing Matt Pocock row in AGENTS referenced skills", () => {
  const problems = verify(makeRepo({ agentsText: withoutRow(agents, "| Matt Pocock pack ") }));
  assert.ok(
    problems.some((problem) =>
      problem.includes('AGENTS.md: missing the Matt Pocock pack row in "Referenced skills (published channels)"')
    )
  );
});

test("rejects a missing skills.sh channel check", () => {
  const problems = verify(
    makeRepo({ publishingText: publishing.replace("https://skills.sh/mattpocock/skills", "") })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes("scripts/verify-publishing.mjs: missing published-channel check https://skills.sh/mattpocock/skills")
    )
  );
});

test("rejects a missing GitHub channel check", () => {
  const problems = verify(
    makeRepo({ publishingText: publishing.replace("https://github.com/mattpocock/skills", "") })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes("scripts/verify-publishing.mjs: missing published-channel check https://github.com/mattpocock/skills")
    )
  );
});

test("rejects a skills:install that drops the Matt Pocock pack", () => {
  const problems = verify(
    makeRepo({ skillsInstall: "npx skills@latest add dyegolara/skillbook" })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes("package.json: skills:install does not install mattpocock/skills")
    )
  );
});

test("the CLI reports the real pack as OK", () => {
  const script = fileURLToPath(new URL("./verify-software-factory.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes("[OK  ] software-factory pack contract holds"));
});
