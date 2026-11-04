// Records the hackathon demo against production (demo account seeded by seed-demo.mjs).
import { chromium } from "@playwright/test";
const OUT = process.argv[2];
const B = "https://snapoto.vercel.app";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const size = { width: 1280, height: 800 };
const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: OUT + "/desk", size } });
const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);
async function cap(text, ms = 3500) {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-cap");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-cap";
      el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:980px;background:rgba(15,23,42,.92);color:#fff;font:600 21px/1.4 system-ui,sans-serif;padding:14px 22px;border-radius:14px;z-index:99999;box-shadow:0 8px 30px rgba(0,0,0,.3);text-align:center;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.style.display = t ? "block" : "none";
  }, text);
  await wait(ms);
}
const nav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true });
await page.goto(B);
await page.locator("#email").fill("demo@snapoto.example.com");
await page.locator("#password").fill("SnapotoDemo-2026");
await cap("Snapoto — the AI work camera, built on Meta Muse Spark", 2500);
await page.getByRole("button", { name: "Sign in", exact: true }).click();
await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
const sel = page.locator("#space");
await sel.selectOption({ label: "Bayview Deliveries" }).catch(() => {});
await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
await wait(1500);
await cap("Maria runs a small delivery & service crew. Her team just takes photos with the Snapoto app.", 4000);
await cap("Every photo was already read by Muse Spark: what it shows, order numbers, meter readings, serials, problems.", 4500);
const gen = page.getByRole("button", { name: /Write today’s report|Regenerate/ });
await gen.scrollIntoViewIfNeeded();
await cap("One click — Muse Spark writes the daily report for the boss…", 1500);
await gen.click();
await page.locator("#report .report-headline").filter({ hasNotText: "Your day in one paragraph." }).waitFor({ timeout: 90000 }).catch(() => {});
await wait(800);
await page.locator("#report").scrollIntoViewIfNeeded();
await cap("…and every highlight links back to the photo it came from. Invented photo IDs are dropped.", 5000);
const confirm = page.locator("[data-accept]").first();
if (await confirm.count()) {
  await confirm.scrollIntoViewIfNeeded();
  await cap("AI read the order number off the label. It's only a suggestion — a person confirms with one tap.", 4500);
  await confirm.click();
  await wait(1500);
  await cap("AI never overwrites a confirmed number, never picks a recipient, never sends on its own.", 4000);
}
await cap("", 0);
await nav("Photos").click();
await page.locator(".photo[data-photo]").first().waitFor();
await wait(1000);
await cap("Photos: AI captions, tags and a clear upload status on every card.", 3500);
await cap("Ask in plain words — no filters to learn.", 1200);
await page.locator("#search").fill("damaged boxes at the dock");
await wait(900);
await page.locator("#search").press("Enter");
await page.locator(".interp").waitFor({ timeout: 60000 }).catch(() => {});
await wait(1500);
await cap("Muse Spark matches by meaning: “damaged” finds the box it described as crushed and torn.", 4000);
await cap("", 0);
const dmg = page.locator(".photo[data-photo]", { hasText: /damag/i }).first();
await (await dmg.count() ? dmg : page.locator(".photo[data-photo]").first()).click();
await page.getByRole("dialog", { name: "Photo record" }).waitFor();
await page.locator("#ai-box").waitFor();
await wait(1200);
await cap("Muse Spark flags what's worth checking: “box crushed and torn open”. The original file is kept untouched and hashed.", 5000);
const orig = page.getByRole("button", { name: "Original", exact: true });
if (await orig.count()) { await orig.click(); await wait(1500); await page.getByRole("button", { name: "Watermarked", exact: true }).click().catch(() => {}); }
await page.getByRole("button", { name: "Share link", exact: true }).click();
await page.locator("#quick-share-result a").waitFor();
const link = await page.locator("#quick-share-result a").getAttribute("href");
await cap("One tap: a private, verified link for the customer — no app to install.", 4000);
await page.locator(".close").click();
await cap("", 0);
await nav("Automations").click();
await page.getByRole("button", { name: "New automation", exact: true }).first().click();
await cap("Automations in plain words…", 0);
await page.locator("#rule-name").fill("Text customers their delivery proof");
await page.locator("#rule-text").pressSequentially("When a driver uploads a delivery photo, read the order number, find the customer in our Google Sheet and text them the verified link. If anything is unclear, ask me.", { delay: 12 });
await cap("Muse Spark turns that sentence into a checked plan: exact steps, who it may contact, what’s missing. Dry-run and your approval come before anything sends.", 0);
const compiled = page.waitForResponse((r) => r.url().includes("/compile"), { timeout: 90000 }).catch(() => {});
await page.getByRole("button", { name: "Preview workflow", exact: true }).click();
await compiled;
await wait(900);
await wait(6500);
await page.locator(".close").first().click({ timeout: 3000 }).catch(() => {});
await cap("", 0);
await nav("Settings").click();
await page.getByRole("tab", { name: "Watermarks", exact: true }).click();
await page.getByRole("button", { name: "Create template", exact: true }).first().click();
await cap("Watermarks: just describe the job…", 0);
await page.locator("#job-desc").pressSequentially("HVAC installs, need the unit serial and the technician", { delay: 30 });
await page.getByRole("button", { name: "Suggest", exact: true }).click();
await page.locator("#suggest-note").filter({ hasNotText: "Thinking…" }).filter({ hasText: /\S/ }).waitFor({ timeout: 90000 }).catch(() => {});
await wait(1000);
await cap("…AI proposes the fields, with a live preview. No industry presets, no Snapoto branding on your photos.", 5500);
await ctx.close();
// Customer page on a phone.
const mctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, isMobile: true, recordVideo: { dir: OUT + "/mobile", size: { width: 390, height: 800 } } });
const m = await mctx.newPage();
const mcap = async (t, ms) => { await m.evaluate((t) => { let el = document.getElementById("demo-cap"); if (!el) { el = document.createElement("div"); el.id = "demo-cap"; el.style.cssText = "position:fixed;left:12px;right:12px;bottom:16px;background:rgba(15,23,42,.92);color:#fff;font:600 16px/1.35 system-ui,sans-serif;padding:12px 14px;border-radius:12px;z-index:99999;text-align:center;pointer-events:none"; document.body.appendChild(el); } el.textContent = t; }, t); await m.waitForTimeout(ms); };
await m.goto(link);
await m.getByRole("heading", { name: "Verified ✓" }).waitFor().catch(() => {});
await m.evaluate(() => window.scrollTo(0, 0));
await m.waitForTimeout(800);
await mcap("The customer opens the link on their phone: photo, time, place, Verified ✓.", 4500);
await m.evaluate(() => window.scrollBy({ top: 420, behavior: "smooth" })); await m.waitForTimeout(2200);
await m.evaluate(() => window.scrollBy({ top: 520, behavior: "smooth" })); await m.waitForTimeout(1800);
const name = m.locator("#ack-name");
if (await name.count()) { await name.scrollIntoViewIfNeeded(); await name.pressSequentially("Jordan Kim", { delay: 50 }); await mcap("They confirm receipt or report a problem. Viewing is never counted as signing.", 3500); await m.getByRole("button", { name: "Confirm received" }).click(); await m.waitForTimeout(2500); }
await mctx.close();
await browser.close();
console.log("recorded");
