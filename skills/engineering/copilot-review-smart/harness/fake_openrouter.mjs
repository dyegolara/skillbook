import { appendLog, loadFixtureContext } from "./fixture_runtime.mjs";

// Claim this process as a fixture tick so auto-advance mode (and the fake gh
// children it spawns) resolve the same tick index. The Listener also loads
// this module (NODE_OPTIONS applies to it too) but must not claim: it is not
// a tick and its env is inherited by every tick child.
const isListener = (process.argv[1] || "").endsWith("pr_monitor_webhook.mjs");
if (!isListener) {
  process.env.PR_MONITOR_FIXTURE_TICK_PID = process.env.PR_MONITOR_FIXTURE_TICK_PID || String(process.pid);
}

globalThis.fetch = async function fakeFetch(url, init = {}) {
  if (typeof url === "string" && url.startsWith("https://openrouter.ai/api/v1/chat/completions")) {
    const { scenarioName, tickIndex, tick } = loadFixtureContext();
    appendLog("fetch", {
      scenario: scenarioName,
      tick: tickIndex + 1,
      url,
      body: init.body || null,
    });
    const responseIndex = Number(process.env.PR_MONITOR_FIXTURE_LLM_CALLS || "0");
    process.env.PR_MONITOR_FIXTURE_LLM_CALLS = String(responseIndex + 1);
    const decision = tick.llmResponses?.[responseIndex];
    if (!decision) throw new Error(`No frozen LLM response for ${scenarioName} tick ${tickIndex + 1} call ${responseIndex + 1}`);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(decision) } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }
  throw new Error(`Unexpected network call in fixture harness: ${String(url)}`);
};
