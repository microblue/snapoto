import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import sharp from "sharp";

// Regression: uploads rejected with a non-retryable status (cloud consent
// off -> 403) must not be retried by the 30s background loop. Manual
// "Retry uploads" must still attempt them.
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let posts = 0;
page.on("response", (r) => {
  if (r.url().endsWith("/captures") && r.request().method() === "POST")
    posts += 1;
});
await page.goto(process.env.BASE_URL || "http://localhost:4310");
await page
  .getByRole("button", { name: "New to Snapoto? Create an account" })
  .click();
await page.locator("#name").fill("Blocked QA");
await page.locator("#email").fill(`blocked-${Date.now()}@example.com`);
await page.locator("#password").fill("Snapoto-QA-password-2026");
await page.getByRole("button", { name: "Create account", exact: true }).click();
await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
// NOTE: cloud consent deliberately left off -> upload POST returns 403.
await page.getByRole("button", { name: "Photos", exact: true }).click();
await page.getByRole("button", { name: "Use camera", exact: true }).click();
const bytes = await sharp({
  create: { width: 800, height: 600, channels: 3, background: "#829bad" },
})
  .jpeg()
  .toBuffer();
await page
  .locator("#upload")
  .setInputFiles({ name: "record.jpg", mimeType: "image/jpeg", buffer: bytes });
await page.waitForResponse(
  (r) =>
    r.url().endsWith("/captures") &&
    r.request().method() === "POST" &&
    r.status() === 403,
);
await page
  .locator("#local-status")
  .filter({ hasText: "Automatic retry paused" })
  .waitFor({ timeout: 10000 });
const afterFirst = posts;
assert.equal(afterFirst, 1);
// Longer than the 30s background interval: no automatic second attempt.
await page.waitForTimeout(33000);
assert.equal(
  posts,
  afterFirst,
  `background loop retried a blocked upload (${posts - afterFirst} extra POSTs)`,
);
// Manual retry must still attempt the queued record.
await page.getByRole("button", { name: "Retry uploads" }).click();
await page.waitForResponse(
  (r) => r.url().endsWith("/captures") && r.request().method() === "POST",
  { timeout: 10000 },
);
assert.ok(posts > afterFirst, "manual retry did not attempt the upload");
assert.deepEqual(errors, []);
await browser.close();
console.log("upload-blocked: pass");
