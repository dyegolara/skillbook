#!/usr/bin/env node
/**
 * pr_monitor_observability.mjs — CLI shim for the copilot-review-smart
 * read-only observability API. The implementation lives in `observability/`
 * (its own private package — see observability/README.md). Plain ESM, no
 * build step, Node >= 18, `node:http` only.
 *
 * The server projects the persisted Tick state and Listener state on loopback:
 * GET /health, GET /timeline, GET /flows and GET /flows/:owner/:repo/:num.
 * It holds no state of its own and never writes; it answers whether or not a
 * watchdog process is running. See docs/adr/0009 (repo root).
 *
 * Env config:
 *   PR_MONITOR_OBSERVABILITY_HOST  bind host (default 127.0.0.1; loopback only)
 *   PR_MONITOR_OBSERVABILITY_PORT  bind port (default 8788)
 *   PR_MONITOR_STATE_PATH          Tick state file (default ~/.cache/pr-monitor/state.json)
 *   PR_MONITOR_WEBHOOK_STATE_PATH  Listener state (default ~/.cache/pr-monitor/listener-state.json)
 *   PR_MONITOR_WEBHOOK_PID_PATH    Listener pid file (default ~/.cache/pr-monitor/listener.pid)
 *
 * CLI flags: --host, --port, --state, --listener-state, --pid, --help.
 */

import { main } from "./observability/src/cli.mjs";

main(process.argv.slice(2)).catch((e) => {
  console.error(`⚠️ observability server crashed: ${e.stack || e}`);
  process.exit(1);
});
