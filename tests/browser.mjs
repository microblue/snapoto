import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import sharp from "sharp";
const base = process.env.BASE_URL || "http://localhost:4310";
const qa = process.env.QA_DIR || "docs/qa";
// Hackathon screenshots (desktop 1440 / mobile 390) go here when set.
const shots = process.env.SHOTS_DIR || "";
if (shots) mkdirSync(shots, { recursive: true });
// Phone shots are viewport-only so the fixed bottom tab bar sits where a phone shows it.
const shot = async (p, name, full = true) => {
  if (!shots) return;
  const phone = p.viewportSize().width < 500;
  await p.screenshot({ path: `${shots}/${name}.png`, fullPage: full && !phone });
};
const openDetail = async () => {
  await page.locator(".photo[data-photo]").first().click();
  await page.getByRole("dialog", { name: "Photo record" }).waitFor();
  await page.locator("#ai-box").waitFor();
  // With AI on, let the analysis finish (reopen after the in-dialog polling stops).
  for (let i = 0; i < 6; i++) {
    if (!(await page.locator("#ai-box").innerText()).includes("is looking")) break;
    await page.waitForTimeout(10000);
    await page.locator(".close").click();
    await page.locator(".photo[data-photo]").first().click();
    await page.locator("#ai-box").waitFor();
  }
  await page.locator(".modalback").evaluate((el) => el.scrollTo(0, 0));
  await page.locator(".modal").evaluate((el) => el.scrollTo(0, 0));
};
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", async (r) => {
  if (r.status() >= 400 && r.url().includes("/api/") && !r.url().endsWith("/me"))
    console.error(r.status(), new URL(r.url()).pathname, await r.text());
});
const nav = (name) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true });
const settled = async (p = page) => {
  await p.locator("#toast").waitFor({ state: "hidden" });
};
await page.goto(base);
await page.getByRole("button", { name: "New to Snapoto? Create an account" }).click();
await page.locator("#name").fill("Snapoto QA");
await page.locator("#email").fill(`qa-${Date.now()}@example.com`);
await page.locator("#password").fill("Snapoto-QA-password-2026");
await page.getByRole("button", { name: "Create account", exact: true }).click();
await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
await page.getByText("Get set up in 4 steps").waitFor();

// Settings › General: company + cloud consent.
await nav("Settings").click();
await page.locator("#company").fill("Snapoto QA Team");
await page.locator("#cloud").check();
await page.getByRole("button", { name: "Save settings", exact: true }).click();
await page.getByRole("status").filter({ hasText: "Settings saved" }).waitFor();

// Settings › Watermarks: AI wizard (degrades without AI) + manual template.
await page.getByRole("tab", { name: "Watermarks", exact: true }).click();
await page.getByRole("button", { name: "Create template", exact: true }).first().click();
await page.locator("#job-desc").fill("HVAC installs, need unit serial and customer name");
await page.getByRole("button", { name: "Suggest", exact: true }).click();
await page.locator("#suggest-note").filter({ hasNotText: "Thinking…" }).filter({ hasText: /\S/ }).waitFor();
await page.locator("input[name=name]").fill("Field record");
await page.getByRole("button", { name: "Save template", exact: true }).click();
await page.getByRole("heading", { name: "Field record", exact: true }).waitFor();

// Photos: upload.
await nav("Photos").click();
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
  (r) => r.url().endsWith("/captures") && r.request().method() === "POST" && r.status() === 201,
);
await page
  .locator("#upload")
  .setInputFiles({ name: "record.jpg", mimeType: "image/jpeg", buffer: bytes });
await page.getByRole("status").filter({ hasText: "Saved on this device" }).waitFor();
await uploaded;

// Photo detail: verify, render, one-tap share.
await page.locator(".photo[data-photo]").first().click();
await page.getByRole("dialog", { name: "Photo record" }).waitFor();
await page.locator("#ai-box").waitFor();
await page.locator("#order").fill("QA-1001");
await page.locator("#confirmed").check();
const saved = page.waitForResponse(
  (r) => r.url().includes("/captures/") && r.request().method() === "PATCH",
);
await page.getByRole("button", { name: "Save verification", exact: true }).click();
await saved;
await page.getByRole("button", { name: "Create watermarked image", exact: true }).click();
await page.getByRole("link", { name: "Download rendered", exact: true }).waitFor();
await page.getByRole("button", { name: "Watermarked", exact: true }).waitFor();
await page.getByRole("button", { name: "Original", exact: true }).click();
await page.getByRole("button", { name: "Watermarked", exact: true }).click();
await page.getByRole("button", { name: "Share link", exact: true }).click();
await page.locator("#quick-share-result a").waitFor();
const link = await page.locator("#quick-share-result a").getAttribute("href");
// Advanced link options still work.
await page.getByText("Link options").click();
await page.getByRole("button", { name: "Create private link", exact: true }).click();
await page.locator("#share-result a").waitFor();
await settled();
await page.screenshot({ path: `${qa}/photo-detail.png`, fullPage: false });

// Customer page.
const pubDesktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await pubDesktop.goto(link);
await pubDesktop.getByRole("heading", { name: "A photo from the field." }).waitFor();
await pubDesktop.getByRole("heading", { name: "Verified ✓" }).waitFor();
await shot(pubDesktop, "customer-desktop");
await pubDesktop.close();
const publicPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
await publicPage.goto(link);
await publicPage.getByRole("heading", { name: "A photo from the field." }).waitFor();
await shot(publicPage, "customer-mobile");
await publicPage.locator("#ack-name").fill("QA recipient");
await publicPage.getByRole("button", { name: "Confirm received" }).click();
await publicPage.getByRole("heading", { name: "Response recorded" }).waitFor();
await publicPage.screenshot({ path: `${qa}/customer-mobile.png`, fullPage: true });
await shot(publicPage, "customer-mobile-confirmed");

// Search + batch actions.
await page.locator(".close").click();
const search = async (q) => {
  await page.locator("#search").fill(q);
  await page.getByRole("button", { name: "Search", exact: true }).click();
};
await search("order:QA-1001");
await page.locator(".photo[data-photo]").first().waitFor();
await search("order:NOPE-9");
await page.getByText("No photos match").waitFor();
await search("");
await page.locator(".photo[data-photo]").first().waitFor();
// On a slow link, let the list settle so a late redraw can't drop the tick.
const pickOne = async () => {
  await page.waitForLoadState("networkidle");
  await page.locator("[data-pick]").first().check();
  await page.locator("#batchbar").filter({ hasText: /^\s*1 selected/ }).waitFor();
};
await pickOne();
await page.getByRole("button", { name: "Reopen checked" }).click();
await page.getByRole("status").filter({ hasText: "Updated 1 records" }).waitFor();
await pickOne();
await page.getByRole("button", { name: "Confirm checked orders" }).click();
await page.getByRole("status").filter({ hasText: "Updated 1 records" }).waitFor();
await page.getByRole("button", { name: "CSV records" }).click();
await page.locator("#export-tasks").filter({ hasText: "Saved to your device" }).waitFor();
await page.getByRole("button", { name: "Needs you", exact: true }).click();
await page.getByRole("button", { name: "All", exact: true }).click();
await page.locator(".photo[data-photo]").first().waitFor();
await openDetail();
await shot(page, "photo-detail-desktop", false);
await page.locator(".close").click();
if (await page.getByRole("button", { name: "Clear", exact: true }).isVisible())
  await page.getByRole("button", { name: "Clear", exact: true }).click();
await page.getByRole("button", { name: "All", exact: true }).click();
await page.locator(".photo[data-photo]").first().waitFor();
await settled();
await shot(page, "photos-desktop");
await page.setViewportSize({ width: 390, height: 844 });
await shot(page, "photos-mobile");
await openDetail();
await shot(page, "photo-detail-mobile", false);
await page.locator(".close").click();
await page.setViewportSize({ width: 1440, height: 1000 });

// Today.
await nav("Today").click();
await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
await page.getByText("Photos today").waitFor();
await page.locator("#report").waitFor();
const gen = page.getByRole("button", { name: /Write today’s report|Regenerate/ });
await gen.click();
await page
  .locator("#report")
  .filter({ hasText: /Highlights|isn’t available|AI|report/ })
  .waitFor();
await page.locator("#report button:not([disabled])").first().waitFor({ timeout: 90000 });
await settled();
await page.screenshot({ path: `${qa}/overview-desktop.png`, fullPage: true });
await shot(page, "today-desktop");
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: `${qa}/overview-mobile.png`, fullPage: true });
await shot(page, "today-mobile");
await page.setViewportSize({ width: 1440, height: 1000 });

// Automations.
await nav("Automations").click();
await page.getByRole("button", { name: "New automation", exact: true }).first().click();
await page.locator("#rule-name").fill("QA customer follow-up");
await page
  .locator("#rule-text")
  .fill("Read the order number and send the customer an email using Sheets. Ask me to confirm.");
await page.getByRole("button", { name: "Preview workflow", exact: true }).click();
await page.getByRole("button", { name: "Save draft", exact: true }).click({ timeout: 90000 });
await page.getByRole("heading", { name: "QA customer follow-up", exact: true }).waitFor();
await page.getByRole("button", { name: "Dry-run test", exact: true }).click();
await page.getByRole("button", { name: "Run test", exact: true }).click();
await page.locator("#test-result").filter({ hasText: "ready_for_review" }).waitFor();
await page.locator(".close").click();
await page.getByRole("button", { name: "Edit", exact: true }).click();
await page.locator("#rule-name").fill("QA customer follow-up revised");
await page.getByRole("button", { name: "Preview workflow", exact: true }).click();
await page.getByRole("button", { name: "Save draft", exact: true }).click({ timeout: 90000 });
await page
  .getByRole("heading", { name: "QA customer follow-up revised", exact: true })
  .waitFor();

// Settings › Advanced (developer) and Connections.
await nav("Settings").click();
await page.getByRole("tab", { name: "Connections", exact: true }).click();
await page.getByRole("heading", { name: "Active share links", exact: true }).waitFor();
await page.getByRole("tab", { name: "Advanced", exact: true }).click();
await page.getByRole("heading", { name: "API keys", exact: true }).waitFor();

// Team.
await nav("Team").click();
await page.locator("#team-name").fill("QA Field Team");
await page.getByRole("button", { name: "Create team", exact: true }).click();
await page
  .locator("#space")
  .getByText("QA Field Team", { exact: true })
  .waitFor({ state: "attached" });
await nav("Team").click();
await page.getByRole("button", { name: "Invite member", exact: true }).click();
await page.getByRole("button", { name: "Create invitation link", exact: true }).click();
await page.locator("#invite-result .linkbox").waitFor();
if (errors.length) throw new Error(errors.join("\n"));
console.log(
  "Browser E2E passed: registration, first-run checklist, consent, watermark wizard + template, upload, photo detail verify/render/original toggle/one-tap share/link options, customer Verified ✓ + confirm, order prefix search, chips, batch reopen/confirm, CSV export, Today + daily report card, rule create/edit/dry-run, connections, developer settings, team creation/invitation; no JS errors.",
);
await browser.close();
