import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
process.env.NODE_ENV = "test";
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "snapoto-p0-"));
const { app } = await import("../server/index.mjs");
const { hash, db, list, get } = await import("../server/store.mjs");
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const realFetch = globalThis.fetch;
async function request(url, method = "GET", body, token) {
  const r = await realFetch(base + url, {
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
  const me = await request("/api/me", "GET", null, r.data.token);
  return { token: r.data.token, space: me.data.spaces[0].id };
}
const owner = await account("p0owner");
const route = (p) => `/api/spaces/${owner.space}${p}`;
const own = (p, m, b) => request(route(p), m, b, owner.token);
const jpg = await sharp({
  create: { width: 800, height: 600, channels: 3, background: "#a4bcc5" },
})
  .jpeg()
  .toBuffer();
async function enableCloud() {
  const r = await own("/settings", "PATCH", {
    retention_days: 90,
    cloud_enabled: true,
  });
  assert.equal(r.status, 200);
}
function mkPayload(id, extra = {}) {
  return {
    id,
    captured_at_device: "2026-11-02T10:00:00.000Z",
    gps: { latitude: 37, longitude: -122, accuracy: 10, age_ms: 2000 },
    note: "P0 note",
    assets: [
      {
        kind: "original",
        mime: "image/jpeg",
        data: jpg.toString("base64"),
        sha256: hash(jpg),
      },
    ],
    ...extra,
  };
}
function aiMock(handler) {
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith(base)) return realFetch(url, options);
    return handler(String(url), options);
  };
}
after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.AI_API_KEY;
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test("extract on confirmed order writes OCR candidate without overwriting", async () => {
  await enableCloud();
  process.env.AI_API_KEY = "test-key";
  const up = await own("/captures", "POST", mkPayload("capture-p0-extract-01"));
  assert.equal(up.status, 201);
  assert.equal(
    (await own(`/captures/capture-p0-extract-01`, "PATCH", {
      order_number: "A100",
      order_confirmed: true,
    })).status,
    200,
  );
  aiMock(async (url) =>
    url.includes("/chat/completions")
      ? new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    order_numbers: ["B999"],
                    confidence: 0.9,
                    source_description: "top corner",
                  }),
                },
              },
            ],
            model: "mock",
            usage: {},
          }),
          { status: 200 },
        )
      : new Response("unexpected", { status: 500 }),
  );
  try {
    const r = await own("/captures/capture-p0-extract-01/extract", "POST");
    assert.equal(r.status, 200);
    assert.equal(r.data.order_number, "A100");
    assert.equal(r.data.order_confirmed, true);
    assert.deepEqual(r.data.ocr.output.order_numbers, ["B999"]);
    const un = await own("/captures", "POST", mkPayload("capture-p0-extract-02"));
    assert.equal(un.status, 201);
    const r2 = await own("/captures/capture-p0-extract-02/extract", "POST");
    assert.equal(r2.status, 200);
    assert.equal(r2.data.order_number, "B999");
    assert.equal(r2.data.order_confirmed, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("transcribe stores independent transcript and never rewrites note", async () => {
  process.env.AI_API_KEY = "test-key";
  const audio = Buffer.from("fake-audio-bytes-p0");
  const up = await own(
    "/captures",
    "POST",
    mkPayload("capture-p0-transcribe-01", {
      note: "Keep this note",
      assets: [
        {
          kind: "original",
          mime: "image/jpeg",
          data: jpg.toString("base64"),
          sha256: hash(jpg),
        },
        {
          kind: "audio",
          mime: "audio/mp4",
          data: audio.toString("base64"),
          sha256: hash(audio),
        },
      ],
    }),
  );
  assert.equal(up.status, 201);
  aiMock(async (url) =>
    url.includes("/audio/transcriptions")
      ? new Response(JSON.stringify({ text: "hello world" }), { status: 200 })
      : new Response("unexpected", { status: 500 }),
  );
  try {
    const r = await own("/captures/capture-p0-transcribe-01/transcribe", "POST");
    assert.equal(r.status, 200);
    assert.equal(r.data.transcript.text, "hello world");
    assert.equal(r.data.note, "Keep this note");
    assert.equal(get("capture-p0-transcribe-01").note, "Keep this note");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("PATCH and render enforce template_snapshot locked fields", async () => {
  const tpl = await own("/templates", "POST", {
    name: "Lock note",
    fields: ["date", "note"],
    locked_fields: ["note"],
    position: "bottom-left",
    font_size: 24,
    opacity: 0.6,
    is_default: true,
  });
  assert.equal(tpl.status, 201);
  const up = await own("/captures", "POST", mkPayload("capture-p0-lock-01"));
  assert.equal(up.status, 201);
  assert.equal(
    (await own("/captures/capture-p0-lock-01", "PATCH", { note: "changed" })).status,
    403,
  );
  assert.equal(
    (await own("/captures/capture-p0-lock-01", "PATCH", { address: "Road 1" })).status,
    200,
  );
  const orderTpl = await own("/templates", "POST", {
    name: "Lock order",
    fields: ["date", "order_number"],
    locked_fields: ["order_number"],
    position: "bottom-left",
    font_size: 24,
    opacity: 0.6,
  });
  assert.equal(orderTpl.status, 201);
  assert.equal(
    (
      await own("/captures/capture-p0-lock-01/render", "POST", {
        template_id: orderTpl.data.id,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await own("/captures/capture-p0-lock-01", "PATCH", {
        order_number: "L1",
        order_confirmed: true,
      })
    ).status,
    200,
  );
  const rendered = await own("/captures/capture-p0-lock-01/render", "POST", {
    template_id: orderTpl.data.id,
  });
  assert.equal(rendered.status, 200);
  assert.deepEqual(
    rendered.data.assets.find((a) => a.kind === "rendered").template_snapshot
      .locked_fields,
    ["order_number"],
  );
});

test("search degrades to exact retrieval when AI fails", async () => {
  process.env.AI_API_KEY = "test-key";
  const up = await own(
    "/captures",
    "POST",
    mkPayload("capture-p0-search-01", { note: "fallback-needle" }),
  );
  assert.equal(up.status, 201);
  aiMock(async () => {
    throw new Error("provider unreachable");
  });
  try {
    const r = await own("/search", "POST", { text: "fallback-needle" });
    assert.equal(r.status, 200);
    assert.equal(r.data.fallback, "ai_unavailable");
    assert.ok(r.data.captures.some((c) => c.id === "capture-p0-search-01"));
  } finally {
    globalThis.fetch = realFetch;
  }
  aiMock(async () => new Response("bad gateway", { status: 502 }));
  try {
    const r = await own("/search", "POST", { text: "fallback-needle" });
    assert.equal(r.status, 200);
    assert.equal(r.data.fallback, "ai_unavailable");
    assert.ok(r.data.captures.some((c) => c.id === "capture-p0-search-01"));
  } finally {
    globalThis.fetch = realFetch;
  }
  process.env.AI_DAILY_LIMIT = "0";
  try {
    const r = await own("/search", "POST", { text: "fallback-needle" });
    assert.equal(r.status, 200);
    assert.equal(r.data.fallback, "ai_unavailable");
  } finally {
    delete process.env.AI_DAILY_LIMIT;
    delete process.env.AI_API_KEY;
  }
});

test("confirmation flip discards stale rendered assets", async () => {
  const tpl = await own("/templates", "POST", {
    name: "Plain",
    fields: ["date", "order_number"],
    locked_fields: [],
    position: "bottom-left",
    font_size: 24,
    opacity: 0.6,
  });
  assert.equal(tpl.status, 201);
  const up = await own("/captures", "POST", mkPayload("capture-p0-flip-01"));
  assert.equal(up.status, 201);
  assert.equal(
    (
      await own("/captures/capture-p0-flip-01", "PATCH", {
        order_number: "X1",
        order_confirmed: true,
      })
    ).status,
    200,
  );
  const first = await own("/captures/capture-p0-flip-01/render", "POST", {
    template_id: tpl.data.id,
  });
  assert.equal(first.status, 200);
  const firstRendered = first.data.assets.find((a) => a.kind === "rendered");
  assert.ok(firstRendered);
  assert.equal(
    (await own("/captures/capture-p0-flip-01", "PATCH", { order_number: "X2" })).status,
    200,
  );
  const after = await own("/captures/capture-p0-flip-01");
  assert.equal(after.data.order_number, "X2");
  assert.equal(
    after.data.assets.filter((a) => a.kind === "rendered").length,
    0,
  );
  const second = await own("/captures/capture-p0-flip-01/render", "POST", {
    template_id: tpl.data.id,
  });
  assert.equal(second.status, 200);
  const secondRendered = second.data.assets.find((a) => a.kind === "rendered");
  assert.ok(secondRendered);
  assert.notEqual(secondRendered.id, firstRendered.id);
  assert.notEqual(
    secondRendered.render_context,
    firstRendered.render_context,
  );
  assert.equal(
    (await own("/captures/capture-p0-flip-01", "PATCH", { order_confirmed: false }))
      .status,
    200,
  );
  assert.equal(
    (await own("/captures/capture-p0-flip-01")).data.assets.filter(
      (a) => a.kind === "rendered",
    ).length,
    0,
  );
});

test("display-only correction keeps earlier renders", async () => {
  const tpl = list(owner.space, "template").find((t) => t.name === "Plain");
  const up = await own("/captures", "POST", mkPayload("capture-p0-flip-02"));
  assert.equal(up.status, 201);
  const first = await own("/captures/capture-p0-flip-02/render", "POST", {
    template_id: tpl.id,
  });
  assert.equal(first.status, 200);
  const before = first.data.assets.length;
  const patched = await own("/captures/capture-p0-flip-02", "PATCH", {
    note: "P0 note v2",
  });
  assert.equal(patched.status, 200);
  assert.equal(
    patched.data.assets.filter((a) => a.kind === "rendered").length,
    2,
  );
  const second = await own("/captures/capture-p0-flip-02/render", "POST", {
    template_id: tpl.id,
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.assets.length, before + 1);
});
