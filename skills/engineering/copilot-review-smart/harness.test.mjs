import test from "node:test";
import assert from "node:assert/strict";
import { runFixtureLoop, runFixtureScenario } from "./harness/run_fixture.mjs";

test("fixture runner selects the first-tick scenario and freezes the LLM response", async () => {
  const out = await runFixtureScenario("first-tick-wait");
  assert.equal(out.code, 0);
  assert.equal(out.stdout, "");
  assert.equal(out.fetchLog.length, 1);
});

test("idle cached scenario makes no LLM call and stays silent", async () => {
  const out = await runFixtureScenario("idle-tick");
  assert.equal(out.code, 0);
  assert.equal(out.stdout, "");
  assert.equal(out.fetchLog.length, 0);
});

test("single-PR fixture emits request_review JSON and dry-run comment", async () => {
  const out = await runFixtureScenario("single-pr-request-review");
  assert.equal(out.code, 0);
  assert.match(out.stdout, /\[DRY-RUN\].*@copilot code review/);
  const [prLine, overallLine] = out.jsonLines;
  assert.equal(prLine.pr, 42);
  assert.equal(prLine.action, "request_review");
  assert.equal(prLine.done, false);
  assert.equal(overallLine.type, "overall");
  assert.equal(overallLine.done, false);
});

test("repo-scope fixture emits one JSON line per PR plus overall", async () => {
  const out = await runFixtureScenario("repo-json-report");
  assert.equal(out.code, 0);
  const prLines = out.jsonLines.filter((line) => line.type === "pr");
  assert.equal(prLines.length, 2);
  assert.equal(out.jsonLines.at(-1).type, "overall");
});

test("human transcript all-clear reports notify_ready done", async () => {
  const out = await runFixtureScenario("all-clear-human");
  const [prLine, overallLine] = out.jsonLines;
  assert.equal(prLine.action, "notify_ready");
  assert.equal(prLine.terminal, "done");
  assert.equal(prLine.done, true);
  assert.equal(overallLine.done, true);
});

test("copilot clean confirmation still reaches all-clear", async () => {
  const out = await runFixtureScenario("all-clear-copilot");
  assert.equal(out.jsonLines[0].action, "notify_ready");
  assert.equal(out.jsonLines[0].done, true);
});

test("unaddressed inline feedback is not all-clear", async () => {
  const out = await runFixtureScenario("unaddressed-inline-comment");
  assert.equal(out.jsonLines[0].action, "request_fix");
  assert.equal(out.jsonLines[0].done, false);
});

test("notify-ready fires once per head sha across repeated ticks", async () => {
  const loop = await runFixtureLoop("notify-ready-once-per-sha");
  assert.equal(loop.ticks.length, 1);
  assert.match(loop.ticks[0].stdout, /READY for your review/);

  const second = await runFixtureScenario("notify-ready-once-per-sha", {
    runtimeDir: loop.runtimeDir,
    statePath: loop.statePath,
    tick: 2,
  });
  assert.equal(second.code, 0);
  assert.doesNotMatch(second.stdout, /READY for your review/);
  assert.equal(second.fetchLog.length, 0);
});

test("needs-human fixture reports terminal escalation and only notifies once", async () => {
  const first = await runFixtureScenario("needs-human-conflicts");
  assert.match(first.stdout, /STILL conflicted/);
  assert.equal(first.jsonLines[0].terminal, "needs-human");
  assert.equal(first.jsonLines[0].done, true);

  const second = await runFixtureScenario("needs-human-conflicts", {
    runtimeDir: first.runtimeDir,
    statePath: first.statePath,
    tick: 2,
  });
  assert.equal(second.code, 0);
  assert.doesNotMatch(second.stdout, /STILL conflicted/);
});

test("loop demo stops once a single PR reaches all-clear", async () => {
  const out = await runFixtureLoop("loop-single-pr-to-done");
  assert.equal(out.ticks.length, 2);
  assert.equal(out.ticks[0].jsonLines.at(-1).done, false);
  assert.equal(out.ticks[1].jsonLines.at(-1).done, true);
});

test("loop demo stops immediately on needs-human", async () => {
  const out = await runFixtureLoop("needs-human-conflicts");
  assert.equal(out.ticks.length, 1);
  assert.equal(out.ticks[0].jsonLines.at(-1).done, true);
  assert.equal(out.ticks[0].jsonLines[0].terminal, "needs-human");
});

test("repo loop live scope includes a PR opened on the next tick", async () => {
  const out = await runFixtureLoop("loop-repo-live-scope");
  assert.equal(out.ticks.length, 2);
  const secondTickPrs = out.ticks[1].jsonLines.filter((line) => line.type === "pr").map((line) => line.pr);
  assert.deepEqual(secondTickPrs, [71, 72]);
  assert.equal(out.ticks[1].jsonLines.at(-1).done, true);
});
