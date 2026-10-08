import path from "node:path";
import { fileURLToPath } from "node:url";

/** Paths and defaults for the Listener package. The package lives inside the
 * skill folder; the Tick script and the CLI shim it drives are one level up. */
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.dirname(SRC_DIR);
const SKILL_DIR = path.dirname(PKG_DIR);

export const PR_MONITOR_SCRIPT = path.join(SKILL_DIR, "pr_monitor.mjs");
export const WEBHOOK_SCRIPT = path.join(SKILL_DIR, "pr_monitor_webhook.mjs");

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const DEFAULT_DEBOUNCE_MS = 30_000;
export const DEFAULT_TICK_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_NOTIFY_TIMEOUT_MS = 30_000;
export const DEFAULT_PING_WAIT_MS = 30_000;
export const DEFAULT_TUNNEL_TIMEOUT_MS = 30_000;
export const TICK_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
export const DELIVERY_LRU_SIZE = 1000;
