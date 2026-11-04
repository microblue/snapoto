import { chromium } from "@playwright/test";
import sharp from "sharp";
const base = process.env.BASE_URL || "http://localhost:4310";
const qa = process.env.QA_DIR || "docs/qa";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", async (r) => {
  if (
    r.status() >= 400 &&
    r.url().includes("/api/") &&
    !r.url().endsWith("/me")
  )
    console.error(r.status(), new URL(r.url()).pathname, await r.text());
});
await page.goto(base);
await page
  .getByRole("button", { name: "New to Snapoto? Create an account" })
  .click();
await page.locator("#name").fill("Snapoto QA");
await page.locator("#email").fill(`qa-${Date.now()}@example.com`);
await page.locator("#password").fill("Snapoto-QA-password-2026");
await page.getByRole("button", { name: "Create account", exact: true }).click();
await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
await page.getByRole("button", { name: "Settings", exact: true }).click();
await page.locator("#company").fill("Snapoto QA Team");
await page.locator("#cloud").check();
await page.getByRole("button", { name: "Save settings", exact: true }).click();
await page.getByRole("button", { name: "Templates", exact: true }).click();
await page
  .getByRole("button", { name: "Create template", exact: true })
  .click();
await page.locator("input[name=name]").fill("Field record");
await page.getByRole("button", { name: "Save template", exact: true }).click();
await page
  .getByRole("heading", { name: "Field record", exact: true })
  .waitFor();
await page.getByRole("button", { name: "Camera", exact: true }).click();
const bytes = await sharp({
  create: { width: 1200, height: 900, channels: 3, background: "#829bad" },
})
  .composite([
    {
      input: Buffer.from(
        '<svg width="1200" height="900"><rect x="200" y="250" width="800" height="450" fill="#c8aa83"/><rect x="400" y="340" width="400" height="220" fill="white"/><text x="440" y="440" font-size="44">ORDER 1001</text></svg>',
      ),
    },
  ])
  .jpeg()
  .toBuffer();
const uploaded = page.waitForResponse(
  (r) =>
    r.url().endsWith("/captures") &&
    r.request().method() === "POST" &&
    r.status() === 201,
);
await page
  .locator("#upload")
  .setInputFiles({ name: "record.jpg", mimeType: "image/jpeg", buffer: bytes });
await page
  .getByRole("status")
  .filter({ hasText: "Saved on this device" })
  .waitFor();
await uploaded;
await page.getByRole("button", { name: "Photos", exact: true }).click();
await page.locator(".photo").first().click();
await page.locator('[data-goto="1"]').click();
await page.locator("#order").fill("QA-1001");
await page.locator("#confirmed").check();
const saved = page.waitForResponse(
  (r) => r.url().includes("/captures/") && r.request().method() === "PATCH",
);
await page
  .getByRole("button", { name: "Save verification", exact: true })
  .click();
await saved;
await page
  .getByRole("button", { name: "Create watermarked image", exact: true })
  .click();
await page
  .getByRole("link", { name: "Download rendered", exact: true })
  .waitFor();
await page.locator('[data-goto="2"]').click();
await page
  .getByRole("button", { name: "Create private link", exact: true })
  .click();
await page.locator("#share-result a").waitFor();
const link = await page.locator("#share-result a").getAttribute("href");
await page.screenshot({ path: `${qa}/photo-detail.png`, fullPage: true });
const publicPage = await browser.newPage({
  viewport: { width: 390, height: 844 },
});
await publicPage.goto(link);
await publicPage
  .getByRole("heading", { name: "A photo from the field." })
  .waitFor();
await publicPage.locator("#ack-name").fill("QA recipient");
await publicPage.getByRole("button", { name: "Confirm received" }).click();
await publicPage.getByRole("heading", { name: "Response recorded" }).waitFor();
await publicPage.screenshot({
  path: `${qa}/customer-mobile.png`,
  fullPage: true,
});
await page.locator(".close").click();
await page.locator("#search").fill("order:QA-1001");
await page.getByRole("button", { name: "Filter photos" }).click();
await page.locator(".photo").first().waitFor();
await page.locator("#search").fill("order:NOPE-9");
await page.getByRole("button", { name: "Filter photos" }).click();
await page.getByText("No photos here yet").waitFor();
await page.locator("#search").fill("");
await page.getByRole("button", { name: "Filter photos" }).click();
await page.locator(".photo").first().waitFor();
await page.locator("[data-pick]").first().check();
await page.getByRole("button", { name: "Reopen checked" }).click();
await page
  .getByRole("status")
  .filter({ hasText: "Updated 1 records" })
  .waitFor();
await page.locator("[data-pick]").first().check();
await page.getByRole("button", { name: "Confirm checked orders" }).click();
await page
  .getByRole("status")
  .filter({ hasText: "Updated 1 records" })
  .waitFor();
await page.getByRole("button", { name: "CSV records" }).click();
await page
  .locator("#export-tasks")
  .filter({ hasText: "Saved to your device" })
  .waitFor();
await page.getByRole("button", { name: "Overview", exact: true }).click();
await page.getByText("Every photo, accounted for.", { exact: true }).waitFor();
await page.locator("#toast").waitFor({ state: "hidden" });
await page.screenshot({ path: `${qa}/overview-desktop.png`, fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: `${qa}/overview-mobile.png`, fullPage: true });
await page.setViewportSize({ width: 1440, height: 1000 });
await page.getByRole("button", { name: "Automations", exact: true }).click();
await page.getByRole("button", { name: "New automation", exact: true }).click();
await page.locator("#rule-name").fill("QA customer follow-up");
await page
  .locator("#rule-text")
  .fill(
    "Read the order number and send the customer an email using Sheets. Ask me to confirm.",
  );
await page
  .getByRole("button", { name: "Preview workflow", exact: true })
  .click();
await page.getByRole("button", { name: "Save draft", exact: true }).click();
await page
  .getByRole("heading", { name: "QA customer follow-up", exact: true })
  .waitFor();
await page.getByRole("button", { name: "Dry-run test", exact: true }).click();
await page.getByRole("button", { name: "Run test", exact: true }).click();
await page
  .locator("#test-result")
  .filter({ hasText: "ready_for_review" })
  .waitFor();
await page.locator(".close").click();
await page.getByRole("button", { name: "Edit", exact: true }).click();
await page.locator("#rule-name").fill("QA customer follow-up revised");
await page
  .getByRole("button", { name: "Preview workflow", exact: true })
  .click();
await page.getByRole("button", { name: "Save draft", exact: true }).click();
await page
  .getByRole("heading", { name: "QA customer follow-up revised", exact: true })
  .waitFor();
await page.getByRole("button", { name: "Developer", exact: true }).click();
await page.getByRole("heading", { name: "API keys", exact: true }).waitFor();
await page.getByRole("button", { name: "Team", exact: true }).click();
await page.locator("#team-name").fill("QA Field Team");
await page.getByRole("button", { name: "Create team", exact: true }).click();
await page
  .locator("#space")
  .getByText("QA Field Team", { exact: true })
  .waitFor({ state: "attached" });
await page.getByRole("button", { name: "Invite member", exact: true }).click();
await page
  .getByRole("button", { name: "Create invitation link", exact: true })
  .click();
await page.locator("#invite-result .linkbox").waitFor();
if (errors.length) throw new Error(errors.join("\n"));
console.log(
  "Browser E2E passed: registration, consent, template, upload, stepped record verify/render/deliver, order prefix search, batch reopen/confirm, CSV export task, acknowledgment, rule create/edit/dry-run, developer settings, team creation/invitation; no JS errors.",
);
await browser.close();
