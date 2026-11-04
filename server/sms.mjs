import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db, get, put, decrypt, audit, now } from "./store.mjs";
export function registerSMS(app, base) {
  app.post(
    "/api/sms/:connectorId/inbound",
    express.urlencoded({ extended: false, limit: "16kb" }),
    (req, res) => {
      const c = get(req.params.connectorId);
      if (!c || c.provider !== "twilio" || c.status !== "connected")
        return res.sendStatus(404);
      const creds = decrypt(c.secret);
      const url = base + req.originalUrl;
      const data =
        url +
        Object.keys(req.body)
          .sort()
          .map((k) => k + req.body[k])
          .join("");
      const expected = createHmac("sha1", creds.auth_token)
        .update(data)
        .digest("base64");
      const supplied = String(req.headers["x-twilio-signature"] || "");
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
      )
        return res.sendStatus(403);
      const body = String(req.body.Body || "")
        .trim()
        .toUpperCase();
      if (
        ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(
          body,
        ) ||
        req.body.OptOutType === "STOP"
      ) {
        put(c.space_id, "optout", {
          phone: req.body.From,
          source: "twilio",
          at: now(),
        });
        audit(c.space_id, "twilio", "sms.opted_out", {
          phone_suffix: String(req.body.From).slice(-4),
        });
      }
      res
        .type("text/xml")
        .send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    },
  );
}
