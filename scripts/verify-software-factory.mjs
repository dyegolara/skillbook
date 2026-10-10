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
 *      and the skills:install command;
 *   5. both pack helpers exist and are referenced: every SKILL.md stage
 *      launch goes through launch-stage.mjs with the explicit `<stage> <spec>
 *      '<thin pointers>'` positionals and code-review-loop's
 *      decision-forcing route goes through open-grill-session.mjs;
 *   6. both pin tables match their records: the launch helper's STAGE_PINS
 *      against the own pi stages' SKILL.md frontmatter and ADR-0006's
 *      implement-spec pin, the grill helper's GRILL_PIN against
 *      grill-with-spec's SKILL.md frontmatter;
 *   7. every inline `pi` spawn snippet carries an explicit --model — checked
 *      separately from the launch check, so a pinned sub-agent spawn is not
 *      mistaken for a stage launch.
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

const HELPER_FILE = "skills/software-factory/scripts/launch-stage.mjs";
const GRILL_HELPER_FILE = "skills/software-factory/scripts/open-grill-session.mjs";
const ADR_FILE = "docs/adr/0006-chain-skills-cross-model-handoffs.md";
const LAUNCH_STAGES = ["dev-flow", "implement-spec", "code-review-loop", "create-pr"];
// The three own pi stages carry frontmatter pins; implement-spec is referenced and pinned via ADR-0006.
const OWN_PI_STAGE_SKILLS = ["dev-flow", "code-review-loop", "create-pr"];

export function verifySoftwareFactoryPack(packDir) {
  const problems = [];
  const repoRoot = resolve(packDir, "../..");
  const registered = readRegisteredSkills(repoRoot, problems);
  const frontmatter = new Map();

  for (const skill of CHAIN_SKILLS) {
    const label = `skills/software-factory/${skill.name}/SKILL.md`;
    const file = join(packDir, skill.name, "SKILL.md");
    if (!existsSync(file)) {
      problems.push(`${label}: missing`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const { data } = parseFrontmatter(text);
    frontmatter.set(skill.name, data);
    checkLaunchSnippets(problems, label, text);
    if (
      skill.name === "code-review-loop" &&
      !fencedCodeBlocks(text).some((block) => block.includes("open-grill-session.mjs"))
    ) {
      problems.push(`${label}: decision-forcing route does not reference ${GRILL_HELPER_FILE}`);
    }
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

  checkLaunchMechanism(problems, packDir, repoRoot, frontmatter);
  checkGrillMechanism(problems, packDir, frontmatter);

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

function fencedCodeBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (current === null) {
      if (/^\s*```/.test(line)) current = [];
    } else if (/^\s*```\s*$/.test(line)) {
      blocks.push(current.join("\n"));
      current = null;
    } else {
      current.push(line);
    }
  }
  return blocks;
}

function launchPositionals(text) {
  const counts = [];
  const pattern = /launch-stage\.mjs/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const rest = text.slice(match.index + match[0].length);
    if (!/^\s/.test(rest)) continue; // a bare mention, not an invocation
    const tokens = scanShellArgs(rest);
    if (tokens.length > 0) counts.push(positionalCount(tokens));
  }
  return counts;
}

/**
 * Scan the shell-ish argument tokens after a command name: quoted strings are
 * single tokens (backticks inside them are literal), and the scan stops at an
 * unquoted newline, backtick, or end of text.
 */
function scanShellArgs(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "`") break;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < text.length && text[j] !== quote) {
        if (quote === '"' && text[j] === "\\") j += 1;
        j += 1;
      }
      tokens.push(text.slice(i, Math.min(j + 1, text.length)));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/[\s`]/.test(text[j])) j += 1;
    tokens.push(text.slice(i, j));
    i = j;
  }
  return tokens;
}

/** Positionals only: a flag and its value are not stage/spec/pointers. */
function positionalCount(tokens) {
  let count = 0;
  let skipValue = false;
  for (const token of tokens) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (token.startsWith("-")) {
      skipValue = true;
      continue;
    }
    count += 1;
  }
  return count;
}

function piSpawnCommands(block) {
  const commands = [];
  for (const line of block.replace(/\\\n\s*/g, " ").split("\n")) {
    for (const segment of line.split(/&&|\|\||[;|]/)) {
      const command = segment.trim().replace(/^nohup\s+/, "");
      if (/^pi(?:\s|$)/.test(command)) commands.push(command);
    }
  }
  return commands;
}

function isNodeStageLaunch(block) {
  return block
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .some(
      (line) => /(?:^|[\s;&|])node\s/.test(line) && LAUNCH_STAGES.some((stage) => line.includes(stage))
    );
}

/**
 * A block is a stage launch when it invokes the helper, runs a node command
 * naming a stage, or contains a `pi` command naming a stage. Any other `pi`
 * spawn is a sub-agent spawn: it passes the launch check and is subject only
 * to the explicit --model check.
 */
function isStageLaunch(block, spawns) {
  return (
    block.includes("launch-stage.mjs") ||
    isNodeStageLaunch(block) ||
    spawns.some((command) => LAUNCH_STAGES.some((stage) => command.includes(stage)))
  );
}

function checkLaunchSnippets(problems, label, text) {
  for (const block of fencedCodeBlocks(text)) {
    const spawns = piSpawnCommands(block);
    if (isStageLaunch(block, spawns) && !block.includes("launch-stage.mjs")) {
      problems.push(`${label}: launch snippet does not reference ${HELPER_FILE}`);
    }
    if (spawns.length > 0 && !spawns.every((command) => command.includes("--model"))) {
      problems.push(`${label}: spawn snippet lacks an explicit --model`);
    }
  }
  for (const count of launchPositionals(text)) {
    if (count < 3) {
      problems.push(
        `${label}: launch snippet invokes ${HELPER_FILE} with ${count} positional(s) — expected <stage> <spec> '<thin pointers>'`
      );
    }
  }
}

/**
 * Read STAGE_PINS from the helper's source text — the verifier must not import
 * the module it verifies, because fixtures mutate the file. Contract: a plain
 * `export const STAGE_PINS` object literal of `"<stage>": { provider: "...",
 * model: "...", thinking: "..." }` entries with quoted string fields.
 */
function parseStagePins(text) {
  const declaration = text.indexOf("export const STAGE_PINS");
  if (declaration === -1) return null;
  const open = text.indexOf("{", declaration);
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;

  const pins = {};
  const entries = text.slice(open + 1, close);
  const entryPattern = /"([^"]+)"\s*:\s*\{([^}]*)\}/g;
  let entry;
  while ((entry = entryPattern.exec(entries)) !== null) {
    const pin = {};
    const fieldPattern = /(\w+)\s*:\s*"([^"]*)"/g;
    let field;
    while ((field = fieldPattern.exec(entry[2])) !== null) pin[field[1]] = field[2];
    pins[entry[1]] = pin;
  }
  return Object.keys(pins).length > 0 ? pins : null;
}

function readAdrPin(repoRoot, problems) {
  const path = join(repoRoot, ADR_FILE);
  if (!existsSync(path)) {
    problems.push(`${ADR_FILE}: missing`);
    return null;
  }
  const match = /-\s+implement-spec\s+[-—–]\s+`([^`]+)`\s+\(`--thinking\s+([\w-]+)`/.exec(
    readFileSync(path, "utf8")
  );
  if (!match) {
    problems.push(`${ADR_FILE}: cannot read the implement-spec pin`);
    return null;
  }
  return { model: match[1], thinking: match[2] };
}

/**
 * Read GRILL_PIN from the grill helper's source text — same fixture-friendly
 * approach as parseStagePins, so the verifier never imports the module it
 * verifies. Contract: a plain `export const GRILL_PIN` object literal with
 * quoted `model` and `effort` string fields.
 */
function parseGrillPin(text) {
  const match = /export const GRILL_PIN\s*=\s*\{([^}]*)\}/.exec(text);
  if (!match) return null;
  const pin = {};
  const fieldPattern = /(\w+)\s*:\s*"([^"]*)"/g;
  let field;
  while ((field = fieldPattern.exec(match[1])) !== null) pin[field[1]] = field[2];
  return Object.keys(pin).length > 0 ? pin : null;
}

function checkGrillMechanism(problems, packDir, frontmatter) {
  const helperPath = join(packDir, "scripts", "open-grill-session.mjs");
  if (!existsSync(helperPath)) {
    problems.push(`${GRILL_HELPER_FILE}: missing`);
    return;
  }
  const pin = parseGrillPin(readFileSync(helperPath, "utf8"));
  if (pin === null) {
    problems.push(`${GRILL_HELPER_FILE}: cannot read the GRILL_PIN table`);
    return;
  }
  const data = frontmatter.get("grill-with-spec");
  if (!data) return; // its SKILL.md is already reported missing
  const label = "skills/software-factory/grill-with-spec/SKILL.md";
  if (pin.model !== data.metadata?.model || pin.effort !== data.metadata?.thinking) {
    problems.push(
      `${GRILL_HELPER_FILE}: grill pin "model ${pin.model ?? ""}, effort ${pin.effort ?? ""}" does not match ${label} frontmatter "model ${data.metadata?.model ?? ""}, thinking ${data.metadata?.thinking ?? ""}"`
    );
  }
}

function checkLaunchMechanism(problems, packDir, repoRoot, frontmatter) {
  const helperPath = join(packDir, "scripts", "launch-stage.mjs");
  if (!existsSync(helperPath)) {
    problems.push(`${HELPER_FILE}: missing`);
    return;
  }
  const pins = parseStagePins(readFileSync(helperPath, "utf8"));
  if (pins === null) {
    problems.push(`${HELPER_FILE}: cannot read the STAGE_PINS table`);
    return;
  }

  const expected = {};
  for (const stage of OWN_PI_STAGE_SKILLS) {
    const data = frontmatter.get(stage);
    if (!data) continue;
    expected[stage] = {
      model: data.metadata?.model,
      thinking: data.metadata?.thinking,
      source: `skills/software-factory/${stage}/SKILL.md frontmatter`,
    };
  }
  const adrPin = readAdrPin(repoRoot, problems);
  if (adrPin) expected["implement-spec"] = { ...adrPin, source: ADR_FILE };

  for (const [stage, record] of Object.entries(expected)) {
    const pin = pins[stage];
    if (!pin) {
      problems.push(`${HELPER_FILE}: missing pin for stage "${stage}"`);
      continue;
    }
    if (pin.model !== record.model || pin.thinking !== record.thinking) {
      problems.push(
        `${HELPER_FILE}: ${stage} pin "model ${pin.model ?? ""}, thinking ${pin.thinking ?? ""}" does not match ${record.source} "model ${record.model}, thinking ${record.thinking}"`
      );
    }
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
