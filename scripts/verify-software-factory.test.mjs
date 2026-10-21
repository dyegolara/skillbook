import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { verifySoftwareFactoryPack } from "./verify-software-factory.mjs";
import { DEFAULTS } from "../skills/software-factory/scripts/env-defaults.mjs";

// The four chain skills and the env-defaults stage key each one documents. The
// fixture's pin values are read from the defaults module — no pin literals.
const CHAIN_SKILLS = [
  { name: "grill-with-spec", stage: "GRILL" },
  { name: "dev-flow", stage: "DEV_FLOW" },
  { name: "code-review-loop", stage: "CODE_REVIEW_LOOP" },
  { name: "create-pr", stage: "CREATE_PR" },
];

/** The stage's default model/effort, read from the defaults module. */
function defaultPin(stage) {
  return { model: DEFAULTS.stages[stage].model, effort: DEFAULTS.stages[stage].effort };
}

/** The `pi` spawn shape with the stage's default pins — a fixture snippet. */
function piSpawn(stage, pointers) {
  const pin = defaultPin(stage);
  return `pi --print --provider ${DEFAULTS.provider} --model ${pin.model} --thinking ${pin.effort} '${pointers}'`;
}

const RETRY_ATTEMPTS = 5;

const helper = [
  'import { buildAgentCommand } from "./env-defaults.mjs";',
  "",
  `export const RETRY_ATTEMPTS = ${RETRY_ATTEMPTS};`,
  "",
  "export function buildStageCommand(stage, pointers) {",
  '  return [...buildAgentCommand(stage, pointers)].join(" ");',
  "}",
  "",
  "export function wakeHelperPath() {",
  '  return new URL("./open-wake-session.mjs", import.meta.url);',
  "}",
  "",
  "export function buildRetryWrapper(stage, spec, pointers) {",
  "  const command = buildStageCommand(stage, pointers);",
  "  const marker = `FAILED: chain #${spec} ${stage} gave up after ${RETRY_ATTEMPTS} attempts`;",
  "  return (",
  '    `while [ "$attempt" -le ${RETRY_ATTEMPTS} ]; do ` +',
  "    `${command}; chain_status=$?; [ $chain_status -eq 0 ] && break; ` +",
  "    `chain_attempt=$((chain_attempt+1)); done; ` +",
  "    `[ $chain_status -ne 0 ] && echo ${marker}; ` +",
  "    `node ${wakeHelperPath()} ${stage} ${spec} ${command}`",
  "  );",
  "}",
  "",
].join("\n");

const grillHelper = [
  'import { AGENT_COMMANDS, resolveAgent, resolveEffort, resolveModel } from "./env-defaults.mjs";',
  "",
  "export function grillPin(env = process.env) {",
  '  const agent = resolveAgent("GRILL", env);',
  '  return { model: resolveModel("GRILL", env), effort: resolveEffort("GRILL", env), adapterId: AGENT_COMMANDS[agent].adapterId };',
  "}",
  "",
].join("\n");

const wakeHelper = ["export function wakeLabel() {}", ""].join("\n");

const GRILL_ROUTE = [
  "Decision-forcing findings open the grilling session instead of waiting:",
  "",
  "```bash",
  'node "<skill-dir>/scripts/open-grill-session.mjs" <spec> \'<re-entry prompt>\'',
  "```",
  "",
].join("\n");

const HANDOFF_RULES = [
  "## Handoff rules",
  "",
  "The chain's rules apply at this stage and every later one:",
  "",
  "- Every stage shares one git worktree.",
  "",
].join("\n");

const DRIFTED_HANDOFF_RULES = HANDOFF_RULES.replace(
  "Every stage shares one git worktree.",
  "Every stage shares one worktree."
);

const adr = [
  "# 0006 — Chain skills hand off across pinned agent/model sessions",
  "",
  "- A stage that gives up actuates the wake: a new sibling helper,",
  "  `open-wake-session.mjs`, packaged beside `launch-stage.mjs`,",
  '  actuated by the wrapper as `node "<skill-dir>/scripts/open-wake-session.mjs" <stage> <spec> \'<resume command>\'`.',
  "",
].join("\n");

// The real defaults module's source text: the fixture pack carries it so the
// verifier reads the same table it checks the real pack against. Its bytes are
// the test's source of truth for every expected default.
const DEFAULTS_SOURCE = readFileSync(
  new URL("../skills/software-factory/scripts/env-defaults.mjs", import.meta.url),
  "utf8"
);

const SKILL_LAUNCHES = {
  "grill-with-spec": ["dev-flow"],
  "dev-flow": ["implement-spec"],
  "code-review-loop": ["dev-flow", "create-pr"],
  "create-pr": [],
};

// The Fresh start's decided launch shape: the triple the status snippet echoed
// rides the three explicit id flags (the fifth decision, item 2).
const FRESH_START_FLAGS = "--repo-id <repoId> --worktree-id <worktreeId> --task-id <taskId>";

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
  const skill = CHAIN_SKILLS.find((entry) => entry.name === name);
  const pin = defaultPin(skill.stage);
  const fields = {
    name,
    description: `Chain skill ${name}.`,
    model: pin.model,
    effort: pin.effort,
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
    `  effort: ${fields.effort}`,
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

function skillContent(name, overrides = {}) {
  const { body, omitHandoffRules, ...frontmatterOverrides } = overrides;
  const content = body ?? defaultSkillBody(name);
  const carriesHandoff = ["dev-flow", "code-review-loop"].includes(name) && !omitHandoffRules;
  const handoff = carriesHandoff ? `\n${HANDOFF_RULES}` : "";
  return `${skillFrontmatter(name, frontmatterOverrides)}\n${content}${handoff}`;
}

function defaultSkillBody(name, { includeGrillRoute = true } = {}) {
  const stages = SKILL_LAUNCHES[name];
  const launches =
    stages.length === 0
      ? "The terminal stage launches nothing.\n"
      : stages
          .map((stage) => {
            const flags =
              name === "grill-with-spec" && stage === "dev-flow" ? ` ${FRESH_START_FLAGS}` : "";
            return [
              `Launch ${stage}:`,
              "",
              "```bash",
              `node "<skill-dir>/scripts/launch-stage.mjs" ${stage} <spec> 'Run the ${stage} skill.'${flags}`,
              "```",
              "",
            ].join("\n");
          })
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
  omitDefaults = false,
  defaultsText = DEFAULTS_SOURCE,
  omitGrillHelper = false,
  grillHelperText = grillHelper,
  omitWakeHelper = false,
  wakeHelperText = wakeHelper,
  omitGrillRoute = false,
  omitAdr = false,
  adrText = adr,
  omitHandoffRules = null,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "software-factory-verify-"));
  roots.push(root);
  for (const { name } of CHAIN_SKILLS) {
    if (name === omitSkill) continue;
    const overrides =
      name === "code-review-loop" && omitGrillRoute
        ? { ...skillOverrides[name], body: "The route prints a pause and waits.\n" }
        : skillOverrides[name];
    write(
      root,
      `skills/software-factory/${name}/SKILL.md`,
      skillContent(name, {
        ...overrides,
        omitHandoffRules: omitHandoffRules === name || overrides?.omitHandoffRules === true,
      })
    );
    if (name !== "create-pr" && !omitHelper) {
      write(root, `skills/software-factory/${name}/scripts/launch-stage.mjs`, helperText);
    }
    if (name === "code-review-loop" && !omitGrillHelper) {
      write(root, `skills/software-factory/${name}/scripts/open-grill-session.mjs`, grillHelperText);
    }
    if (name !== "create-pr" && !omitWakeHelper) {
      write(root, `skills/software-factory/${name}/scripts/open-wake-session.mjs`, wakeHelperText);
    }
    if (name !== "create-pr" && !omitDefaults) {
      write(root, `skills/software-factory/${name}/scripts/env-defaults.mjs`, defaultsText);
    }
  }
  if (!omitHelper) write(root, "skills/software-factory/scripts/launch-stage.mjs", helperText);
  if (!omitGrillHelper) {
    write(root, "skills/software-factory/scripts/open-grill-session.mjs", grillHelperText);
  }
  if (!omitWakeHelper) write(root, "skills/software-factory/scripts/open-wake-session.mjs", wakeHelperText);
  if (!omitDefaults) write(root, "skills/software-factory/scripts/env-defaults.mjs", defaultsText);
  if (!omitAdr) write(root, "docs/adr/0006-chain-skills-cross-model-handoffs.md", adrText);
  if (!skipPackReadme) write(root, "skills/software-factory/README.md", "# software-factory pack\n");
  write(
    root,
    ".claude-plugin/plugin.json",
    JSON.stringify({
      skills:
        pluginSkills ??
        CHAIN_SKILLS.map(({ name }) => `./skills/software-factory/${name}`),
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

// The identity check compares the two block-carrying skills to each other,
// not to a fixed text — so the pinning pair carries a custom block.
const CUSTOM_HANDOFF_RULES = HANDOFF_RULES.replace(
  "Every stage shares one git worktree.",
  "Every stage shares one git worktree, no exceptions."
);
const DRIFTED_CUSTOM_HANDOFF_RULES = CUSTOM_HANDOFF_RULES.replace("no exceptions", "no exception");

function bodyWithHandoff(name, rules) {
  return `${defaultSkillBody(name)}\n${rules}`;
}

test("accepts an identical non-canonical Handoff rules pair", () => {
  const pack = makeRepo({
    skillOverrides: {
      "dev-flow": { body: bodyWithHandoff("dev-flow", CUSTOM_HANDOFF_RULES), omitHandoffRules: true },
      "code-review-loop": {
        body: bodyWithHandoff("code-review-loop", CUSTOM_HANDOFF_RULES),
        omitHandoffRules: true,
      },
    },
  });
  for (const name of ["dev-flow", "code-review-loop"]) {
    assert.ok(
      readFileSync(join(pack, name, "SKILL.md"), "utf8").endsWith(CUSTOM_HANDOFF_RULES),
      `${name} closes with the custom block`
    );
  }
  assert.deepEqual(verify(pack), []);
});

test("rejects a one-byte drift between the custom Handoff rules blocks", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "dev-flow": { body: bodyWithHandoff("dev-flow", CUSTOM_HANDOFF_RULES), omitHandoffRules: true },
        "code-review-loop": {
          body: bodyWithHandoff("code-review-loop", DRIFTED_CUSTOM_HANDOFF_RULES),
          omitHandoffRules: true,
        },
      },
    })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        'skills/software-factory/dev-flow/SKILL.md: "## Handoff rules" block differs from skills/software-factory/code-review-loop/SKILL.md'
      )
    )
  );
});

test("rejects a Handoff rules block that drifts from its shared copy", () => {
  const problems = verify(
    makeRepo({
      omitHandoffRules: "code-review-loop",
      skillOverrides: {
        "code-review-loop": {
          body: `${defaultSkillBody("code-review-loop")}\n${DRIFTED_HANDOFF_RULES}`,
        },
      },
    })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        'skills/software-factory/dev-flow/SKILL.md: "## Handoff rules" block differs from skills/software-factory/code-review-loop/SKILL.md'
      )
    )
  );
});

test("rejects a block-carrying skill missing its closing Handoff rules block", () => {
  const problems = verify(makeRepo({ omitHandoffRules: "code-review-loop" }));
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        'skills/software-factory/code-review-loop/SKILL.md: missing the closing "## Handoff rules" block'
      )
    )
  );
});

test("rejects a registered skill missing its local launch helper", () => {
  const pack = makeRepo();
  rmSync(join(pack, "dev-flow/scripts/launch-stage.mjs"));
  assert.ok(verify(pack).some((problem) => problem.includes("dev-flow/scripts/launch-stage.mjs: missing packaged helper")));
});

test("rejects a packaged helper that drifts from its shared source", () => {
  const pack = makeRepo();
  writeFileSync(join(pack, "code-review-loop/scripts/launch-stage.mjs"), "export const STAGE_PINS = {};\n");
  assert.ok(verify(pack).some((problem) => problem.includes("code-review-loop/scripts/launch-stage.mjs: differs")));
});

test("rejects an invocation of a helper outside the installed skill folder", () => {
  const pack = makeRepo({
    skillOverrides: {
      "dev-flow": { body: "```bash\nnode skills/software-factory/scripts/launch-stage.mjs implement-spec <spec> 'pointers'\n```\n" },
    },
  });
  assert.ok(verify(pack).some((problem) => problem.includes("helper invocation escapes")));
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

test("rejects a frontmatter model pin that diverges from env-defaults", () => {
  const wrong = "opencode-go/gpt-9";
  const expected = defaultPin("GRILL").model;
  const problems = verify(makeRepo({ skillOverrides: { "grill-with-spec": { model: wrong } } }));
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        `skills/software-factory/grill-with-spec/SKILL.md: model pin "${wrong}" does not match skills/software-factory/scripts/env-defaults.mjs DEFAULTS.stages.GRILL.model "${expected}"`
      )
    )
  );
});

test("rejects a frontmatter effort pin that diverges from env-defaults", () => {
  const wrong = "low";
  const expected = defaultPin("CREATE_PR").effort;
  const problems = verify(makeRepo({ skillOverrides: { "create-pr": { effort: wrong } } }));
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        `skills/software-factory/create-pr/SKILL.md: effort pin "${wrong}" does not match skills/software-factory/scripts/env-defaults.mjs DEFAULTS.stages.CREATE_PR.effort "${expected}"`
      )
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

test("rejects a missing shared wake helper", () => {
  const problems = verify(makeRepo({ omitWakeHelper: true }));
  assert.ok(
    problems.some((problem) =>
      problem.includes("skills/software-factory/scripts/open-wake-session.mjs: missing")
    )
  );
});

test("rejects a launching skill missing its packaged wake helper", () => {
  const pack = makeRepo();
  rmSync(join(pack, "dev-flow/scripts/open-wake-session.mjs"));
  assert.ok(
    verify(pack).some((problem) =>
      problem.includes("dev-flow/scripts/open-wake-session.mjs: missing packaged helper")
    )
  );
});

test("rejects a packaged wake helper that drifts from its shared source", () => {
  const pack = makeRepo();
  writeFileSync(join(pack, "code-review-loop/scripts/open-wake-session.mjs"), "export function wakeLabel() { /* drifted */ }\n");
  assert.ok(
    verify(pack).some((problem) =>
      problem.includes("code-review-loop/scripts/open-wake-session.mjs: differs")
    )
  );
});

test("rejects a missing shared env-defaults module", () => {
  const problems = verify(makeRepo({ omitDefaults: true }));
  assert.ok(problems.some((problem) => problem.includes("skills/software-factory/scripts/env-defaults.mjs: missing")));
});

test("rejects a launching skill missing its packaged env-defaults module", () => {
  const pack = makeRepo();
  rmSync(join(pack, "dev-flow/scripts/env-defaults.mjs"));
  assert.ok(
    verify(pack).some((problem) =>
      problem.includes("dev-flow/scripts/env-defaults.mjs: missing packaged helper")
    )
  );
});

test("rejects a packaged env-defaults module that drifts from its shared source", () => {
  const pack = makeRepo();
  writeFileSync(join(pack, "code-review-loop/scripts/env-defaults.mjs"), "export const DEFAULTS = { provider: \"x\", stages: {} };\n");
  assert.ok(
    verify(pack).some((problem) =>
      problem.includes("code-review-loop/scripts/env-defaults.mjs: differs")
    )
  );
});

test("rejects an env-defaults module whose DEFAULTS table cannot be read", () => {
  const problems = verify(makeRepo({ defaultsText: "export const DEFAULTS = {};\n" }));
  assert.ok(
    problems.some((problem) =>
      problem.includes("skills/software-factory/scripts/env-defaults.mjs: cannot read the DEFAULTS table")
    )
  );
});

test("rejects an env-defaults module whose pi AGENT_COMMANDS row cannot be read", () => {
  const problems = verify(makeRepo({ defaultsText: DEFAULTS_SOURCE.replace("pi: {", "processor: {") }));
  assert.ok(
    problems.some((problem) =>
      problem.includes("skills/software-factory/scripts/env-defaults.mjs: cannot read the AGENT_COMMANDS pi row")
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

test("reads the pin defaults from env-defaults.mjs, not hardcoded copies", () => {
  const expected = defaultPin("GRILL").model;
  const wrong = "opencode-go/gpt-9";
  const mutated = DEFAULTS_SOURCE.replace(`model: "${expected}"`, `model: "${wrong}"`);
  const problems = verify(makeRepo({ defaultsText: mutated }));
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        `skills/software-factory/grill-with-spec/SKILL.md: model pin "${expected}" does not match skills/software-factory/scripts/env-defaults.mjs DEFAULTS.stages.GRILL.model "${wrong}"`
      )
    )
  );
});

test("rejects a grill helper that still carries the GRILL_PIN literal table", () => {
  const problems = verify(makeRepo({ grillHelperText: `${grillHelper}\nexport const GRILL_PIN = {};\n` }));
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        "skills/software-factory/scripts/open-grill-session.mjs: still carries the GRILL_PIN literal table"
      )
    )
  );
});

test("rejects a grill helper that does not import env-defaults", () => {
  const importLine = 'import { AGENT_COMMANDS, resolveAgent, resolveEffort, resolveModel } from "./env-defaults.mjs";\n\n';
  const problems = verify(makeRepo({ grillHelperText: grillHelper.replace(importLine, "") }));
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        "skills/software-factory/scripts/open-grill-session.mjs: does not import skills/software-factory/scripts/env-defaults.mjs"
      )
    )
  );
});

test("rejects a grill helper whose grillPin resolver cannot be read", () => {
  const problems = verify(makeRepo({ grillHelperText: "export function nothing() {}\n" }));
  assert.ok(
    problems.some((problem) =>
      problem.includes("skills/software-factory/scripts/open-grill-session.mjs: missing the grillPin resolver")
    )
  );
});

test("rejects a grillPin resolver that does not use the AGENT_COMMANDS table", () => {
  const problems = verify(
    makeRepo({ grillHelperText: grillHelper.replace("AGENT_COMMANDS[agent].adapterId", '"opencode"') })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes("skills/software-factory/scripts/open-grill-session.mjs: grillPin does not resolve through AGENT_COMMANDS")
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
            piSpawn("DEV_FLOW", "Run implement-spec."),
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

test("rejects a launch snippet that omits the explicit spec positional", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "dev-flow": {
          body: [
            "Launch the next stage:",
            "",
            "```bash",
            "node skills/software-factory/scripts/launch-stage.mjs implement-spec 'Run the implement-spec skill.'",
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
        "skills/software-factory/dev-flow/SKILL.md: launch snippet invokes skills/software-factory/scripts/launch-stage.mjs with 2 positional(s)"
      )
    )
  );
});

test("rejects an inline launch rule that omits the explicit spec positional", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "dev-flow": {
          body: "Launch through `node skills/software-factory/scripts/launch-stage.mjs <stage> '<pointers>'`.\n",
        },
      },
    })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        "skills/software-factory/dev-flow/SKILL.md: launch snippet invokes skills/software-factory/scripts/launch-stage.mjs with 2 positional(s)"
      )
    )
  );
});

test("accepts the three-position launch form", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "dev-flow": {
          body: [
            "Launch the next stage:",
            "",
            "```bash",
            'node "<skill-dir>/scripts/launch-stage.mjs" implement-spec <spec> \'Run the implement-spec skill.\'',
            "```",
            "",
          ].join("\n"),
        },
      },
    })
  );
  assert.deepEqual(problems, []);
});

test("accepts the three-position form followed by id flags", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "dev-flow": {
          body: [
            "Launch the next stage:",
            "",
            "```bash",
            'node "<skill-dir>/scripts/launch-stage.mjs" dev-flow <spec> \'Run the dev-flow skill.\' --repo-id r --worktree-id w --task-id t',
            "```",
            "",
          ].join("\n"),
        },
      },
    })
  );
  assert.deepEqual(problems, []);
});

test("accepts the decided Fresh start launch shape with the echoed id triple", () => {
  const decided = [
    "Launch dev-flow:",
    "",
    "```bash",
    `node "<skill-dir>/scripts/launch-stage.mjs" dev-flow <spec> 'Run the dev-flow skill.' ${FRESH_START_FLAGS}`,
    "```",
    "",
  ].join("\n");
  assert.deepEqual(verify(makeRepo({ skillOverrides: { "grill-with-spec": { body: decided } } })), []);
});

test("rejects a Fresh start launch snippet missing the repo-id flag", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "grill-with-spec": {
          body: defaultSkillBody("grill-with-spec").replace("--repo-id <repoId> ", ""),
        },
      },
    })
  );
  assert.ok(
    problems.some((problem) => problem.includes("Fresh start launch snippet lacks the explicit --repo-id"))
  );
});

test("rejects a Fresh start launch snippet missing the worktree-id flag", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "grill-with-spec": {
          body: defaultSkillBody("grill-with-spec").replace("--worktree-id <worktreeId> ", ""),
        },
      },
    })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes("Fresh start launch snippet lacks the explicit --worktree-id")
    )
  );
});

test("rejects a Fresh start launch snippet missing the task-id flag", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "grill-with-spec": {
          body: defaultSkillBody("grill-with-spec").replace(" --task-id <taskId>", ""),
        },
      },
    })
  );
  assert.ok(
    problems.some((problem) => problem.includes("Fresh start launch snippet lacks the explicit --task-id"))
  );
});

test("does not count Fresh start id flags that appear only in comments", () => {
  const body = [
    '# node "<skill-dir>/scripts/launch-stage.mjs" dev-flow <spec> \'Run the dev-flow skill.\' --repo-id <repoId> --worktree-id <worktreeId> --task-id <taskId>',
    "Launch dev-flow:",
    "",
    "```bash",
    'node "<skill-dir>/scripts/launch-stage.mjs" dev-flow <spec> \'Run the dev-flow skill.\'',
    "```",
    "",
  ].join("\n");
  const problems = verify(makeRepo({ skillOverrides: { "grill-with-spec": { body } } }));
  for (const flag of ["--repo-id", "--worktree-id", "--task-id"]) {
    assert.ok(problems.some((problem) => problem.includes(`lacks the explicit ${flag} or its value`)));
  }
});

test("rejects a Fresh start id flag with no following value", () => {
  const body = [
    "Launch dev-flow:",
    "",
    "```bash",
    'node "<skill-dir>/scripts/launch-stage.mjs" dev-flow <spec> \'Run the dev-flow skill.\' --repo-id --worktree-id w --task-id t',
    "```",
    "",
  ].join("\n");
  const problems = verify(makeRepo({ skillOverrides: { "grill-with-spec": { body } } }));
  assert.ok(problems.some((problem) => problem.includes("lacks the explicit --repo-id or its value")));
});

test("rejects an empty Fresh start id flag value", () => {
  const body = [
    "Launch dev-flow:",
    "",
    "```bash",
    'node "<skill-dir>/scripts/launch-stage.mjs" dev-flow <spec> \'Run the dev-flow skill.\' --repo-id "" --worktree-id w --task-id t',
    "```",
    "",
  ].join("\n");
  const problems = verify(makeRepo({ skillOverrides: { "grill-with-spec": { body } } }));
  assert.ok(problems.some((problem) => problem.includes("lacks the explicit --repo-id or its value")));
});

test("accepts a mid-chain launch in grill-with-spec without the id flags", () => {
  const body = [
    defaultSkillBody("grill-with-spec"),
    "Re-entry resumes without the bootstrap flags:",
    "",
    "```bash",
    `node "<skill-dir>/scripts/launch-stage.mjs" implement-spec <spec> 'Run the implement-spec skill.'`,
    "```",
    "",
  ].join("\n");
  assert.deepEqual(verify(makeRepo({ skillOverrides: { "grill-with-spec": { body } } })), []);
});

test("accepts a dev-flow launch in a mid-chain skill without the id flags", () => {
  const body = [
    "Launch dev-flow:",
    "",
    "```bash",
    `node "<skill-dir>/scripts/launch-stage.mjs" dev-flow <spec> 'Run the dev-flow skill.'`,
    "```",
    "",
    GRILL_ROUTE,
  ].join("\n");
  assert.deepEqual(verify(makeRepo({ skillOverrides: { "code-review-loop": { body } } })), []);
});

test("rejects a stale launch line even when a following line has more words", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "dev-flow": {
          body: [
            "Launch the next stage:",
            "",
            "```bash",
            "node skills/software-factory/scripts/launch-stage.mjs implement-spec 'Run the implement-spec skill.'",
            "# launch it now",
            "```",
            "",
          ].join("\n"),
        },
      },
    })
  );
  assert.ok(
    problems.some((problem) => problem.includes("with 2 positional(s)"))
  );
});

test("rejects a launch snippet with more positionals than the contract", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "dev-flow": {
          body: [
            "Launch the next stage:",
            "",
            "```bash",
            "node skills/software-factory/scripts/launch-stage.mjs implement-spec <spec> 'Run the implement-spec skill.' stray",
            "```",
            "",
          ].join("\n"),
        },
      },
    })
  );
  assert.ok(
    problems.some((problem) => problem.includes("with 4 positional(s)"))
  );
});

test("ignores a prose mention of the helper", () => {
  const problems = verify(
    makeRepo({
      skillOverrides: {
        "dev-flow": {
          body: "The launch-stage.mjs helper takes the stage, the spec and the pointers.\n",
        },
      },
    })
  );
  assert.deepEqual(problems, []);
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
            piSpawn("DEV_FLOW", "Run implement-spec.").replace(` --model ${defaultPin("DEV_FLOW").model}`, ""),
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
            piSpawn("DEV_FLOW", "Run the tdd skill."),
            "```",
            "",
          ].join("\n"),
        },
      },
    })
  );
  assert.deepEqual(problems, []);
});

test("rejects a launch helper that does not import env-defaults", () => {
  const importLine = 'import { buildAgentCommand } from "./env-defaults.mjs";\n\n';
  const problems = verify(makeRepo({ helperText: helper.replace(importLine, "") }));
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        "skills/software-factory/scripts/launch-stage.mjs: does not import skills/software-factory/scripts/env-defaults.mjs"
      )
    )
  );
});

test("rejects a launch helper that still carries the STAGE_PINS literal table", () => {
  const problems = verify(makeRepo({ helperText: `${helper}\nexport const STAGE_PINS = {};\n` }));
  assert.ok(
    problems.some((problem) =>
      problem.includes("skills/software-factory/scripts/launch-stage.mjs: still carries the STAGE_PINS literal table")
    )
  );
});

test("rejects a launch helper whose command builder does not use the AGENT_COMMANDS rows", () => {
  const problems = verify(makeRepo({ helperText: helper.replaceAll("buildAgentCommand", "rawCommand") }));
  assert.ok(
    problems.some((problem) =>
      problem.includes("skills/software-factory/scripts/launch-stage.mjs: pinned command does not build through the AGENT_COMMANDS rows")
    )
  );
});
test("rejects a missing ADR-0006 wake record", () => {
  const problems = verify(makeRepo({ omitAdr: true }));
  assert.ok(
    problems.some((problem) =>
      problem.includes("docs/adr/0006-chain-skills-cross-model-handoffs.md: missing")
    )
  );
});

test("rejects a launch helper whose injected command is not the retry wrapper", () => {
  const problems = verify(
    makeRepo({ helperText: helper.slice(0, helper.indexOf("export function buildRetryWrapper")) })
  );
  assert.deepEqual(problems, [
    "skills/software-factory/scripts/launch-stage.mjs: missing the buildRetryWrapper retry wrapper around the pinned command",
  ]);
});

test("rejects a retry wrapper whose give-up path drops the wake reference", () => {
  const problems = verify(
    makeRepo({
      helperText: helper.replace(
        "    `node ${wakeHelperPath()} ${stage} ${spec} ${command}`",
        "    `echo done`"
      ),
    })
  );
  assert.deepEqual(problems, [
    "skills/software-factory/scripts/launch-stage.mjs: give-up path does not reference the wake helper open-wake-session.mjs",
  ]);
});

test("rejects a pi AGENT_COMMANDS row that drops an explicit pin flag", () => {
  const problems = verify(makeRepo({ defaultsText: DEFAULTS_SOURCE.replace('"--model",', "") }));
  assert.deepEqual(problems, [
    "skills/software-factory/scripts/env-defaults.mjs: the pi row drops the explicit --model",
  ]);
});

test("reads the wake helper name from ADR-0006, not a hardcoded copy", () => {
  const problems = verify(
    makeRepo({ adrText: adr.replaceAll("open-wake-session.mjs", "open-sleep-session.mjs") })
  );
  assert.deepEqual(problems, [
    "skills/software-factory/scripts/launch-stage.mjs: give-up path resolves a different wake helper than open-sleep-session.mjs",
  ]);
});

test("rejects a resolver pointed at another helper while the ADR name survives in a comment", () => {
  const problems = verify(
    makeRepo({
      helperText: helper
        .replace('new URL("./open-wake-session.mjs", import.meta.url)', 'new URL("./open-snooze-session.mjs", import.meta.url)')
        .replace("export const RETRY_ATTEMPTS =", "// The wake helper is open-wake-session.mjs.\nexport const RETRY_ATTEMPTS ="),
    })
  );
  assert.deepEqual(problems, [
    "skills/software-factory/scripts/launch-stage.mjs: give-up path resolves a different wake helper than open-wake-session.mjs",
  ]);
});

test("the CLI reports the real pack as OK", () => {
  const script = fileURLToPath(new URL("./verify-software-factory.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes("[OK  ] software-factory pack contract holds"));
});
