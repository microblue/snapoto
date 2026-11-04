import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
process.env.NODE_ENV = "test";
process.env.PUBLIC_URL = "http://127.0.0.1:4327";
process.env.DATA_DIR = mkdtempSync(
  path.join(os.tmpdir(), "snapoto-browser-otp-"),
);
const { app } = await import("../server/index.mjs");
const { db, hash } = await import("../server/store.mjs");
const server = app.listen(4327, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + server.address().port;
const realFetch = globalThis.fetch;
let code,
  providerCalls = 0,
  browser;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith(base)) return realFetch(url, options);
  assert.equal(
    String(url),
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
  );
  providerCalls++;
  code = Buffer.from(JSON.parse(options.body).raw, "base64url")
    .toString()
    .match(/code is (\d{6})/)[1];
  return new Response(JSON.stringify({ id: "mock-only" }), { status: 200 });
};
try {
  let token;
  const api = async (url, body, method = "POST") => {
    const res = await fetch(base + url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(res.ok, await res.clone().text());
    return res.json();
  };
  token = (
    await api("/api/auth/register", {
      email: "otp-browser@example.com",
      name: "OTP QA",
      password: "test-browser-otp-password",
    })
  ).token;
  const space = (await api("/api/me", undefined, "GET")).spaces[0].id;
  const route = "/api/spaces/" + space;
  await api(
    route + "/settings",
    { cloud_enabled: true, retention_days: 30, company: "QA", phone: "" },
    "PATCH",
  );
  const bytes = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "#abc" },
  })
    .jpeg()
    .toBuffer();
  const capture = await api(route + "/captures", {
    id: "browser-otp-record-00001",
    captured_at_device: new Date().toISOString(),
    assets: [
      {
        kind: "original",
        mime: "image/jpeg",
        sha256: hash(bytes),
        data: bytes.toString("base64"),
      },
    ],
  });
  const conn = await api(route + "/connectors", {
    provider: "gmail",
    credentials: { access_token: "mock-only" },
  });
  const share = await api(route + "/captures/" + capture.id + "/shares", {
    days: 1,
    download: false,
    acknowledge: true,
    require_otp: true,
    recipient_email: "recipient@example.com",
    otp_connector_id: conn.id,
  });
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/s/" + share.token);
  await page.getByRole("heading", { name: "Verify your email" }).waitFor();
  assert.equal(await page.locator("img").count(), 0);
  await page.getByRole("button", { name: "Email verification code" }).click();
  await page.locator("#otp-code").waitFor({ state: "visible" });
  await page.locator("#otp-code").fill(code);
  await page.getByRole("button", { name: "Open record", exact: true }).click();
  await page
    .getByRole("heading", { name: "A photo from the field." })
    .waitFor();
  await page.reload();
  await page
    .getByRole("heading", { name: "A photo from the field." })
    .waitFor();
  await page.locator("#ack-name").fill("Email recipient");
  await page.getByRole("button", { name: "Confirm received" }).click();
  await page.getByRole("heading", { name: "Response recorded" }).waitFor();
  await page.screenshot({ path: "docs/qa/otp-mobile.png", fullPage: true });
  const acknowledgments = await api(
    route + "/acknowledgments",
    undefined,
    "GET",
  );
  assert.equal(acknowledgments[0].identity_check, "email_verified");
  assert.equal(providerCalls, 1);
  assert.deepEqual(errors, []);
  console.log(
    "OTP browser passed: gated preview, mock code delivery, verification cookie, reload, verified acknowledgment; zero real messages.",
  );
} finally {
  globalThis.fetch = realFetch;
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}
