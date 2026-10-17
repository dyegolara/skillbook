/**
 * tick_liveness.mjs — the shared read side of the Tick's in-flight marker.
 *
 * A Tick writes `tick_in_flight` into the state file before it starts and
 * heartbeats it while it runs (pr_monitor.mjs). A reader decides liveness
 * from disk alone: a marker whose pid is gone or whose heartbeat is stale is
 * not running, so a Tick that crashed mid-run is never read as in flight
 * forever.
 *
 * The Tick and the read-only observability projection both import this
 * module. It holds no state, reads no env and imports nothing beyond the
 * Node runtime, so a read-only process can reuse the rule without loading
 * the writer's module-level state (ADR-0009). Plain ESM, zero dependencies
 * (ADR-0008).
 */

export const TICK_IN_FLIGHT_STALE_MS = 10 * 60_000;

/** Is this the pid of a process that exists? A process owned by another user
 * answers EPERM and counts as alive; ESRCH is the only "gone" answer. */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== "ESRCH";
  }
}

function toMs(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Read the persisted in-flight marker and decide whether its Tick can still
 * be running. Returns null when no Tick is marked, otherwise the readable
 * fields plus `alive`:
 *   alive: true  — the recorded pid is alive and its heartbeat is fresh
 *   alive: false — the owner is gone (crash/kill) or the heartbeat is stale
 *                  (pid reuse); a projection must not read it as running.
 */
export function tickInFlight(state, {
  nowMs = Date.now(),
  isAliveFn = isPidAlive,
  staleMs = TICK_IN_FLIGHT_STALE_MS,
} = {}) {
  const marker = state?.tick_in_flight;
  if (!marker || typeof marker !== "object") return null;
  const heartbeatMs = toMs(marker.heartbeat_at);
  const heartbeatFresh = heartbeatMs !== null && nowMs - heartbeatMs <= staleMs;
  return {
    pid: marker.pid ?? null,
    started_at: marker.started_at ?? null,
    heartbeat_at: marker.heartbeat_at ?? null,
    alive: isAliveFn(Number(marker.pid)) && heartbeatFresh,
  };
}
