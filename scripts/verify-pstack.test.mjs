import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { verifyPack, TOOLING_ENTRYPOINTS } from "./verify-pstack.mjs";

const COMMIT = "c5db7fef1f1b1ebb2d4b7ae0308bf4beb10cb4c1";
const AUTHORED_UPSTREAM = "https://github.com/cursor/plugins/tree/main/pstack";
const roots = [];

function write(root, rel, content) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function makePack({
  skillName = "how",
  skillFile = "SKILL.md",
  frontmatter = [
    `name: "${skillName}"`,
    'description: "Explains things."',
    "license: MIT",
    "metadata:",
    `  upstream: "${AUTHORED_UPSTREAM}"`,
    `  upstream-commit: "${COMMIT}"`,
  ],
  body = "# How\n\nBody.\n",
  pluginSkills = [`./skills/pstack/${skillName}`],
  manifestFiles,
  manifestCommit = COMMIT,
  provenance = "Ported at c5db7fef1f1b1ebb2d4b7ae0308bf4beb10cb4c1 (v0.15.1). benny excluded.\n",
  omit = [],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "pstack-verify-"));
  roots.push(root);
  if (!omit.includes("skill")) {
    write(root, `skills/pstack/${skillName}/${skillFile}`, `---\n${frontmatter.join("\n")}\n---\n${body}`);
  }
  if (!omit.includes("plugin")) {
    write(root, ".claude-plugin/plugin.json", JSON.stringify({ skills: pluginSkills }, null, 2));
  }
  if (!omit.includes("manifest")) {
    write(
      root,
      "skills/pstack/_upstream/upstream-manifest.json",
      JSON.stringify({
        repo: "https://github.com/cursor/plugins",
        subdirectory: "pstack",
        version: "0.15.1",
        commit: manifestCommit,
        captured: "2026-09-10",
        files: manifestFiles ?? {
          [`skills/pstack/${skillName}/${skillFile}`]: {
            upstream: `pstack/skills/${skillName}/${skillFile}`,
            blob: "a".repeat(40),
          },
        },
      })
    );
  }
  if (!omit.includes("provenance")) write(root, "skills/pstack/_upstream/PROVENANCE.md", provenance);
  if (!omit.includes("notices")) write(root, "skills/pstack/_upstream/THIRD_PARTY_NOTICES.md", "MIT\n");
  if (!omit.includes("drift")) write(root, "skills/pstack/_upstream/verify-upstream.mjs", "export {};\n");
  return join(root, "skills", "pstack");
}

function verify(pack) {
  return verifyPack(pack, { smoke: false });
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("a conforming fixture pack has no problems", () => {
  assert.deepEqual(verify(makePack()), []);
});

test("rejects a name that does not match its folder", () => {
  const problems = verify(makePack({ frontmatter: ['name: "other"', 'description: "x"', "license: MIT"] }));
  assert.ok(problems.some((problem) => problem.includes("does not match folder")));
});

test("rejects an invalid skill name", () => {
  const problems = verify(
    makePack({ skillName: "How", frontmatter: ['name: "How"', 'description: "x"', "license: MIT"] })
  );
  assert.ok(problems.some((problem) => problem.includes("invalid or missing name")));
});

test("rejects a missing description", () => {
  const problems = verify(makePack({ frontmatter: ['name: "how"', "license: MIT"] }));
  assert.ok(problems.some((problem) => problem.includes("missing description")));
});

test("rejects client-only frontmatter fields at top level", () => {
  const problems = verify(
    makePack({
      frontmatter: [
        'name: "how"',
        'description: "x"',
        "license: MIT",
        "disable-model-invocation: true",
      ],
    })
  );
  assert.ok(problems.some((problem) => problem.includes("client-only field")));
});

test("rejects a skill missing from the plugin manifest", () => {
  const problems = verify(makePack({ pluginSkills: [] }));
  assert.ok(problems.some((problem) => problem.includes("not registered")));
});

test("rejects a broken relative link", () => {
  const problems = verify(makePack({ body: "# How\n\nSee [missing](references/nope.md).\n" }));
  assert.ok(problems.some((problem) => problem.includes("link target does not exist")));
});

test("accepts a resolving relative link", () => {
  const pack = makePack({
    body: "# How\n\nSee [prompt](references/prompt.md).\n",
    manifestFiles: {
      "skills/pstack/how/SKILL.md": { upstream: "pstack/skills/how/SKILL.md", blob: "a".repeat(40) },
      "skills/pstack/how/references/prompt.md": {
        upstream: "pstack/skills/how/references/prompt.md",
        blob: "a".repeat(40),
      },
    },
  });
  write(pack, "how/references/prompt.md", "prompt\n");
  const problems = verify(pack);
  assert.deepEqual(problems, []);
});

test("rejects a citation of a skill that does not exist", () => {
  const problems = verify(makePack({ body: "# How\n\nRun the **missing-skill** skill.\n" }));
  assert.ok(problems.some((problem) => problem.includes("cited skill does not exist")));
});

test("rejects a backticked companion-skill citation that does not exist", () => {
  const problems = verify(
    makePack({ body: "# How\n\nCompanion to `how` and `missing-skill`.\n" })
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes("cited skill does not exist: missing-skill")
    )
  );
});

test("accepts a backticked run-as citation when the skill exists", () => {
  const problems = verify(
    makePack({ body: "# How\n\nFor broad changes, run it as an `how`.\n" })
  );
  assert.deepEqual(problems, []);
});

test("rejects a citation of a principle that does not exist", () => {
  const problems = verify(makePack({ body: "# How\n\nApply principle-nope.\n" }));
  assert.ok(problems.some((problem) => problem.includes("cited principle does not exist")));
});

test("rejects a tooling script reference that does not resolve", () => {
  const problems = verify(makePack({ body: "# How\n\nRun `scripts/nope/run.sh`.\n" }));
  assert.ok(problems.some((problem) => problem.includes("script reference does not resolve")));
});

test("resolves a tooling script reference against the skill root", () => {
  const pack = makePack({
    body: "# How\n\nRun `scripts/log.sh`.\n",
    manifestFiles: {
      "skills/pstack/how/SKILL.md": { upstream: "pstack/skills/how/SKILL.md", blob: "a".repeat(40) },
      "skills/pstack/how/scripts/log.sh": {
        upstream: "pstack/skills/how/scripts/log.sh",
        blob: "a".repeat(40),
      },
    },
  });
  write(pack, "how/scripts/log.sh", "#!/bin/sh\n");
  assert.deepEqual(verify(pack), []);
});

test("accepts a bare principle name cited as a skill when principle-name exists", () => {
  const problems = verify(
    makePack({
      skillName: "principle-boundary-discipline",
      frontmatter: [
        'name: "principle-boundary-discipline"',
        'description: "x"',
        "license: MIT",
        "metadata:",
        `  upstream: "${AUTHORED_UPSTREAM}"`,
        `  upstream-commit: "${COMMIT}"`,
      ],
      body: "# Boundary\n\nSee the **boundary-discipline** skill.\n",
    })
  );
  assert.deepEqual(problems, []);
});

test("accepts a link to a resource directory", () => {
  const pack = makePack({
    body: "# How\n\nSee [the example](references/feature-map-example/README.md).\n",
    manifestFiles: {
      "skills/pstack/how/SKILL.md": { upstream: "pstack/skills/how/SKILL.md", blob: "a".repeat(40) },
      "skills/pstack/how/references/feature-map-example/README.md": {
        upstream: "pstack/skills/how/references/feature-map-example/README.md",
        blob: "a".repeat(40),
      },
    },
  });
  write(pack, "how/references/feature-map-example/README.md", "example\n");
  assert.deepEqual(verify(pack), []);
});

test("rejects a concrete model slug", () => {
  const problems = verify(makePack({ body: "# How\n\nUse grok-4.6-fast-xhigh for this.\n" }));
  assert.ok(problems.some((problem) => problem.includes("concrete model slug")));
});

test("rejects a required cloud environment", () => {
  const problems = verify(makePack({ body: '# How\n\nWorkers run as `environment: "cloud"`.\n' }));
  assert.ok(problems.some((problem) => problem.includes("required cloud environment")));
});

test("accepts a cloud environment named as a preference with a local fallback", () => {
  const problems = verify(
    makePack({
      body: '# How\n\nPrefer an `environment: "cloud"` run when your harness offers one; otherwise run locally.\n',
    })
  );
  assert.deepEqual(problems, []);
});

test("rejects a .cursor path with no fallback", () => {
  const problems = verify(makePack({ body: "# How\n\nWrite ~/.cursor/rules/pstack-models.mdc.\n" }));
  assert.ok(problems.some((problem) => problem.includes("without a fallback")));
});

test("accepts a .cursor path named as a fallback", () => {
  const problems = verify(
    makePack({
      body: "# How\n\nWrite ~/.agents/rules/pstack-models.md, with the legacy ~/.cursor/rules path as fallback.\n",
    })
  );
  assert.deepEqual(problems, []);
});

test("rejects AskQuestion with no fallback", () => {
  const problems = verify(makePack({ body: "# How\n\nAsk with AskQuestion before writing.\n" }));
  assert.ok(problems.some((problem) => problem.includes("without a fallback")));
});

test("accepts AskQuestion named as an optional capability", () => {
  const problems = verify(
    makePack({
      body: "# How\n\nUse your harness's structured question tool if available (for example AskQuestion); otherwise ask in plain text.\n",
    })
  );
  assert.deepEqual(problems, []);
});

test("rejects provenance whose commit disagrees with the manifest", () => {
  const problems = verify(makePack({ manifestCommit: "b".repeat(40) }));
  assert.ok(problems.some((problem) => problem.includes("does not match the pinned commit")));
});

test("rejects a pack file missing from the manifest", () => {
  const pack = makePack();
  write(pack, "how/references/extra.md", "extra\n");
  const problems = verify(pack);
  assert.ok(problems.some((problem) => problem.includes("no upstream manifest entry")));
});

test("rejects a manifest entry with no file", () => {
  const problems = verify(
    makePack({
      manifestFiles: {
        "skills/pstack/how/SKILL.md": { upstream: "pstack/skills/how/SKILL.md", blob: "a".repeat(40) },
        "skills/pstack/how/gone.md": { upstream: "pstack/skills/how/gone.md", blob: "a".repeat(40) },
      },
    })
  );
  assert.ok(problems.some((problem) => problem.includes("manifest entry has no file")));
});

test("rejects incomplete provenance", () => {
  const problems = verify(makePack({ omit: ["notices"] }));
  assert.ok(problems.some((problem) => problem.includes("missing THIRD_PARTY_NOTICES.md")));
});

test("rejects a missing provenance file without crashing", () => {
  const problems = verify(makePack({ omit: ["provenance"] }));
  assert.ok(problems.some((problem) => problem.includes("missing PROVENANCE.md")));
});

function addTooling(pack) {
  for (const parts of TOOLING_ENTRYPOINTS) {
    write(pack, ["poteto-mode", "scripts", ...parts].join("/"), "#!/usr/bin/env node\n");
  }
}

test("reports a failing tooling smoke", () => {
  const pack = makePack();
  addTooling(pack);
  const problems = verifyPack(pack, {
    run: () => ({ status: 1, stderr: "TypeError: not stripped" }),
  });
  assert.ok(problems.some((problem) => problem.includes("smoke:")));
});

test("accepts a passing tooling smoke", () => {
  const pack = makePack();
  addTooling(pack);
  const problems = verifyPack(pack, {
    run: () => ({ status: 0, stderr: "" }),
  });
  assert.ok(!problems.some((problem) => problem.includes("smoke:")));
});
