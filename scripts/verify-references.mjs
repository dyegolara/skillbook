#!/usr/bin/env node
/**
 * verify-references.mjs — checks that every external skill referenced by this
 * skillbook actually resolves. References only, nothing is downloaded into the
 * repo.
 *
 * Statuses:
 *   OK   — reference resolves on its published channel
 *   WARN — known-pending channel (e.g. nostr-auth not yet on skills.sh/npm)
 */
const CHECK = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "skillbook-verify" } });
  return { status: res.status, ok: res.ok, url };
};

const refs = [
  // lnurl-auth: published to npm
  ["npm registry", "https://registry.npmjs.org/lnurl-auth", "OK"],
  ["skills.sh page", "https://skills.sh/dyegolara/lnurl-auth-agents", "OK"],
  // nostr-auth: TEMPORARY github reference until npm/skills.sh publish
  ["github repo (TEMP)", "https://api.github.com/repos/dyegolara/nostr-auth-agents", "OK"],
  ["skills.sh page (pending)", "https://skills.sh/dyegolara/nostr-auth-agents", "WARN"],
];

let failed = false;
for (const [kind, url, expect] of refs) {
  try {
    const r = await CHECK(url);
    const ok = r.ok;
    const label = expect === "WARN" ? (ok ? "OK " : "WARN") : ok ? "OK " : "FAIL";
    console.log(`[${label}] ${kind.padStart(24)} ${url} -> ${r.status}`);
    if (!ok && expect === "OK") failed = true;
  } catch (e) {
    console.log(`[FAIL] ${kind.padStart(24)} ${url} -> ${e.message}`);
    if (expect === "OK") failed = true;
  }
}
if (!failed) console.log("\nAll published-channel references OK.");
process.exit(failed ? 1 : 0);