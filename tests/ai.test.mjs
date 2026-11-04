import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.NODE_ENV = "test";
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "snapoto-ai-"));
const { parseModelJSON, modelJSON, META_BASE_URL, META_MODEL } =
  await import("../server/ai.mjs");

test("model JSON parsing tolerates fences and prose", () => {
  assert.deepEqual(parseModelJSON('{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJSON('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseModelJSON('Sure: {"a":3} done'), { a: 3 });
  assert.deepEqual(parseModelJSON([{ type: "text", text: '{"a":4}' }]), { a: 4 });
  assert.throws(() => parseModelJSON("no json here"), /non-JSON/);
});

test("defaults to Meta Model API and retries without response_format", async () => {
  process.env.AI_API_KEY = "test-key";
  delete process.env.AI_BASE_URL;
  delete process.env.AI_MODEL;
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (body.response_format) return new Response("{}", { status: 400 });
    return Response.json({
      model: body.model,
      choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
    });
  };
  try {
    const r = await modelJSON("sys", "hi");
    assert.deepEqual(r.output, { ok: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, META_BASE_URL + "/chat/completions");
    assert.equal(calls[1].body.model, META_MODEL);
    assert.equal(calls[1].body.response_format, undefined);
  } finally {
    globalThis.fetch = real;
    delete process.env.AI_API_KEY;
  }
});
