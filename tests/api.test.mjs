import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
process.env.NODE_ENV = "test";
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "snapoto-test-"));
const { app } = await import("../server/index.mjs");
const { hash, db, list, get, encrypt, decrypt } =
  await import("../server/store.mjs");
const { processJobs } = await import("../server/engine.mjs");
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(url, method = "GET", body, token) {
  const r = await fetch(base + url, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = r.headers.get("content-type") || "";
  return {
    status: r.status,
    data: type.includes("json")
      ? await r.json()
      : Buffer.from(await r.arrayBuffer()),
  };
}
async function account(name) {
  const r = await request("/api/auth/register", "POST", {
    email: name + "@example.com",
    name,
    password: "test-password-12345",
  });
  assert.equal(r.status, 201);
  const token = r.data.token;
  const me = await request("/api/me", "GET", null, token);
  return { token, space: me.data.spaces[0].id, id: me.data.id };
}
const owner = await account("owner"),
  other = await account("other");
const teamSpace = await request(
  "/api/spaces",
  "POST",
  { name: "Test team" },
  owner.token,
);
owner.personal = owner.space;
owner.space = teamSpace.data.id;
const route = (p) => `/api/spaces/${owner.space}${p}`;
const own = (p, m, b) => request(route(p), m, b, owner.token);
const jpg = await sharp({
  create: { width: 800, height: 600, channels: 3, background: "#a4bcc5" },
})
  .jpeg()
  .toBuffer();
const payload = {
  id: "capture-test-00000001",
  captured_at_device: "2026-11-02T10:00:00.000Z",
  gps: { latitude: 37, longitude: -122, accuracy: 10, age_ms: 2000 },
  note: "Test original",
  assets: [
    {
      kind: "original",
      mime: "image/jpeg",
      data: jpg.toString("base64"),
      sha256: hash(jpg),
    },
  ],
};
let capture, template, share, rule;
test("secrets are authenticated-encrypted", () => {
  const value = { access_token: "secret-for-test" };
  const sealed = encrypt(value);
  assert.ok(!sealed.includes(value.access_token));
  assert.deepEqual(decrypt(sealed), value);
  assert.throws(() => decrypt(sealed.slice(0, -4) + "AAAA"));
});
test("authentication and space isolation", async () => {
  assert.equal((await request(route("/captures"))).status, 401);
  assert.equal(
    (await request(route("/captures"), "GET", null, other.token)).status,
    403,
  );
});
test("upload requires owner cloud consent", async () => {
  assert.equal((await own("/captures", "POST", payload)).status, 403);
  assert.equal(
    (
      await own("/settings", "PATCH", {
        retention_days: 90,
        cloud_enabled: true,
      })
    ).status,
    200,
  );
});
test("invalid hash never creates a capture", async () => {
  assert.equal(
    (
      await own("/captures", "POST", {
        ...payload,
        assets: [{ ...payload.assets[0], mime: "audio/mp4" }],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await own("/captures", "POST", {
        ...payload,
        assets: [{ ...payload.assets[0], sha256: "0".repeat(64) }],
      })
    ).status,
    422,
  );
  assert.equal((await own("/captures")).data.length, 0);
});
test("upload preserves original and verifies hash; repeated upload is idempotent", async () => {
  let r = await own("/captures", "POST", payload);
  assert.equal(r.status, 201);
  capture = r.data;
  assert.equal(capture.hash_check, "verified");
  assert.equal((await own("/captures", "POST", payload)).status, 200);
  assert.equal((await own("/captures")).data.length, 1);
  const bytes = await own(
    `/captures/${capture.id}/assets/${capture.assets[0].id}`,
  );
  assert.equal(hash(bytes.data), hash(jpg));
});
test("id collision cannot overwrite original", async () => {
  const bytes = await sharp(jpg).resize(200).toBuffer();
  const r = await own("/captures", "POST", {
    ...payload,
    assets: [
      {
        ...payload.assets[0],
        data: bytes.toString("base64"),
        sha256: hash(bytes),
      },
    ],
  });
  assert.equal(r.status, 409);
});
test("template locked fields enforced and render keeps original hash", async () => {
  const input = {
    name: "Site record",
    fields: ["date", "address"],
    locked_fields: ["date"],
    position: "bottom-left",
    font_size: 24,
    opacity: 0.6,
    is_default: true,
  };
  assert.equal(
    (await own("/templates", "POST", { ...input, fields: ["address"] })).status,
    400,
  );
  const r = await own("/templates", "POST", input);
  assert.equal(r.status, 201);
  template = r.data;
  const rendered = await own(`/captures/${capture.id}/render`, "POST", {
    template_id: template.id,
  });
  assert.equal(rendered.status, 200);
  assert.equal(rendered.data.assets[0].sha256, hash(jpg));
  assert.equal(rendered.data.assets[1].kind, "rendered");
  assert.notEqual(rendered.data.assets[1].sha256, hash(jpg));
});
test("share hides exact GPS, prohibits download, acknowledgment remains separate", async () => {
  const r = await own(`/captures/${capture.id}/shares`, "POST", {
    days: 1,
    download: false,
    acknowledge: true,
  });
  assert.equal(r.status, 200);
  share = r.data;
  const read = await request(`/api/public/${share.token}`);
  assert.equal(read.status, 200);
  assert.equal(read.data.capture.gps, undefined);
  assert.equal(list(owner.space, "ack").length, 0);
  const asset = read.data.capture.assets[0];
  assert.equal(
    (await request(`/api/public/${share.token}/assets/${asset.id}?download=1`))
      .status,
    403,
  );
  const ack = await request(`/api/public/${share.token}/ack`, "POST", {
    name: "Recipient",
    status: "received",
    note: "Received",
  });
  assert.equal(ack.status, 201);
  assert.equal(ack.data.identity_check, "not_verified");
  assert.equal(list(owner.space, "ack").length, 1);
});
test("revoked and expired shares reject reads and acknowledgments", async () => {
  await own(`/shares/${share.id}`, "DELETE");
  assert.equal((await request(`/api/public/${share.token}`)).status, 410);
  assert.equal(
    (
      await request(`/api/public/${share.token}/ack`, "POST", {
        name: "Bad",
        status: "received",
      })
    ).status,
    410,
  );
});
test("rules require dry run and connector authorization; test never delivers", async () => {
  const r = await own("/rules", "POST", {
    name: "Customer delivery",
    text: "Read order and send email to customer from Sheets",
    channel: "email",
    daily_limit: 10,
  });
  rule = r.data;
  assert.equal(r.status, 201);
  assert.equal(
    (await own(`/rules/${rule.id}`, "PATCH", { enabled: true })).status,
    400,
  );
  const dry = await own(`/rules/${rule.id}/test`, "POST", {
    order_number: "1",
    customers: [
      { order: "1", email: "a@example.com" },
      { order: "1", email: "b@example.com" },
    ],
  });
  assert.equal(dry.data.state, "needs_review");
  assert.equal(dry.data.sent, false);
  assert.equal(db.prepare("SELECT count(*) n FROM deliveries").get().n, 0);
  assert.equal(
    (await own(`/rules/${rule.id}`, "PATCH", { enabled: true })).status,
    400,
  );
});
test("viewer cannot upload, modify templates or access connector credentials", async () => {
  const inv = await own("/invites", "POST", { role: "Viewer" });
  const token = new URL(inv.data.url).searchParams.get("invite");
  assert.equal(
    (await request("/api/invites/accept", "POST", { token }, other.token))
      .status,
    200,
  );
  assert.equal(
    (await request("/api/invites/accept", "POST", { token }, other.token))
      .status,
    410,
  );
  assert.equal(
    (await request(route("/captures"), "POST", payload, other.token)).status,
    403,
  );
  assert.equal(
    (await request(route("/templates"), "POST", {}, other.token)).status,
    403,
  );
  assert.equal(
    (await request(route("/connectors"), "GET", null, other.token)).status,
    403,
  );
  assert.equal(
    (
      await request(
        `/api/spaces/${other.space}/captures`,
        "GET",
        null,
        owner.token,
      )
    ).status,
    403,
  );
});
test("connector API never returns secrets and revoked connections block publishing", async () => {
  const c = await own("/connectors", "POST", {
    provider: "gmail",
    credentials: { access_token: "test-token" },
  });
  assert.equal(c.status, 201);
  assert.equal(c.data.secret, undefined);
  const cs = await own("/connectors");
  assert.equal(cs.data[0].secret, undefined);
  await own(`/connectors/${c.data.id}`, "DELETE");
  assert.equal(
    (await own(`/rules/${rule.id}`, "PATCH", { enabled: true })).status,
    400,
  );
});
after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});
test("automation matching and send outcomes never cause duplicate messages", async () => {
  await own("/connectors", "POST", {
    provider: "sheets",
    credentials: { access_token: "mock-only", spreadsheet_id: "mock-sheet" },
  });
  await own("/connectors", "POST", {
    provider: "gmail",
    credentials: { access_token: "mock-only" },
  });
  assert.equal(
    (await own(`/rules/${rule.id}`, "PATCH", { enabled: true })).status,
    200,
  );
  const next = { ...payload, id: "capture-automation-00001" };
  await own("/captures", "POST", next);
  await processJobs(base);
  let job = db.prepare("SELECT * FROM jobs WHERE capture_id=?").get(next.id);
  assert.equal(job.state, "needs_review");
  await own(`/captures/${next.id}`, "PATCH", {
    order_number: "A100",
    order_confirmed: true,
  });
  const realFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("sheets.googleapis.com"))
      return new Response(
        JSON.stringify({
          values: [
            ["Order", "Name", "Email", "Phone"],
            ["A100", "Customer", "customer@example.com", ""],
          ],
        }),
        { status: 200 },
      );
    if (String(url).includes("gmail.googleapis.com")) {
      sends++;
      return new Response(JSON.stringify({ id: "provider-message" }), {
        status: 200,
      });
    }
    throw new Error("Unmocked provider call forbidden");
  };
  try {
    await processJobs(base);
    await processJobs(base);
    job = db.prepare("SELECT * FROM jobs WHERE capture_id=?").get(next.id);
    assert.equal(job.state, "completed");
    assert.equal(sends, 1);
    db.prepare("UPDATE jobs SET state='queued' WHERE id=?").run(job.id);
    await processJobs(base);
    assert.equal(sends, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
test("ambiguous customer lookup never sends; provider uncertainty is not retried", async () => {
  const next = { ...payload, id: "capture-automation-00002" };
  await own("/captures", "POST", next);
  await own(`/captures/${next.id}`, "PATCH", {
    order_number: "B200",
    order_confirmed: true,
  });
  const realFetch = globalThis.fetch;
  let sends = 0,
    ambiguous = true;
  globalThis.fetch = async (url) => {
    if (String(url).includes("sheets.googleapis.com"))
      return new Response(
        JSON.stringify({
          values: [
            ["Order", "Name", "Email", "Phone"],
            ["B200", "One", "one@example.com", ""],
            ...(ambiguous ? [["B200", "Two", "two@example.com", ""]] : []),
          ],
        }),
        { status: 200 },
      );
    sends++;
    throw new Error("Connection lost after request sent");
  };
  try {
    await processJobs(base);
    let job = db.prepare("SELECT * FROM jobs WHERE capture_id=?").get(next.id);
    assert.equal(job.state, "needs_review");
    assert.equal(sends, 0);
    ambiguous = false;
    db.prepare("UPDATE jobs SET state='queued' WHERE id=?").run(job.id);
    await processJobs(base);
    assert.equal(sends, 1);
    db.prepare("UPDATE jobs SET state='queued' WHERE id=?").run(job.id);
    await processJobs(base);
    assert.equal(sends, 1);
    assert.equal(
      db
        .prepare("SELECT state FROM deliveries WHERE id=?")
        .get(job.id + "-send").state,
      "unknown",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
test("missing AI config reports explicit unavailability, never fake OCR", async () => {
  const r = await own(`/captures/${capture.id}/extract`, "POST");
  assert.equal(r.status, 503);
  assert.equal(get(capture.id).order_confirmed, false);
});
test("share snapshot excludes subsequently created watermark assets", async () => {
  const s = (
    await own(`/captures/${capture.id}/shares`, "POST", {
      days: 1,
      download: true,
      acknowledge: false,
    })
  ).data;
  const before = (await request(`/api/public/${s.token}`)).data.capture.assets
    .length;
  await own(`/captures/${capture.id}/render`, "POST", {
    template_id: template.id,
  });
  const after = (await request(`/api/public/${s.token}`)).data.capture.assets
    .length;
  assert.equal(after, before);
});

test("manifest signatures are independently verifiable and tamper evident", async () => {
  const { verifyManifest } = await import("../server/signing.mjs");
  const record = get(capture.id).signed_manifest;
  assert.equal(verifyManifest(record), true);
  assert.equal(
    verifyManifest({ ...record, manifest: record.manifest + " " }),
    false,
  );
});
test("signed API keys reject replays, bad signatures and revoked keys", async () => {
  const { createHmac, randomUUID } = await import("node:crypto");
  const key = (await own("/developer/keys", "POST", { name: "QA read client" }))
    .data;
  const timestamp = String(Date.now()),
    nonce = randomUUID(),
    url = "/api/v1/captures";
  const canonical = `GET\n${url}\n${timestamp}\n${nonce}\n${hash("")}`;
  const signature = createHmac("sha256", key.signing_secret)
    .update(canonical)
    .digest("hex");
  const headers = {
    Authorization: `Bearer ${key.token}`,
    "X-Snapoto-Timestamp": timestamp,
    "X-Snapoto-Nonce": nonce,
    "X-Snapoto-Signature": signature,
  };
  const first = await fetch(base + url, { headers });
  assert.equal(first.status, 200);
  assert.equal((await fetch(base + url, { headers })).status, 409);
  assert.equal(
    (
      await fetch(base + url, {
        headers: {
          ...headers,
          "X-Snapoto-Nonce": randomUUID(),
          "X-Snapoto-Signature": "0".repeat(64),
        },
      })
    ).status,
    401,
  );
  await own(`/developer/keys/${key.id}`, "DELETE");
  assert.equal((await fetch(base + url, { headers })).status, 401);
});
test("webhook private destinations and unconfigured OAuth are blocked", async () => {
  assert.equal(
    (
      await own("/developer/webhooks", "POST", {
        url: "http://127.0.0.1/admin",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await own("/developer/webhooks", "POST", {
        url: "https://unapproved.example.com/",
      })
    ).status,
    400,
  );
  assert.equal((await own("/oauth/gmail", "POST", {})).status, 503);
});
test("exports return actual PDF, ZIP and CSV files", async () => {
  assert.equal(
    (await own("/report.pdf")).data.subarray(0, 4).toString(),
    "%PDF",
  );
  const zip = await own("/export.zip");
  assert.equal(zip.status, 200);
  assert.equal(zip.data.subarray(0, 2).toString(), "PK");
  const csv = await own("/export.csv");
  assert.ok(csv.data.toString().startsWith("id,device_time"));
});
test("resumable upload persists offsets, rejects conflicting chunks and is idempotent", async () => {
  const input = {
    ...payload,
    id: "capture-resumable-0001",
    assets: [
      {
        kind: "original",
        mime: "image/jpeg",
        sha256: hash(jpg),
        bytes: jpg.length,
      },
    ],
  };
  const created = await own("/uploads", "POST", input);
  assert.equal(created.status, 201);
  const uid = created.data.id;
  const url = route(`/uploads/${uid}/0`);
  const split = Math.floor(jpg.length / 2);
  const chunk = (offset, bytes) =>
    fetch(base + url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/octet-stream",
        "X-Offset": String(offset),
      },
      body: bytes,
    });
  assert.equal((await chunk(0, jpg.subarray(0, split))).status, 200);
  assert.equal((await own(`/uploads/${uid}`)).data.offsets[0], split);
  assert.equal((await own(`/uploads/${uid}/complete`, "POST", {})).status, 409);
  assert.equal((await chunk(0, jpg.subarray(0, split))).status, 200);
  assert.equal((await chunk(0, Buffer.alloc(split))).status, 409);
  assert.equal((await chunk(split, jpg.subarray(split))).status, 200);
  assert.equal((await own(`/uploads/${uid}/complete`, "POST", {})).status, 201);
  assert.equal((await own(`/uploads/${uid}/complete`, "POST", {})).status, 200);
});
test("concurrent duplicate captures preserve the first original without extra records", async () => {
  const input = { ...payload, id: "capture-concurrent-001" };
  const results = await Promise.all([
    own("/captures", "POST", input),
    own("/captures", "POST", input),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.equal(results[0].data.assets[0].id, results[1].data.assets[0].id);
});
test("changing display metadata regenerates watermark without modifying earlier renders", async () => {
  const c = get("capture-concurrent-001");
  const before = c.assets.length;
  await own(`/captures/${c.id}`, "PATCH", { note: "Corrected display note" });
  const rendered = await own(`/captures/${c.id}/render`, "POST", {
    template_id: template.id,
  });
  assert.equal(rendered.status, 200);
  assert.equal(rendered.data.assets.length, before + 1);
  assert.equal(rendered.data.assets[0].sha256, hash(jpg));
});
test("email draft mode calls draft endpoint and never sends a message", async () => {
  const { send } = await import("../server/engine.mjs");
  const conn = list(owner.space, "connector").find(
    (c) => c.provider === "gmail" && c.status === "connected",
  );
  const realFetch = globalThis.fetch;
  let calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    const body = JSON.parse(options.body);
    assert.ok(body.message.raw);
    return new Response(JSON.stringify({ id: "draft-1" }), { status: 200 });
  };
  try {
    await send(
      conn,
      { email: "recipient@example.com" },
      "https://example.com/record",
      "draft-test",
      "draft",
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith("/drafts"));
  } finally {
    globalThis.fetch = realFetch;
  }
});
test("Twilio opt-out callbacks require a valid provider signature", async () => {
  const { createHmac } = await import("node:crypto");
  const conn = (
    await own("/connectors", "POST", {
      provider: "twilio",
      credentials: {
        account_sid: "ACtest",
        auth_token: "test-auth-token",
        from: "+15550001111",
      },
      sms_consent: true,
    })
  ).data;
  const endpoint = `/api/sms/${conn.id}/inbound`,
    body = { Body: "STOP", From: "+15551234567" };
  assert.equal(
    (
      await fetch(base + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      })
    ).status,
    403,
  );
  const canonical =
    "http://localhost:4310" +
    endpoint +
    Object.keys(body)
      .sort()
      .map((k) => k + body[k])
      .join("");
  const signature = createHmac("sha1", "test-auth-token")
    .update(canonical)
    .digest("base64");
  const response = await fetch(base + endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    body: new URLSearchParams(body),
  });
  assert.equal(response.status, 200);
  assert.ok(list(owner.space, "optout").some((o) => o.phone === body.From));
});

test("email-gated shares enforce access, one-use codes, throttling and revocation", async () => {
  const conn = await own("/connectors", "POST", {
    provider: "gmail",
    credentials: { access_token: "mock-otp-only" },
  });
  const created = await own("/captures/" + payload.id + "/shares", "POST", {
    days: 7,
    acknowledge: true,
    download: false,
    require_otp: true,
    recipient_email: "recipient@example.com",
    otp_connector_id: conn.data.id,
  });
  assert.equal(created.status, 200);
  const token = created.data.token;
  const url = "/api/public/" + token;
  const gate = await request(url);
  assert.equal(gate.data.access_required, true);
  assert.equal(gate.data.capture, undefined);
  const asset = get(payload.id).assets[0].id;
  assert.equal((await request(url + "/assets/" + asset)).status, 401);
  assert.equal(
    (
      await request(url + "/ack", "POST", {
        name: "Anonymous",
        status: "received",
      })
    ).status,
    401,
  );
  const realFetch = globalThis.fetch;
  let code,
    sends = 0;
  globalThis.fetch = async (target, options) => {
    if (String(target).startsWith(base)) return realFetch(target, options);
    assert.equal(
      String(target),
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    );
    sends++;
    const raw = Buffer.from(
      JSON.parse(options.body).raw,
      "base64url",
    ).toString();
    code = raw.match(/code is (\d{6})/)[1];
    return new Response(JSON.stringify({ id: "mock-otp" }), { status: 200 });
  };
  try {
    const challenge = await request(url + "/otp", "POST", {});
    assert.equal(challenge.status, 200);
    assert.equal((await request(url + "/otp", "POST", {})).status, 429);
    assert.equal(sends, 1);
    const body = { challenge_id: challenge.data.challenge_id, code: "000000" };
    assert.equal(
      (await request(url + "/otp/verify", "POST", body)).status,
      400,
    );
    body.code = code;
    const verify = await fetch(base + url + "/otp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(verify.status, 200);
    const cookie = verify.headers.get("set-cookie").split(";")[0];
    assert.match(verify.headers.get("set-cookie"), /HttpOnly/);
    assert.equal(
      (await request(url + "/otp/verify", "POST", body)).status,
      400,
    );
    const view = await fetch(base + url, { headers: { cookie } });
    assert.equal((await view.json()).identity_check, "email_verified");
    assert.equal(
      (await fetch(base + url + "/assets/" + asset, { headers: { cookie } }))
        .status,
      200,
    );
    const ack = await fetch(base + url + "/ack", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Recipient", status: "received" }),
    });
    assert.equal(ack.status, 201);
    const saved = list(owner.space, "ack").find(
      (a) => a.share_id === created.data.id,
    );
    assert.equal(saved.identity_check, "email_verified");
    assert.equal(saved.identity_email, "recipient@example.com");
    await own("/shares/" + created.data.id, "DELETE");
    assert.equal(
      (await fetch(base + url, { headers: { cookie } })).status,
      410,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
test("PNG originals retain their format in downloads and ZIP exports", async () => {
  const png = await sharp(jpg).png().toBuffer();
  const record = await own("/captures", "POST", {
    ...payload,
    id: "capture-png-export-00001",
    assets: [
      {
        kind: "original",
        mime: "image/png",
        sha256: hash(png),
        data: png.toString("base64"),
      },
    ],
  });
  assert.equal(record.status, 201);
  const share = await own("/captures/" + record.data.id + "/shares", "POST", {
    days: 1,
    download: true,
    acknowledge: false,
  });
  const download = await fetch(
    base +
      "/api/public/" +
      share.data.token +
      "/assets/" +
      record.data.assets[0].id +
      "?download=1",
  );
  assert.match(download.headers.get("content-disposition"), /\.png/);
  assert.equal(hash(Buffer.from(await download.arrayBuffer())), hash(png));
  const zip = await own("/export.zip");
  assert.ok(zip.data.includes(Buffer.from(record.data.assets[0].id + ".png")));
});
test("retention removes originals, retains verification history and reports unavailability", async () => {
  const { sweepRetention } = await import("../server/retention.mjs");
  const count = sweepRetention(Date.now() + 100 * 86400000);
  assert.ok(count >= 1);
  assert.equal(get(capture.id).hash_check, "original_unavailable");
  const login = await request("/api/auth/login", "POST", {
    email: "owner@example.com",
    password: "test-password-12345",
  });
  owner.token = login.data.token;
  assert.equal(
    (await own(`/captures/${capture.id}/assets/${capture.assets[0].id}`))
      .status,
    410,
  );
});
