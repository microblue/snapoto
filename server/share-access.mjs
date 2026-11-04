import {
  randomInt,
  randomBytes,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { root, id, hash, now, get, put, list, audit } from "./store.mjs";
import { credentials } from "./oauth.mjs";
import { providerFetch } from "./engine.mjs";
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const digest = (challenge, code) =>
  createHmac("sha256", readFileSync(path.join(root, "key")))
    .update(challenge + ":" + code)
    .digest("hex");
const cookieName = (share) => "snapoto_share_" + share.id;
export function recipientHint(email) {
  const [local, domain] = email.split("@");
  return local.slice(0, 1) + "•••@" + domain;
}
export function shareIdentity(req, share) {
  if (!share.require_otp) return null;
  const name = cookieName(share) + "=";
  const token =
    req.headers["x-share-session"] ||
    req.headers.cookie
      ?.split("; ")
      .find((c) => c.startsWith(name))
      ?.slice(name.length);
  if (!token) return null;
  const session = get(hash("share-session:" + token));
  if (
    !session ||
    session.share_id !== share.id ||
    session.expires <= Date.now()
  )
    return null;
  return {
    email: share.recipient_email,
    verified_at: session.verified_at,
    method: "email_otp",
  };
}
export function requireShareAccess(req, share) {
  const identity = shareIdentity(req, share);
  if (share.require_otp && !identity)
    fail(401, "Verify the recipient email before accessing this record");
  return identity;
}
async function deliverCode(conn, email, code) {
  const c = await credentials(conn);
  const body = `Your Snapoto verification code is ${code}. It expires in 10 minutes. If you did not request this code, ignore this message.`;
  if (conn.provider === "gmail") {
    const raw = Buffer.from(
      `To: ${email}\r\nSubject: Snapoto verification code\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`,
    ).toString("base64url");
    return providerFetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw }),
      },
    );
  }
  if (conn.provider === "microsoft")
    return providerFetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: "Snapoto verification code",
          body: { contentType: "Text", content: body },
          toRecipients: [{ emailAddress: { address: email } }],
        },
        saveToSentItems: true,
      }),
    });
  fail(400, "Email verification connector is unavailable");
}
export function registerShareAccess(app, shared, baseUrl) {
  app.post("/api/public/:token/otp", async (req, res) => {
    const { s } = shared(req.params.token);
    if (!s.require_otp)
      fail(400, "This link does not require email verification");
    const attempts = list(s.space_id, "otp").filter(
      (r) => r.share_id === s.id && r.requested_at > Date.now() - 3600000,
    );
    if (
      attempts.length >= 5 ||
      attempts.some((r) => r.requested_at > Date.now() - 60000)
    )
      fail(429, "Wait before requesting another code");
    const conn = get(s.otp_connector_id);
    if (!conn || conn.space_id !== s.space_id || conn.status !== "connected")
      fail(503, "The sender needs to reconnect email verification");
    const cid = id(),
      code = String(randomInt(100000, 1000000));
    const challenge = put(
      s.space_id,
      "otp",
      {
        share_id: s.id,
        requested_at: Date.now(),
        expires: Date.now() + 600000,
        attempts: 0,
        state: "sending",
        code_digest: digest(cid, code),
      },
      cid,
    );
    for (const previous of attempts.filter((r) => r.state === "ready"))
      put(
        s.space_id,
        "otp",
        { ...previous, state: "superseded", code_digest: null },
        previous.id,
      );
    try {
      await deliverCode(conn, s.recipient_email, code);
      const current = shared(req.params.token).s;
      if (get(conn.id)?.status !== "connected" || current.revoked_at)
        fail(410, "Share or connector is no longer active");
      put(s.space_id, "otp", { ...challenge, state: "ready" }, cid);
      audit(s.space_id, "recipient", "share.code_requested", {
        share_id: s.id,
      });
      res.json({
        challenge_id: cid,
        expires_in: 600,
        recipient_hint: recipientHint(s.recipient_email),
      });
    } catch (e) {
      put(
        s.space_id,
        "otp",
        { ...challenge, state: "failed", code_digest: null },
        cid,
      );
      fail(
        502,
        "Code delivery could not be confirmed. Wait a minute before trying again.",
      );
    }
  });
  app.post("/api/public/:token/otp/verify", (req, res) => {
    const { s } = shared(req.params.token);
    if (!s.require_otp)
      fail(400, "This link does not require email verification");
    const b = z
      .object({
        challenge_id: z.string().regex(/^[a-f0-9]{32}$/),
        code: z.string().regex(/^\d{6}$/),
      })
      .parse(req.body);
    const challenge = get(b.challenge_id);
    if (
      !challenge ||
      challenge.share_id !== s.id ||
      challenge.state !== "ready" ||
      challenge.expires <= Date.now() ||
      challenge.attempts >= 5
    )
      fail(400, "Code expired or unavailable. Request a new code.");
    const updated = { ...challenge, attempts: challenge.attempts + 1 };
    put(s.space_id, "otp", updated, challenge.id);
    const expected = digest(challenge.id, b.code);
    if (
      !timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(challenge.code_digest),
      )
    )
      fail(400, "Code is incorrect");
    put(
      s.space_id,
      "otp",
      { ...updated, state: "used", code_digest: null },
      challenge.id,
    );
    const token = randomBytes(32).toString("base64url"),
      expires = Math.min(Date.now() + 1800000, Date.parse(s.expires_at));
    put(
      s.space_id,
      "share_session",
      { share_id: s.id, verified_at: now(), expires },
      hash("share-session:" + token),
    );
    res.cookie(cookieName(s), token, {
      httpOnly: true,
      sameSite: "strict",
      secure: baseUrl.startsWith("https:"),
      path: "/api/public/" + s.token,
      maxAge: expires - Date.now(),
    });
    audit(s.space_id, "recipient", "share.email_verified", { share_id: s.id });
    res.json({ verified: true, expires_at: new Date(expires).toISOString() });
  });
}
