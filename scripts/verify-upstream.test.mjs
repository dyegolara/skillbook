import { test } from "node:test";
import assert from "node:assert/strict";
import { diffManifest, driftExitCode } from "../skills/pstack/_upstream/verify-upstream.mjs";

const manifest = {
  commit: "a".repeat(40),
  files: {
    "skills/pstack/how/SKILL.md": { upstream: "pstack/skills/how/SKILL.md", blob: "b".repeat(40) },
    "skills/pstack/why/SKILL.md": { upstream: "pstack/skills/why/SKILL.md", blob: "c".repeat(40) },
  },
};

function tree(...paths) {
  return paths.map(([path, sha]) => ({ type: "blob", path, sha }));
}

test("no drift when head is the pin and every blob matches", () => {
  const result = diffManifest(manifest, {
    head: "a".repeat(40),
    tree: tree(["pstack/skills/how/SKILL.md", "b".repeat(40)], ["pstack/skills/why/SKILL.md", "c".repeat(40)]),
  });
  assert.equal(result.drift, false);
  assert.ok(result.lines.some((line) => line.includes("no upstream drift")));
});

test("reports a changed upstream file", () => {
  const result = diffManifest(manifest, {
    head: "a".repeat(40),
    tree: tree(["pstack/skills/how/SKILL.md", "d".repeat(40)], ["pstack/skills/why/SKILL.md", "c".repeat(40)]),
  });
  assert.equal(result.drift, true);
  assert.ok(result.lines.some((line) => line.includes("changed upstream: pstack/skills/how/SKILL.md")));
});

test("reports a removed upstream file", () => {
  const result = diffManifest(manifest, {
    head: "a".repeat(40),
    tree: tree(["pstack/skills/how/SKILL.md", "b".repeat(40)]),
  });
  assert.equal(result.drift, true);
  assert.ok(result.lines.some((line) => line.includes("removed upstream: pstack/skills/why/SKILL.md")));
});

test("reports a new upstream skill file", () => {
  const result = diffManifest(manifest, {
    head: "a".repeat(40),
    tree: tree(
      ["pstack/skills/how/SKILL.md", "b".repeat(40)],
      ["pstack/skills/why/SKILL.md", "c".repeat(40)],
      ["pstack/skills/new-skill/SKILL.md", "e".repeat(40)]
    ),
  });
  assert.equal(result.drift, true);
  assert.ok(result.lines.some((line) => line.includes("new upstream file: pstack/skills/new-skill/SKILL.md")));
});

test("ignores new files outside the tracked prefixes", () => {
  const result = diffManifest(manifest, {
    head: "a".repeat(40),
    tree: tree(
      ["pstack/skills/how/SKILL.md", "b".repeat(40)],
      ["pstack/skills/why/SKILL.md", "c".repeat(40)],
      ["pstack/docs/guide/01-setup.md", "e".repeat(40)],
      ["pstack/automations/benny/README.md", "e".repeat(40)]
    ),
  });
  assert.equal(result.drift, false);
});

test("ignores upstream files recorded as intentionally skipped", () => {
  const result = diffManifest(
    { ...manifest, skipped: ["pstack/skills/poteto-mode/scripts/bun.lock"] },
    {
      head: "a".repeat(40),
      tree: tree(
        ["pstack/skills/how/SKILL.md", "b".repeat(40)],
        ["pstack/skills/why/SKILL.md", "c".repeat(40)],
        ["pstack/skills/poteto-mode/scripts/bun.lock", "e".repeat(40)]
      ),
    }
  );
  assert.equal(result.drift, false);
});

test("reports the pin-to-head move without failing when ported files match", () => {
  const result = diffManifest(manifest, {
    head: "f".repeat(40),
    tree: tree(["pstack/skills/how/SKILL.md", "b".repeat(40)], ["pstack/skills/why/SKILL.md", "c".repeat(40)]),
  });
  assert.equal(result.drift, false);
  assert.ok(result.lines.some((line) => line.includes("upstream moved")));
});

test("fails on drift when run as a check", () => {
  assert.equal(driftExitCode({ drift: true, reportOnly: false }), 1);
});

test("report-only mode exits zero even on drift", () => {
  assert.equal(driftExitCode({ drift: true, reportOnly: true }), 0);
});
