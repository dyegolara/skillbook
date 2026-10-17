/**
 * The observability TUI client (ADR-0009): a coloured terminal view of the
 * read-only API contract. This module holds the pure frame renderer and the
 * small HTTP client; `tui-cli.mjs` owns the refresh loop. Everything in the
 * frame comes from `GET /timeline` and `GET /flows` — no state file is ever
 * opened and nothing from the watchdog core is imported. Zero dependencies;
 * colour is hand-rolled ANSI over `node:*`.
 */

import { STAGES } from "./stages.mjs";

export const ANSI = {
  reset: "\u001b[0m",
  past: "\u001b[32m", // green — Stage already run
  current: "\u001b[1;33m", // bold yellow — Stage running now
  next: "\u001b[90m", // bright black — Stage still to come
  allClear: "\u001b[32m", // green — All-clear / Notify-ready
  stuck: "\u001b[1;31m", // bold red — Stuck PR
  needsHuman: "\u001b[1;31m", // bold red — Needs-human
  heading: "\u001b[1;36m", // bold cyan
  dim: "\u001b[2m",
  warn: "\u001b[1;31m",
};

const STATUS_CODES = { past: ANSI.past, current: ANSI.current, next: ANSI.next };
const ANSI_ANYWHERE = /\u001b\[[0-9;]*m/g;

function paint(text, code, color) {
  return color ? `${code}${text}${ANSI.reset}` : text;
}

function visibleLength(line) {
  return line.replace(ANSI_ANYWHERE, "").length;
}

/** Cut a line to `columns` visible characters (ANSI escapes do not count),
 * closing any colour left open with a reset. `0` disables truncation. */
function truncateVisible(line, columns) {
  if (!Number.isInteger(columns) || columns <= 0 || visibleLength(line) <= columns) return line;
  let out = "";
  let shown = 0;
  for (let i = 0; i < line.length && shown < columns - 1; i++) {
    if (line[i] === "\u001b") {
      const match = /\u001b\[[0-9;]*m/.exec(line.slice(i));
      if (match && match.index === 0) {
        out += match[0];
        i += match[0].length - 1;
        continue;
      }
    }
    out += line[i];
    shown++;
  }
  const reset = /\u001b\[(?!0m)[0-9;]*m/.test(out) ? ANSI.reset : "";
  return `${out}…${reset}`;
}

function terminalCode(terminal) {
  if (/^all-clear/i.test(terminal)) return ANSI.allClear;
  if (/^stuck pr/i.test(terminal)) return ANSI.stuck;
  return ANSI.needsHuman;
}

function renderStageSequence(stages, color) {
  const byName = new Map((Array.isArray(stages) ? stages : []).map((stage) => [stage?.stage, stage]));
  return STAGES.map((name) => {
    const status = byName.get(name)?.status ?? "next";
    return paint(name, STATUS_CODES[status] ?? ANSI.next, color);
  }).join(" ");
}

function renderFlowLine(flow, { color, keyWidth }) {
  const terminal = flow?.terminal
    ? paint(flow.terminal, terminalCode(flow.terminal), color)
    : paint("—", ANSI.dim, color);
  return `${String(flow?.key ?? "?").padEnd(keyWidth)}  ${renderStageSequence(flow?.stages, color)}  ${terminal}`;
}

function renderHeader(timeline, color) {
  const executed = timeline?.executed ?? [];
  const scheduled = timeline?.scheduled ?? [];
  const inFlight = timeline?.in_flight ?? null;
  const last = executed.at(-1) ?? null;

  const lines = [
    paint("copilot-review-smart", ANSI.heading, color) +
      paint(" · observability", ANSI.dim, color) +
      (timeline?.now ? paint(`  ${timeline.now}`, ANSI.dim, color) : ""),
  ];
  const done = `done ${executed.length}${last ? ` (last ${last.action ?? "?"} @ ${last.ts ?? "?"})` : ""}`;
  const running = `in-flight ${inFlight ? `pid ${inFlight.pid}${inFlight.alive === false ? " (stale)" : ""}` : "idle"}`;
  const nextCheck = scheduled.length ? `next check ${scheduled[0]?.deadline_at ?? "?"}` : "next check none";
  lines.push(`ticks  ${done}  ·  ${running}  ·  scheduled ${scheduled.length}  ·  ${nextCheck}`);
  return lines;
}

/**
 * Pure frame: `/timeline` and `/flows` payloads plus the terminal's width and
 * colour capability in, one string out. No clock, no I/O — the suite can
 * assert the frame, colours included, without a TTY.
 */
export function renderFrame({ timeline, flows = [], color = false, columns = 0 } = {}) {
  const rows = Array.isArray(flows) ? flows : [];
  const lines = renderHeader(timeline, color);
  if (rows.length === 0) {
    lines.push(paint("no watched PRs — the API is reachable and no Flow is open", ANSI.dim, color));
  } else {
    const keyWidth = Math.max(...rows.map((flow) => String(flow?.key ?? "?").length));
    for (const flow of rows) lines.push(renderFlowLine(flow, { color, keyWidth }));
  }
  return lines.map((line) => truncateVisible(line, columns)).join("\n");
}

/**
 * The one frame drawn when the API cannot be reached. It names the URL that
 * failed, the reason, and exactly what to start — and says it keeps trying,
 * because the live loop does.
 */
export function renderApiError({ url, message = "", intervalMs = 2000, color = false, columns = 0 } = {}) {
  const base = String(url ?? "").replace(/\/+$/, "");
  const lines = [
    paint("⚠ observability API unreachable", ANSI.warn, color) + `  ${base}`,
    paint(`  reason: ${message}`, ANSI.dim, color),
    "  start it:  node pr_monitor_observability.mjs",
    "  or:        npm --prefix observability start",
    paint(`  retrying every ${intervalMs} ms — Ctrl-C to exit`, ANSI.dim, color),
  ];
  return lines.map((line) => truncateVisible(line, columns)).join("\n");
}

/**
 * The HTTP client: only `/timeline` and `/flows` are ever requested. Every
 * value the frame shows arrives through here, which is what makes the API the
 * only seam. Failures are re-thrown with the URL and the OS error code so the
 * error frame is actionable.
 */
export async function fetchFrame(baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error(`invalid observability URL: ${baseUrl}`);

  const getJson = async (pathname) => {
    const url = `${base}${pathname}`;
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const detail = error?.cause?.code ? ` (${error.cause.code})` : "";
      throw new Error(`GET ${url}: ${error?.message || error}${detail}`, { cause: error });
    }
    if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
    return response.json();
  };

  const [timeline, flows] = await Promise.all([getJson("/timeline"), getJson("/flows")]);
  return { timeline, flows };
}
