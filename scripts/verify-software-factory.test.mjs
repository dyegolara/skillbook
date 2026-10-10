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

const IMPLEMENT_SPEC_PIN = { model: "opencode-go/deepseek-v4.1-flash", thinking: "max" };

function helperEntry(stage, pin) {
  return `  "${stage}": { provider: "opencode-go", model: "${pin.model}", thinking: "${pin.thinking}" },`;
}

const helper = [
  "export const STAGE_PINS = {",
  helperEntry("dev-flow", CHAIN_PINS["dev-flow"]),
  helperEntry("implement-spec", IMPLEMENT_SPEC_PIN),
  helperEntry("code-review-loop", CHAIN_PINS["code-review-loop"]),
  helperEntry("create-pr", CHAIN_PINS["create-pr"]),
  "};",
  "",
].join("\n");

const GRILL_PIN = { model: "opencode-go/glm-5.3", effort: "max" };

const grillHelper = [
  `export const GRILL_PIN = { model: "${GRILL_PIN.model}", effort: "${GRILL_PIN.effort}" };`,
  "",
].join("\n");

const GRILL_ROUTE = [
  "Decision-forcing findings open the grilling session instead of waiting:",
  "",
  "```bash",
  "node skills/software-factory/scripts/open-grill-session.mjs <spec> '<re-entry prompt>'",
  "```",
  "",
].join("\n");

const adr = [
  "# 0006 — Chain skills hand off across pinned agent/model sessions",
  "",
  "- Each stage's `SKILL.md` pins its model, invoked at the model's highest",
  "  available effort/thinking:",
  "  - grill-with-spec — `opencode-go/glm-5.3` (effort max)",
  "  - dev-flow — `opencode-go/glm-5.3` (`--thinking max`)",
  "  - implement-spec — `opencode-go/deepseek-v4.1-flash` (`--thinking max`)",
  "  - code-review-loop — `opencode-go/mimo-v2.6-pro` (`--thinking high`)",
  "  - create-pr — `opencode-go/muse-spark-1.3-contributor` (`--thinking xhigh`)",
  "",
].join("\n");

const SKILL_LAUNCHES = {
  "grill-with-spec": ["dev-flow"],
  "dev-flow": ["implement-spec"],
  "code-review-loop": ["dev-flow", "create-pr"],
  "create-pr": [],
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

function skillContent(name, overrides = {}) {
  const { body, ...frontmatterOverrides } = overrides;
  return `${skillFrontmatter(name, frontmatterOverrides)}\n${body ?? defaultSkillBody(name)}`;
}

function defaultSkillBody(name, { includeGrillRoute = true } = {}) {
  const stages = SKILL_LAUNCHES[name];
  const launches =
    stages.length === 0
      ? "The terminal stage launches nothing.\n"
      : stages
          .map((stage) =>
            [
              `Launch ${stage}:`,
              "",
              "```bash",
              `node skills/software-factory/scripts/launch-stage.mjs ${stage} 'Run the ${stage} skill.'`,
              "```",
              "",
            ].join("\n")
          )
          .join("\n");
  if (name !== "code-review-loop" || !includeGrillRoute) return launches;
  return `${launches}\n${GRILL_ROUTE}`;
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
  omitHelper = false,
  helperText = helper,
  omitGrillHelper = false,
  grillHelperText = grillHelper,
  omitGrillRoute = false,
  omitAdr = false,
  adrText = adr,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "software-factory-verify-"));
  roots.push(root);
  for (const name of Object.keys(CHAIN_PINS)) {
    if (name === omitSkill) continue;
    const overrides =
      name === "code-review-loop" && omitGrillRoute
        ? { ...skillOverrides[name], body: "The route prints a pause and waits.\n" }
        : skillOverrides[name];
    write(root, `skills/software-factory/${name}/SKILL.md`, skillContent(name, overrides));
  }
  if (!omitHelper) write(root, "skills/software-factory/scripts/launch-stage.mjs", helperText);
  if (!omitGrillHelper) {
    write(root, "skills/software-factory/scripts/open-grill-session.mjs", grillHelperText);
  }
  if (!omitAdr) write(root, "docs/adr/0006-chain-skills-cross-model-handoffs.md", adrText);
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

test("rejects a missing launch helper", () => {
  const problems = verify(makeRepo({ omitHelper: true }));
  assert.ok(
    problems.some((problem) =>
      problem.includes("skills/software-factory/scripts/launch-stage.mjs: missing")
    )
  );
});

test("rejects a missing grill-session helper", () => {
  const problems = verify(makeRepo({ omitGrillHelper: true }));
  assert.ok(
    problems.some((problem) =>
      problem.includes("skills/software-factory/scripts/open-grill-session.mjs: missing")
    )
  );
});

test("rejects a code-review-loop whose decision-forcing route does not reference the grill-session helper", () => {
  const problems = verify(makeRepo({ omitGrillRoute: true }));
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        "skills/software-factory/code-review-loop/SKILL.md: decision-forcing route does not reference skills/software-factory/scripts/open-grill-session.mjs"
      )
    )
  );
});

test("rejects a decision-forcing route that mentions the grill-session helper only in prose", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "code-review-loop": {
          body: "Decision-forcing findings route to skills/software-factory/scripts/open-grill-session.mjs.\n",
        },
      },
    })
  );
  assert.deepEqual(problems, [
    "skills/software-factory/code-review-loop/SKILL.md: decision-forcing route does not reference skills/software-factory/scripts/open-grill-session.mjs",
  ]);
});

test("rejects a grill pin that diverges from the grill-with-spec frontmatter", () => {
  const problems = verify(
    makeRepo({ grillHelperText: grillHelper.replace("opencode-go/glm-5.3", "opencode-go/gpt-9") })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        'skills/software-factory/scripts/open-grill-session.mjs: grill pin "model opencode-go/gpt-9, effort max" does not match skills/software-factory/grill-with-spec/SKILL.md frontmatter "model opencode-go/glm-5.3, thinking max"'
      )
    )
  );
});

test("rejects a grill helper whose GRILL_PIN table cannot be read", () => {
  const problems = verify(makeRepo({ grillHelperText: "export const GRILL_PIN = {};\n" }));
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        "skills/software-factory/scripts/open-grill-session.mjs: cannot read the GRILL_PIN table"
      )
    )
  );
});

test("rejects a launch snippet that does not reference the helper", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "dev-flow": {
          body: [
            "Launch the next stage:",
            "",
            "```bash",
            "pi --print --provider opencode-go --model opencode-go/glm-5.3 --thinking max 'Run implement-spec.'",
            "```",
            "",
          ].join("\n"),
        },
      },
    })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        "skills/software-factory/dev-flow/SKILL.md: launch snippet does not reference skills/software-factory/scripts/launch-stage.mjs"
      )
    )
  );
});

test("rejects a helper pins table that diverges from the SKILL.md frontmatter", () => {
  const problems = verify(
    makeRepo({ helperText: helper.replace("opencode-go/glm-5.3", "opencode-go/gpt-9") })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        'skills/software-factory/scripts/launch-stage.mjs: dev-flow pin "model opencode-go/gpt-9, thinking max" does not match skills/software-factory/dev-flow/SKILL.md frontmatter "model opencode-go/glm-5.3, thinking max"'
      )
    )
  );
});

test("rejects a helper pins table that diverges from ADR-0006", () => {
  const problems = verify(
    makeRepo({
      helperText: helper.replace("opencode-go/deepseek-v4.1-flash", "opencode-go/deepseek-v4.1"),
    })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        'skills/software-factory/scripts/launch-stage.mjs: implement-spec pin "model opencode-go/deepseek-v4.1, thinking max" does not match docs/adr/0006-chain-skills-cross-model-handoffs.md "model opencode-go/deepseek-v4.1-flash, thinking max"'
      )
    )
  );
});

test("reads the implement-spec pin from ADR-0006, not a hardcoded copy", () => {
  const problems = verify(
    makeRepo({ adrText: adr.replace("opencode-go/deepseek-v4.1-flash", "opencode-go/deepseek-v4.1") })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        'skills/software-factory/scripts/launch-stage.mjs: implement-spec pin "model opencode-go/deepseek-v4.1-flash, thinking max" does not match docs/adr/0006-chain-skills-cross-model-handoffs.md "model opencode-go/deepseek-v4.1, thinking max"'
      )
    )
  );
});

test("rejects a spawn snippet without an explicit --model", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "dev-flow": {
          body: [
            "Launch the next stage:",
            "",
            "```bash",
            "pi --print --provider opencode-go --thinking max 'Run implement-spec.'",
            "```",
            "",
          ].join("\n"),
        },
      },
    })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes("skills/software-factory/dev-flow/SKILL.md: spawn snippet lacks an explicit --model")
    )
  );
});

test("accepts a pinned sub-agent spawn that is not a stage launch", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "dev-flow": {
          body: [
            "Run the test author as a sub-agent:",
            "",
            "```bash",
            "pi --print --provider opencode-go --model opencode-go/glm-5.3 --thinking max 'Run the tdd skill.'",
            "```",
            "",
          ].join("\n"),
        },
      },
    })
  );
  assert.deepEqual(problems, []);
});

test("rejects a helper whose STAGE_PINS table cannot be read", () => {
  const problems = verify(makeRepo({ helperText: "export const STAGE_PINS = {};\n" }));
  assert.ok(
    problems.some((problem) =>
      problem.includes("skills/software-factory/scripts/launch-stage.mjs: cannot read the STAGE_PINS table")
    )
  );
});

test("rejects a missing ADR-0006 pin source", () => {
  const problems = verify(makeRepo({ omitAdr: true }));
  assert.ok(
    problems.some((problem) =>
      problem.includes("docs/adr/0006-chain-skills-cross-model-handoffs.md: missing")
    )
  );
});

test("the CLI reports the real pack as OK", () => {
  const script = fileURLToPath(new URL("./verify-software-factory.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes("[OK  ] software-factory pack contract holds"));
});
