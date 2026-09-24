import { createHmac, timingSafeEqual } from "node:crypto";

export const HOOK_NAME = "copilot-review-smart (pr-monitor)";
export const HOOK_PATH = "/github/webhook";

export const SUBSCRIBED_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
];

export const SUBSCRIBED_ACTIONS = {
  pull_request: new Set([
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
    "converted_to_draft",
    "closed",
  ]),
  pull_request_review: new Set(["submitted", "dismissed"]),
  pull_request_review_comment: new Set(["created"]),
  issue_comment: new Set(["created", "edited"]),
};

export const MAX_BODY_BYTES = 1024 * 1024;

export const iso = (ms) => new Date(ms).toISOString();


function splitRepos(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function keyOf(repo, num) {
  return `${repo}#${num}`;
}

function parseKey(key) {
  const match = String(key).match(/^([^#]+)#(\d+)$/);
  if (!match) throw new Error(`Invalid listener key: ${key}`);
  return { repo: match[1], num: Number(match[2]) };
}

function isCopilotLogin(login) {
  return String(login || "").toLowerCase().includes("copilot");
}

/** HMAC-SHA256 over the raw body, constant-time compare. */
export function verifySignature(rawBody, signatureHeader, secret) {
  const header = String(signatureHeader || "");
  if (!header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", String(secret || ""))
    .update(rawBody)
    .digest("hex");
  const provided = header.slice("sha256=".length).trim();
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}



/** Which Deliveries wake the loop, which are acknowledged and dropped. */
export function classifyDelivery({ event, payload = {}, repos = [], login = "" }) {
  if (event === "ping") {
    return { accepted: true, kind: "ping", repo: payload.repository?.full_name || null, num: null };
  }
  if (!SUBSCRIBED_EVENTS.includes(event)) {
    return { accepted: false, reason: `event ${event} is not subscribed` };
  }
  const action = payload.action || "";
  if (!SUBSCRIBED_ACTIONS[event]?.has(action)) {
    return { accepted: false, reason: `${event}.${action || "?"} is not subscribed` };
  }
  const repo = payload.repository?.full_name || "";
  if (!repo) return { accepted: false, reason: "delivery carries no repository" };
  if (event === "issue_comment" && !payload.issue?.pull_request) {
    return { accepted: false, reason: "issue_comment is not on a pull request" };
  }
  const num = payload.pull_request?.number ?? payload.issue?.number ?? null;
  if (!Number.isInteger(num)) return { accepted: false, reason: "delivery carries no PR number" };
  if (repos.length && !repos.includes(repo)) {
    return { accepted: false, reason: `repo ${repo} is not watched` };
  }
  const sender = payload.sender?.login || "";
  // Copilot is never filtered: Copilot's own deliveries are progress, and a
  // Copilot login could in principle collide with the loop's own login.
  if (login && sender === login && !isCopilotLogin(sender)) {
    return { accepted: false, echo: true, repo, num, reason: "Echo: delivery was caused by our own login" };
  }
  return {
    accepted: true,
    kind: "delivery",
    event,
    action,
    repo,
    num,
    sender,
    closesFlow: event === "pull_request" && action === "closed",
  };
}



export {
  splitRepos,
  keyOf,
  parseKey,
  isCopilotLogin,
};
