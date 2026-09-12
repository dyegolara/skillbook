#!/usr/bin/env node
/**
 * verify-pstack.mjs — the pstack pack contract.
 *
 * Checks over skills/pstack as an artifact:
 *   1. every ported skill has a spec-conformant SKILL.md (name matches folder,
 *      valid name, description, license, no client-only fields at top level,
 *      upstream provenance in metadata);
 *   2. every cross-reference resolves (relative links, `**skill** skill`
 *      citations, `principle-*` tokens);
 *   3. every ported skill is registered in the plugin manifest;
 *   4. the provenance folder is complete and the manifest covers the pack;
 *   5. no Cursor coupling is required by normative text (concrete model slugs,
 *      named client subagent fields, cloud environment defaults, `.cursor`
 *      paths, client built-ins) — they may appear only as examples or
 *      fallbacks, which must say so in the same paragraph.
 *
 * With --smoke (the default) it also runs the tooling entry points under Node
 * to enforce the runtime contract (type stripping, no Bun). The smoke runs the
 * tooling's own bootstrap, so a first run can install tooling dependencies;
 * pass --skip-smoke for a fully offline check.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKILL_NAME = /^[a-z][a-z0-9-]*$/;
const CLIENT_ONLY = [
  "disable-model-invocation",
  "mode",
  "icon",
  "color",
  "reminder",
  "paths",
];

const MODEL_SLUG =
  /\b(?:gpt|claude|opus|sonnet|grok|composer|gemini|o[0-9])-[a-z0-9-]*[0-9][a-z0-9.-]*\b/i;
const CLOUD_ENVIRONMENT = /environment\s*:\s*"?cloud"?/i;
const OPTIONAL_COUPLINGS = [
  /~?\/?\.cursor\//,
  /\.cursor\b/,
  /\bAskQuestion\b/,
  /\bcursor-team-kit\b/,
  /\bcontrol-ui\b/,
  /\bcontrol-cli\b/,
  /\/deslop\b/,
  /\/loop\b/,
  /\bcreate-skill\b/,
  /\bsubagent_type\b/,
  /\bBugbot\b/i,
  /\bcloud agent\b/i,
];
const FALLBACK_MARKERS = [
  "fallback",
  "otherwise",
  "for example",
  "e.g.",
  "example",
  "if your harness",
  "if available",
  "when available",
  "optional",
  "prefer",
  "or inline",
  "or manual",
  "or poll",
  "plain text",
  "or omit",
  "or the equivalent",
];

export function parseFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { data: {}, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: text };
  const data = {};
  const stack = [{ indent: -1, map: data }];
  let i = 1;
  while (i < end) {
    const line = lines[i];
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();
    i += 1;
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).map;
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const rest = trimmed.slice(separator + 1).trim();
    if (rest === "" || rest === ">-" || rest === ">" || rest === "|" || rest === "|-") {
      const child = {};
      parent[key] = child;
      stack.push({ indent, map: child });
      continue;
    }
    parent[key] = parseScalar(rest);
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((part) => parseScalar(part.trim()));
  }
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
    if (value[0] === '"') return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function walkFiles(root, base = root) {
  const out = [];
  for (const entry of readdirSync(root).sort()) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...walkFiles(full, base));
    } else {
      out.push(relative(base, full));
    }
  }
  return out;
}

function paragraphs(body) {
  return body.split(/\n\s*\n/);
}

function checkCouplings(file, body, problems) {
  for (const [index, paragraph] of paragraphs(body).entries()) {
    const slug = MODEL_SLUG.exec(paragraph);
    if (slug) {
      problems.push(`${file}: concrete model slug "${slug[0]}" (paragraph ${index + 1})`);
    }
    const lowered = paragraph.toLowerCase();
    const conditional = FALLBACK_MARKERS.some((marker) => lowered.includes(marker));
    if (CLOUD_ENVIRONMENT.test(paragraph) && !conditional) {
      problems.push(`${file}: required cloud environment (paragraph ${index + 1})`);
    }
    for (const pattern of OPTIONAL_COUPLINGS) {
      const match = pattern.exec(paragraph);
      if (match && !conditional) {
        problems.push(
          `${file}: client coupling "${match[0]}" without a fallback (paragraph ${index + 1})`
        );
      }
    }
  }
}

export function verifyPack(packDir, options = {}) {
  const problems = [];
  const pluginPath = options.pluginPath ?? resolve(packDir, "../../.claude-plugin/plugin.json");
  const shouldSmoke = options.smoke ?? true;

  const skillDirs = readdirSync(packDir)
    .filter((entry) => entry !== "_upstream" && entry !== "agents")
    .filter((entry) => existsSync(join(packDir, entry, "SKILL.md")))
    .sort();
  const skillNames = new Set(skillDirs);

  const plugin = existsSync(pluginPath) ? JSON.parse(readFileSync(pluginPath, "utf8")) : { skills: [] };
  const registered = new Set((plugin.skills ?? []).map((value) => value.replace(/^\.\//, "")));

  const parsed = new Map();
  for (const name of skillDirs) {
    const file = join(packDir, name, "SKILL.md");
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    parsed.set(name, data);
    const label = `skills/pstack/${name}/SKILL.md`;
    if (!SKILL_NAME.test(String(data.name ?? ""))) {
      problems.push(`${label}: invalid or missing name field`);
    } else if (data.name !== name) {
      problems.push(`${label}: name "${data.name}" does not match folder "${name}"`);
    }
    if (typeof data.description !== "string" || data.description.trim() === "") {
      problems.push(`${label}: missing description`);
    }
    if (data.license !== "MIT") {
      problems.push(`${label}: missing MIT license field`);
    }
    for (const key of CLIENT_ONLY) {
      if (key in data) problems.push(`${label}: client-only field "${key}" at top level`);
    }
    const metadata = data.metadata ?? {};
    if (typeof metadata.upstream !== "string" || metadata.upstream === "") {
      problems.push(`${label}: missing metadata.upstream`);
    }
    if (typeof metadata["upstream-commit"] !== "string" || !/^[0-9a-f]{40}$/.test(metadata["upstream-commit"])) {
      problems.push(`${label}: missing metadata.upstream-commit`);
    }
    if (!registered.has(`skills/pstack/${name}`)) {
      problems.push(`${label}: not registered in the plugin manifest`);
    }
    checkCouplings(label, body, problems);
    for (const problem of checkReferences(label, file, body, skillNames)) problems.push(problem);
    for (const problem of checkScriptReferences(label, file, body, packDir)) problems.push(problem);
  }

  checkFileCouplings(packDir, problems);
  const manifest = checkProvenance(packDir, problems);
  if (manifest) {
    for (const name of skillDirs) {
      const commit = parsed.get(name)?.metadata?.["upstream-commit"];
      if (typeof commit === "string" && commit !== manifest.commit) {
        problems.push(
          `skills/pstack/${name}/SKILL.md: metadata.upstream-commit does not match the pinned commit`
        );
      }
    }
  }

  if (shouldSmoke) {
    for (const problem of smokeTooling(packDir, options)) problems.push(problem);
  }
  return problems;
}

function stripFences(text) {
  const kept = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) kept.push(line);
  }
  return kept.join("\n");
}

function nearestSkillRoot(file, packDir) {
  let directory = dirname(file);
  const stop = resolve(packDir);
  for (;;) {
    if (existsSync(join(directory, "SKILL.md"))) return directory;
    if (resolve(directory) === stop) return null;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function checkScriptReferences(label, file, body, packDir) {
  const problems = [];
  const prose = stripFences(body);
  const skillRoot = nearestSkillRoot(file, packDir);
  const repoRoot = resolve(packDir, "../..");
  for (const match of prose.matchAll(/`(?:[^`\s]*\/)?(scripts\/[^`\s]+)`/g)) {
    const target = match[0].slice(1, -1);
    if (target.includes("://")) continue;
    const bases = [dirname(file), skillRoot, packDir, repoRoot].filter(Boolean);
    if (!bases.some((base) => existsSync(resolve(base, target)))) {
      problems.push(`${label}: script reference does not resolve: ${target}`);
    }
  }
  return problems;
}

function checkReferences(label, file, body, skillNames) {
  const problems = [];
  const dir = dirname(file);
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
    const clean = target.split("#")[0];
    if (clean === "") continue;
    const resolved = resolve(dir, clean);
    if (!existsSync(resolved)) {
      problems.push(`${label}: link target does not exist: ${target}`);
    }
  }
  for (const match of body.matchAll(/\*\*([a-z][a-z0-9-]+)\*\* (?:principle )?skill/g)) {
    const cited = match[1];
    if (!skillNames.has(cited) && !skillNames.has(`principle-${cited}`)) {
      problems.push(`${label}: cited skill does not exist: ${cited}`);
    }
  }
  for (const match of body.matchAll(/principle-[a-z0-9-]+/g)) {
    if (!skillNames.has(match[0])) {
      problems.push(`${label}: cited principle does not exist: ${match[0]}`);
    }
  }
  return problems;
}

function checkFileCouplings(packDir, problems) {
  for (const rel of walkFiles(packDir)) {
    if (rel.startsWith(`_upstream${process.platform === "win32" ? "\\" : "/"}`)) continue;
    if (!rel.endsWith(".md") && !rel.endsWith(".sh")) continue;
    if (rel.endsWith("SKILL.md")) continue;
    const full = join(packDir, rel);
    const text = readFileSync(full, "utf8");
    const label = `skills/pstack/${rel}`;
    checkCouplings(label, text, problems);
    for (const problem of checkScriptReferences(label, full, text, packDir)) problems.push(problem);
  }
}

function checkProvenance(packDir, problems) {
  const upstream = join(packDir, "_upstream");
  const required = ["PROVENANCE.md", "THIRD_PARTY_NOTICES.md", "upstream-manifest.json", "verify-upstream.mjs"];
  for (const name of required) {
    if (!existsSync(join(upstream, name))) {
      problems.push(`skills/pstack/_upstream: missing ${name}`);
    }
  }
  const manifestPath = join(upstream, "upstream-manifest.json");
  if (!existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    problems.push(`skills/pstack/_upstream/upstream-manifest.json: ${error.message}`);
    return null;
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.commit ?? "")) {
    problems.push("upstream-manifest.json: missing pinned commit");
  }
  if (typeof manifest.version !== "string" || manifest.version === "") {
    problems.push("upstream-manifest.json: missing upstream version");
  }
  const files = manifest.files ?? {};
  const authored = new Set(["skills/pstack/README.md", "skills/pstack/poteto-mode/scripts/package-lock.json"]);
  for (const rel of walkFiles(packDir)) {
    if (rel.startsWith("_upstream") || authored.has(`skills/pstack/${rel}`)) continue;
    if (rel === "poteto-mode/scripts/node_modules" || rel.includes("node_modules/")) continue;
    if (rel.endsWith(".poteto-mode-tools-install-key")) continue;
    const key = `skills/pstack/${rel}`;
    if (!(key in files)) {
      problems.push(`provenance: ${key} has no upstream manifest entry`);
    }
  }
  for (const key of Object.keys(files)) {
    const full = resolve(packDir, "../..", key);
    if (!existsSync(full)) {
      problems.push(`provenance: manifest entry has no file: ${key}`);
    }
    const entry = files[key];
    if (!entry || typeof entry.upstream !== "string" || !/^[0-9a-f]{40}$/.test(entry.blob ?? "")) {
      problems.push(`provenance: invalid manifest entry for ${key}`);
    }
  }
  const provenancePath = join(upstream, "PROVENANCE.md");
  if (existsSync(provenancePath)) {
    const provenance = readFileSync(provenancePath, "utf8");
    if (manifest.commit && !provenance.includes(manifest.commit)) {
      problems.push("provenance: PROVENANCE.md does not name the pinned commit");
    }
    if (!/benny/i.test(provenance)) {
      problems.push("provenance: PROVENANCE.md does not record the benny exclusion");
    }
  }
  return manifest;
}

export const TOOLING_ENTRYPOINTS = [
  ["watch-pr", "watch-pr"],
  ["orch", "orch.ts"],
  ["check-plan.mjs"],
];

export function smokeTooling(packDir, options = {}) {
  const problems = [];
  const scripts = join(packDir, "poteto-mode", "scripts");
  const entries = TOOLING_ENTRYPOINTS.map((parts) => join(scripts, ...parts));
  const run = options.run ?? ((command, args, cwd) => spawnSync(command, args, { cwd, encoding: "utf8" }));
  for (const entry of entries) {
    if (!existsSync(entry)) {
      problems.push(`smoke: missing tooling entry point ${relative(packDir, entry)}`);
      continue;
    }
    const result = run(process.execPath, [entry, "--help"], scripts);
    if (result.status !== 0) {
      problems.push(
        `smoke: node ${relative(packDir, entry)} --help failed (status ${result.status ?? "?"})${
          result.stderr ? `: ${String(result.stderr).split("\n")[0]}` : ""
        }`
      );
    }
  }
  return problems;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const packDir = resolve(here, "../skills/pstack");
  const skipSmoke = process.argv.includes("--skip-smoke");
  const problems = verifyPack(packDir, { smoke: !skipSmoke });
  for (const problem of problems) console.log(`[FAIL] ${problem}`);
  if (problems.length === 0) {
    console.log("[OK  ] pstack pack contract holds");
    return;
  }
  console.log(`\n${problems.length} problem(s) in the pstack pack.`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
