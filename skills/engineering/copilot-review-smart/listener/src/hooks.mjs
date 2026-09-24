import { randomBytes } from "node:crypto";
import { HOOK_NAME, HOOK_PATH, SUBSCRIBED_EVENTS, iso } from "./signature.mjs";
import { emptyListenerState } from "./state.mjs";
import { runGh } from "./gh.mjs";

export function hookPayload({ publicUrl, secret }) {
  return {
    name: HOOK_NAME,
    active: true,
    events: [...SUBSCRIBED_EVENTS],
    config: {
      url: `${String(publicUrl).replace(/\/+$/, "")}${HOOK_PATH}`,
      content_type: "json",
      secret,
      insecure_ssl: "0",
    },
  };
}

export function findOurHook(hooks) {
  if (!Array.isArray(hooks)) return null;
  return hooks.find(
    (h) =>
      String(h?.name || "").startsWith(HOOK_NAME) &&
      String(h?.config?.url || "").includes(HOOK_PATH)
  ) || hooks.find((h) => String(h?.config?.url || "").includes(HOOK_PATH)) || null;
}

function ghHookArgs(payload) {
  return [
    "-f", `name=${payload.name}`,
    "-F", "active=true",
    "-f", `config[url]=${payload.config.url}`,
    "-f", `config[content_type]=${payload.config.content_type}`,
    "-f", `config[secret]=${payload.config.secret}`,
    "-f", `config[insecure_ssl]=${payload.config.insecure_ssl}`,
    ...payload.events.flatMap((event) => ["-f", `events[]=${event}`]),
  ];
}

export async function setupHook({
  repo,
  publicUrl,
  secret,
  state = emptyListenerState(),
  gh = runGh,
  fetchFn = globalThis.fetch,
  now = () => Date.now(),
  persistState = null,
  requireHealth = true,
} = {}) {
  if (!secret) throw new Error("PR_MONITOR_WEBHOOK_SECRET is required to set up a Hook.");
  if (!publicUrl) throw new Error("PR_MONITOR_PUBLIC_URL is required to set up a Hook.");
  const healthUrl = `${String(publicUrl).replace(/\/+$/, "")}/healthz`;
  if (requireHealth) {
    let response;
    try {
      response = await fetchFn(healthUrl);
    } catch (e) {
      throw new Error(
        `${healthUrl} is not reachable (${e?.message || e}). Fix public ingress or use cron mode ` +
          "(node pr_monitor.mjs) instead of the webhook Listener."
      );
    }
    if (!response?.ok) {
      throw new Error(
        `${healthUrl} answered ${response?.status ?? "no response"}: refusing to create a Hook GitHub ` +
          "cannot verify. Fix public ingress or use cron mode instead."
      );
    }
  }
  let id = state.hooks?.[repo]?.id || null;
  let created = false;
  if (!id) {
    const hooks = await gh([`repos/${repo}/hooks?per_page=100`]);
    const found = findOurHook(hooks);
    if (found) id = found.id;
  }
  const payload = hookPayload({ publicUrl, secret });
  if (id) {
    await gh([`repos/${repo}/hooks/${id}`, "-X", "PATCH", ...ghHookArgs(payload)]);
  } else {
    const hook = await gh([`repos/${repo}/hooks`, "-X", "POST", ...ghHookArgs(payload)]);
    id = hook?.id ?? null;
    created = true;
  }
  if (!id) throw new Error(`GitHub did not return a Hook id for ${repo}.`);
  state.hooks = state.hooks || {};
  state.hooks[repo] = { id, url: payload.config.url, updated_at: iso(now()) };
  if (persistState) persistState(state);
  await gh([`repos/${repo}/hooks/${id}/pings`, "-X", "POST"]);
  return { repo, id, created, url: payload.config.url };
}

export async function listHooks({ repos, gh = runGh, state = emptyListenerState() }) {
  const result = [];
  for (const repo of repos) {
    let hooks;
    try {
      hooks = await gh([`repos/${repo}/hooks?per_page=100`]);
    } catch (e) {
      result.push({ repo, error: String(e?.message || e) });
      continue;
    }
    const ours = (Array.isArray(hooks) ? hooks : []).filter(
      (h) => h.id === state.hooks?.[repo]?.id || findOurHook([h])
    );
    for (const hook of ours) {
      let deliveries = [];
      try {
        deliveries = await gh([`repos/${repo}/hooks/${hook.id}/deliveries?per_page=5`]);
      } catch {
        deliveries = [];
      }
      result.push({
        repo,
        id: hook.id,
        url: hook.config?.url || null,
        active: hook.active !== false,
        events: hook.events || [],
        recent_deliveries: (Array.isArray(deliveries) ? deliveries : []).map((d) => ({
          event: d.event || null,
          action: d.action || null,
          status: d.status || null,
          status_code: d.status_code ?? null,
          delivered_at: d.delivered_at || null,
        })),
      });
    }
  }
  return result;
}

export async function teardownHooks({ repos, gh = runGh, state = emptyListenerState(), persistState = null }) {
  const removed = [];
  for (const repo of repos) {
    let id = state.hooks?.[repo]?.id || null;
    if (!id) {
      try {
        id = findOurHook(await gh([`repos/${repo}/hooks?per_page=100`]))?.id || null;
      } catch {
        id = null;
      }
    }
    if (!id) continue;
    await gh([`repos/${repo}/hooks/${id}`, "-X", "DELETE"]);
    removed.push({ repo, id });
    if (state.hooks) delete state.hooks[repo];
  }
  if (persistState) persistState(state);
  return removed;
}

export function generateWebhookSecret() {
  return randomBytes(32).toString("hex");
}

export async function rotateSecret({
  repos,
  gh = runGh,
  state = emptyListenerState(),
  persistState = null,
  now = () => Date.now(),
} = {}) {
  const secret = generateWebhookSecret();
  const updated = [];
  for (const repo of repos) {
    let id = state.hooks?.[repo]?.id || null;
    if (!id) {
      try {
        id = findOurHook(await gh([`repos/${repo}/hooks?per_page=100`]))?.id || null;
      } catch {
        id = null;
      }
    }
    if (!id) continue;
    await gh([`repos/${repo}/hooks/${id}`, "-X", "PATCH", "-f", `config[secret]=${secret}`]);
    state.hooks = state.hooks || {};
    state.hooks[repo] = { ...(state.hooks[repo] || {}), id, updated_at: iso(now()) };
    updated.push({ repo, id });
  }
  if (persistState) persistState(state);
  return { secret, updated };
}
