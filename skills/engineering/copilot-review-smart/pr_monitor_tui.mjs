#!/usr/bin/env node
/**
 * pr_monitor_tui.mjs — CLI shim for the copilot-review-smart observability
 * TUI. The implementation lives in `observability/` (its own private
 * package — see observability/README.md). Plain ESM, no build step, Node
 * >= 18, zero dependencies.
 *
 * The TUI is a client of the read-only observability API (ADR-0009): it
 * renders `GET /timeline` and `GET /flows` as one live, coloured frame with
 * no access to the watchdog's state files. Start the API first:
 *
 *   node pr_monitor_observability.mjs     # http://127.0.0.1:8788
 *   node pr_monitor_tui.mjs               # this view, refreshing every 2s
 *
 * Env config:
 *   PR_MONITOR_OBSERVABILITY_URL   API base URL (default http://127.0.0.1:8788)
 *   PR_MONITOR_OBSERVABILITY_HOST  host used when no URL is set
 *   PR_MONITOR_OBSERVABILITY_PORT  port used when no URL is set
 *   PR_MONITOR_TUI_INTERVAL_MS     refresh interval (default 2000)
 *   NO_COLOR                       disable colour
 *
 * CLI flags: --url, --interval, --once, --color, --no-color, --help.
 * Ctrl-C exits cleanly; an unreachable API draws what to start and retries.
 */

import { main } from "./observability/src/tui-cli.mjs";

main(process.argv.slice(2)).catch((e) => {
  console.error(`⚠️ TUI crashed: ${e.stack || e}`);
  process.exit(1);
});
