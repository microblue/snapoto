import { unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { db, root, list, put, now, audit } from "./store.mjs";
export function sweepRetention(clock = Date.now()) {
  let count = 0;
  db.prepare("DELETE FROM sessions WHERE expires < ?").run(clock);
  for (const space of db.prepare("SELECT * FROM spaces").all()) {
    for (const u of list(space.id, "upload").filter((u) => u.expires < clock)) {
      for (let i = 0; i < u.capture.assets.length; i++) {
        const file = path.join(root, "assets", u.id + "-" + i + ".part");
        if (existsSync(file)) unlinkSync(file);
      }
      db.prepare("DELETE FROM records WHERE id=?").run(u.id);
    }
    for (const kind of ["otp", "share_session"])
      for (const item of list(space.id, kind).filter((r) => r.expires < clock))
        db.prepare("DELETE FROM records WHERE id=?").run(item.id);
    const days = JSON.parse(space.settings).retention_days;
    if (!days) continue;
    for (const cap of list(space.id, "capture")) {
      if (
        cap.deleted_at ||
        Date.parse(cap.server_received_at) + days * 86400000 > clock
      )
        continue;
      for (const a of cap.assets) {
        const f = path.join(root, "assets", a.id);
        if (existsSync(f)) unlinkSync(f);
      }
      put(
        space.id,
        "capture",
        {
          ...cap,
          cloud_state: "expired",
          deleted_at: now(),
          hash_check: "original_unavailable",
        },
        cap.id,
      );
      audit(space.id, "retention", "capture.expired", { capture_id: cap.id });
      count++;
    }
  }
  return count;
}
