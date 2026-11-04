import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  db,
  id,
  hash,
  now,
  get,
  list,
  put,
  audit,
  encrypt,
  decrypt,
  root,
} from "./store.mjs";
import { credentials } from "./oauth.mjs";
import { providerFetch } from "./engine.mjs";
const fail = (s, m) => {
  throw Object.assign(new Error(m), { status: s });
};
export function registerExtensions(app, api, admin, record) {
  api.get("/developer", (req, res) => {
    admin(req);
    res.json({
      keys: list(req.space, "api_key").map(({ secret, token_hash, ...k }) => k),
      webhooks: list(req.space, "webhook").map(({ secret, ...w }) => w),
      events: list(req.space, "webhook_delivery").slice(0, 50),
    });
  });
  api.post("/developer/keys", (req, res) => {
    admin(req);
    const name = String(req.body.name || "").trim();
    if (!name || name.length > 100) fail(400, "Key name required");
    const token = id() + id(),
      signing = id() + id();
    const k = put(req.space, "api_key", {
      name,
      token_hash: hash(token),
      secret: encrypt(signing),
      scopes: ["captures:read"],
      revoked: false,
      expires: Date.now() + 90 * 86400000,
    });
    audit(req.space, req.uid, "api_key.created", { id: k.id });
    res.json({ id: k.id, token, signing_secret: signing, expires: k.expires });
  });
  api.delete("/developer/keys/:kid", (req, res) => {
    admin(req);
    const k = record(req, req.params.kid, "api_key");
    put(req.space, "api_key", { ...k, revoked: true, secret: null }, k.id);
    res.json({ ok: true });
  });
  api.post("/developer/webhooks", (req, res) => {
    admin(req);
    let url;
    try {
      url = new URL(req.body.url);
    } catch {
      fail(400, "Valid HTTPS URL required");
    }
    const allowed = (process.env.WEBHOOK_ALLOWED_HOSTS || "")
      .split(",")
      .filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !allowed.includes(url.hostname)
    )
      fail(
        400,
        "Webhook hostname must be explicitly approved in WEBHOOK_ALLOWED_HOSTS",
      );
    const secret = id() + id();
    const w = put(req.space, "webhook", {
      url: url.toString(),
      secret: encrypt(secret),
      enabled: true,
      since: now(),
    });
    audit(req.space, req.uid, "webhook.created", { id: w.id });
    res.json({ id: w.id, signing_secret: secret });
  });
  api.delete("/developer/webhooks/:wid", (req, res) => {
    admin(req);
    const w = record(req, req.params.wid, "webhook");
    put(req.space, "webhook", { ...w, enabled: false }, w.id);
    res.json({ ok: true });
  });
  function signed(req, res, next) {
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      if (!token) fail(401, "API key required");
      const k = db
        .prepare("SELECT body FROM records WHERE kind='api_key'")
        .all()
        .map((r) => JSON.parse(r.body))
        .find((k) => k.token_hash === hash(token));
      if (!k || k.revoked || k.expires < Date.now())
        fail(401, "API key expired or revoked");
      const timestamp = String(req.headers["x-snapoto-timestamp"] || ""),
        nonce = String(req.headers["x-snapoto-nonce"] || ""),
        signature = String(req.headers["x-snapoto-signature"] || "");
      if (
        !/^\d+$/.test(timestamp) ||
        Math.abs(Date.now() - Number(timestamp)) > 300000 ||
        !/^[a-zA-Z0-9-]{16,100}$/.test(nonce)
      )
        fail(401, "Timestamp or nonce invalid");
      const canonical = `${req.method}\n${req.originalUrl}\n${timestamp}\n${nonce}\n${hash(req.body ? JSON.stringify(req.body) : "")}`;
      const expected = createHmac("sha256", decrypt(k.secret))
        .update(canonical)
        .digest("hex");
      if (
        signature.length !== 64 ||
        !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
      )
        fail(401, "Signature mismatch");
      const nonceId = hash(k.id + nonce);
      if (get(nonceId)) fail(409, "Request replay rejected");
      put(k.space_id, "api_nonce", { expires: Date.now() + 600000 }, nonceId);
      req.apiSpace = k.space_id;
      next();
    } catch (e) {
      next(e);
    }
  }
  app.get("/api/v1/captures", signed, (req, res) =>
    res.json(
      list(req.apiSpace, "capture").map((c) => ({
        id: c.id,
        captured_at_device: c.captured_at_device,
        server_received_at: c.server_received_at,
        hash_check: c.hash_check,
        collection: c.collection,
        assets: c.assets.map((a) => ({ kind: a.kind, sha256: a.sha256 })),
      })),
    ),
  );
  app.post("/api/mcp", signed, (req, res) => {
    const { method, id: rid, params } = req.body;
    const answer = (result) => res.json({ jsonrpc: "2.0", id: rid, result });
    if (method === "initialize")
      return answer({
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "snapoto", version: "0.1.0" },
      });
    if (method === "notifications/initialized") return res.status(202).end();
    if (method === "tools/list")
      return answer({
        tools: [
          {
            name: "list_photo_records",
            description:
              "Read photo verification metadata from the authorized space. No sending actions.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      });
    if (method === "tools/call" && params?.name === "list_photo_records")
      return answer({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              list(req.apiSpace, "capture").map((c) => ({
                id: c.id,
                captured_at_device: c.captured_at_device,
                hash_check: c.hash_check,
              })),
            ),
          },
        ],
      });
    res.json({
      jsonrpc: "2.0",
      id: rid,
      error: { code: -32601, message: "Method not supported" },
    });
  });
  api.post("/captures/:cid/archive", async (req, res) => {
    admin(req);
    const c = record(req, req.params.cid, "capture");
    const conn = record(req, req.body.connector_id, "connector");
    if (
      !["drive", "onedrive"].includes(conn.provider) ||
      conn.status !== "connected"
    )
      fail(400, "Authorize a Drive or OneDrive connector");
    const creds = await credentials(conn);
    const results = [];
    for (const a of c.assets.filter((a) => a.kind === "original")) {
      const deliveryId = hash(conn.id + a.id);
      if (get(deliveryId)) {
        results.push(get(deliveryId));
        continue;
      }
      const file = path.join(root, "assets", a.id);
      if (!existsSync(file)) fail(410, "Original unavailable");
      const bytes = readFileSync(file);
      put(
        req.space,
        "archive",
        {
          asset_id: a.id,
          connector_id: conn.id,
          state: "pending_verification",
        },
        deliveryId,
      );
      let result;
      if (conn.provider === "drive") {
        const boundary = "snapoto-" + id();
        const body = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: c.captured_at_device.slice(0, 10) + "-" + c.id + ".jpg", appProperties: { snapotoAsset: a.id } })}\r\n--${boundary}\r\nContent-Type: ${a.mime}\r\n\r\n`,
          ),
          bytes,
          Buffer.from(`\r\n--${boundary}--`),
        ]);
        result = await providerFetch(
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${creds.access_token}`,
              "Content-Type": `multipart/related; boundary=${boundary}`,
            },
            body,
          },
        );
      } else {
        result = await providerFetch(
          `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${c.captured_at_device.slice(0, 10)}-${a.id}.jpg:/content`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${creds.access_token}`,
              "Content-Type": a.mime,
            },
            body: bytes,
          },
        );
      }
      results.push(
        put(
          req.space,
          "archive",
          { asset_id: a.id, connector_id: conn.id, result, state: "archived" },
          deliveryId,
        ),
      );
    }
    res.json(results);
  });
}
// PRD §12 event topics the server can observe. capture.local_saved happens
// on the device before upload, so the server cannot emit it truthfully.
export const webhookEvents = [
  "capture.cloud_verified",
  "capture.analyzed",
  "rule.started",
  "rule.needs_review",
  "notification.sent",
  "notification.failed",
  "share.acknowledged",
];
export async function dispatchWebhooks() {
  for (const row of db.prepare("SELECT * FROM spaces").all()) {
    const events = list(row.id, "audit").filter((a) =>
      webhookEvents.includes(a.event),
    );
    for (const hook of list(row.id, "webhook").filter((w) => w.enabled)) {
      for (const event of events.filter((e) => e.created_at >= hook.since)) {
        const did = hash(hook.id + event.id);
        let delivery = get(did);
        if (
          delivery?.state === "sent" ||
          delivery?.attempts >= 5 ||
          delivery?.next_at > Date.now()
        )
          continue;
        delivery = put(
          row.id,
          "webhook_delivery",
          {
            hook_id: hook.id,
            event_id: event.id,
            state: "sending",
            attempts: (delivery?.attempts || 0) + 1,
          },
          did,
        );
        const body = JSON.stringify({
            id: event.id,
            type: event.event,
            at: event.created_at,
            data: event.details,
          }),
          timestamp = String(Date.now());
        const signature = createHmac("sha256", decrypt(hook.secret))
          .update(timestamp + "." + body)
          .digest("hex");
        try {
          const response = await fetch(hook.url, {
            method: "POST",
            redirect: "error",
            headers: {
              "Content-Type": "application/json",
              "X-Snapoto-Event": event.id,
              "X-Snapoto-Timestamp": timestamp,
              "X-Snapoto-Signature": signature,
            },
            body,
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error("HTTP " + response.status);
          put(
            row.id,
            "webhook_delivery",
            { ...delivery, state: "sent", sent_at: now() },
            did,
          );
        } catch (e) {
          put(
            row.id,
            "webhook_delivery",
            {
              ...delivery,
              state: "retry",
              error: e.message,
              next_at: Date.now() + 2 ** delivery.attempts * 30000,
            },
            did,
          );
        }
      }
    }
  }
  db.prepare(
    "DELETE FROM records WHERE kind='api_nonce' AND json_extract(body,'$.expires') < ?",
  ).run(Date.now());
}
