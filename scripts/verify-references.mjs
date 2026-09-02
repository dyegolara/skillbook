#!/usr/bin/env node
/**
 * verify-references.mjs — checks that every external skill referenced by this
 * skillbook actually resolves (npm package or GitHub repo). References only,
 * nothing is downloaded into the repo.
 */
const CHECK = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "skillbook-verify" } });
  return { status: res.status, ok: res.ok, url };
};

const refs = [
  ["npm registry", "https://registry.npmjs.org/lnurl-auth"],
  ["github repo", "https://api.github.com/repos/dyegolara/lnurl-auth-agents"],
  ["github repo", "https://api.github.com/repos/dyegolara/nostr-auth-agents"],
];

let failed = false;
for (const [kind, url] of refs) {
  try {
    const r = await CHECK(url);
    const label = r.ok ? "OK " : "FAIL";
    console.log(`[${label}] ${kind.padStart(12)} ${url} -> ${r.status}`);
    if (!r.ok) failed = true;
  } catch (e) {
    console.log(`[FAIL] ${kind.padStart(12)} ${url} -> ${e.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);