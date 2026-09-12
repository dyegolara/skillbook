#!/usr/bin/env node
/**
 * verify-upstream.mjs — reports upstream drift against the recorded pin.
 *
 * Network-dependent and deliberately separate from the offline pack contract:
 * it reads upstream-manifest.json, asks GitHub for the current upstream tree,
 * and reports files that changed, disappeared, or are new since the pin. It
 * never syncs anything; a human decides what to bring over.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = "cursor/plugins";
const SUBDIRECTORY = "pstack";
const TRACKED_PREFIXES = [`${SUBDIRECTORY}/skills/`, `${SUBDIRECTORY}/agents/`];

export function diffManifest(manifest, { head, tree }) {
  const lines = [];
  let drift = false;
  if (head && manifest.commit && head !== manifest.commit) {
    lines.push(`[INFO ] upstream moved: pin ${manifest.commit.slice(0, 7)} -> head ${head.slice(0, 7)}`);
  } else if (head) {
    lines.push(`[OK   ] upstream head still at the pin ${head.slice(0, 7)}`);
  }

  const upstream = new Map();
  for (const entry of tree) {
    if (entry.type === "blob" && entry.path.startsWith(`${SUBDIRECTORY}/`)) {
      upstream.set(entry.path, entry.sha);
    }
  }

  for (const [ourPath, entry] of Object.entries(manifest.files ?? {})) {
    const sha = upstream.get(entry.upstream);
    if (sha === undefined) {
      drift = true;
      lines.push(`[DRIFT] removed upstream: ${entry.upstream} (still at ${ourPath})`);
    } else if (sha !== entry.blob) {
      drift = true;
      lines.push(`[DRIFT] changed upstream: ${entry.upstream} (ported as ${ourPath})`);
    }
  }

  const seen = new Set(Object.values(manifest.files ?? {}).map((entry) => entry.upstream));
  const skipped = new Set(manifest.skipped ?? []);
  for (const path of [...upstream.keys()].sort()) {
    if (!TRACKED_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
    if (path === `${SUBDIRECTORY}/agents/` || seen.has(path) || skipped.has(path)) continue;
    drift = true;
    lines.push(`[DRIFT] new upstream file: ${path}`);
  }

  if (!drift) lines.push("[OK   ] no upstream drift against the pin");
  return { drift, lines };
}

async function githubJson(url, token) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "skillbook-verify-upstream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchUpstream(token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN) {
  const headCommit = await githubJson(`https://api.github.com/repos/${REPO}/commits/main`, token);
  const tree = await githubJson(
    `https://api.github.com/repos/${REPO}/git/trees/${headCommit.commit.tree.sha}?recursive=1`,
    token
  );
  if (tree.truncated) throw new Error("upstream tree response was truncated");
  return { head: headCommit.sha, tree: tree.tree };
}

export function driftExitCode({ drift, reportOnly }) {
  return drift && !reportOnly ? 1 : 0;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const reportOnly = process.argv.includes("--report-only");
  const manifestPath = join(here, "upstream-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let upstream;
  try {
    upstream = await fetchUpstream();
  } catch (error) {
    console.log(`[FAIL ] could not read upstream: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const { drift, lines } = diffManifest(manifest, upstream);
  for (const line of lines) console.log(line);
  if (drift) {
    console.log("\nUpstream drift found. Review the list above and port deliberately.");
  }
  process.exitCode = driftExitCode({ drift, reportOnly });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
