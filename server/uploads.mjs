import express from "express";
import { z } from "zod";
import {
  existsSync,
  statSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { root, id, now, list, put, get, hash, db } from "./store.mjs";
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
export function registerUploads(api, writer, record, completeCapture) {
  api.post("/uploads", (req, res) => {
    writer(req);
    const settings = JSON.parse(
      db.prepare("SELECT settings FROM spaces WHERE id=?").get(req.space)
        .settings,
    );
    if (!settings.cloud_enabled) fail(403, "Cloud storage consent required");
    const body = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9-]{16,80}$/),
        captured_at_device: z.iso.datetime(),
        assets: z
          .array(
            z.object({
              kind: z.enum(["original", "selfie", "video", "audio"]),
              mime: z.enum([
                "image/jpeg",
                "image/png",
                "video/mp4",
                "audio/mp4",
                "audio/webm",
              ]),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
              bytes: z
                .number()
                .int()
                .min(1)
                .max(24 * 1024 * 1024),
            }),
          )
          .min(1)
          .max(4),
      })
      .passthrough()
      .parse(req.body);
    if (body.assets.reduce((n, a) => n + a.bytes, 0) > 30 * 1024 * 1024)
      fail(413, "Capture exceeds 30 MB");
    const digest = hash(JSON.stringify(body));
    const previous = list(req.space, "upload").find(
      (u) =>
        u.capture.id === body.id &&
        u.created_by === req.uid &&
        u.expires > Date.now(),
    );
    if (previous) {
      if (previous.digest !== digest) fail(409, "Upload metadata conflict");
      return res.json(status(previous));
    }
    if (
      list(req.space, "upload").filter(
        (u) => u.expires > Date.now() && !u.completed,
      ).length >= 50
    )
      fail(429, "Too many pending uploads");
    const u = put(req.space, "upload", {
      created_by: req.uid,
      capture: body,
      digest,
      expires: Date.now() + 86400000,
      completed: false,
    });
    res.status(201).json(status(u));
  });
  function status(u) {
    return {
      id: u.id,
      completed: u.completed,
      offsets: u.capture.assets.map((a, i) => {
        const file = path.join(root, "assets", u.id + "-" + i + ".part");
        return existsSync(file) ? statSync(file).size : 0;
      }),
    };
  }
  function owned(req) {
    const u = record(req, req.params.upload, "upload");
    if (u.created_by !== req.uid) fail(403, "Upload belongs to another user");
    if (u.expires < Date.now()) fail(410, "Upload expired");
    return u;
  }
  api.get("/uploads/:upload", (req, res) => res.json(status(owned(req))));
  api.put(
    "/uploads/:upload/:part",
    express.raw({ type: "application/octet-stream", limit: "1mb" }),
    (req, res) => {
      writer(req);
      const u = owned(req);
      if (u.completed) fail(409, "Upload already completed");
      const part = Number(req.params.part),
        offset = Number(req.headers["x-offset"]);
      if (
        !Number.isInteger(part) ||
        part < 0 ||
        !u.capture.assets[part] ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Buffer.isBuffer(req.body)
      )
        fail(400, "Invalid upload chunk");
      const file = path.join(root, "assets", u.id + "-" + part + ".part"),
        length = existsSync(file) ? statSync(file).size : 0;
      if (offset < length) {
        const existing = readFileSync(file).subarray(
          offset,
          offset + req.body.length,
        );
        if (existing.equals(req.body)) return res.json({ offset: length });
        fail(409, "Chunk conflicts with stored bytes");
      }
      if (offset !== length) fail(409, "Resume from stored offset " + length);
      if (length + req.body.length > u.capture.assets[part].bytes)
        fail(413, "Chunk exceeds declared asset size");
      const fd = openSync(file, "a", 0o600);
      try {
        writeSync(fd, req.body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      res.json({ offset: length + req.body.length });
    },
  );
  api.post("/uploads/:upload/complete", async (req, res) => {
    writer(req);
    const u = owned(req);
    if (u.completed) {
      const c = get(u.capture.id);
      if (c && c.space_id === req.space) return res.json(c);
      fail(410, "Capture is no longer available");
    }
    const assets = u.capture.assets.map((a, i) => {
      const file = path.join(root, "assets", u.id + "-" + i + ".part");
      if (!existsSync(file) || statSync(file).size !== a.bytes)
        fail(409, "Upload incomplete");
      return { ...a, data: readFileSync(file).toString("base64") };
    });
    req.body = { ...u.capture, assets };
    await completeCapture(req, res);
    if (get(u.capture.id)) {
      put(req.space, "upload", { ...u, completed: true }, u.id);
      for (let i = 0; i < assets.length; i++) {
        const file = path.join(root, "assets", u.id + "-" + i + ".part");
        if (existsSync(file)) unlinkSync(file);
      }
    }
  });
}
