#!/usr/bin/env node
/**
 * verify-references.mjs — checks that every external skill referenced by this
 * skillbook actually resolves on its PUBLISHED channel (npm / skills.sh /
 * ClawHub). References only, nothing is downloaded into the repo.
 */
const CHECK = async (url) => {
  const res = await fetch(url, { redirect: "follow" });
  return { status: res.status, ok: res.ok, url };
};

const refs = [
  // lnurl-auth: published to npm + skills.sh
  ["npm registry", "https://registry.npmjs.org/lnurl-auth"],
  ["skills.sh page", "https://skills.sh/dyegolara/lnurl-auth-agents"],
  // nostr-auth: published to npm + skills.sh + ClawHub
  ["npm registry", "https://registry.npmjs.org/nostr-auth"],
  ["skills.sh page", "https://skills.sh/dyegolara/nostr-auth-agents"],
  ["ClawHub page", "https://clawhub.ai/skills/skills/nostr-auth"],
];

let failed = false;
for (const [kind, url] of refs) {
  try {
    const r = await CHECK(url);
    const label = r.ok ? "OK " : "FAIL";
    console.log(`[${label}] ${kind.padEnd(16)} ${url} -> ${r.status}`);
    if (!r.ok) failed = true;
  } catch (e) {
    console.log(`[FAIL] ${kind.padEnd(16)} ${url} -> ${e.message}`);
    failed = true;
  }
}
if (!failed) console.log("\nAll published-channel references OK.");
process.exit(failed ? 1 : 0);