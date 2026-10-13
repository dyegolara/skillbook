/**
 * CLI for the observability TUI. It is a client of the read-only REST
 * contract (ADR-0009): `GET /timeline` and `GET /flows` are the only inputs.
 * The loop is deliberately thin — fetch, render, wait — with the renderer and
 * HTTP client in `tui.mjs`. When the API is unreachable the loop draws an
 * actionable frame and keeps retrying; Ctrl-C exits cleanly.
 */

import { fetchFrame, renderApiError, renderFrame } from "./tui.mjs";
import { pathToFileURL } from "node:url";
import { DEFAULT_HOST, DEFAULT_PORT } from "./paths.mjs";

export const DEFAULT_INTERVAL_MS = 2000;

const USAGE = `Usage: node pr_monitor_tui.mjs [options]

Coloured live view of the copilot-review-smart observability API. It is a
client of the read-only REST contract (GET /timeline, GET /flows) and never
reads the watchdog's state files.

Options:
  --url <url>        API base URL (default http://127.0.0.1:8788)
  --interval <ms>    refresh interval (default 2000)
  --once             render one frame and exit
  --color            force ANSI colour (default: auto when stdout is a TTY)
  --no-color         disable ANSI colour
  --help, -h         print this help

Env:
  PR_MONITOR_OBSERVABILITY_URL   API base URL
  PR_MONITOR_OBSERVABILITY_HOST  API host, used when no URL is set (default 127.0.0.1)
  PR_MONITOR_OBSERVABILITY_PORT  API port, used when no URL is set (default 8788)
  PR_MONITOR_TUI_INTERVAL_MS     refresh interval (default 2000)
  NO_COLOR                       disable colour
`;

const VALUE_FLAGS = { "--url": "url", "--interval": "intervalMs" };

export function parseTuiArgs(argv = []) {
  const config = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const key = VALUE_FLAGS[arg];
    if (key) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      config[key] = value;
    } else if (arg === "--once") {
      config.once = true;
    } else if (arg === "--color") {
      config.color = true;
    } else if (arg === "--no-color") {
      config.color = false;
    } else if (arg === "--help" || arg === "-h") {
      config.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return config;
}

export function resolveTuiConfig({ env = process.env, argv = [] } = {}) {
  const cli = parseTuiArgs(argv);
  const host = env.PR_MONITOR_OBSERVABILITY_HOST || DEFAULT_HOST;
  const port = env.PR_MONITOR_OBSERVABILITY_PORT !== undefined ? env.PR_MONITOR_OBSERVABILITY_PORT : DEFAULT_PORT;
  const url = String(cli.url ?? env.PR_MONITOR_OBSERVABILITY_URL ?? `http://${host}:${port}`).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new Error(`invalid observability URL: ${url}`);
  const intervalRaw = cli.intervalMs ?? env.PR_MONITOR_TUI_INTERVAL_MS ?? DEFAULT_INTERVAL_MS;
  const intervalMs = Number(intervalRaw);
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(`invalid --interval ${intervalRaw}: expected a positive integer number of milliseconds`);
  }
  return { help: Boolean(cli.help), url, intervalMs, once: Boolean(cli.once), color: cli.color };
}

export async function main(
  argv = process.argv.slice(2),
  { env = process.env, fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr } = {}
) {
  let config;
  try {
    config = resolveTuiConfig({ env, argv });
  } catch (error) {
    stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (config.help) {
    stdout.write(USAGE);
    return;
  }

  const color = config.color ?? (Boolean(stdout.isTTY) && env.NO_COLOR === undefined);
  const columns = Number.isInteger(stdout.columns) ? stdout.columns : 0;

  const renderOnce = async () => {
    try {
      const { timeline, flows } = await fetchFrame(config.url, { fetchImpl });
      stdout.write(`${renderFrame({ timeline, flows, color, columns })}\n`);
      return true;
    } catch (error) {
      stdout.write(
        `${renderApiError({ url: config.url, message: String(error?.message || error), intervalMs: config.intervalMs, color, columns })}\n`
      );
      return false;
    }
  };

  if (config.once) {
    if (!(await renderOnce())) process.exitCode = 1;
    return;
  }

  let stopped = false;
  let timer = null;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (stdout.isTTY) stdout.write("\u001b[?25h");
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const draw = (frame) => {
    if (stdout.isTTY) stdout.write("\u001b[2J\u001b[H");
    stdout.write(`${frame}\n`);
    if (stdout.isTTY) stdout.write("\u001b[?25l");
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const { timeline, flows } = await fetchFrame(config.url, { fetchImpl });
      draw(renderFrame({ timeline, flows, color, columns }));
    } catch (error) {
      draw(
        renderApiError({ url: config.url, message: String(error?.message || error), intervalMs: config.intervalMs, color, columns })
      );
    }
    if (!stopped) timer = setTimeout(tick, config.intervalMs);
  };

  await tick();
}

// Running this module directly (the package's `npm run tui`) is the same
// command as the root shim; importing it for tests must do nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`⚠️ TUI crashed: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
