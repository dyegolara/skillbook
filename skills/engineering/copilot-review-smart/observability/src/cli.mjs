import { createObservabilityServer } from "./server.mjs";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  defaultListenerPidPath,
  defaultListenerStatePath,
  defaultTickStatePath,
} from "./paths.mjs";

const USAGE = `Usage: node pr_monitor_observability.mjs [options]

Read-only observability API for the copilot-review-smart watchdog. Projects
the persisted Tick state and Listener state on loopback; GET only, no writes.

Options:
  --host <host>            bind host (loopback only; default 127.0.0.1)
  --port <port>            bind port (default 8788)
  --state <path>           Tick state file (default ~/.cache/pr-monitor/state.json)
  --listener-state <path>  Listener state file (default ~/.cache/pr-monitor/listener-state.json)
  --pid <path>             Listener pid file (default ~/.cache/pr-monitor/listener.pid)
  --help                   print this help

Env:
  PR_MONITOR_OBSERVABILITY_HOST   bind host (default 127.0.0.1)
  PR_MONITOR_OBSERVABILITY_PORT   bind port (default 8788)
  PR_MONITOR_STATE_PATH           Tick state file
  PR_MONITOR_WEBHOOK_STATE_PATH   Listener state file
  PR_MONITOR_WEBHOOK_PID_PATH     Listener pid file

Routes (GET only):
  /health                  watchdog liveness, in the Listener's health shape
  /timeline                executed, in-flight and scheduled ticks
  /flows                   one row per watched PR with its Stage sequence
  /flows/:owner/:repo/:num one Flow in full; 404 when unknown
`;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const FLAG_KEYS = {
  "--host": "host",
  "--port": "port",
  "--state": "statePath",
  "--listener-state": "listenerStatePath",
  "--pid": "pidPath",
};

export function parseObservabilityArgs(argv = []) {
  const config = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const key = FLAG_KEYS[arg];
    if (key) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      config[key] = value;
    } else if (arg === "--help" || arg === "-h") {
      config.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return config;
}

export function resolveObservabilityConfig({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const cli = parseObservabilityArgs(argv);
  const envPort = env.PR_MONITOR_OBSERVABILITY_PORT;
  return {
    help: Boolean(cli.help),
    host: cli.host ?? env.PR_MONITOR_OBSERVABILITY_HOST ?? DEFAULT_HOST,
    port: Number(cli.port ?? (envPort !== undefined ? envPort : DEFAULT_PORT)),
    statePath: cli.statePath ?? defaultTickStatePath(),
    listenerStatePath: cli.listenerStatePath ?? defaultListenerStatePath(),
    pidPath: cli.pidPath ?? defaultListenerPidPath(),
  };
}

export async function main(argv = process.argv.slice(2), { env = process.env } = {}) {
  let config;
  try {
    config = resolveObservabilityConfig({ env, argv });
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
    return;
  }
  if (config.help) {
    console.log(USAGE);
    return;
  }
  if (!LOOPBACK_HOSTS.has(String(config.host))) {
    console.error(
      `refusing to bind ${config.host}: the observability API is loopback only (127.0.0.1 by default).`
    );
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    console.error(`invalid port ${config.port}: expected an integer between 0 and 65535.`);
    process.exitCode = 1;
    return;
  }

  const server = createObservabilityServer({
    statePath: config.statePath,
    listenerStatePath: config.listenerStatePath,
    pidPath: config.pidPath,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const { address, port } = server.address();
  console.log(
    `observability listening on http://${address}:${port} ` +
      `(state=${config.statePath}, listener-state=${config.listenerStatePath}, pid=${config.pidPath})`
  );

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

// Running this module directly (the package's `npm start`) is the same
// command as the root shim; importing it for tests must do nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`⚠️ observability server crashed: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
