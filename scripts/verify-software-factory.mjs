#!/usr/bin/env node
/**
 * verify-software-factory.mjs — the software-factory pack contract.
 *
 * Checks over skills/software-factory as an artifact, fully offline:
 *   1. the four chain skills exist with spec-conformant frontmatter (name
 *      matches folder, description present and <=1024 characters) and carry
 *      the model and effort defaults recorded in env-defaults.mjs
 *      (DEFAULTS.stages.<STAGE>) — the verifier follows the file, never pins;
 *   2. every chain skill is registered in the plugin manifest;
 *   3. the pack README exists and the book's tables carry the pack's rows
 *      (README "What's inside", AGENTS "Own skills");
 *   4. the referenced Matt Pocock pack is wired as a dependency: its row in
 *      both books' referenced-skills tables, both published-channel checks,
 *      and the skills:install command;
 *   5. the pack helpers exist and are referenced: every SKILL.md stage
 *      launch goes through launch-stage.mjs with the explicit `<stage> <spec>
 *      '<pointers>'` positionals, and grill-with-spec's Fresh start launch
 *      additionally carries the three explicit `--repo-id/--worktree-id/
 *      --task-id` flags (re-entry and mid-chain launches stay unpinned),
 *      code-review-loop's decision-forcing
 *      route goes through open-grill-session.mjs, and every launching skill
 *      packages launch-stage.mjs, open-wake-session.mjs and env-defaults.mjs
 *      byte-identically to their shared sources;
 *   6. the launch and grill helpers resolve through env-defaults.mjs: both
 *      import it and carry no literal pin tables — the grill helper's resolved
 *      pin (model, effort, the grill agent's adapterId) comes from the same
 *      DEFAULTS/AGENT_COMMANDS tables the chain skills' frontmatter is
 *      checked against;
 *   7. every inline `pi` spawn snippet carries an explicit --model — checked
 *      separately from the launch check, so a pinned sub-agent spawn is not
 *      mistaken for a stage launch;
 *   8. the error route holds: the launch helper injects a bounded retry
 *      wrapper (buildRetryWrapper) around the resolved command (buildStageCommand),
 *      the wrapper's give-up path carries the FAILED marker and references the
 *      wake helper ADR-0006 names, the command builder goes through the
 *      resolved agent's AGENT_COMMANDS row, and the pi row still emits the
 *      explicit --provider/--model/--thinking flags;
 *   9. the shared `## Handoff rules` block is byte-identical between the two
 *      block-carrying skills: dev-flow and code-review-loop close with the
 *      same block, and a drift between them is a pack-contract problem;
 *   10. ADR-0006's documented pin rows cross-check against the DEFAULTS table:
 *      every expected stage (the LAUNCH_STAGES map plus the grill stage) must
 *      have a parsed ADR row, and the verifier reads each row's model and
 *      effort, in the ADR's recorded spellings, to compare them to the same
 *      table the frontmatter is checked against — the only verifier-side guard
 *      for the implement-spec pin, which has no SKILL.md frontmatter, so a
 *      missing row, a malformed row or a drift is a pack-contract problem.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFrontmatter } from "./verify-pstack.mjs";

const DESCRIPTION_LIMIT = 1024;

// The four chain skills and the env-defaults stage key each one's frontmatter
// documents. The pin values themselves live only in env-defaults.mjs.
const CHAIN_SKILLS = [
  { name: "grill-with-spec", stage: "GRILL" },
  { name: "dev-flow", stage: "DEV_FLOW" },
  { name: "code-review-loop", stage: "CODE_REVIEW_LOOP" },
  { name: "create-pr", stage: "CREATE_PR" },
];

const DEPENDENCY_CHANNELS = [
  "https://skills.sh/mattpocock/skills",
  "https://github.com/mattpocock/skills",
];

const HELPER_FILE = "skills/software-factory/scripts/launch-stage.mjs";
const GRILL_HELPER_FILE = "skills/software-factory/scripts/open-grill-session.mjs";
const WAKE_HELPER_FILE = "skills/software-factory/scripts/open-wake-session.mjs";
const DEFAULTS_FILE = "skills/software-factory/scripts/env-defaults.mjs";
// The defaults module is packaged with the two helpers beside the launch helper
// in every skill that launches a stage.
const PACKAGED_HELPERS = ["launch-stage.mjs", "open-wake-session.mjs", "env-defaults.mjs"];
const ADR_FILE = "docs/adr/0006-chain-skills-cross-model-handoffs.md";
// The grill stage is not a launch stage (LAUNCH_STAGES omits it), yet ADR-0006
// documents its pin row; the expected ADR row set is this row plus the map.
const GRILL_STAGE = { stage: "grill-with-spec", key: "GRILL" };
// The skills that close with the shared `## Handoff rules` block.
const HANDOFF_RULES_SKILLS = ["dev-flow", "code-review-loop"];

export function verifySoftwareFactoryPack(packDir) {
  const problems = [];
  const repoRoot = resolve(packDir, "../..");
  const registered = readRegisteredSkills(repoRoot, problems);
  const defaults = readDefaults(packDir, problems);
  const launchStageEntries = readLaunchStages(packDir, problems);
  const launchStages = launchStageEntries.map((entry) => entry.stage);

  for (const skill of CHAIN_SKILLS) {
    const label = `skills/software-factory/${skill.name}/SKILL.md`;
    const file = join(packDir, skill.name, "SKILL.md");
    if (!existsSync(file)) {
      problems.push(`${label}: missing`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const { data } = parseFrontmatter(text);
    checkLaunchSnippets(problems, label, text, skill.name, launchStages);
    checkPackagedHelpers(problems, packDir, skill.name, text);
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
    const defaultsForStage = defaults?.stages?.[skill.stage];
    if (defaultsForStage && data.metadata?.model !== defaultsForStage.model) {
      problems.push(
        `${label}: model pin "${data.metadata?.model ?? ""}" does not match ${DEFAULTS_FILE} DEFAULTS.stages.${skill.stage}.model "${defaultsForStage.model}"`
      );
    }
    if (defaultsForStage && data.metadata?.effort !== defaultsForStage.effort) {
      problems.push(
        `${label}: effort pin "${data.metadata?.effort ?? ""}" does not match ${DEFAULTS_FILE} DEFAULTS.stages.${skill.stage}.effort "${defaultsForStage.effort}"`
      );
    }
    if (!registered.has(`skills/software-factory/${skill.name}`)) {
      problems.push(`${label}: not registered in the plugin manifest`);
    }
  }

  checkAdrPins(problems, repoRoot, defaults, [GRILL_STAGE, ...launchStageEntries]);
  checkLaunchMechanism(problems, packDir, repoRoot, defaultsSource(packDir));
  checkGrillMechanism(problems, packDir);
  checkWakeMechanism(problems, packDir);
  checkHandoffRules(problems, packDir);

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
  const pattern = /launch-stage\.mjs["']?/g;
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
 * unquoted newline, backtick, shell operator, or end of text.
 */
function scanShellArgs(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n" || ch === "`" || ch === ";" || ch === "&" || ch === "|" || ch === "#") break;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
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
    while (j < text.length && !/[\s`;&|]/.test(text[j])) j += 1;
    tokens.push(text.slice(i, j));
    i = j;
  }
  return tokens;
}

const LAUNCH_VALUE_FLAGS = new Set(["--repo-id", "--worktree-id", "--task-id"]);

/**
 * The Fresh start launch: the fenced helper invocation whose first positional is
 * the dev-flow stage — the fresh chain's bootstrap. The token scan keeps a bare
 * mention or an invocation of another stage from matching.
 */
function stripShellComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (quote === '"' && ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function freshStartLaunchTokens(block) {
  for (const line of block.replace(/\\\n\s*/g, " ").split("\n")) {
    const code = stripShellComment(line);
    const match = /launch-stage\.mjs["']?/.exec(code);
    if (match === null) continue;
    const tokens = scanShellArgs(code.slice(match.index + match[0].length));
    if (tokens[0] === "dev-flow") return tokens;
  }
  return [];
}

function isFreshStartLaunch(block) {
  return freshStartLaunchTokens(block)[0] === "dev-flow";
}

function hasLaunchFlagValue(tokens, flag) {
  const index = tokens.indexOf(flag);
  if (index < 0 || index + 1 >= tokens.length) return false;
  const value = tokens[index + 1];
  return value !== "''" && value !== '""' && !value.startsWith("-");
}

/** Positionals only: the known id flags consume their value; other flags are ignored. */
function positionalCount(tokens) {
  let count = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (LAUNCH_VALUE_FLAGS.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    count += 1;
  }
  return count;
}

/** Fenced code blocks and inline code spans — where launch snippets live, prose excluded. */
function codeSegments(text) {
  const segments = fencedCodeBlocks(text);
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const match of line.matchAll(/`([^`]+)`/g)) segments.push(match[1]);
  }
  return segments;
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

function isNodeStageLaunch(block, launchStages) {
  return block
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .some(
      (line) => /(?:^|[\s;&|])node\s/.test(line) && launchStages.some((stage) => line.includes(stage))
    );
}

/**
 * A block is a stage launch when it invokes the helper, runs a node command
 * naming a stage, or contains a `pi` command naming a stage. Any other `pi`
 * spawn is a sub-agent spawn: it passes the launch check and is subject only
 * to the explicit --model check. The stage names come from env-defaults.mjs.
 */
function isStageLaunch(block, spawns, launchStages) {
  return (
    block.includes("launch-stage.mjs") ||
    isNodeStageLaunch(block, launchStages) ||
    spawns.some((command) => launchStages.some((stage) => command.includes(stage)))
  );
}

function checkLaunchSnippets(problems, label, text, skill, launchStages) {
  for (const block of fencedCodeBlocks(text)) {
    const spawns = piSpawnCommands(block);
    if (isStageLaunch(block, spawns, launchStages) && !block.includes("launch-stage.mjs")) {
      problems.push(`${label}: launch snippet does not reference ${HELPER_FILE}`);
    }
    if (spawns.length > 0 && !spawns.every((command) => command.includes("--model"))) {
      problems.push(`${label}: spawn snippet lacks an explicit --model`);
    }
    // The id flags are scoped to grill-with-spec's Fresh start (the fifth
    // decision's fix-ticket scope item 4): its fenced step-4 dev-flow launch
    // passes the triple the status snippet echoed. Mid-chain and re-entry
    // launches anchor on the live terminal instead, and the §Handoff rules
    // inline mention carries no stage — neither is required to pass the flags.
    if (skill === "grill-with-spec" && isFreshStartLaunch(block)) {
      const launchTokens = freshStartLaunchTokens(block);
      for (const flag of LAUNCH_VALUE_FLAGS) {
        if (!hasLaunchFlagValue(launchTokens, flag)) {
          problems.push(
            `${label}: Fresh start launch snippet lacks the explicit ${flag} or its value — pass the status snippet's echoed chain-ids triple`
          );
        }
      }
    }
  }
  for (const segment of codeSegments(text)) {
    for (const count of launchPositionals(segment)) {
      if (count !== 3) {
        problems.push(
          `${label}: launch snippet invokes ${HELPER_FILE} with ${count} positional(s) — expected <stage> <spec> '<pointers>'`
        );
      }
    }
  }
}

function checkPackagedHelpers(problems, packDir, skill, text) {
  const helpers = skill === "create-pr" ? [] : [...PACKAGED_HELPERS];
  if (skill === "code-review-loop") helpers.push("open-grill-session.mjs");
  for (const helper of helpers) {
    const label = `skills/software-factory/${skill}/scripts/${helper}`;
    const file = join(packDir, skill, "scripts", helper);
    if (!existsSync(file)) {
      problems.push(`${label}: missing packaged helper`);
    } else {
      const source = join(packDir, "scripts", helper);
      if (existsSync(source) && readFileSync(file, "utf8") !== readFileSync(source, "utf8")) {
        problems.push(`${label}: differs from the shared helper source`);
      }
    }
  }
  for (const segment of codeSegments(text)) {
    if (/node\s+(?:["']?skills\/software-factory\/scripts\/|["']?\.\.\/)/.test(segment)) {
      problems.push(`skills/software-factory/${skill}/SKILL.md: helper invocation escapes the installed skill folder`);
    }
  }
}

/** Parse the quoted `key: "value"` string fields from an entry's source text. */
function parseQuotedFields(fieldsText) {
  const fields = {};
  const fieldPattern = /(\w+)\s*:\s*"([^"]*)"/g;
  let field;
  while ((field = fieldPattern.exec(fieldsText)) !== null) fields[field[1]] = field[2];
  return fields;
}

/**
 * Read `DEFAULTS` from env-defaults.mjs source text — the verifier follows the
 * file, never importing the module it verifies. Contract: `export const
 * DEFAULTS = { provider: "...", stages: { <STAGE>: { model: "...", effort:
 * "...", agent: "..." } } }` with quoted string fields.
 */
function parseDefaults(text) {
  const declaration = text.indexOf("export const DEFAULTS");
  if (declaration === -1) return null;
  const objectStart = text.indexOf("{", declaration);
  if (objectStart === -1) return null;
  const body = bracedBlock(text, objectStart);
  if (body === null) return null;
  const provider = /provider\s*:\s*"([^"]*)"/.exec(body)?.[1];
  const stagesMatch = /stages\s*:\s*\{/.exec(body);
  if (provider === undefined || !stagesMatch) return null;
  const stagesBody = bracedBlock(body, body.indexOf("{", stagesMatch.index));
  if (stagesBody === null) return null;

  const stages = {};
  const entryPattern = /"?([A-Z_]+)"?\s*:\s*\{([^}]*)\}/g;
  let entry;
  while ((entry = entryPattern.exec(stagesBody)) !== null) {
    stages[entry[1]] = parseQuotedFields(entry[2]);
  }
  return Object.keys(stages).length > 0 ? { provider, stages } : null;
}

/**
 * Read the DEFAULTS table from the shared defaults module; a missing or
 * unreadable module is reported here once and returns null.
 */
function readDefaults(packDir, problems) {
  const path = join(packDir, "scripts", "env-defaults.mjs");
  if (!existsSync(path)) {
    problems.push(`${DEFAULTS_FILE}: missing`);
    return null;
  }
  const defaults = parseDefaults(readFileSync(path, "utf8"));
  if (defaults === null) problems.push(`${DEFAULTS_FILE}: cannot read the DEFAULTS table`);
  return defaults;
}

/** The shared defaults module's source text, or "" when it is missing. */
function defaultsSource(packDir) {
  const path = join(packDir, "scripts", "env-defaults.mjs");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * Read the `LAUNCH_STAGES` map's entries from env-defaults.mjs source text —
 * same source-text approach as `parseDefaults`, so the verifier follows the
 * file instead of pinning a second copy of the launch stage set. Both sides
 * are captured: the kebab name the helpers take and the DEFAULTS stage key.
 * Contract: `export const LAUNCH_STAGES = { "<kebab-stage>": "<STAGE_KEY>",
 * ... }`, optionally wrapped in `Object.freeze(...)`.
 */
function parseLaunchStages(text) {
  const declaration = text.indexOf("export const LAUNCH_STAGES");
  if (declaration === -1) return null;
  const objectStart = text.indexOf("{", declaration);
  if (objectStart === -1) return null;
  const body = bracedBlock(text, objectStart);
  if (body === null) return null;
  const stages = [];
  const entryPattern = /"?([A-Za-z][\w-]*)"?\s*:\s*"([^"]*)"/g;
  let entry;
  while ((entry = entryPattern.exec(body)) !== null) {
    stages.push({ stage: entry[1], key: entry[2] });
  }
  return stages.length > 0 ? stages : null;
}

/**
 * Read the `{ stage, key }` launch-stage entries from the shared defaults
 * module. A missing module is already reported by `readDefaults`; an
 * unreadable map is reported here once. An unreadable set leaves the
 * stage-launch detection without stage names rather than pinning a copy.
 */
function readLaunchStages(packDir, problems) {
  const path = join(packDir, "scripts", "env-defaults.mjs");
  if (!existsSync(path)) return [];
  const stages = parseLaunchStages(readFileSync(path, "utf8"));
  if (stages === null) problems.push(`${DEFAULTS_FILE}: cannot read the LAUNCH_STAGES map`);
  return stages ?? [];
}

/** The brace-matched body starting at `open`, or null when it is unclosed. */
function bracedBlock(text, open) {
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * The grill helper resolves its pin through env-defaults.mjs — same
 * fixture-friendly source-text approach: it must import the module, carry no
 * GRILL_PIN literal, and its grillPin resolver must read the model, the
 * effort and the grill agent's adapterId from the shared tables. The frontmatter
 * comparison against DEFAULTS.stages.GRILL happens in the chain-skill loop.
 */
function checkGrillMechanism(problems, packDir) {
  const helperPath = join(packDir, "scripts", "open-grill-session.mjs");
  if (!existsSync(helperPath)) {
    problems.push(`${GRILL_HELPER_FILE}: missing`);
    return;
  }
  const text = readFileSync(helperPath, "utf8");
  if (!/from\s+"\.\/env-defaults\.mjs"/.test(text)) {
    problems.push(`${GRILL_HELPER_FILE}: does not import ${DEFAULTS_FILE}`);
  }
  if (text.includes("GRILL_PIN")) {
    problems.push(`${GRILL_HELPER_FILE}: still carries the GRILL_PIN literal table`);
  }
  const body = functionBody(text, "grillPin");
  if (body === null) {
    problems.push(`${GRILL_HELPER_FILE}: missing the grillPin resolver`);
    return;
  }
  for (const source of ["resolveModel", "resolveEffort", "AGENT_COMMANDS"]) {
    if (!body.includes(source)) {
      problems.push(`${GRILL_HELPER_FILE}: grillPin does not resolve through ${source}`);
    }
  }
}

function checkWakeMechanism(problems, packDir) {
  if (!existsSync(join(packDir, "scripts", "open-wake-session.mjs"))) {
    problems.push(`${WAKE_HELPER_FILE}: missing`);
  }
}

/**
 * The closing `## Handoff rules` block: the heading line to EOF, or null when
 * the file does not carry it. The block-carrying skills must carry
 * byte-identical copies; a one-byte drift between them is the pack-contract
 * problem this check pins.
 */
function handoffRulesBlock(text) {
  const match = /^## Handoff rules[ \t]*$/m.exec(text);
  return match === null ? null : text.slice(match.index);
}

function checkHandoffRules(problems, packDir) {
  const blocks = new Map();
  for (const skill of HANDOFF_RULES_SKILLS) {
    const label = `skills/software-factory/${skill}/SKILL.md`;
    const file = join(packDir, skill, "SKILL.md");
    if (!existsSync(file)) continue; // the skill's own check already reports the missing file
    const block = handoffRulesBlock(readFileSync(file, "utf8"));
    if (block === null) {
      problems.push(`${label}: missing the closing "## Handoff rules" block`);
    } else {
      blocks.set(label, block);
    }
  }
  if (blocks.size !== HANDOFF_RULES_SKILLS.length) return;
  const [[firstLabel, firstBlock], [secondLabel, secondBlock]] = [...blocks.entries()];
  if (firstBlock !== secondBlock) {
    problems.push(`${firstLabel}: "## Handoff rules" block differs from ${secondLabel}`);
  }
}

function checkLaunchMechanism(problems, packDir, repoRoot, defaultsText) {
  const helperPath = join(packDir, "scripts", "launch-stage.mjs");
  if (!existsSync(helperPath)) {
    problems.push(`${HELPER_FILE}: missing`);
    return;
  }
  const text = readFileSync(helperPath, "utf8");
  if (!/from\s+"\.\/env-defaults\.mjs"/.test(text)) {
    problems.push(`${HELPER_FILE}: does not import ${DEFAULTS_FILE}`);
  }
  if (text.includes("STAGE_PINS")) {
    problems.push(`${HELPER_FILE}: still carries the STAGE_PINS literal table`);
  }

  const wrapper = checkRetryWrapper(problems, text);
  checkWakeReference(problems, repoRoot, text, wrapper);
  checkPinnedCommand(problems, text, defaultsText);
}

/**
 * Read a top-level function's body from source text by brace matching. The
 * verifier reads text and never imports the module it verifies, so fixtures
 * can mutate it. Contract: the declaration is `function <name>(` followed by
 * a brace-matched body (balanced braces in its strings and comments).
 */
function functionBody(text, name) {
  const declaration = text.indexOf(`function ${name}(`);
  if (declaration === -1) return null;
  const open = text.indexOf("{", declaration);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * (a) The launch construction wraps the pinned command: buildRetryWrapper
 * builds its inner command through buildStageCommand and runs a bounded retry
 * loop. Returns the wrapper's body for the wake-reference check, or null when
 * the wrapper is missing (so that check stays quiet).
 */
function checkRetryWrapper(problems, text) {
  const body = functionBody(text, "buildRetryWrapper");
  if (body === null) {
    problems.push(`${HELPER_FILE}: missing the buildRetryWrapper retry wrapper around the pinned command`);
    return null;
  }
  if (!body.includes("buildStageCommand")) {
    problems.push(`${HELPER_FILE}: retry wrapper does not wrap the buildStageCommand pinned command`);
  }
  if (!/\b(?:while|for)\b/.test(body) || !body.includes("RETRY_ATTEMPTS")) {
    problems.push(`${HELPER_FILE}: retry wrapper does not make a bounded retry loop`);
  }
  return body;
}

/**
 * Read the wake helper's filename from ADR-0006's recorded wake shape — the
 * same source-text approach as the defaults checks. Contract: the wake bullet
 * records the actuation as `node "<skill-dir>/scripts/<wake-helper>.mjs"`.
 */
function readWakeHelperName(repoRoot, problems) {
  const path = join(repoRoot, ADR_FILE);
  if (!existsSync(path)) {
    problems.push(`${ADR_FILE}: missing`);
    return null;
  }
  const match = /actuated by the wrapper\s+as\s+`node\s+"[^"]*\/([\w.-]+\.mjs)"/.exec(
    readFileSync(path, "utf8")
  );
  if (!match) {
    problems.push(`${ADR_FILE}: cannot read the wake helper name`);
    return null;
  }
  return match[1];
}

/**
 * Parse the wake-helper filename `wakeHelperPath` resolves: the
 * `new URL("...", import.meta.url)` literal in its function body. Returns the
 * literal's basename, or null when the resolver is missing or carries no
 * such literal — a resolver that cannot be parsed is treated as resolving a
 * different helper.
 */
function resolveWakeHelperName(text) {
  const body = functionBody(text, "wakeHelperPath");
  if (body === null) return null;
  const match = /new URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*\)/.exec(body);
  if (!match) return null;
  return match[1].split("/").pop();
}

/**
 * (b) The wrapper's give-up path — the buildRetryWrapper body where the FAILED
 * marker lives — references the wake helper ADR-0006 names: directly, or by
 * calling the file-local wakeHelperPath resolver, whose literal filename must
 * then equal the named helper. The whole-file presence of the name is not
 * enough: a resolver pointed elsewhere must fail even if the ADR name survives
 * in a comment.
 */
function checkWakeReference(problems, repoRoot, text, wrapper) {
  if (wrapper === null) return;
  const wakeName = readWakeHelperName(repoRoot, problems);
  if (wakeName === null) return;
  if (!wrapper.includes("FAILED")) {
    problems.push(`${HELPER_FILE}: retry wrapper's give-up path has no FAILED marker`);
  }
  const callsResolver = /\bwakeHelperPath\s*\(/.test(wrapper);
  if (!wrapper.includes(wakeName) && !callsResolver) {
    problems.push(`${HELPER_FILE}: give-up path does not reference the wake helper ${wakeName}`);
    return;
  }
  if (callsResolver && resolveWakeHelperName(text) !== wakeName) {
    problems.push(`${HELPER_FILE}: give-up path resolves a different wake helper than ${wakeName}`);
  }
}

/**
 * (c) The resolved command is built through the resolved agent's
 * AGENT_COMMANDS row, and the `pi` row keeps its explicit pins: the provider,
 * model and thinking flags are emitted from env-defaults.mjs's table, not from
 * the helper. The wrapper's use of the builder is check (a)'s contract.
 */
function checkPinnedCommand(problems, text, defaultsText) {
  const body = functionBody(text, "buildStageCommand");
  if (body === null) {
    problems.push(`${HELPER_FILE}: missing the buildStageCommand pinned-command builder`);
    return;
  }
  if (!body.includes("buildAgentCommand")) {
    problems.push(`${HELPER_FILE}: pinned command does not build through the AGENT_COMMANDS rows`);
  }
  const piRow = agentCommandRow(defaultsText, "pi");
  if (piRow === null) {
    problems.push(`${DEFAULTS_FILE}: cannot read the AGENT_COMMANDS pi row`);
    return;
  }
  for (const flag of ["--provider", "--model", "--thinking"]) {
    if (!piRow.includes(flag)) {
      problems.push(`${DEFAULTS_FILE}: the pi row drops the explicit ${flag}`);
    }
  }
}

/** The `AGENT_COMMANDS` row's source text for `agent`, or null when unreadable. */
function agentCommandRow(text, agent) {
  const declaration = text.indexOf("export const AGENT_COMMANDS");
  if (declaration === -1) return null;
  const pattern = new RegExp(`(?:^|[\\s,{])"?${agent.replaceAll("-", "\\-")}"?\\s*:\\s*\\{`, "m");
  const match = pattern.exec(text.slice(declaration));
  if (!match) return null;
  return bracedBlock(text, declaration + match.index + match[0].lastIndexOf("{"));
}

/**
 * Read ADR-0006's documented pin rows as source text — the same source-text
 * approach as the defaults and wake-name reads. A row records the stage's kebab
 * name, the model in backticks and the effort in a parenthetical: the
 * launch-stage rows carry the `--thinking` flag, the grill row says "effort
 * <value>", and a row may append a note after the recorded effort. A row is a
 * bullet: stage name, the model in backticks, then the effort parenthetical.
 * Returns the rows, or null when no row can be read.
 */
function parseAdrPins(text) {
  const pins = [];
  const rowPattern = /^\s*-\s+([a-z][a-z-]*)\s+(?:—|–|--)\s+`([^`]+)`\s+\(([^)]*)\)/gm;
  let row;
  while ((row = rowPattern.exec(text)) !== null) {
    const effort = /^(?:effort\s+|`?--thinking\s+)([a-z][\w.-]*)/.exec(row[3]);
    if (effort === null) continue;
    pins.push({ stage: row[1], model: row[2], effort: effort[1] });
  }
  return pins.length > 0 ? pins : null;
}

/**
 * Cross-check ADR-0006's documented pin rows against the DEFAULTS table the
 * verifier already reads from env-defaults.mjs. The 2026-10-16 amendment names
 * that table as the pin list's source, while the ADR's historical text is never
 * rewritten — so drift between the record and the file is caught here instead.
 * The expected rows come from the launch-stage map plus the grill row; every
 * one must parse, and extra or unknown rows are ignored. This is the one check
 * that guards the implement-spec pin.
 */
function checkAdrPins(problems, repoRoot, defaults, stageEntries) {
  const path = join(repoRoot, ADR_FILE);
  // A missing ADR is reported by the wake-record check.
  if (!existsSync(path)) return;
  const pins = parseAdrPins(readFileSync(path, "utf8"));
  if (pins === null) {
    problems.push(`${ADR_FILE}: cannot read the documented pin table rows`);
    return;
  }
  // An unreadable DEFAULTS table is already reported by readDefaults.
  if (defaults === null) return;
  const pinsByStage = new Map(pins.map((pin) => [pin.stage, pin]));
  for (const { stage, key } of stageEntries) {
    const documented = defaults.stages[key];
    if (documented === undefined) {
      problems.push(
        `${ADR_FILE}: ${stage} pin row has no ${DEFAULTS_FILE} DEFAULTS.stages.${key} entry`
      );
      continue;
    }
    const pin = pinsByStage.get(stage);
    if (pin === undefined) {
      problems.push(
        `${ADR_FILE}: missing the documented ${stage} pin row for ${DEFAULTS_FILE} DEFAULTS.stages.${key}`
      );
      continue;
    }
    if (pin.model !== documented.model) {
      problems.push(
        `${ADR_FILE}: ${stage} model pin "${pin.model}" does not match ${DEFAULTS_FILE} DEFAULTS.stages.${key}.model "${documented.model}"`
      );
    }
    if (pin.effort !== documented.effort) {
      problems.push(
        `${ADR_FILE}: ${stage} effort pin "${pin.effort}" does not match ${DEFAULTS_FILE} DEFAULTS.stages.${key}.effort "${documented.effort}"`
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
