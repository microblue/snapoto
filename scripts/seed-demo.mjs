import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
const B = process.env.BASE || "https://snapoto.vercel.app";
const DIR = process.argv[2];
async function req(path, method = "GET", body, token) {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(method + " " + path + " " + r.status + " " + t.slice(0, 200));
  return j;
}
async function account(email, name, password) {
  try { return (await req("/api/auth/register", "POST", { email, name, password })).token; }
  catch { return (await req("/api/auth/login", "POST", { email, password })).token; }
}
const PW = "SnapotoDemo-2026";
const owner = await account("demo@snapoto.example.com", "Maria Lopez", PW);
const driver = await account("driver@snapoto.example.com", "Ana Ruiz", PW);
const me = await req("/api/me", "GET", null, owner);
let team = me.spaces.find((s) => s.name === "Bayview Deliveries");
const sid = team ? team.id : (await req("/api/spaces", "POST", { name: "Bayview Deliveries" }, owner)).id;
const S = (p) => `/api/spaces/${sid}${p}`;
await req(S("/settings"), "PATCH", { retention_days: 365, company: "Bayview Deliveries", phone: "(510) 555-0142", cloud_enabled: true, ai_auto: true }, owner);
const tpls = await req(S("/templates"), "GET", null, owner);
if (!tpls.length) await req(S("/templates"), "POST", { name: "Delivery proof", fields: ["date", "time", "address", "company", "employee", "order_number"], locked_fields: ["date", "time", "address"], position: "bottom-left", font_size: 28, opacity: 0.6, custom: "", is_default: true }, owner);
const dme = await req("/api/me", "GET", null, driver);
if (!dme.spaces.some((s) => s.id === sid)) {
  const inv = await req(S("/invites"), "POST", { role: "Member" }, owner);
  const token = inv.token || new URL(inv.url || inv.link).searchParams.get("invite");
  await req("/api/invites/accept", "POST", { token }, driver);
}
const shots = [
  ["1-doorstep.jpg", 37.8044, -122.2712, "1420 Oak St, Oakland, CA 94607", "Left at front door", 8, 15],
  ["2-dock.jpg", 37.7955, -122.2793, "Dock 4, 300 Embarcadero W, Oakland, CA", "Pallet staged", 9, 5],
  ["3-hvac.jpg", 37.8110, -122.2540, "88 Linda Ave, Piedmont, CA 94611", "Install complete", 10, 40],
  ["4-meter.jpg", 37.8200, -122.2650, "512 Fairmount Ave, Oakland, CA 94611", "Meter read", 11, 20],
  ["5-damage.jpg", 37.7955, -122.2793, "Dock 4, 300 Embarcadero W, Oakland, CA", "Box arrived like this", 13, 10],
  ["6-cleaning.jpg", 37.8049, -122.2711, "1 Kaiser Plaza, Oakland, CA 94612", "Kitchen done", 14, 30],
];
const day = new Date(); 
for (const [file, lat, lng, address, note, h, m] of shots) {
  const bytes = readFileSync(DIR + "/" + file);
  const t = new Date(day); t.setHours(h, m, 0, 0);
  if (t > new Date()) t.setTime(Date.now() - (15 - h) * 60000);
  const body = { id: randomUUID(), captured_at_device: t.toISOString(), gps: { latitude: lat, longitude: lng, accuracy: 6, age_ms: 2000 }, note, address, collection: "", assets: [{ kind: "original", mime: "image/jpeg", sha256: createHash("sha256").update(bytes).digest("hex"), data: bytes.toString("base64") }] };
  const c = await req(S("/captures"), "POST", body, driver);
  console.log("uploaded", file, c.id, c.ai?.state);
}
console.log("space", sid);
