import fs from "node:fs";
import path from "node:path";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_DEBOUNCE_MS, DEFAULT_TICK_TIMEOUT_MS } from "./paths.mjs";
import { iso, splitRepos } from "./signature.mjs";
import { defaultListenerStatePath, loadListenerState, saveListenerState } from "./state.mjs";
import { createListener } from "./listener.mjs";
import { runGh } from "./gh.mjs";
import { setupHook, listHooks, teardownHooks, rotateSecret } from "./hooks.mjs";
import { startTunnel } from "./tunnels.mjs";
import { runNotifyCmd } from "./notify.mjs";
import {
  claimPidFile,
  defaultLogPath,
  defaultPidPath,
  listenerStatus,
  removePidFile,
  startDaemon,
  stopListenerProcess,
} from "./daemon.mjs";

const USAGE = `Usage: node pr_monitor_webhook.mjs <command> [options]

Commands:
  --serve            run the Listener in the foreground
  --daemon           detach the Listener (pid + log files)
  --stop             stop the detached Listener
  --status           report pid + health
  --setup-hooks      create/update the GitHub Hook(s) and ping them
  --list-hooks       list our Hook(s) and recent deliveries
  --teardown         remove our Hook(s)
  --rotate-secret    generate a new Hook secret and print the env line

Options:
  --keep-alive       keep serving when no active Flow remains
  --setup-hooks      with --serve: verify Hooks by waiting for GitHub's ping
  --tunnel <kind>    ngrok | cloudflared (dev convenience)
`;

export function parseListenerArgs(argv = []) {
  const flags = {
    command: null,
    setupHooks: false,
    keepAlive: false,
    rotateSecret: false,
    listHooks: false,
    teardown: false,
    tunnel: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--serve") flags.command = flags.command || "serve";
    else if (arg === "--daemon") flags.command = "daemon";
    else if (arg === "--stop") flags.command = "stop";
    else if (arg === "--status") flags.command = "status";
    else if (arg === "--setup-hooks") flags.setupHooks = true;
    else if (arg === "--rotate-secret") flags.rotateSecret = true;
    else if (arg === "--list-hooks") flags.listHooks = true;
    else if (arg === "--teardown") flags.teardown = true;
    else if (arg === "--keep-alive") flags.keepAlive = true;
    else if (arg === "--tunnel") {
      flags.tunnel = argv[++i];
      if (!flags.tunnel) throw new Error("--tunnel requires a value: ngrok or cloudflared");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return flags;
}

function resolveCommand(flags) {
  if (flags.command) return flags.command;
  if (flags.teardown) return "teardown";
  if (flags.listHooks) return "list-hooks";
  if (flags.rotateSecret) return "rotate-secret";
  if (flags.setupHooks) return "setup-hooks";
  return "help";
}

export function resolveListenerConfig({ env = process.env, flags = {} } = {}) {
  return {
    repos: splitRepos(env.PR_MONITOR_REPOS || ""),
    secret: env.PR_MONITOR_WEBHOOK_SECRET || "",
    host: env.PR_MONITOR_WEBHOOK_HOST || DEFAULT_HOST,
    port: Number(env.PR_MONITOR_WEBHOOK_PORT || DEFAULT_PORT),
    debounceMs: Number(env.PR_MONITOR_DEBOUNCE_MS || DEFAULT_DEBOUNCE_MS),
    tickTimeoutMs: Number(env.PR_MONITOR_TICK_TIMEOUT || DEFAULT_TICK_TIMEOUT_MS),
    publicUrl: env.PR_MONITOR_PUBLIC_URL || "",
    login: env.PR_MONITOR_LOGIN || "",
    notifyCmd: env.PR_MONITOR_NOTIFY_CMD || "",
    startupTick: env.PR_MONITOR_STARTUP_TICK !== "0",
    keepAlive: Boolean(flags.keepAlive),
    statePath: env.PR_MONITOR_WEBHOOK_STATE_PATH || defaultListenerStatePath(),
    pidPath: env.PR_MONITOR_WEBHOOK_PID_PATH || defaultPidPath(),
    logPath: defaultLogPath(),
    tunnel: flags.tunnel || null,
  };
}

function createJsonlLogger({ logPath = null } = {}) {
  let stream = null;
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    stream = fs.createWriteStream(logPath, { flags: "a" });
  }
  return {
    log: (entry) => {
      const line = JSON.stringify({ ts: iso(Date.now()), ...entry });
      process.stdout.write(`${line}\n`);
      stream?.write(`${line}\n`);
    },
    close: () => new Promise((resolve) => {
      try {
        if (stream) stream.end(resolve);
        else resolve();
      } catch {
        resolve();
      }
    }),
  };
}

function requireServeConfig(config) {
  if (!config.secret) {
    throw new Error(
      "PR_MONITOR_WEBHOOK_SECRET is required: refusing to serve an unauthenticated webhook. " +
        "Use --rotate-secret (or --setup-hooks) to generate/register one."
    );
  }
  if (config.repos.length === 0) {
    throw new Error("PR_MONITOR_REPOS is required: refusing to serve without a watched-repo filter.");
  }
}

async function commandServe({ flags, env = process.env }) {
  const config = resolveListenerConfig({ env, flags });
  requireServeConfig(config);
  claimPidFile(config.pidPath);
  const { log, close } = createJsonlLogger({ logPath: config.logPath });
  const state = loadListenerState(config.statePath);
  const persistState = (next) => saveListenerState(next, config.statePath);
  let tunnel = null;
  let listener = null;
  let shuttingDown = false;
  let resolveShutdown;
  const shutdownRequest = new Promise((resolve) => { resolveShutdown = resolve; });

  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ event: "shutdown", reason });
    tunnel?.stop?.();
    try {
      await listener?.stop();
    } catch (e) {
      log({ event: "shutdown_error", error: String(e?.message || e) });
    }
    removePidFile(config.pidPath, process.pid);
    await close();
    resolveShutdown();
  }

  process.once("SIGINT", () => { shutdown("SIGINT"); });
  process.once("SIGTERM", () => { shutdown("SIGTERM"); });

  listener = createListener({
    config,
    state,
    persistState,
    logger: log,
    gh: runGh,
    notifier: (note) => runNotifyCmd({ cmd: config.notifyCmd, note }),
    onExit: () => { shutdown("idle"); },
  });

  const { port } = await listener.start();
  config.port = port;
  if (config.tunnel) {
    tunnel = await startTunnel({ kind: config.tunnel, port, logger: log });
    config.publicUrl = tunnel.url;
    log({ event: "tunnel_started", kind: config.tunnel, url: tunnel.url });
  }

  try {
    if (flags.setupHooks) {
      // Register the ping wait before setup POSTs the pings: GitHub can
      // deliver a ping before the HTTP round-trip returns.
      const pingsPromise = listener.waitForPings(config.repos);
      void pingsPromise.catch(() => {});
      for (const repo of config.repos) {
        const hook = await setupHook({
          repo,
          publicUrl: config.publicUrl,
          secret: config.secret,
          state,
          gh: runGh,
          persistState,
          now: Date.now,
        });
        log({ event: "hook_ready", ...hook });
        console.log(`hook ${hook.created ? "created" : "updated"} id=${hook.id} repo=${hook.repo} url=${hook.url}`);
      }
      const verified = await pingsPromise;
      log({ event: "hooks_verified", repos: verified });
      console.log(`✅ Hooks verified by GitHub ping: ${verified.join(", ")}`);
    } else if (!config.publicUrl) {
      log({
        event: "public_url_missing",
        message: "set PR_MONITOR_PUBLIC_URL (or use --tunnel) to manage the GitHub Hook",
      });
    }
    await shutdownRequest;
    // Everything graceful is done (state persisted, Hook ids saved, pid file
    // removed, log closed). Libuv can still be held by transport debris
    // (stdio pipes to the caller, keep-alive sockets): an idle exit must be
    // decisive, so flush the pipes and exit.
    await new Promise((resolve) => {
      let pending = 2;
      const flushed = () => {
        if (--pending === 0) resolve();
      };
      process.stdout.write("", flushed);
      process.stderr.write("", flushed);
    });
    process.exit(0);
  } catch (e) {
    await shutdown("error");
    throw e;
  }
}

async function commandDaemon({ flags, env = process.env }) {
  const config = resolveListenerConfig({ env, flags });
  requireServeConfig(config);
  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error("PR_MONITOR_WEBHOOK_PORT must be a fixed port (not 0) for --daemon.");
  }
  const args = ["--serve"];
  if (flags.keepAlive) args.push("--keep-alive");
  if (flags.setupHooks) args.push("--setup-hooks");
  if (config.tunnel) args.push("--tunnel", config.tunnel);
  const result = await startDaemon({
    args,
    env,
    logPath: config.logPath,
    pidPath: config.pidPath,
    host: config.host,
    port: config.port,
  });
  if (!result.started) {
    console.error(result.error);
    process.exitCode = 1;
    return;
  }
  console.log(`Listener daemon started pid=${result.pid} log=${result.logPath}`);
}

async function commandStatus({ flags, env = process.env }) {
  const config = resolveListenerConfig({ env, flags });
  const status = await listenerStatus({ host: config.host, port: config.port, pidPath: config.pidPath });
  if (status.running) {
    console.log(`running pid=${status.pid} healthy=${status.healthy}`);
    if (status.health && !status.health.healthy) console.log(`health: ${JSON.stringify(status.health)}`);
  } else {
    console.log("not running");
    process.exitCode = 1;
  }
}

async function commandStop({ flags, env = process.env }) {
  const config = resolveListenerConfig({ env, flags });
  const result = await stopListenerProcess({ pidPath: config.pidPath });
  if (result.stopped) {
    console.log(`stopped pid=${result.pid}`);
    return;
  }
  console.log(`not stopped: ${result.reason}`);
  if (result.reason && !/^not running|^stale/.test(result.reason)) process.exitCode = 1;
}

async function commandSetupHooks({ flags, env = process.env }) {
  const config = resolveListenerConfig({ env, flags });
  requireServeConfig(config);
  if (!config.publicUrl) {
    throw new Error(
      "PR_MONITOR_PUBLIC_URL is required to set up Hooks (or start the Listener with --tunnel)."
    );
  }
  const state = loadListenerState(config.statePath);
  const persistState = (next) => saveListenerState(next, config.statePath);
  for (const repo of config.repos) {
    const hook = await setupHook({
      repo,
      publicUrl: config.publicUrl,
      secret: config.secret,
      state,
      gh: runGh,
      persistState,
      now: Date.now,
    });
    console.log(`hook ${hook.created ? "created" : "updated"} id=${hook.id} repo=${hook.repo} url=${hook.url}`);
  }
  console.log("Hooks set up. Start the Listener (--serve or --daemon); its /healthz will show the ping Delivery.");
}

async function commandListHooks({ env = process.env }) {
  const config = resolveListenerConfig({ env });
  requireServeConfig(config);
  const state = loadListenerState(config.statePath);
  const rows = await listHooks({ repos: config.repos, gh: runGh, state });
  console.log(JSON.stringify(rows, null, 2));
}

async function commandTeardown({ env = process.env }) {
  const config = resolveListenerConfig({ env });
  requireServeConfig(config);
  const state = loadListenerState(config.statePath);
  const removed = await teardownHooks({
    repos: config.repos,
    gh: runGh,
    state,
    persistState: (next) => saveListenerState(next, config.statePath),
  });
  if (removed.length === 0) console.log("no Hooks to remove");
  for (const hook of removed) console.log(`hook removed id=${hook.id} repo=${hook.repo}`);
}

async function commandRotateSecret({ env = process.env }) {
  const config = resolveListenerConfig({ env });
  requireServeConfig(config);
  const state = loadListenerState(config.statePath);
  const { secret, updated } = await rotateSecret({
    repos: config.repos,
    gh: runGh,
    state,
    persistState: (next) => saveListenerState(next, config.statePath),
    now: Date.now,
  });
  if (updated.length === 0) {
    console.log("no Hooks found to rotate; nothing to do");
    return;
  }
  for (const hook of updated) console.log(`hook secret rotated id=${hook.id} repo=${hook.repo}`);
  console.log("");
  console.log("Update the Host env and RESTART the Listener (it keeps the old secret in memory):");
  console.log(`PR_MONITOR_WEBHOOK_SECRET=${secret}`);
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseListenerArgs(argv);
  const command = resolveCommand(flags);
  switch (command) {
    case "serve":
      return commandServe({ flags });
    case "daemon":
      return commandDaemon({ flags });
    case "stop":
      return commandStop({ flags });
    case "status":
      return commandStatus({ flags });
    case "setup-hooks":
      return commandSetupHooks({ flags });
    case "list-hooks":
      return commandListHooks({ flags });
    case "teardown":
      return commandTeardown({ flags });
    case "rotate-secret":
      return commandRotateSecret({ flags });
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}
