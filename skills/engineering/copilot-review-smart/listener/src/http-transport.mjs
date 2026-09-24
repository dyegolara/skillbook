import { HOOK_PATH, MAX_BODY_BYTES, iso, verifySignature } from "./signature.mjs";

/** HTTP transport for the Listener: `GET /healthz` and the signed webhook
 * endpoint. Pure transport: it never decides anything, it forwards verified
 * Deliveries to `ingest()` and reports liveness through `health()`. */
export function createHttpTransport({
  secret,
  ingest,
  health,
  logger = () => {},
  now = () => Date.now(),
  recordRejectedDelivery = () => {},
} = {}) {
function handleRequest(req, res) {
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/healthz/")) {
    const body = JSON.stringify(health());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
    return;
  }
  if (req.method === "POST" && (req.url === HOOK_PATH || req.url === `${HOOK_PATH}/`)) {
    let chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "body too large" }));
        return;
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const event = String(req.headers["x-github-event"] || "");
      const deliveryId = String(req.headers["x-github-delivery"] || "");
      const signature = req.headers["x-hub-signature-256"] || "";
      if (!verifySignature(rawBody, signature, secret)) {
        logger({ event: "delivery_rejected", delivery_id: deliveryId, reason: "bad signature" });
        recordRejectedDelivery({ event, at: iso(now()), delivery_id: deliveryId, accepted: false, reason: "bad signature" });
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad signature" }));
        return;
      }
      let payload = null;
      if (rawBody) {
        try {
          payload = JSON.parse(rawBody);
        } catch {
          logger({ event: "delivery_rejected", delivery_id: deliveryId, reason: "malformed JSON" });
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "malformed JSON body" }));
          return;
        }
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      setImmediate(() => {
        try {
          ingest({ event, deliveryId, payload, rawBody, signature, verify: false });
        } catch (e) {
          logger({ event: "delivery_failed", delivery_id: deliveryId, error: String(e?.message || e) });
        }
      });
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}


  return { handleRequest };
}
