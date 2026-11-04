import { randomBytes, createHash } from "node:crypto";
import { id, now, db, put, get, encrypt, decrypt, audit } from "./store.mjs";
const scopes = {
  gmail: "https://www.googleapis.com/auth/gmail.send",
  sheets: "https://www.googleapis.com/auth/spreadsheets.readonly",
  drive: "https://www.googleapis.com/auth/drive.file",
  microsoft: "offline_access https://graph.microsoft.com/Mail.Send",
  onedrive:
    "offline_access https://graph.microsoft.com/Files.ReadWrite.AppFolder",
};
function config(provider) {
  const ms = ["microsoft", "onedrive"].includes(provider);
  return {
    client_id: process.env[ms ? "MICROSOFT_CLIENT_ID" : "GOOGLE_CLIENT_ID"],
    client_secret:
      process.env[ms ? "MICROSOFT_CLIENT_SECRET" : "GOOGLE_CLIENT_SECRET"],
    authorize: ms
      ? "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
      : "https://accounts.google.com/o/oauth2/v2/auth",
    token: ms
      ? "https://login.microsoftonline.com/common/oauth2/v2.0/token"
      : "https://oauth2.googleapis.com/token",
  };
}
const error = (message, status = 400) =>
  Object.assign(new Error(message), { status });
async function exchange(provider, params) {
  const c = config(provider);
  const r = await fetch(c.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...params,
      client_id: c.client_id,
      client_secret: c.client_secret,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok)
    throw error("Authorization expired or failed. Reconnect this tool.", 401);
  return r.json();
}
export function authorize(provider, space, user, base, options) {
  if (!scopes[provider]) throw error("Unknown provider");
  const c = config(provider);
  if (!c.client_id || !c.client_secret)
    throw error("OAuth application is not configured on this server.", 503);
  const verifier = randomBytes(32).toString("base64url"),
    state = id() + id();
  const requestedScope =
    provider === "gmail" && options.drafts
      ? "https://www.googleapis.com/auth/gmail.compose"
      : provider === "microsoft" && options.drafts
        ? "offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite"
        : provider === "sheets" && options.writeback_column
          ? "https://www.googleapis.com/auth/spreadsheets"
          : scopes[provider];
  put(space, "oauth_state", {
    token: state,
    provider,
    requestedScope,
    user,
    verifier: encrypt(verifier),
    options,
    expires: Date.now() + 600000,
    used: false,
  });
  const query = new URLSearchParams({
    client_id: c.client_id,
    redirect_uri: base + "/api/oauth/callback",
    response_type: "code",
    scope: requestedScope,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });
  return c.authorize + "?" + query;
}
export async function callback(state, code, base) {
  const s = db
    .prepare("SELECT body FROM records WHERE kind='oauth_state'")
    .all()
    .map((r) => JSON.parse(r.body))
    .find((s) => s.token === state);
  if (!s || s.used || s.expires < Date.now())
    throw error("Authorization state expired or already used");
  const member = db
    .prepare("SELECT role FROM members WHERE space_id=? AND user_id=?")
    .get(s.space_id, s.user);
  if (!member || !["Owner", "Admin"].includes(member.role))
    throw error("Permission no longer available", 403);
  put(s.space_id, "oauth_state", { ...s, used: true, verifier: null }, s.id);
  const data = await exchange(s.provider, {
    grant_type: "authorization_code",
    code,
    redirect_uri: base + "/api/oauth/callback",
    code_verifier: decrypt(s.verifier),
  });
  put(s.space_id, "connector", {
    provider: s.provider,
    secret: encrypt({
      ...s.options,
      ...data,
      expires_at: Date.now() + data.expires_in * 1000,
      oauth: true,
    }),
    status: "connected",
    scopes: data.scope?.split(" ") || [s.requestedScope || scopes[s.provider]],
    sms_consent: false,
  });
  audit(s.space_id, s.user, "connector.authorized", { provider: s.provider });
  return s.space_id;
}
export async function credentials(conn) {
  let c = decrypt(conn.secret);
  if (c.oauth && c.expires_at < Date.now() + 60000) {
    try {
      const refreshed = await exchange(conn.provider, {
        grant_type: "refresh_token",
        refresh_token: c.refresh_token,
      });
      const latest = get(conn.id);
      if (!latest || latest.status !== "connected")
        throw error("Connector was revoked", 403);
      c = {
        ...c,
        ...refreshed,
        expires_at: Date.now() + refreshed.expires_in * 1000,
      };
      put(conn.space_id, "connector", { ...conn, secret: encrypt(c) }, conn.id);
    } catch (e) {
      const latest = get(conn.id);
      if (latest?.status === "connected") {
        put(
          conn.space_id,
          "connector",
          { ...latest, status: "expired" },
          conn.id,
        );
        // PRD 7.3: tell administrators to reauthorize; dependent rule runs pause.
        audit(conn.space_id, "system", "connector.expired", {
          connector_id: conn.id,
          provider: conn.provider,
        });
      }
      throw e;
    }
  }
  return c;
}
