#!/usr/bin/env node
/**
 * pr_monitor_webhook.mjs — CLI shim for the copilot-review-smart Listener.
 * The implementation lives in `listener/` (its own package, one module per
 * concern — see listener/README.md). Plain ESM JavaScript, no build step,
 * Node >= 18, `node:http` only.
 *
 * The Listener is transport only: it verifies GitHub Deliveries, filters and
 * coalesces them, spawns one Tick at a time scoped to the affected PR, and
 * arms the Expectation the Tick report hands back. It never decides actions.
 * Cron mode (`pr_monitor.mjs`) stays the alternate mode for Hosts without a
 * public HTTPS endpoint. See docs/adr/0005 (repo root).
 *
 * Env config:
 *   PR_MONITOR_REPOS              (required) watched repos "owner/repo,..."
 *   PR_MONITOR_WEBHOOK_SECRET     (required) HMAC secret of the Hook
 *   PR_MONITOR_PUBLIC_URL         public base URL of this Listener (Hook setup)
 *   PR_MONITOR_LOGIN              own login for the Echo filter (default: gh api user)
 *   PR_MONITOR_WEBHOOK_HOST       bind host (default 127.0.0.1)
 *   PR_MONITOR_WEBHOOK_PORT       bind port (default 8787)
 *   PR_MONITOR_DEBOUNCE_MS        per-PR debounce (default 30000)
 *   PR_MONITOR_TICK_TIMEOUT       kill a hung Tick after this many ms (default 300000)
 *   PR_MONITOR_STARTUP_TICK       "0" disables the Startup tick
 *   PR_MONITOR_WEBHOOK_STATE_PATH Listener state (default ~/.cache/pr-monitor/listener-state.json)
 *   PR_MONITOR_WEBHOOK_PID_PATH   pid file (default ~/.cache/pr-monitor/listener.pid)
 *   PR_MONITOR_WEBHOOK_LOG        optional JSONL log file (stdout always logs)
 *   PR_MONITOR_NOTIFY_CMD         owner notifications: command, JSON on stdin
 *
 * CLI flags:
 *   --serve                    run the Listener in the foreground
 *   --daemon                   detach the Listener (writes pid + log file)
 *   --stop                     stop the detached Listener
 *   --status                   report pid + health
 *   --keep-alive               keep serving when no active Flow remains
 *   --setup-hooks              create/update the GitHub Hook(s), then ping them
 *   --list-hooks               list our Hook(s) and recent deliveries
 *   --teardown                 remove our Hook(s)
 *   --rotate-secret            generate a new Hook secret and print the env line
 *   --tunnel ngrok|cloudflared start a tunnel and use its URL for Hook setup
 */

import { main } from "./listener/src/cli.mjs";

main(process.argv.slice(2)).catch((e) => {
  console.error(`⚠️ listener crashed: ${e.stack || e}`);
  process.exit(1);
});
