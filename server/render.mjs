import { persistAsset } from "./assets.mjs";
import { signManifest } from "./signing.mjs";
import QRCode from "qrcode";
import sharp from "sharp";
import path from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { root, db, id, hash, put, get } from "./store.mjs";
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const xml = (s) =>
  String(s).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
export async function renderCapture(c, t, link = "") {
  const a = c.assets.find((a) => a.kind === "original");
  if (!a) fail(400, "Still image required");
  const filename = path.join(root, "assets", a.id);
  if (!existsSync(filename)) fail(410, "Original unavailable");
  const bytes = await sharp(filename).rotate().toBuffer();
  const meta = await sharp(bytes).metadata();
  const settings = JSON.parse(
    db.prepare("SELECT settings FROM spaces WHERE id=?").get(c.space_id)
      .settings,
  );
  const user = db
    .prepare("SELECT name FROM users WHERE id=?")
    .get(c.created_by);
  const values = {
    date: c.captured_at_device.slice(0, 10),
    time: c.captured_at_device.slice(11, 19) + " (device)",
    timezone: "UTC",
    address: c.address || "Address not provided",
    gps: c.gps ? `${c.gps.latitude}, ${c.gps.longitude}` : "GPS not provided",
    accuracy: c.gps ? `±${c.gps.accuracy} m` : "Accuracy unknown",
    company: settings.company || "",
    phone: settings.phone || "",
    employee: user.name,
    order_number: c.order_number,
    note: c.note,
    custom: t.custom,
    verification: link || `Record ${c.id.slice(0, 12)}`,
  };
  const context = hash(
    JSON.stringify({
      link,
      values,
      template: t,
      order_confirmed: c.order_confirmed,
    }),
  );
  if (
    c.assets.some((a) => a.kind === "rendered" && a.render_context === context)
  )
    return c;
  const lines = t.fields
    .map((f) => values[f])
    .filter(Boolean)
    .flatMap((v) => String(v).match(/.{1,48}/g) || [])
    .slice(0, 16);
  const font = Math.min(
    t.font_size,
    meta.width / 22,
    meta.height / (lines.length * 1.5 + 2),
  );
  const width = Math.min(
      meta.width,
      Math.max(120, ...lines.map((s) => s.length * font * 0.6)) + 32,
    ),
    height = Math.min(meta.height, lines.length * font * 1.4 + 28);
  const svg = `<svg width="${Math.ceil(width)}" height="${Math.ceil(height)}"><rect width="100%" height="100%" fill="black" fill-opacity="${t.opacity}"/>${lines.map((s, i) => `<text x="16" y="${22 + (i + 0.6) * font * 1.4}" font-family="sans-serif" font-size="${font}" fill="white">${xml(s)}</text>`).join("")}</svg>`;
  const gravity = {
    "bottom-left": "southwest",
    "bottom-right": "southeast",
    "top-left": "northwest",
    "top-right": "northeast",
  }[t.position];
  const overlays = [{ input: Buffer.from(svg), gravity }];
  if (t.fields.includes("qr") && link) {
    const width = Math.max(
      1,
      Math.min(meta.height, meta.width, 180, Math.floor(meta.width / 4)),
    );
    overlays.push({
      input: await QRCode.toBuffer(link, { width, margin: 1 }),
      gravity: "southeast",
    });
  }
  if (t.fields.includes("logo") && t.logo_data) {
    const logoBytes = Buffer.from(t.logo_data, "base64");
    if (!(
      logoBytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
      logoBytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ))
      fail(400, "Logo must be a JPEG or PNG");
    const logo = await sharp(logoBytes, { limitInputPixels: 16000000 })
      .resize({
        width: Math.max(1, Math.floor(meta.width / 6)),
        height: Math.max(1, Math.floor(meta.height / 6)),
        fit: "inside",
      })
      .png()
      .toBuffer();
    overlays.push({ input: logo, gravity: "northwest" });
  }
  const selfie = c.assets.find((a) => a.kind === "selfie");
  if (selfie && existsSync(path.join(root, "assets", selfie.id))) {
    const thumb = await sharp(path.join(root, "assets", selfie.id))
      .rotate()
      .resize({
        width: Math.max(1, Math.floor(meta.width / 3)),
        height: Math.max(1, Math.floor(meta.height / 3)),
        fit: "inside",
      })
      .toBuffer();
    overlays.unshift({ input: thumb, gravity: "northeast" });
  }
  const output = await sharp(bytes)
    .composite(overlays)
    .jpeg({ quality: 92 })
    .toBuffer();
  const aid = id();
  persistAsset(aid, output);
  const rendered = {
    id: aid,
    kind: "rendered",
    sha256: hash(output),
    mime: "image/jpeg",
    bytes: output.length,
    template_id: t.id,
    template_version: t.version,
    template_snapshot: t,
    render_context: context,
  };
  const latest = get(c.id) || c;
  if (latest.deleted_at) {
    throw Object.assign(new Error("Original was deleted during rendering"), {
      status: 410,
    });
  }
  const assets = [...latest.assets, rendered];
  const manifest = JSON.stringify({
    capture_id: c.id,
    space_id: c.space_id,
    received: c.server_received_at,
    assets: assets.map((a) => ({ id: a.id, sha256: a.sha256 })),
  });
  const updated = put(
    c.space_id,
    "capture",
    { ...latest, assets, signed_manifest: signManifest(manifest) },
    c.id,
  );
  return updated;
}
