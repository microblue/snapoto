import { renderCapture } from "./render.mjs";
import { credentials } from "./oauth.mjs";
import { extractOrder } from "./ai.mjs";
import { db, id, now, get, list, put, decrypt, audit } from "./store.mjs";
export function compile(text) {
  const lower = text.toLowerCase();
  const channel = /sms|text message|短信/.test(lower)
    ? "sms"
    : /email|mail|邮件|邮箱/.test(lower)
      ? "email"
      : null;
  return {
    trigger: "capture.cloud_verified",
    extract: "order_number",
    lookup: "sheets",
    channel,
    review_required: true,
    daily_limit: 100,
    recipient_domain: "",
    text,
    steps: [
      "Wait until the original is stored and its hash matches.",
      "Read the order number; require human confirmation.",
      "Find exactly one matching customer in the approved sheet.",
      `Send a verification link by ${channel || "a channel you must select"}.`,
      "Hold ambiguous results for review.",
    ],
    errors: channel ? [] : ["Choose email or SMS explicitly."],
  };
}
export function enqueue(capture) {
  for (const rule of list(capture.space_id, "rule").filter((r) => r.enabled)) {
    db.prepare("INSERT OR IGNORE INTO jobs VALUES(?,?,?,?,?,?)").run(
      id(),
      capture.space_id,
      capture.id,
      rule.id,
      "queued",
      JSON.stringify({ rule, logs: [], attempts: 0 }),
    );
  }
}
export async function providerFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok)
    throw Object.assign(new Error(`Provider returned HTTP ${res.status}`), {
      providerStatus: res.status,
    });
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}
// A 4xx response (other than timeout/throttle codes) means the provider
// rejected the request, so nothing was sent. Anything else is uncertain.
export const definitelyRejected = (e) =>
  Number.isInteger(e?.providerStatus) &&
  e.providerStatus >= 400 &&
  e.providerStatus < 500 &&
  ![408, 409, 425, 429].includes(e.providerStatus);
// Re-queue jobs paused for missing/expired connectors once an admin
// reconnects. The worker re-checks rule, version and authorization, and
// delivery idempotency still prevents any resend.
export function resumePausedJobs(space) {
  return db
    .prepare("UPDATE jobs SET state='queued' WHERE space_id=? AND state='paused'")
    .run(space).changes;
}
export async function lookup(conn, order) {
  const c = await credentials(conn);
  const range = encodeURIComponent(c.range || "Customers!A:D");
  const data = await providerFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(c.spreadsheet_id)}/values/${range}`,
    { headers: { Authorization: `Bearer ${c.access_token}` } },
  );
  const rows = (data.values || [])
    .map((r, index) => ({ r, row_number: index + 1 }))
    .slice(1)
    // Exact match after trimming sheet whitespace only; never fuzzy-match.
    .filter(({ r }) => String(r[0] ?? "").trim() === order.trim());
  return rows.map(({ r, row_number }) => ({
    row_number,
    order: r[0],
    name: r[1],
    email: r[2],
    phone: r[3],
  }));
}
export async function send(conn, recipient, url, deliveryId, mode = "send") {
  const c = await credentials(conn);
  if (conn.provider === "gmail") {
    const subject = "Your Snapoto photo record";
    const raw = Buffer.from(
      `To: ${recipient.email}\r\nSubject: ${subject}\r\nMessage-ID: <${deliveryId}@snapoto.local>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nView your photo record: ${url}`,
    ).toString("base64url");
    return providerFetch(
      mode === "draft"
        ? "https://gmail.googleapis.com/gmail/v1/users/me/drafts"
        : "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(mode === "draft" ? { message: { raw } } : { raw }),
      },
    );
  }
  if (conn.provider === "microsoft") {
    const message = {
      subject: "Your Snapoto photo record",
      body: { contentType: "Text", content: `View your photo record: ${url}` },
      toRecipients: [{ emailAddress: { address: recipient.email } }],
    };
    return providerFetch(
      mode === "draft"
        ? "https://graph.microsoft.com/v1.0/me/messages"
        : "https://graph.microsoft.com/v1.0/me/sendMail",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          mode === "draft" ? message : { message, saveToSentItems: true },
        ),
      },
    );
  }
  if (conn.provider === "twilio") {
    return providerFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.account_sid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${c.account_sid}:${c.auth_token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: c.from,
          To: recipient.phone,
          Body: `Your photo record: ${url}. Reply STOP to opt out.`,
        }),
      },
    );
  }
  throw new Error("Unsupported sending connector");
}
export async function processJobs(baseUrl) {
  const rows = db
    .prepare("SELECT * FROM jobs WHERE state IN ('queued','retry')")
    .all();
  for (const row of rows) {
    const b = JSON.parse(row.body),
      cap = get(row.capture_id),
      rule = b.rule;
    const ref = {
      job_id: row.id,
      capture_id: row.capture_id,
      rule_id: row.rule_id,
      rule_version: rule.version,
    };
    const save = (state, message) => {
      b.logs.push({ at: now(), message });
      db.prepare("UPDATE jobs SET state=?,body=? WHERE id=?").run(
        state,
        JSON.stringify(b),
        row.id,
      );
      if (state === "needs_review")
        audit(row.space_id, "worker", "rule.needs_review", {
          ...ref,
          reason: message,
        });
    };
    try {
      if (!get(row.rule_id)?.enabled) {
        save("paused", "Rule paused");
        continue;
      }
      if (get(row.rule_id)?.version !== rule.version) {
        save(
          "needs_review",
          "Rule version changed; retry explicitly to use the new approved version.",
        );
        continue;
      }
      if (!b.started_at) {
        b.started_at = now();
        audit(row.space_id, "worker", "rule.started", ref);
      }
      if (cap && !cap.order_confirmed && !cap.ocr && process.env.AI_API_KEY) {
        try {
          const result = await extractOrder(cap);
          Object.assign(cap, get(cap.id));
          if (cap.order_confirmed) {
          } else {
            cap.order_confirmed = false;
            cap.ocr = { ...result, at: now() };
            cap.order_number =
              result.output.order_numbers.length === 1
                ? result.output.order_numbers[0]
                : "";
            put(row.space_id, "capture", cap, cap.id);
          }
        } catch (e) {
          b.logs.push({
            at: now(),
            message: "AI extraction unavailable: " + e.message,
          });
        }
      }
      if (!cap?.order_confirmed || !cap.order_number) {
        save("needs_review", "Confirm a single order number before sending.");
        continue;
      }
      if (cap.deleted_at || cap.hash_check !== "verified") {
        save("needs_review", "Original unavailable; no message sent.");
        continue;
      }
      let sheet = list(row.space_id, "connector").find(
        (c) => c.provider === "sheets" && c.status === "connected",
      );
      const channel = rule.dsl.channel;
      let sender = list(row.space_id, "connector").find(
        (c) =>
          (channel === "sms"
            ? c.provider === "twilio"
            : ["gmail", "microsoft"].includes(c.provider)) &&
          c.status === "connected",
      );
      // PRD 7.3: an expired or revoked connector pauses the action until an
      // administrator reconnects; resolving credentials up front also keeps a
      // failed token refresh from being recorded as an uncertain delivery.
      let authorized = Boolean(sheet && sender);
      if (authorized) {
        try {
          await credentials(sheet);
          await credentials(sender);
          sheet = get(sheet.id);
          sender = get(sender.id);
          authorized =
            sheet?.status === "connected" && sender?.status === "connected";
        } catch {
          authorized = false;
        }
      }
      if (!authorized) {
        save(
          "paused",
          "Connector authorization is missing or expired. Reconnect it to resume; no message sent.",
        );
        continue;
      }
      const matches = await lookup(sheet, cap.order_number);
      if (matches.length !== 1) {
        save(
          "needs_review",
          `Found ${matches.length} customer matches; no message sent.`,
        );
        continue;
      }
      const recipient = matches[0];
      if (
        channel === "sms"
          ? !/^\+[1-9]\d{7,14}$/.test(recipient.phone || "")
          : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email || "")
      ) {
        save("needs_review", "Customer contact is invalid.");
        continue;
      }
      if (
        channel === "email" &&
        rule.dsl.recipient_domain &&
        !recipient.email
          .toLowerCase()
          .endsWith("@" + rule.dsl.recipient_domain.toLowerCase())
      ) {
        save("needs_review", "Recipient outside approved domain.");
        continue;
      }
      if (
        channel === "sms" &&
        (!sender.sms_consent ||
          list(row.space_id, "optout").some((o) => o.phone === recipient.phone))
      ) {
        save("needs_review", "SMS consent missing or recipient opted out.");
        continue;
      }
      const current = get(cap.id);
      if (
        !get(row.rule_id)?.enabled ||
        get(sender.id)?.status !== "connected" ||
        !current?.order_confirmed ||
        current.order_number !== cap.order_number
      ) {
        save(
          "needs_review",
          "Authorization or confirmed order changed during lookup.",
        );
        continue;
      }
      const deliveryId = `${row.id}-send`;
      const prior = db
        .prepare("SELECT state FROM deliveries WHERE id=?")
        .get(deliveryId);
      if (prior) {
        save(
          ["sent", "drafted"].includes(prior.state)
            ? "completed"
            : "needs_review",
          "Existing delivery recorded; never resend an uncertain provider request.",
        );
        continue;
      }
      const contact = channel === "sms" ? recipient.phone : recipient.email;
      const duplicate = db
        .prepare("SELECT body FROM deliveries WHERE space_id=?")
        .all(row.space_id)
        .map((d) => JSON.parse(d.body))
        .some(
          (d) =>
            d.capture_id === cap.id &&
            d.channel === channel &&
            String(
              channel === "sms" ? d.recipient?.phone : d.recipient?.email,
            ).toLowerCase() === String(contact).toLowerCase(),
        );
      if (duplicate) {
        save(
          "needs_review",
          "This record was already sent to this recipient by another rule; no duplicate message sent.",
        );
        continue;
      }
      const today = now().slice(0, 10);
      const sent = db
        .prepare("SELECT body FROM deliveries WHERE space_id=?")
        .all(row.space_id)
        .filter((d) => JSON.parse(d.body).at?.startsWith(today)).length;
      if (sent >= rule.dsl.daily_limit) {
        save("needs_review", "Daily delivery limit reached.");
        continue;
      }
      const token = id() + id();
      if (rule.template_snapshot) {
        const rendered = await renderCapture(
          cap,
          rule.template_snapshot,
          baseUrl + "/s/" + token,
        );
        cap.assets = rendered.assets;
      }
      put(row.space_id, "share", {
        token,
        capture_id: cap.id,
        asset_ids: [
          ...cap.assets.filter((a) => ["original", "video"].includes(a.kind)),
          ...cap.assets
            .filter(
              (a) =>
                a.kind === "rendered" &&
                (!rule.template_snapshot ||
                  a.template_id === rule.template_snapshot.id),
            )
            .slice(-1),
        ].map((a) => a.id),
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
        download: false,
        acknowledge: true,
        revoked_at: null,
        views: 0,
      });
      if (
        !get(row.rule_id)?.enabled ||
        get(sender.id)?.status !== "connected"
      ) {
        save(
          "needs_review",
          "Authorization changed before delivery; no message sent.",
        );
        continue;
      }
      const payload = {
        recipient,
        at: now(),
        channel,
        job_id: row.id,
        capture_id: cap.id,
      };
      db.prepare("INSERT INTO deliveries VALUES(?,?,?,?)").run(
        deliveryId,
        row.space_id,
        "sending",
        JSON.stringify(payload),
      );
      try {
        const result = await send(
          sender,
          recipient,
          `${baseUrl}/s/${token}`,
          deliveryId,
          rule.dsl.delivery_mode || "send",
        );
        db.prepare("UPDATE deliveries SET state=?,body=? WHERE id=?").run(
          rule.dsl.delivery_mode === "draft" ? "drafted" : "sent",
          JSON.stringify({ ...payload, result }),
          deliveryId,
        );
        try {
          const sc = await credentials(sheet);
          if (sc.writeback_column && /^[A-Z]{1,3}$/.test(sc.writeback_column)) {
            const sheetName = (sc.range || "Customers!A:D").split("!")[0];
            const range = encodeURIComponent(
              sheetName + "!" + sc.writeback_column + recipient.row_number,
            );
            await providerFetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sc.spreadsheet_id)}/values/${range}?valueInputOption=RAW`,
              {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${sc.access_token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  values: [
                    [
                      JSON.stringify({
                        delivery_id: deliveryId,
                        state:
                          rule.dsl.delivery_mode === "draft"
                            ? "drafted"
                            : "sent",
                        at: now(),
                        capture_id: cap.id,
                      }),
                    ],
                  ],
                }),
              },
            );
          }
        } catch (e) {
          b.logs.push({
            at: now(),
            message:
              "Message outcome recorded; Sheets writeback needs review: " +
              e.message,
          });
        }
        save(
          "completed",
          rule.dsl.delivery_mode === "draft"
            ? "Email draft created. No message sent."
            : "Message accepted by provider; this is not customer acknowledgment.",
        );
        audit(
          row.space_id,
          "worker",
          rule.dsl.delivery_mode === "draft"
            ? "notification.drafted"
            : "notification.sent",
          { ...ref, delivery_id: deliveryId, channel },
        );
      } catch (e) {
        const rejected = definitelyRejected(e);
        db.prepare("UPDATE deliveries SET state=? WHERE id=?").run(
          rejected ? "failed" : "unknown",
          deliveryId,
        );
        audit(row.space_id, "worker", "notification.failed", {
          ...ref,
          delivery_id: deliveryId,
          channel,
          outcome: rejected ? "rejected" : "uncertain",
        });
        save(
          "needs_review",
          rejected
            ? `Provider rejected the message (HTTP ${e.providerStatus}); nothing was sent. Fix the cause, then resend manually.`
            : "Provider outcome uncertain. Check provider history before any manual resend.",
        );
      }
      audit(row.space_id, "worker", "automation.executed", { job_id: row.id });
    } catch (e) {
      b.attempts++;
      save(b.attempts < 3 ? "retry" : "needs_review", e.message);
    }
  }
}
