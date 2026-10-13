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
 *   5. the pack helpers exist and are referenced: every SKILL.md stage
 *      launch goes through launch-stage.mjs with the explicit `<stage> <spec>
 *      '<pointers>'` positionals, and grill-with-spec's Fresh start launch
 *      additionally carries the three explicit `--repo-id/--worktree-id/
 *      --task-id` flags (re-entry and mid-chain launches stay unpinned),
 *      code-review-loop's decision-forcing
 *      route goes through open-grill-session.mjs, and every launching skill
 *      packages open-wake-session.mjs byte-identically beside launch-stage.mjs;
 *   6. both pin tables match their records: the launch helper's STAGE_PINS
 *      against the own pi stages' SKILL.md frontmatter and ADR-0006's
 *      implement-spec pin, the grill helper's GRILL_PIN against
 *      grill-with-spec's SKILL.md frontmatter;
 *   7. every inline `pi` spawn snippet carries an explicit --model — checked
 *      separately from the launch check, so a pinned sub-agent spawn is not
 *      mistaken for a stage launch;
 *   8. the error route holds: the launch helper injects a bounded retry
 *      wrapper (buildRetryWrapper) around the pinned command (buildPiCommand),
 *      the wrapper's give-up path carries the FAILED marker and references the
 *      wake helper ADR-0006 names, and the pinned-command builder emits the
 *      explicit --provider/--model/--thinking flags;
 *   9. the shared `## Handoff rules` block is byte-identical between the two
 *      block-carrying skills: dev-flow and code-review-loop close with the
 *      same block, and a drift between them is a pack-contract problem.
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
const WAKE_HELPER_FILE = "skills/software-factory/scripts/open-wake-session.mjs";
// The wake helper is packaged beside the launch helper in every skill that launches a stage.
const PACKAGED_HELPERS = ["launch-stage.mjs", "open-wake-session.mjs"];
const ADR_FILE = "docs/adr/0006-chain-skills-cross-model-handoffs.md";
const LAUNCH_STAGES = ["dev-flow", "implement-spec", "code-review-loop", "create-pr"];
// The three own pi stages carry frontmatter pins; implement-spec is referenced and pinned via ADR-0006.
const OWN_PI_STAGE_SKILLS = ["dev-flow", "code-review-loop", "create-pr"];
// The skills that close with the shared `## Handoff rules` block.
const HANDOFF_RULES_SKILLS = ["dev-flow", "code-review-loop"];

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
    checkLaunchSnippets(problems, label, text, skill.name);
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
    if (ch === "\n" || ch === "`" || ch === ";" || ch === "&" || ch === "|") break;
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
function isFreshStartLaunch(block) {
  const match = /launch-stage\.mjs["']?/.exec(block);
  if (match === null) return false;
  const tokens = scanShellArgs(block.slice(match.index + match[0].length));
  return tokens[0] === "dev-flow";
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

function checkLaunchSnippets(problems, label, text, skill) {
  for (const block of fencedCodeBlocks(text)) {
    const spawns = piSpawnCommands(block);
    if (isStageLaunch(block, spawns) && !block.includes("launch-stage.mjs")) {
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
      for (const flag of LAUNCH_VALUE_FLAGS) {
        if (!block.includes(flag)) {
          problems.push(
            `${label}: Fresh start launch snippet lacks the explicit ${flag} — pass the status snippet's echoed chain-ids triple`
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
    pins[entry[1]] = parseQuotedFields(entry[2]);
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
 * approach as parseStagePins (both read an entry's string fields through
 * parseQuotedFields), so the verifier never imports the module it verifies.
 * Contract: a plain `export const GRILL_PIN` object literal with quoted `model`
 * and `effort` string fields.
 */
function parseGrillPin(text) {
  const match = /export const GRILL_PIN\s*=\s*\{([^}]*)\}/.exec(text);
  if (!match) return null;
  const pin = parseQuotedFields(match[1]);
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

function checkLaunchMechanism(problems, packDir, repoRoot, frontmatter) {
  const helperPath = join(packDir, "scripts", "launch-stage.mjs");
  if (!existsSync(helperPath)) {
    problems.push(`${HELPER_FILE}: missing`);
    return;
  }
  const text = readFileSync(helperPath, "utf8");
  const pins = parseStagePins(text);
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

  const wrapper = checkRetryWrapper(problems, text);
  checkWakeReference(problems, repoRoot, text, wrapper);
  checkPinnedCommand(problems, text);
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
 * builds its inner command through buildPiCommand and runs a bounded retry
 * loop. Returns the wrapper's body for the wake-reference check, or null when
 * the wrapper is missing (so that check stays quiet).
 */
function checkRetryWrapper(problems, text) {
  const body = functionBody(text, "buildRetryWrapper");
  if (body === null) {
    problems.push(`${HELPER_FILE}: missing the buildRetryWrapper retry wrapper around the pinned command`);
    return null;
  }
  if (!body.includes("buildPiCommand")) {
    problems.push(`${HELPER_FILE}: retry wrapper does not wrap the buildPiCommand pinned command`);
  }
  if (!/\b(?:while|for)\b/.test(body) || !body.includes("RETRY_ATTEMPTS")) {
    problems.push(`${HELPER_FILE}: retry wrapper does not make a bounded retry loop`);
  }
  return body;
}

/**
 * Read the wake helper's filename from ADR-0006's recorded wake shape — the
 * same source-text approach as the pin checks. Contract: the wake bullet
 * records the actuation as `node "<skill-dir>/scripts/<wake-helper>.mjs"`.
 */
function readWakeHelperName(repoRoot, problems) {
  const path = join(repoRoot, ADR_FILE);
  if (!existsSync(path)) return null; // readAdrPin already reports the missing record
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
 * (c) The pinned command inside the wrapper keeps its explicit pins: the
 * buildPiCommand builder emits the provider, model and thinking flags. The
 * wrapper's use of that builder is check (a)'s contract.
 */
function checkPinnedCommand(problems, text) {
  const body = functionBody(text, "buildPiCommand");
  if (body === null) {
    problems.push(`${HELPER_FILE}: missing the buildPiCommand pinned-command builder`);
    return;
  }
  for (const flag of ["--provider", "--model", "--thinking"]) {
    if (!body.includes(flag)) {
      problems.push(`${HELPER_FILE}: pinned command drops the explicit ${flag}`);
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
