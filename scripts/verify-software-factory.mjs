#!/usr/bin/env node
/**
 * verify-software-factory.mjs — the software-factory pack contract.
 *
 * Checks over skills/software-factory as an artifact, fully offline:
 *   1. the four chain skills exist with spec-conformant frontmatter (name
 *      matches folder, description present and <=1024 characters) and carry
 *      the model and thinking pins recorded in ADR-0006;
 *   2. every chain skill is registered in the plugin manifest;
 *   3. the pack README exists and the book's tables carry the pack's rows
 *      (README "What's inside", AGENTS "Own skills");
 *   4. the referenced Matt Pocock pack is wired as a dependency: its row in
 *      both books' referenced-skills tables, both published-channel checks,
 *      and the skills:install command.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFrontmatter } from "./verify-pstack.mjs";

const DESCRIPTION_LIMIT = 1024;

// Pins per ADR-0006 (the decision record); the check verifies the contract, not the ADR text.
const CHAIN_SKILLS = [
  { name: "grill-with-spec", model: "opencode-go/glm-5.3", thinking: "max" },
  { name: "dev-flow", model: "opencode-go/glm-5.3", thinking: "max" },
  { name: "code-review-loop", model: "opencode-go/mimo-v2.6-pro", thinking: "high" },
  { name: "create-pr", model: "opencode-go/muse-spark-1.3-contributor", thinking: "xhigh" },
];

const DEPENDENCY_CHANNELS = [
  "https://skills.sh/mattpocock/skills",
  "https://github.com/mattpocock/skills",
];

export function verifySoftwareFactoryPack(packDir, options = {}) {
  const problems = [];
  const repoRoot = options.repoRoot ?? resolve(packDir, "../..");
  const registered = readRegisteredSkills(repoRoot, problems);

  for (const skill of CHAIN_SKILLS) {
    const label = `skills/software-factory/${skill.name}/SKILL.md`;
    const file = join(packDir, skill.name, "SKILL.md");
    if (!existsSync(file)) {
      problems.push(`${label}: missing`);
      continue;
    }
    const { data } = parseFrontmatter(readFileSync(file, "utf8"));
    if (data.name !== skill.name) {
      problems.push(`${label}: name "${data.name ?? ""}" does not match folder "${skill.name}"`);
    }
    if (typeof data.description !== "string" || data.description.trim() === "") {
      problems.push(`${label}: missing description`);
    } else if (data.description.length > DESCRIPTION_LIMIT) {
      problems.push(`${label}: description longer than ${DESCRIPTION_LIMIT} characters`);
    }
    if (data.metadata?.model !== skill.model) {
      problems.push(
        `${label}: model pin "${data.metadata?.model ?? ""}" does not match the pinned chain contract "${skill.model}"`
      );
    }
    if (data.metadata?.thinking !== skill.thinking) {
      problems.push(
        `${label}: thinking pin "${data.metadata?.thinking ?? ""}" does not match the pinned chain contract "${skill.thinking}"`
      );
    }
    if (!registered.has(`skills/software-factory/${skill.name}`)) {
      problems.push(`${label}: not registered in the plugin manifest`);
    }
  }

  if (!existsSync(join(packDir, "README.md"))) {
    problems.push("skills/software-factory/README.md: missing");
  }

  checkTableRow(problems, repoRoot, {
    file: "README.md",
    heading: "What's inside",
    prefix: "| `software-factory` pack ",
    what: "software-factory pack",
  });
  checkTableRow(problems, repoRoot, {
    file: "AGENTS.md",
    heading: "Own skills",
    prefix: "| `software-factory` pack ",
    what: "software-factory pack",
  });
  checkTableRow(problems, repoRoot, {
    file: "README.md",
    heading: "What's inside",
    prefix: "| Matt Pocock pack ",
    what: "Matt Pocock pack",
  });
  checkTableRow(problems, repoRoot, {
    file: "AGENTS.md",
    heading: "Referenced skills (published channels)",
    prefix: "| Matt Pocock pack ",
    what: "Matt Pocock pack",
  });
  checkPublishedChannels(problems, repoRoot);
  checkInstallCommand(problems, repoRoot);

  return problems;
}

function checkPublishedChannels(problems, repoRoot) {
  const path = join(repoRoot, "scripts", "verify-publishing.mjs");
  if (!existsSync(path)) {
    problems.push("scripts/verify-publishing.mjs: missing");
    return;
  }
  const text = readFileSync(path, "utf8");
  for (const url of DEPENDENCY_CHANNELS) {
    if (!text.includes(url)) {
      problems.push(`scripts/verify-publishing.mjs: missing published-channel check ${url}`);
    }
  }
}

function checkInstallCommand(problems, repoRoot) {
  const path = join(repoRoot, "package.json");
  if (!existsSync(path)) {
    problems.push("package.json: missing");
    return;
  }
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    const install = pkg.scripts?.["skills:install"];
    if (typeof install !== "string" || !install.includes("mattpocock/skills")) {
      problems.push("package.json: skills:install does not install mattpocock/skills");
    }
  } catch (error) {
    problems.push(`package.json: ${error.message}`);
  }
}

function sectionLines(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (line) => /^#{1,6}\s/.test(line) && line.replace(/^#{1,6}\s+/, "").trim() === heading
  );
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body;
}

function checkTableRow(problems, repoRoot, { file, heading, prefix, what }) {
  const path = join(repoRoot, file);
  if (!existsSync(path)) {
    problems.push(`${file}: missing`);
    return;
  }
  const lines = sectionLines(readFileSync(path, "utf8"), heading);
  if (lines === null) {
    problems.push(`${file}: missing the "${heading}" section`);
    return;
  }
  if (!lines.some((line) => line.trimStart().startsWith(prefix))) {
    problems.push(`${file}: missing the ${what} row in "${heading}"`);
  }
}

function readRegisteredSkills(repoRoot, problems) {
  const path = join(repoRoot, ".claude-plugin", "plugin.json");
  if (!existsSync(path)) {
    problems.push(".claude-plugin/plugin.json: missing");
    return new Set();
  }
  try {
    const plugin = JSON.parse(readFileSync(path, "utf8"));
    return new Set((plugin.skills ?? []).map((value) => String(value).replace(/^\.\//, "")));
  } catch (error) {
    problems.push(`.claude-plugin/plugin.json: ${error.message}`);
    return new Set();
  }
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const packDir = resolve(here, "../skills/software-factory");
  const problems = verifySoftwareFactoryPack(packDir);
  for (const problem of problems) console.log(`[FAIL] ${problem}`);
  if (problems.length === 0) {
    console.log("[OK  ] software-factory pack contract holds");
    return;
  }
  console.log(`\n${problems.length} problem(s) in the software-factory pack.`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
