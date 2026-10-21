#!/usr/bin/env node
/**
 * fake_kepler_api.mjs — a loopback-only fake of the Kepler HTTP surface the
 * software-factory helpers use.
 *
 * It binds `127.0.0.1` on an ephemeral port and answers exactly the endpoints
 * a stage launch and a grill session touch: the terminal routes
 * (`GET /terminal/list`, `POST /terminal/start`, `POST /terminal/input`,
 * `GET /terminal/buffer`, `POST /terminal/close`) and the agent routes
 * (`POST /agent/sessions`, `POST /agent/rename-session`,
 * `POST /agent/session-config-option`, `POST /agent/send-prompt`). Every
 * request is recorded, so a test can assert what the real helper sent without
 * stubbing `fetch`. Nothing leaves the machine and no provider CLI runs.
 *
 * `POST /terminal/input` simulates the executed retry wrapper: the injected
 * input lands in the terminal's scrollback and the wrapper's first action —
 * the `CHAIN-STAGE-START:` sentinel line — follows it, so the helper's
 * post-injection check passes. `GET /terminal/buffer` answers with the
 * scrollback as a bare JSON string, the shape Kepler returns.
 *
 * Plain ESM per ADR-0002, zero dependencies beyond Node.
 */
import http from "node:http";
import { createHmac } from "node:crypto";

/** Extract the standalone sentinel line the wrapper prints from an injected input. */
function sentinelOf(input) {
  return /CHAIN-STAGE-START: chain #\d+ [\w-]+/.exec(input)?.[0] ?? null;
}

/**
 * Start the fake on loopback and resolve once it is listening.
 *
 * @param {{ terminalId?: string, sessionId?: string, anchor?: Object|null }} options
 * @returns {Promise<{ apiBase: string, calls: Array<Object>, inputs: Array<Object>, close: () => Promise<void> }>}
 */
export async function startFakeKeplerApi({
  terminalId = "term-fixture",
  sessionId = "sess-fixture",
  anchor = null,
  terminalEnv = {},
} = {}) {
  const calls = [];
  const inputs = [];
  const scrollback = new Map();
  let starts = 0;

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const url = new URL(request.url, "http://127.0.0.1");
        const method = request.method ?? "GET";
        const body = raw === "" ? undefined : JSON.parse(raw);
        calls.push({ method, path: url.pathname, url: request.url, host: request.headers.host, body });

        const send = (value) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };

        const route = `${method} ${url.pathname}`;
        if (route === "GET /terminal/list") return send(anchor ? [anchor] : []);
        if (route === "POST /terminal/start") {
          starts += 1;
          return send({ terminalId: starts === 1 ? terminalId : `${terminalId}-${starts}` });
        }
        if (route === "POST /terminal/input") {
          inputs.push(body);
          const injected = String(body?.input ?? "");
          const previous = scrollback.get(body?.terminalId) ?? "";
          const credentialCheck =
            /^# PROVIDER-CREDENTIAL-CHECK (\w+) ([a-f0-9]+) ([a-f0-9]+) (\S+)$/m.exec(injected);
          if (credentialCheck) {
            const [, keyVariable, nonce, expected, mismatchMarker] = credentialCheck;
            const key = terminalEnv?.[keyVariable];
            const actual = key ? createHmac("sha256", String(key)).update(nonce).digest("hex") : "";
            if (actual !== expected) {
              scrollback.set(body?.terminalId, `${previous}${injected}\r\n${mismatchMarker}\r\n`);
              return send(null);
            }
          }
          const sentinel = sentinelOf(injected);
          scrollback.set(body?.terminalId, sentinel ? `${previous}${injected}\r\n${sentinel}\r\n` : previous + injected);
          return send(null);
        }
        if (route === "GET /terminal/buffer") {
          return send(scrollback.get(url.searchParams.get("terminalId")) ?? "");
        }
        if (route === "POST /terminal/close") return send(null);
        if (route === "POST /agent/sessions") return send({ sessionId });
        if (
          route === "POST /agent/rename-session" ||
          route === "POST /agent/session-config-option" ||
          route === "POST /agent/send-prompt"
        ) {
          return send(null);
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: `unexpected ${route}` }));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error.message }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  return {
    apiBase: `http://127.0.0.1:${port}`,
    calls,
    inputs,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Undici keeps sockets alive; destroy them so close() resolves.
        server.closeAllConnections?.();
      }),
  };
}
