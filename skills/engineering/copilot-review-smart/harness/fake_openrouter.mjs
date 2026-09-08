import { appendLog, loadFixtureContext } from "./fixture_runtime.mjs";

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
