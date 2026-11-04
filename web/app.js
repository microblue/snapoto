const app = document.querySelector("#app");
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const brand = '<div class="brand"><span class="brandmark"></span>snapoto</div>';
// Every AI output is a suggestion; this marker is the one consistent cue.
const AI =
  '<span class="ai" title="Suggested by AI. Check it before relying on it.">✦ AI</span>';
let me,
  space,
  view = "Today",
  settingsTab = "General",
  stream,
  photoFilter = null,
  refreshPhotos = null;
const selectedPhotos = new Set();
const isAdmin = () => ["Owner", "Admin"].includes(space.role);
const fmt = (d) => (d ? new Date(d).toLocaleString() : "—");
const fmtTime = (d) =>
  d
    ? new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";
const fmtDay = (d) =>
  new Date(d).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
// Local calendar day, YYYY-MM-DD.
const dayKey = (d = new Date()) => {
  const x = new Date(d);
  return new Date(x.getTime() - x.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
};
const initials = (n) =>
  String(n || "?")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
let toastTimer;
function toast(text) {
  const t = document.querySelector("#toast");
  t.textContent = text;
  t.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.display = "none"), 5000);
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
// Bumped on every navigation; a GET that returns after the user moved on is
// dropped so a slow earlier view never overwrites the current one.
let navSeq = 0;
const staleError = () => Object.assign(new Error("stale"), { stale: true });
async function api(url, method = "GET", body) {
  const seq = navSeq;
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can’t reach Snapoto. Check your connection and try again.");
  }
  // Proxies and crashes can return HTML; never surface a JSON parse error.
  const json = await r.json().catch(() => ({}));
  if (method === "GET" && seq !== navSeq) throw staleError();
  if (!r.ok)
    throw Object.assign(
      new Error(json.error || `Request failed (${r.status}). Try again.`),
      { status: r.status },
    );
  return json;
}
const route = (p) => `/api/spaces/${space.id}${p}`;
const call = (p, m, b) => api(route(p), m, b);
// Optional data: missing endpoints or permissions fall back to a default.
const maybe = (p, fallback) =>
  call(p).catch((e) => {
    if (e.stale) throw e;
    return fallback;
  });
// A feature endpoint that this server build does not have yet.
const missing = (e) => e.status === 404 || e.status === 405 || e.status === 501;
const on = (selector, event, fn, root = document) =>
  root.querySelectorAll(selector).forEach((el) => {
    el["on" + event] = async (e) => {
      try {
        await fn(e, el);
      } catch (err) {
        if (!err.stale) toast(err.message);
      }
    };
  });
const empty = (title, body, buttonHtml = "") =>
  `<div class="empty"><h2>${title}</h2><p>${body}</p>${buttonHtml}</div>`;
let labelSeq = 0;
function labelize(root) {
  root.querySelectorAll("label:not([for])").forEach((l) => {
    if (l.querySelector("input,select,textarea")) return;
    const next = l.nextElementSibling;
    if (!next?.matches("input,select,textarea")) return;
    if (!next.id) next.id = "f" + ++labelSeq;
    l.htmlFor = next.id;
  });
}
const button = (label, id, cls = "") =>
  `<button id="${id}" class="${cls}">${label}</button>`;
function modal(title, html, cls = "") {
  document.querySelectorAll(".modalback").forEach((el) => el.remove());
  const div = document.createElement("div");
  div.className = "modalback";
  div.innerHTML = `<section class="modal ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button class="close" aria-label="Close dialog">✕</button></header>${html}</section>`;
  document.body.append(div);
  labelize(div);
  div.querySelector(".close").onclick = () => div.remove();
  div.addEventListener("click", (e) => {
    if (e.target === div) div.remove();
  });
  div.addEventListener("keydown", (e) => {
    if (e.key === "Escape") div.remove();
    if (e.key === "Tab") {
      const nodes = [
        ...div.querySelectorAll("button,input,select,textarea,a[href]"),
      ];
      if (e.shiftKey && document.activeElement === nodes[0]) {
        e.preventDefault();
        nodes.at(-1).focus();
      } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
        e.preventDefault();
        nodes[0].focus();
      }
    }
  });
  div.querySelector(".close")?.focus();
  return div;
}
const svg = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const icons = {
  Today: svg(
    '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/><path d="m9 15 2 2 4-4"/>',
  ),
  Photos: svg(
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  ),
  Camera: svg(
    '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/>',
  ),
  Automations: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  Team: svg(
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  ),
  Settings: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  ),
  Me: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
};
async function init() {
  if (location.pathname.startsWith("/s/")) return publicPage();
  try {
    me = await api("/api/me");
    let saved = null;
    try {
      saved = localStorage.space;
    } catch {}
    space = me.spaces.find((s) => s.id === saved) || me.spaces[0];
    const invite = new URLSearchParams(location.search).get("invite");
    if (invite) {
      await api("/api/invites/accept", "POST", { token: invite });
      history.replaceState({}, "", "/");
      return init();
    }
    await shell();
  } catch (e) {
    auth();
  }
}
function auth(register = false) {
  app.className = "";
  app.innerHTML = `<div class="auth"><section class="auth-story"><div>${brand}<h1>Timemark stamps photos.<br>Snapoto reads them.</h1><p>Take the photo. AI files it, finds the order number and drafts your daily report. You approve what reaches the customer.</p></div><ul class="auth-points"><li>Originals always kept, never branded</li><li>“Saved ✓” only after it is really saved</li><li>Customers get a Verified ✓ page, not just a picture</li></ul></section><form class="auth-form"><h1>${register ? "Create your workspace" : "Welcome back"}</h1><p class="muted">${register ? "Start with a private personal space. Add a team when you’re ready." : "Sign in to your photos, team and automations."}</p>${register ? '<label for="name">Your name</label><input id="name" name="name" required autocomplete="name">' : ""}<label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email"><label for="password">Password</label><input id="password" name="password" type="password" minlength="12" required autocomplete="${register ? "new-password" : "current-password"}"><small>At least 12 characters</small><p class="error" id="auth-error"></p><button class="primary" type="submit">${register ? "Create account" : "Sign in"}</button><p><button type="button" id="switch-auth">${register ? "Already have an account? Sign in" : "New to Snapoto? Create an account"}</button></p></form></div>`;
  document.querySelector("#switch-auth").onclick = () => auth(!register);
  document.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      await api(`/api/auth/${register ? "register" : "login"}`, "POST", b);
      await init();
    } catch (err) {
      document.querySelector("#auth-error").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
}
function tabsFor(role) {
  if (["Owner", "Admin"].includes(role))
    return ["Today", "Photos", "Automations", "Team", "Settings"];
  if (role === "Viewer") return ["Today", "Photos", "Me"];
  return ["Camera", "Photos", "Me"];
}
const subtitles = {
  Today: () =>
    new Date().toLocaleDateString([], {
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
  Photos: () => "Every photo your team took, read and filed.",
  Camera: () => "Saved on this device first, then uploaded.",
  Automations: () => "What happens after a photo. You approve every step.",
  Team: () => "Who can take, see and send photos in this space.",
  Settings: () => "Company, watermarks, connected tools.",
  Me: () => "Your account and upload queue.",
};
async function go(next) {
  view = next;
  await shell();
}
async function shell() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  refreshPhotos = null;
  const tabs = tabsFor(space.role);
  // Camera stays reachable for writers from Photos even when not in the nav.
  const allowed = [...tabs, ...(space.role !== "Viewer" ? ["Camera"] : [])];
  if (!allowed.includes(view)) view = tabs[0];
  navSeq++;
  app.className = "with-shell";
  app.innerHTML = `<aside class="sidebar"><div class="side-top">${brand}<select id="space" aria-label="Current space">${me.spaces.map((s) => `<option value="${esc(s.id)}" ${s.id === space.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div><nav aria-label="Main">${tabs.map((t) => `<button data-nav="${t}" class="${t === view ? "active" : ""}" ${t === view ? 'aria-current="page"' : ""}>${icons[t] || ""}<span>${t}</span></button>`).join("")}</nav><footer><span class="avatar" aria-hidden="true">${esc(initials(me.name))}</span><div class="who"><strong>${esc(me.name)}</strong><p class="muted">${esc(space.role)} · ${esc(space.name)}</p></div><button id="logout" class="small ghost">Sign out</button></footer></aside><main class="workspace"><header class="topbar"><div><h1>${view}</h1><p class="muted">${esc(subtitles[view]?.() || "")}</p></div><div class="actions" id="page-actions"></div></header><div id="content"><p class="loading">Loading…</p></div></main>`;
  on("[data-nav]", "click", async (e, el) => go(el.dataset.nav));
  on("#space", "change", async (e, el) => {
    try {
      localStorage.space = el.value;
    } catch {}
    space = me.spaces.find((s) => s.id === el.value);
    // Selections and filters belong to the previous space.
    selectedPhotos.clear();
    photoFilter = null;
    await shell();
  });
  on("#logout", "click", async () => {
    await api("/api/auth/logout", "POST");
    auth();
  });
  const render = {
    Today: today,
    Photos: photos,
    Camera: camera,
    Automations: automations,
    Team: team,
    Settings: settings,
    Me: settings,
  }[view];
  try {
    await render();
  } catch (e) {
    if (e.stale) return;
    document.querySelector("#content").innerHTML =
      `<p class="error">${esc(e.message)}</p>`;
  }
}
const content = (html) => {
  const el = document.querySelector("#content");
  el.innerHTML = html;
  labelize(el);
};
const actions = (html) => {
  const el = document.querySelector("#page-actions");
  if (el) el.innerHTML = html;
};
function parsePhotoQuery(raw) {
  const parts = { text: [], order: "", email: "", date: "" };
  for (const tok of String(raw || "").split(/\s+/)) {
    const m = tok.match(/^(order|email|date):(.*)$/i);
    if (m) parts[m[1].toLowerCase()] = m[2].trim();
    else if (tok) parts.text.push(tok);
  }
  parts.text = parts.text.join(" ");
  return parts;
}

/* ---------- Photo helpers ---------- */
const OFFLINE_GAP_MS = 5 * 60 * 1000;
// True when the server received the record well after the device says it was
// taken (offline capture or delayed upload). Capture time is then device-only.
const receivedLate = (c) =>
  c.server_received_at &&
  c.captured_at_device &&
  Date.parse(c.server_received_at) - Date.parse(c.captured_at_device) >
    OFFLINE_GAP_MS;
const isProblem = (c) =>
  !!c.deleted_at ||
  c.hash_check === "original_unavailable" ||
  (c.hash_check && c.hash_check !== "verified") ||
  c.ai?.state === "failed";
function statusChip(c) {
  if (c.deleted_at || c.hash_check === "original_unavailable")
    return '<span class="badge bad">Original removed</span>';
  if (c.hash_check === "verified" && (c.cloud_state || "stored") === "stored")
    return '<span class="badge">In cloud ✓</span>';
  return `<span class="badge warn">Problem: ${esc(String(c.hash_check || "not verified").replaceAll("_", " "))}</span>`;
}
const captionOf = (c) => c.caption || c.ai?.caption || "";
const captionIsAI = (c) => !c.caption && !c.ai?.caption_edited && !!c.ai?.caption;
const fieldNames = {
  order_number: "Order #",
  plate: "Plate",
  meter: "Meter reading",
  serial: "Serial #",
  text: "Text",
};
// An AI order number that differs from a human-confirmed one is never offered
// as an action: it can only be dismissed.
const conflicts = (c, f) =>
  f.field === "order_number" &&
  c.order_confirmed &&
  (c.order_number || "") !== f.value;
const proposed = (c) =>
  (c.ai?.findings || []).filter((f) => f.status === "proposed" && !conflicts(c, f));
function shownAsset(c) {
  return (
    c.assets.filter((a) => a.kind === "rendered").at(-1) ||
    c.assets.find((a) => ["original", "video"].includes(a.kind))
  );
}
let memberNames = new Map();
function photoCard(c) {
  const a = shownAsset(c);
  const cap = captionOf(c);
  const who = memberNames.get(c.created_by);
  const tags = (c.ai?.tags || [])
    .slice(0, 3)
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join("");
  const needs = proposed(c).length || (c.order_number && !c.order_confirmed);
  return `<button class="photo" data-photo="${esc(c.id)}"><div class="img">${a && !c.deleted_at && a.kind !== "video" ? `<img src="${route(`/captures/${c.id}/assets/${a.id}`)}" alt="${esc(cap || "Field photo")}" loading="lazy">` : `<span>${a?.kind === "video" ? "Video" : "No preview"}</span>`}${statusChip(c)}</div><div class="meta"><p class="caption">${cap ? (captionIsAI(c) ? AI + " " : "") + esc(cap) : esc(c.address || c.note || c.collection || "Field photo")}</p>${tags ? `<div class="tags">${tags}</div>` : ""}<span class="sub">${esc(fmtDay(c.captured_at_device))} · ${esc(fmtTime(c.captured_at_device))}${who ? " · " + esc(who) : ""}${needs ? ' · <span class="badge warn">Needs you</span>' : ""}</span></div></button>`;
}
function bindPhotos(root = document) {
  on("[data-photo]", "click", async (e, el) => detail(el.dataset.photo), root);
}
async function loadMembers() {
  const members = await maybe("/members", []);
  memberNames = new Map(members.map((m) => [m.id, m.name]));
  return members;
}

/* ---------- Today ---------- */
function needsItems({ captures, jobs, acks, shares, local, todayOnly }) {
  const admin = isAdmin();
  const items = [];
  const byId = new Map(captures.map((c) => [c.id, c]));
  const shareCapture = new Map(shares.map((s) => [s.id, s.capture_id]));
  for (const c of captures) {
    for (const f of proposed(c).filter((f) => f.field === "order_number"))
      items.push({
        c,
        title: `Confirm order # ${f.value}?`,
        body: `${AI} read it from the photo${f.where ? " (" + esc(f.where) + ")" : ""}. Check it, then confirm.`,
        actions: `${admin || c.created_by === me.id ? `<button class="primary small" data-accept="${esc(c.id)}" data-fid="${esc(f.id)}">Confirm</button>` : ""}<button class="small" data-photo="${esc(c.id)}">Check photo</button>`,
      });
    if (c.order_number && !c.order_confirmed && !proposed(c).length)
      items.push({
        c,
        title: `Order # ${c.order_number} isn’t confirmed`,
        body: "Compare it with the photo before it goes to a customer.",
        actions: `<button class="small" data-photo="${esc(c.id)}">Open</button>`,
      });
    if (
      (c.ai?.issues || []).length &&
      (!todayOnly || dayKey(c.captured_at_device) === dayKey())
    )
      items.push({
        c,
        title: "Worth a look",
        body: `${AI} ${esc(c.ai.issues.join(" · "))}`,
        actions: `<button class="small" data-photo="${esc(c.id)}">Open</button>`,
      });
  }
  for (const j of jobs.filter((j) => j.state === "needs_review"))
    items.push({
      c: byId.get(j.capture_id),
      title: `“${j.rule.name}” is waiting for you`,
      body: esc(
        j.logs.at(-1)?.message ||
          "The automation stopped instead of guessing. Review the photo.",
      ),
      actions: `<button class="small" data-photo="${esc(j.capture_id)}">Review</button>`,
    });
  for (const a of acks.filter((a) => a.status === "issue")) {
    const cid = shareCapture.get(a.share_id);
    items.push({
      c: byId.get(cid),
      title: `${a.name} reported a problem`,
      body: esc(a.note || "No comment left."),
      actions: cid
        ? `<button class="small" data-photo="${esc(cid)}">Open</button>`
        : "",
    });
  }
  for (const r of local.filter((r) => r.blocked))
    items.push({
      local: r,
      title: "Upload paused",
      body: esc(r.blocked),
      actions: '<button class="small" data-retry-uploads>Retry uploads</button>',
    });
  return items;
}
function needsList(items) {
  if (!items.length)
    return '<div class="allclear"><span class="tick">✓</span>All clear. Anything that needs you shows up here.</div>';
  return `<ul class="needs">${items
    .slice(0, 8)
    .map((i) => {
      const a = i.c && shownAsset(i.c);
      const thumb =
        a && a.kind !== "video" && !i.c.deleted_at
          ? `<img src="${route(`/captures/${i.c.id}/assets/${a.id}`)}" alt="" loading="lazy">`
          : i.local
            ? `<img src="data:${esc(i.local.assets[0].mime)};base64,${esc(i.local.assets[0].data)}" alt="">`
            : '<span class="thumb-ph"></span>';
      return `<li>${thumb}<div class="what"><strong>${esc(i.title)}</strong><p>${i.body}</p><div class="actions">${i.actions}</div></div></li>`;
    })
    .join(
      "",
    )}</ul>${items.length > 8 ? `<p><button class="ghost small" data-nav-filter="needs">See all ${items.length}</button></p>` : ""}`;
}
async function acceptFinding(cid, fid, value) {
  try {
    const body = { action: "accept", confirm: true };
    if (value !== undefined) body.value = value;
    return await call(`/captures/${cid}/findings/${fid}`, "POST", body);
  } catch (e) {
    if (missing(e))
      throw new Error("Confirming AI findings isn’t available on this server yet.");
    if (e.status === 409)
      throw new Error(
        "This photo already has a different confirmed order number. Nothing was changed.",
      );
    throw e;
  }
}
function reportCard(r, state, captures) {
  const date = dayKey();
  const head = `<div class="card-head"><h2>Daily report ${AI}</h2><div class="actions">${r ? '<button class="small" id="gen-report">Regenerate</button><button class="small" id="report-pdf">Download PDF</button>' : ""}</div></div>`;
  if (!r) {
    const note =
      state === "unavailable"
        ? '<p class="suggest-note">Daily reports aren’t available on this server yet. The numbers above are live.</p>'
        : state && state !== "none"
          ? `<p class="suggest-note">${esc(state)}</p>`
          : "";
    return `<section class="card ai-card" id="report">${head}<p class="report-headline">Your day in one paragraph.</p><p class="muted">AI reads today’s captions, findings and deliveries and writes a short report you can forward. Text only — photos never leave Snapoto for this.</p>${note}<p><button class="primary" id="gen-report" ${captures.length ? "" : 'disabled title="Take a photo first"'}>Write today’s report</button></p></section>`;
  }
  const byId = new Map(captures.map((c) => [c.id, c]));
  const links = (ids = []) =>
    `<span class="links">${ids
      .filter((id) => byId.has(id))
      .slice(0, 4)
      .map(
        (id, i) =>
          `<button class="small" data-photo="${esc(id)}" aria-label="Open photo ${i + 1}">Photo ${i + 1}</button>`,
      )
      .join("")}</span>`;
  const list = (rows, cls = "") =>
    rows?.length
      ? `<ul class="report-list">${rows.map((h) => `<li class="${cls}"><span>${esc(h.text)}</span>${links(h.capture_ids)}</li>`).join("")}</ul>`
      : "";
  return `<section class="card ai-card" id="report">${head}<p class="report-headline">${esc(r.headline)}</p><p>${esc(r.summary)}</p>${r.highlights?.length ? "<h3>Highlights</h3>" + list(r.highlights) : ""}${r.needs_attention?.length ? '<h3 style="margin-top:14px">Needs attention</h3>' + list(r.needs_attention, "warn") : ""}${r.by_member?.length ? `<p class="muted" style="margin-top:14px">${r.by_member.map((m) => `${esc(m.name)}: ${esc(m.photos)} photos`).join(" · ")}</p>` : ""}<p class="suggest-note">Draft written by ${esc(r.model || "AI")} at ${esc(fmtTime(r.created_at))} for ${esc(r.date || date)}. Check it against the photos before forwarding.</p></section>`;
}
async function today() {
  const admin = isAdmin();
  const date = dayKey();
  const [o, captures, acks, shares, templates, members, local] =
    await Promise.all([
      maybe("/overview", { jobs: [], activity: [], sent: 0 }),
      call("/captures"),
      maybe("/acknowledgments", []),
      admin ? maybe("/shares", []) : [],
      maybe("/templates", []),
      loadMembers(),
      localAll().catch(() => []),
    ]);
  let report = null,
    reportState = "none";
  try {
    report = await call(`/reports/daily?date=${date}`);
    if (!report?.headline) report = null;
  } catch (e) {
    if (e.stale) throw e;
    if (e.status === 503) reportState = e.message;
  }
  const mineLocal = local.filter(
    (r) => r.user_id === me.id && r.space_id === space.id,
  );
  const todays = captures.filter(
    (c) => dayKey(c.captured_at_device) === date,
  );
  const inCloud = todays.filter(
    (c) => c.hash_check === "verified" && !c.deleted_at,
  ).length;
  const items = needsItems({
    captures,
    jobs: o.jobs || [],
    acks,
    shares,
    local: mineLocal,
    todayOnly: true,
  });
  const sent = report?.counts?.sent ?? o.sent ?? 0;
  const steps = [
    [
      "Company name + allow cloud",
      !!(space.settings?.company && space.settings?.cloud_enabled),
      "settings",
      "Open settings",
    ],
    ["Make your watermark", templates.length > 0, "watermarks", "Make one"],
    ["Take or upload a photo", captures.length > 0, "photos", "Add photo"],
    ["Invite your team", members.length > 1, "team", "Invite"],
  ];
  const doneCount = steps.filter((s) => s[1]).length;
  let hidden = false;
  try {
    hidden = localStorage["firstrun-hidden-" + space.id] === "1";
  } catch {}
  const firstRun =
    admin && doneCount < steps.length && !hidden
      ? `<section class="card firstrun" aria-label="Get started"><div class="card-head"><div><h2>Get set up in 4 steps</h2><p>${doneCount} of ${steps.length} done. It takes about two minutes.</p></div><button class="small" id="hide-firstrun">Hide</button></div><div class="bar"><span style="width:${(doneCount / steps.length) * 100}%"></span></div><ol class="steps-list">${steps.map(([label, done, target, cta], i) => `<li class="${done ? "done" : ""}"><span class="num">${done ? "✓" : i + 1}</span><strong>${label}</strong>${done ? "<small>Done</small>" : `<button class="small" data-setup="${target}">${cta}</button>`}</li>`).join("")}</ol></section>`
      : "";
  const stat = (n, label, sub, cls, filter) =>
    `<button class="stat ${cls}" ${filter ? `data-nav-filter="${filter}"` : ""}><span class="label">${label}</span><strong>${n}</strong><small>${sub}</small></button>`;
  const responses = acks
    .slice(0, 4)
    .map(
      (a) =>
        `<div class="row"><div><strong>${esc(a.name)}</strong> <span class="badge ${a.status === "issue" ? "warn" : ""}">${a.status === "issue" ? "Reported a problem" : "Confirmed received"}</span><p class="muted">${esc(a.note)}</p><small>${fmt(a.timestamp)} · ${a.identity_check === "email_verified" ? "Verified email" : "Self-reported name"}</small></div></div>`,
    )
    .join("");
  const activity = (o.activity || [])
    .slice(0, 5)
    .map(
      (a) =>
        `<div class="row"><div><p>${esc({ "capture.cloud_verified": "Photo stored and verified", "capture.analyzed": "AI described a photo", "share.created": "Share link created", "share.acknowledged": "Customer responded", "settings.changed": "Settings updated", "space.created": "Team created", "connector.connected": "Tool connected", "member.invited": "Member invited" }[a.event] || a.event.replaceAll(".", " ").replaceAll("_", " "))}</p><small>${fmt(a.created_at)}</small></div></div>`,
    )
    .join("");
  actions(
    space.role === "Viewer"
      ? ""
      : '<button class="primary" id="add-photo">Upload or take a photo</button>',
  );
  content(
    `${firstRun}<div class="stats">${stat(todays.length, "Photos today", `${captures.length} in total`, "", "today")}${stat(inCloud, "In cloud ✓", todays.length ? `${todays.length - inCloud} still syncing or need a look` : "Verified originals", "good", "today")}${stat(sent, "Sent to customers", report?.counts ? "today" : "all time", "", admin ? "shared" : "")}${stat(items.length, "Needs you", items.length ? "Tap to see them" : "Nothing waiting", items.length ? "alert" : "", "needs")}</div><div class="split"><div class="stack">${reportCard(report, reportState, captures)}<section class="card"><div class="card-head"><h2>Latest photos</h2><button class="ghost small" data-nav-filter="">See all</button></div>${captures.length ? `<div class="grid compact">${captures.slice(0, 6).map(photoCard).join("")}</div>` : empty("Your first photo starts here", "Upload one from this computer, or take it with the Snapoto app.", space.role === "Viewer" ? "" : '<button class="primary" data-setup="photos">Add a photo</button>')}</section></div><div class="stack"><section class="card" aria-label="Needs you"><div class="card-head"><h2>Needs you</h2>${items.length ? `<span class="badge warn">${items.length}</span>` : ""}</div>${needsList(items)}</section><section class="card"><h2>Customer responses</h2>${responses || '<p class="muted">When a customer confirms or reports a problem, it shows here.</p>'}</section><section class="card"><h2>Recent activity</h2>${activity || '<p class="muted">Nothing yet.</p>'}</section></div></div>`,
  );
  const goPhotos = async (filter) => {
    photoFilter = filter || null;
    selectedPhotos.clear();
    await go("Photos");
  };
  on("#add-photo", "click", () => goPhotos(""));
  on("[data-nav-filter]", "click", (e, el) => goPhotos(el.dataset.navFilter));
  on("[data-setup]", "click", async (e, el) => {
    const t = el.dataset.setup;
    if (t === "settings") settingsTab = "General";
    if (t === "watermarks") settingsTab = "Watermarks";
    await go(
      { settings: "Settings", watermarks: "Settings", photos: "Photos", team: "Team" }[t],
    );
  });
  on("#hide-firstrun", "click", async () => {
    try {
      localStorage["firstrun-hidden-" + space.id] = "1";
    } catch {}
    document.querySelector(".firstrun")?.remove();
  });
  on("[data-accept]", "click", async (e, el) => {
    el.disabled = true;
    try {
      await acceptFinding(el.dataset.accept, el.dataset.fid);
      toast("Order number confirmed");
      await today();
    } finally {
      el.disabled = false;
    }
  });
  on("[data-retry-uploads]", "click", async () => {
    await retryBlocked();
    toast("Upload queue checked");
    await today();
  });
  const generate = async (e, el) => {
    el.disabled = true;
    el.textContent = "Writing report…";
    let html;
    try {
      const r = await call("/reports/daily", "POST", {
        date,
        tz_offset_min: -new Date().getTimezoneOffset(),
      });
      html = reportCard(r, "", captures);
    } catch (err) {
      html = reportCard(null, missing(err) ? "unavailable" : err.message, captures);
    }
    const box = document.querySelector("#report");
    if (!box) return;
    box.outerHTML = html;
    bindReport();
  };
  const bindReport = () => {
    const box = document.querySelector("#report");
    if (!box) return;
    bindPhotos(box);
    on("#gen-report", "click", generate, box);
    on("#report-pdf", "click", async (e, el) => {
      el.disabled = true;
      try {
        const r = await fetch(route(`/reports/daily.pdf?date=${date}`));
        if (!r.ok)
          throw new Error(
            r.status === 404
              ? "The PDF isn’t available yet. Generate the report first."
              : "PDF download failed (" + r.status + ")",
          );
        downloadBlob(await r.blob(), `snapoto-daily-${date}.pdf`);
      } finally {
        el.disabled = false;
      }
    }, box);
  };
  bindPhotos();
  bindReport();
}
function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

/* ---------- Photos ---------- */
async function runExport(kind, taskBox) {
  const names = { csv: "CSV records", zip: "Originals ZIP", pdf: "PDF report" };
  const paths = { csv: "/export.csv", zip: "/export.zip", pdf: "/report.pdf" };
  const el = document.createElement("div");
  el.className = "card export-task";
  taskBox.prepend(el);
  const draw = (step, state, note = "") => {
    const steps = ["Prepare", "Download", "Done"];
    el.innerHTML = `<div class="row"><div><strong>${esc(names[kind])}</strong><p>${esc(note || steps[step] + "…")}</p><ol class="steps">${steps.map((s, i) => `<li class="${i < step ? "done" : i === step ? "current" : ""}">${s}</li>`).join("")}</ol></div><div class="actions">${state === "failed" ? `<button data-retry-export="${kind}">Retry</button>` : ""}</div></div>`;
    el.querySelector("[data-retry-export]")?.addEventListener("click", () =>
      runExport(kind, taskBox),
    );
  };
  try {
    draw(0, "running", "Preparing export on the server");
    const r = await fetch(route(paths[kind]));
    if (!r.ok) throw new Error("Export failed: " + r.status);
    draw(1, "running", "Downloading file");
    downloadBlob(
      await r.blob(),
      { csv: "snapoto-records.csv", zip: "snapoto-originals.zip", pdf: "snapoto-report.pdf" }[kind],
    );
    draw(3, "done", "Saved to your device");
  } catch (e) {
    draw(1, "failed", e.message + ". Nothing was changed. You can retry.");
  }
}
function selectedCsv(rows) {
  const cell = (s) =>
    '"' +
    String(s ?? "")
      .replace(/^[=+@-]/, "'$&")
      .replace(/"/g, '""') +
    '"';
  const head = [
    "id",
    "captured_at_device",
    "server_received_at",
    "address",
    "order_number",
    "order_confirmed",
    "caption",
    "tags",
    "sha256_original",
    "status",
  ];
  const lines = rows.map((c) =>
    [
      c.id,
      c.captured_at_device,
      c.server_received_at,
      c.address,
      c.order_number,
      c.order_confirmed ? "yes" : "no",
      captionOf(c),
      (c.ai?.tags || []).join(" "),
      c.assets.find((a) => a.kind === "original")?.sha256,
      c.hash_check,
    ]
      .map(cell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n");
}
function pendingTile(r) {
  const a = r.assets?.[0];
  const status = r.blocked
    ? `<span class="badge bad">Problem: ${esc(r.blocked)}</span>`
    : r.error
      ? '<span class="badge warn">Uploading… retrying</span>'
      : '<span class="badge info">Saved on this device · Uploading…</span>';
  return `<div class="batch-item"><div class="photo pending-tile"><div class="img">${a && a.mime?.startsWith("image/") ? `<img src="data:${esc(a.mime)};base64,${esc(a.data)}" alt="Photo waiting to upload">` : ""}${status}</div><div class="meta"><p class="caption">Waiting to upload</p><span class="sub">${esc(fmt(r.captured_at_device))}</span></div></div></div>`;
}
async function photos() {
  const admin = isAdmin();
  const writer = space.role !== "Viewer";
  if (photoFilter === "review") photoFilter = "needs";
  actions(
    writer
      ? `<button id="use-camera">${icons.Camera}Use camera</button><label for="upload" class="btn primary">Upload photos</label><input id="upload" type="file" accept="image/jpeg,image/png" multiple hidden>`
      : "",
  );
  // Bind upload before any network wait so a quick pick is never ignored.
  let reloadPhotos = async () => {};
  on("#use-camera", "click", () => go("Camera"));
  on("#upload", "change", async (e, el) => {
    for (const f of [...el.files]) await saveBlob(f);
    el.value = "";
    await reloadPhotos();
  });
  const chip = (v, l) =>
    `<button data-chip="${v}" class="${(photoFilter || "") === v ? "active" : ""}">${l}</button>`;
  content(
    `<form class="askbar" id="askform" role="search">${icons.search.replace("<svg", '<svg class="icon"')}<input id="search" placeholder="Ask: yesterday’s photos at Oak St with damage" aria-label="Search photos" autocomplete="off"><button class="primary" id="filter" type="submit">Search</button></form><div class="toolbar"><div class="chips" role="group" aria-label="Quick filters">${chip("", "All")}${chip("today", "Today")}${chip("needs", "Needs you")}${admin ? chip("shared", "Shared") : ""}${chip("problems", "Problems")}</div><div class="actions"><div class="seg" role="group" aria-label="Layout"><button id="view-grid" class="active">Grid</button><button id="map">Map</button></div><button class="small" id="summarize">✦ Summarize</button><button class="small" id="compare">Compare</button></div></div><details class="morefilters"><summary>More filters</summary><div class="row-inputs"><input id="from" type="date" aria-label="From date"><span class="muted">to</span><input id="to" type="date" aria-label="To date"><small>Exact search: order:123 · date:2026-01-05 · email:a@b.com</small></div></details><div id="interp"></div><div id="batchbar" class="batchbar" hidden></div><div id="photos"><p class="loading">Loading photos…</p></div>${admin ? `<section class="card" style="margin-top:28px" aria-label="Exports"><div class="card-head"><div><h2>Export everything</h2><p class="muted">All photos in this space. To export a few, select them above.</p></div><div class="actions"><button data-export="csv">CSV records</button><button data-export="zip">Originals ZIP</button><button data-export="pdf">PDF report</button></div></div><div id="export-tasks"></div></section>` : ""}`,
  );
  await loadMembers();
  let cache = [];
  let loadSeq = 0;
  let mapMode = false;
  const load = async () => {
    // Only the newest filter request may draw the list.
    const mine = ++loadSeq;
    const raw = document.querySelector("#search")?.value.trim() || "";
    const p = parsePhotoQuery(raw);
    const from = document.querySelector("#from").value;
    const to = document.querySelector("#to").value;
    let rows,
      interp = "";
    if (p.text.length >= 2) {
      const r = await call("/search", "POST", { q: p.text, text: p.text });
      rows = r.captures || [];
      const f = r.filters || {};
      interp = r.fallback
        ? `<div class="interp">Showing exact matches for “${esc(p.text)}”. <span class="muted">AI search isn’t set up, so plain words are matched.</span></div>`
        : `<div class="interp">${AI} understood: ${[
            f.understood && `“${esc(f.understood)}”`,
            f.query && `words “${esc(f.query)}”`,
            f.from && `from ${esc(f.from)}`,
            f.to && `to ${esc(f.to)}`,
            f.collection && `in ${esc(f.collection)}`,
          ]
            .filter(Boolean)
            .join(" · ") || "everything"}. <button class="ghost small" id="clear-search" type="button">Clear</button></div>`;
    } else rows = await call("/captures");
    if (from) rows = rows.filter((c) => c.captured_at_device >= from);
    if (to)
      rows = rows.filter((c) => c.captured_at_device <= to + "T23:59:59.999Z");
    if (p.order)
      rows = rows.filter((c) =>
        (c.order_number || "").toLowerCase().includes(p.order.toLowerCase()),
      );
    if (p.date)
      rows = rows.filter((c) => (c.captured_at_device || "").slice(0, 10) === p.date);
    const needShares = admin && (p.email || ["shared", "problems"].includes(photoFilter));
    const [shares, acks, o] = await Promise.all([
      needShares ? maybe("/shares", []) : [],
      p.email || photoFilter === "problems" ? maybe("/acknowledgments", []) : [],
      photoFilter === "needs" ? maybe("/overview", { jobs: [] }) : { jobs: [] },
    ]);
    const shareCap = new Map(shares.map((s) => [s.id, s.capture_id]));
    if (p.email) {
      const q = p.email.toLowerCase();
      const ids = new Set([
        ...shares
          .filter((s) => (s.recipient_email || "").toLowerCase().includes(q))
          .map((s) => s.capture_id),
        ...acks
          .filter((a) => (a.identity_email || "").toLowerCase().includes(q))
          .map((a) => shareCap.get(a.share_id)),
      ]);
      rows = rows.filter((c) => ids.has(c.id));
    }
    if (photoFilter === "today")
      rows = rows.filter((c) => dayKey(c.captured_at_device) === dayKey());
    if (photoFilter === "needs") {
      const review = new Set(
        o.jobs.filter((j) => j.state === "needs_review").map((j) => j.capture_id),
      );
      rows = rows.filter(
        (c) =>
          review.has(c.id) ||
          proposed(c).length ||
          (c.order_number && !c.order_confirmed),
      );
    }
    if (photoFilter === "shared") {
      const ids = new Set(shares.map((s) => s.capture_id));
      rows = rows.filter((c) => ids.has(c.id));
    }
    if (photoFilter === "problems") {
      const issueIds = new Set(
        acks.filter((a) => a.status === "issue").map((a) => shareCap.get(a.share_id)),
      );
      rows = rows.filter((c) => isProblem(c) || issueIds.has(c.id));
    }
    const local = (await localAll().catch(() => [])).filter(
      (r) => r.user_id === me.id && r.space_id === space.id,
    );
    if (mine !== loadSeq || !document.querySelector("#photos")) return;
    cache = rows;
    document.querySelector("#interp").innerHTML = interp;
    on("#clear-search", "click", async () => {
      document.querySelector("#search").value = "";
      await load();
    });
    const box = document.querySelector("#photos");
    const filtered = raw || from || to || photoFilter;
    if (mapMode) return drawMap(box, rows);
    box.innerHTML =
      rows.length || local.length
        ? `<div class="grid">${(filtered ? "" : local.map(pendingTile).join("")) + rows.map(batchItem).join("")}</div>`
        : filtered
          ? empty("No photos match", "Try fewer words, or clear the filters.", '<button id="reset-filters">Show all photos</button>')
          : empty(
              "No photos here yet",
              "Upload a photo from this computer, or take one with the Snapoto app. AI will describe it and pull out order numbers for you.",
              writer ? '<label for="upload" class="btn primary">Upload a photo</label>' : "",
            );
    on("#reset-filters", "click", async () => {
      document.querySelector("#search").value = "";
      photoFilter = null;
      await photos();
    });
    bindPhotos(box);
    wirePicks();
    drawBatch();
  };
  const batchItem = (c) =>
    `<div class="batch-item"><label class="pick"><input type="checkbox" data-pick="${esc(c.id)}" ${selectedPhotos.has(c.id) ? "checked" : ""}><span>Select</span></label>${photoCard(c)}</div>`;
  const wirePicks = () => {
    document.querySelectorAll("[data-pick]").forEach((box) => {
      box.onchange = () => {
        if (box.checked) selectedPhotos.add(box.dataset.pick);
        else selectedPhotos.delete(box.dataset.pick);
        drawBatch();
      };
    });
  };
  const drawBatch = () => {
    const bar = document.querySelector("#batchbar");
    if (!bar) return;
    if (!selectedPhotos.size) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.innerHTML = `<span><strong>${selectedPhotos.size}</strong> selected</span><div class="actions">${admin ? '<button id="batch-share" class="primary">Share links</button>' : ""}<button id="batch-export">Export CSV</button>${admin ? '<button id="batch-confirm">Confirm checked orders</button><button id="batch-unconfirm">Reopen checked</button>' : ""}<button id="select-all">Select all</button><button id="select-none">Clear</button></div>`;
    on("#select-all", "click", async () => {
      cache.forEach((c) => selectedPhotos.add(c.id));
      await load();
    });
    on("#select-none", "click", async () => {
      selectedPhotos.clear();
      await load();
    });
    on("#batch-export", "click", async () => {
      const rows = cache.filter((c) => selectedPhotos.has(c.id));
      downloadBlob(
        new Blob([selectedCsv(rows)], { type: "text/csv" }),
        "snapoto-selected.csv",
      );
      toast(`Exported ${rows.length} photos`);
    });
    on("#batch-share", "click", async () => {
      const ids = [...selectedPhotos];
      const links = [];
      for (const id of ids) {
        try {
          const s = await call(`/captures/${id}/shares`, "POST", {
            days: 7,
            download: false,
            acknowledge: true,
          });
          links.push(s.url);
        } catch (e) {
          links.push(`(${id.slice(0, 8)}: ${e.message})`);
        }
      }
      const d = modal(
        `${ids.length} share links`,
        `<p class="muted">Each link opens one photo with its Verified ✓ page. Links expire in 7 days and can be revoked in Settings › Connections.</p>${links.map((u) => `<div class="linkbox"><span>${esc(u)}</span></div>`).join("")}<p><button class="primary" id="copy-all">Copy all links</button></p>`,
      );
      on("#copy-all", "click", async () =>
        toast((await copyText(links.join("\n"))) ? "Links copied" : "Select the links and copy them"),
        d,
      );
    });
    const adjudicate = async (confirmed) => {
      let ok = 0,
        skip = 0;
      for (const id of [...selectedPhotos]) {
        const c = cache.find((r) => r.id === id);
        if (!c || (confirmed && !c.order_number)) {
          skip++;
          continue;
        }
        try {
          await call(`/captures/${id}`, "PATCH", { order_confirmed: confirmed });
          ok++;
          selectedPhotos.delete(id);
        } catch {
          skip++;
        }
      }
      toast(`Updated ${ok} records${skip ? `, ${skip} skipped` : ""}`);
      await load();
    };
    on("#batch-confirm", "click", () => adjudicate(true));
    on("#batch-unconfirm", "click", () => adjudicate(false));
  };
  document.querySelector("#askform").onsubmit = (e) => {
    e.preventDefault();
    load().catch((err) => !err.stale && toast(err.message));
  };
  ["#from", "#to"].forEach((s) =>
    document.querySelector(s).addEventListener("change", () =>
      load().catch((err) => !err.stale && toast(err.message)),
    ),
  );
  on("[data-chip]", "click", async (e, el) => {
    photoFilter = el.dataset.chip || null;
    selectedPhotos.clear();
    document.querySelectorAll("[data-chip]").forEach((b) =>
      b.classList.toggle("active", b === el),
    );
    await load();
  });
  on("[data-export]", "click", async (e, el) =>
    runExport(el.dataset.export, document.querySelector("#export-tasks")),
  );
  reloadPhotos = load;
  on("#view-grid", "click", async (e, el) => {
    mapMode = false;
    el.classList.add("active");
    document.querySelector("#map").classList.remove("active");
    await load();
  });
  on("#map", "click", async (e, el) => {
    mapMode = true;
    el.classList.add("active");
    document.querySelector("#view-grid").classList.remove("active");
    await load();
  });
  on("#summarize", "click", summarize);
  on("#compare", "click", comparePhotos);
  const seq = navSeq;
  refreshPhotos = () => {
    if (seq === navSeq) load().catch(() => {});
  };
  await load();
}
function drawMap(box, all) {
  const rows = all.filter((c) => c.gps);
  if (!rows.length) {
    box.innerHTML = empty(
      "No locations to show",
      "These photos have no GPS. Photos from the Snapoto app include the device location.",
    );
    return;
  }
  box.innerHTML =
    '<div id="photo-map-inline"></div><p class="muted">Device-reported locations; the circle shows GPS accuracy. Map © OpenStreetMap contributors.</p>';
  const map = L.map(box.querySelector("#photo-map-inline"));
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
  const points = [];
  for (const c of rows) {
    const point = [c.gps.latitude, c.gps.longitude];
    points.push(point);
    const popup = document.createElement("div");
    popup.textContent =
      (captionOf(c) || c.address || "Field photo") + " · " + fmt(c.captured_at_device);
    const open = document.createElement("button");
    open.textContent = "Open photo";
    open.className = "small";
    open.onclick = () => detail(c.id).catch((e) => toast(e.message));
    popup.append(document.createElement("br"), open);
    L.circleMarker(point, { radius: 8, color: "#235edb", fillOpacity: 0.85 })
      .addTo(map)
      .bindPopup(popup);
    if (c.gps.accuracy)
      L.circle(point, {
        radius: c.gps.accuracy,
        color: "#235edb",
        weight: 1,
        fillOpacity: 0.08,
      }).addTo(map);
  }
  map.fitBounds(points, { maxZoom: 15, padding: [30, 30] });
  setTimeout(() => map.invalidateSize(), 100);
}
async function summarize() {
  const records = await call("/captures");
  if (!records.length) return toast("Add a photo first.");
  const result = await call("/summary", "POST", {
    capture_ids: records.slice(0, 30).map((c) => c.id),
  });
  const d = modal(
    "Summary of recent photos",
    `<p class="notice">${AI} This is a draft. Check it against the photos, edit, then save.</p><textarea id="summary-edit" rows="10">${esc(result.summary)}</textarea><p><button id="save-summary" class="primary">Save reviewed summary</button></p><h3>Based on</h3><div class="actions">${(result.sources || []).map((cid, i) => `<button class="small" data-photo="${esc(cid)}">Photo ${i + 1}</button>`).join("")}</div>`,
  );
  on(
    "#save-summary",
    "click",
    async () => {
      await call(`/summaries/${result.id}`, "PATCH", {
        summary: d.querySelector("#summary-edit").value,
      });
      toast("Reviewed summary saved");
    },
    d,
  );
  bindPhotos(d);
}
async function comparePhotos() {
  const rows = await call("/captures");
  if (rows.length < 2) return toast("Add at least two photos to compare.");
  const d = modal(
    "Compare two photos",
    `<p class="muted">Originals side by side. Capture times come from each device.</p><div class="split even">${[0, 1]
      .map(
        (i) =>
          `<div><select data-comparison="${i}" aria-label="Photo ${i + 1}">${rows.map((c, j) => `<option value="${esc(c.id)}" ${j === i ? "selected" : ""}>${esc(captionOf(c) || c.collection || c.address || c.id.slice(0, 12))} · ${esc(fmt(c.captured_at_device))}</option>`).join("")}</select><div id="comparison-${i}"></div></div>`,
      )
      .join("")}</div>`,
    "wide",
  );
  const draw = () => {
    d.querySelectorAll("[data-comparison]").forEach((select) => {
      const c = rows.find((c) => c.id === select.value),
        a = c.assets.find((a) => a.kind === "original");
      d.querySelector("#comparison-" + select.dataset.comparison).innerHTML =
        (a
          ? `<img class="detail" style="margin-top:10px;border-radius:12px" src="${route(`/captures/${c.id}/assets/${a.id}`)}" alt="Original photo">`
          : "") +
        `<p>${esc(captionOf(c) || c.note)}</p><small>${esc(c.hash_check)}</small>`;
    });
  };
  d.querySelectorAll("select").forEach((s) => (s.onchange = draw));
  draw();
}

/* ---------- Photo detail ---------- */
// PRD §6: show each verification dimension separately, never one blanket claim.
function evidenceList(c) {
  const row = (label, ok, text, badge = ok ? "Yes" : "No") =>
    `<div class="evidence-row"><dt>${label}</dt><dd><span class="badge ${ok ? "" : "warn"}">${badge}</span>${esc(text)}</dd></div>`;
  const stored = c.cloud_state === "stored" && !c.deleted_at;
  const verified = c.hash_check === "verified" && !c.deleted_at;
  const attested = !["not_provided", undefined, null, ""].includes(
    c.attestation_state,
  );
  const late = receivedLate(c);
  return `<dl class="evidence">${[
    row("Saved on device", true, "It reached the cloud, so the device saved it first."),
    row(
      "Stored in cloud",
      stored,
      stored
        ? `Received ${fmt(c.server_received_at)}`
        : "Original no longer stored; it can’t be re-checked.",
    ),
    row(
      "File unchanged",
      verified,
      verified ? "SHA-256 fingerprint matched at upload" : "Cannot re-check: " + (c.hash_check || "unknown"),
    ),
    row(
      "Device source",
      attested,
      attested ? String(c.attestation_state) : "No device integrity proof; device identity not verified.",
      attested ? "Provided" : "Unverified",
    ),
    row(
      "Capture time",
      false,
      `Device clock: ${fmt(c.captured_at_device)}. ${late ? "Uploaded later (offline or delayed), so the server can’t vouch for the moment it was taken." : c.time_evidence || "Device-reported time."}`,
      late ? "Uploaded later" : "Device-reported",
    ),
    row(
      "Location",
      !!c.gps,
      c.location_evidence || (c.gps ? "Device-reported GPS" : "Not provided"),
      c.gps ? "Device-reported" : "None",
    ),
  ].join("")}</dl>`;
}
function aiBox(c, canEdit) {
  const ai = c.ai || { state: "off" };
  const state = ai.state || "off";
  const cap = captionOf(c);
  const edited = !!(c.caption || ai.caption_edited);
  const analyzeBtn = canEdit
    ? `<button class="small ${state === "done" ? "ghost" : "primary"}" id="analyze">${state === "done" ? "Re-analyze" : state === "failed" ? "Try again" : "Analyze with AI"}</button>`
    : "";
  let body = "";
  if (state === "pending")
    body = '<p class="muted">AI is looking at this photo… this takes a few seconds.</p>';
  else if (state === "failed")
    body = `<p class="error">AI couldn’t read this photo${ai.error ? ": " + esc(ai.error) : "."}</p>`;
  else if (state === "off" && !cap)
    body = '<p class="muted">AI hasn’t looked at this photo yet. It can write a caption and find order numbers, plates, meter readings and serials for you to confirm.</p>';
  const findings = (ai.findings || []).filter((f) => f.status !== "dismissed");
  const findingHtml = findings
    .map((f) => {
      const val = f.status === "accepted" ? f.accepted_value ?? f.value : f.value;
      return `<div class="finding ${esc(f.status)}" data-finding="${esc(f.id)}"><div class="top"><strong>${esc(fieldNames[f.field] || f.field)}</strong>${f.status === "accepted" ? '<span class="badge">✓ Confirmed</span>' : `<span class="muted" style="font-size:13px">${Math.round((f.confidence || 0) * 100)}% sure</span>`}</div><div class="value">${esc(val)}</div>${f.where ? `<p class="why">Seen: ${esc(f.where)}</p>` : ""}${f.status === "proposed" && conflicts(c, f) ? `<p class="why">Order # ${esc(c.order_number)} is already confirmed by a person, so this reading won’t replace it.</p>${canEdit ? `<div class="actions"><button class="small ghost" data-fdismiss="${esc(f.id)}">Dismiss</button></div>` : ""}` : f.status === "proposed" && canEdit ? `<div class="actions"><button class="small primary" data-faccept="${esc(f.id)}">Confirm</button><button class="small" data-fedit="${esc(f.id)}">Edit</button><button class="small ghost" data-fdismiss="${esc(f.id)}">Dismiss</button></div>` : ""}</div>`;
    })
    .join("");
  const tags = (ai.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  return `<div class="card-head"><h3>${edited ? "Caption" : "Caption " + AI}</h3>${analyzeBtn}</div>${body}${
    cap || (canEdit && state === "done")
      ? `<label for="caption" class="sr" style="margin:0 0 6px;font-weight:500;font-size:13px;color:var(--muted)">${edited ? "Edited by you" : "Suggested caption — edit if it’s wrong"}</label><textarea id="caption" rows="2" ${canEdit ? "" : "disabled"}>${esc(cap)}</textarea>${canEdit ? '<p><button class="small" id="save-caption">Save caption</button></p>' : ""}`
      : ""
  }${tags ? `<div class="tags" style="margin-top:6px">${tags}</div>` : ""}${findingHtml ? `<h3 style="margin-top:16px">AI found ${AI}</h3>${findingHtml}` : ""}${ai.issues?.length ? `<div class="issues"><strong>Worth a look</strong><ul>${ai.issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>` : ""}${state === "done" ? `<p class="suggest-note" style="margin-top:12px">Suggestions by ${esc(ai.model || "AI")}${ai.analyzed_at ? " · " + esc(fmt(ai.analyzed_at)) : ""}. Nothing is used until you confirm it.</p>` : ""}`;
}
async function detail(cid) {
  const [c, ts] = await Promise.all([call(`/captures/${cid}`), maybe("/templates", [])]);
  if (!memberNames.size) await loadMembers();
  const admin = isAdmin();
  const canEdit = space.role !== "Viewer" && (admin || c.created_by === me.id);
  const allConnectors = admin
    ? (await maybe("/connectors", [])).filter((x) => x.status === "connected")
    : [];
  const archiveConnectors = allConnectors.filter((x) =>
    ["drive", "onedrive"].includes(x.provider),
  );
  const emailConnectors = allConnectors.filter((x) =>
    ["gmail", "microsoft"].includes(x.provider),
  );
  const rendered = c.assets.filter((a) => a.kind === "rendered").at(-1);
  const original = c.assets.find((a) => ["original", "video"].includes(a.kind));
  const first = rendered || original;
  const src = (a) => route(`/captures/${cid}/assets/${a.id}`);
  const kindName = (k) =>
    ({ rendered: "Watermarked copy", original: "Original photo", selfie: "Front camera original", video: "Original video", audio: "Voice note" })[k] || k;
  const defaultTpl = ts.find((t) => t.is_default) || ts[0];
  const verifiedAll = c.hash_check === "verified" && !c.deleted_at;
  const history = [
    [c.captured_at_device, "Photo taken (device clock)"],
    [c.server_received_at, "Stored in cloud and fingerprint checked"],
    [c.ai?.analyzed_at, "AI described the photo"],
    ...c.assets.filter((a) => a.kind === "rendered").map((a) => [a.created_at, "Watermarked copy made"]),
    [c.order_confirmed ? c.updated_at : null, "Order number confirmed"],
  ].filter(([t]) => t);
  const d = modal(
    "Photo record",
    `<div class="detail-grid"><div class="viewer">${
      rendered && original && original.kind === "original"
        ? `<div class="seg" role="group" aria-label="Photo version"><button data-show="rendered" class="active">Watermarked</button><button data-show="original">Original</button></div>`
        : ""
    }<div class="frame">${first?.kind === "video" ? `<video controls class="detail" src="${src(first)}"></video>` : first ? `<img id="detail-img" class="detail" src="${src(first)}" alt="${esc(captionOf(c) || "Photo record")}">` : '<p style="color:#fff">No preview for this record</p>'}</div><div class="viewer-bar"><div class="actions">${statusChip(c)}<span class="muted">${esc(fmt(c.captured_at_device))}</span></div>${admin ? '<button class="primary" id="quick-share">Share link</button>' : ""}</div><div id="quick-share-result"></div></div><div class="side"><section class="card ai-card" id="ai-box">${aiBox(c, canEdit)}</section><section class="card"><h3>Details</h3><dl class="facts" style="margin-top:10px"><dt>Taken by</dt><dd>${esc(memberNames.get(c.created_by) || "Team member")}</dd><dt>When</dt><dd>${esc(fmt(c.captured_at_device))}</dd><dt>Where</dt><dd>${esc(c.address || "No address")}</dd>${c.gps ? `<dt>GPS</dt><dd>${esc(Number(c.gps.latitude).toFixed(5))}, ${esc(Number(c.gps.longitude).toFixed(5))}${c.gps.accuracy ? " ±" + esc(Math.round(c.gps.accuracy)) + " m" : ""}</dd>` : ""}${c.note ? `<dt>Note</dt><dd>${esc(c.note)}</dd>` : ""}${Object.entries(c.fields || {}).map(([k, v]) => `<dt>${esc(fieldNames[k] || k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${
      canEdit
        ? `<details class="fold"><summary>Edit details</summary><label>Address label</label><input id="address" value="${esc(c.address)}"><small>Changing the label never changes the original GPS.</small><label>Note</label><textarea id="note" rows="3">${esc(c.note)}</textarea><label>Collection</label><input id="collection" value="${esc(c.collection)}"><div class="actions" style="margin-top:12px"><button id="save-detail" class="primary small">Save details</button>${c.assets.some((a) => a.kind === "audio") ? '<button class="small" id="transcribe">✦ Transcribe voice note</button>' : ""}</div></details>`
        : ""
    }</section>${
      admin
        ? `<section class="card"><div class="card-head"><h3>Order number</h3>${c.order_confirmed ? '<span class="badge">Confirmed</span>' : c.order_number ? '<span class="badge warn">Not confirmed</span>' : ""}</div><label>Order number</label><input id="order" value="${esc(c.order_number)}"><label><input type="checkbox" id="confirmed" ${c.order_confirmed ? "checked" : ""}>I checked this number against the photo</label><div class="actions" style="margin-top:12px"><button id="save-detail-verify" class="primary small">Save verification</button><button id="ocr" class="small">✦ Read with AI</button></div></section>`
        : ""
    }${
      canEdit
        ? `<section class="card"><h3>Watermark</h3><p class="muted" style="font-size:14px">Draws your fields on a copy. The original stays untouched.</p>${ts.length ? `<label>Watermark</label><select id="render-template">${ts.map((t) => `<option value="${esc(t.id)}" ${t.id === defaultTpl?.id ? "selected" : ""}>${esc(t.name)} · v${esc(t.version)}</option>`).join("")}</select><div class="actions" style="margin-top:12px"><button id="render" class="small">Create watermarked image</button>${rendered ? `<a class="btn small" href="${src(rendered)}" download>Download rendered</a>` : ""}</div>` : '<p class="muted">No watermark yet. Make one in Settings › Watermarks.</p>'}</section>`
        : ""
    }${
      admin
        ? `<section class="card"><h3>Send to customer</h3><p class="muted" style="font-size:14px">A private link with the photo and its Verified ✓ page. The customer can confirm receipt or report a problem.</p><details class="fold"><summary>Link options</summary><label>Expires after (days)</label><input id="days" type="number" value="7" min="1" max="365"><label><input id="download" type="checkbox">Allow original download</label><label><input id="acknowledge" type="checkbox" checked>Let the customer confirm or report a problem</label>${emailConnectors.length ? `<label><input id="require-otp" type="checkbox">Require the customer to verify their email</label><label>Customer email</label><input id="recipient-email" type="email"><label>Send codes using</label><select id="otp-connector">${emailConnectors.map((x) => `<option value="${esc(x.id)}">${esc(x.provider)}</option>`).join("")}</select>` : ""}<p><button id="share" class="small">Create private link</button></p>${archiveConnectors.length ? `<hr><label>Archive original to</label><select id="archive-connector">${archiveConnectors.map((x) => `<option value="${esc(x.id)}">${esc(x.provider)}</option>`).join("")}</select><p><button class="small" id="archive-original">Archive original</button></p>` : ""}</details><div id="share-result"></div><p class="suggest-note">To send automatically by email or SMS, set up an Automation — it asks you before anything ambiguous is sent.</p></section>`
        : ""
    }<details class="card"><summary><span>Verification ${verifiedAll ? '<span class="badge">Verified ✓</span>' : '<span class="badge warn">Check</span>'}</span></summary><div style="margin-top:10px">${evidenceList(c)}<p class="suggest-note">The watermark is text drawn on a copy. Proof comes from the original file and its fingerprint.</p>${c.assets.map((a) => `<p><strong>${esc(kindName(a.kind))}</strong><br><span class="hash">${esc(a.sha256)}</span><br><a href="${src(a)}" download>Save ${esc(kindName(a.kind).toLowerCase())} file</a></p>`).join("")}<p class="hash">Record ${esc(cid)}</p></div></details><details class="card"><summary>History</summary><ul class="timeline">${history.map(([t, l]) => `<li>${esc(l)} <small>· ${esc(fmt(t))}</small></li>`).join("")}</ul></details></div></div>`,
    "wide",
  );
  // Watermarked / Original toggle.
  on(
    "[data-show]",
    "click",
    async (e, el) => {
      const a = el.dataset.show === "rendered" ? rendered : original;
      d.querySelector("#detail-img").src = src(a);
      d.querySelectorAll("[data-show]").forEach((b) => b.classList.toggle("active", b === el));
    },
    d,
  );
  const bindAI = (cur) => {
    const box = d.querySelector("#ai-box");
    if (!box) return;
    box.innerHTML = aiBox(cur, canEdit);
    labelize(box);
    on(
      "#analyze",
      "click",
      async (e, el) => {
        el.disabled = true;
        try {
          const next = await call(`/captures/${cid}/analyze`, "POST");
          bindAI(next);
          poll(next);
        } catch (err) {
          el.disabled = false;
          if (missing(err)) throw new Error("AI analysis isn’t available on this server yet.");
          throw err;
        }
      },
      box,
    );
    on(
      "#save-caption",
      "click",
      async () => {
        const caption = box.querySelector("#caption").value.trim();
        const next = await call(`/captures/${cid}`, "PATCH", { caption });
        if ((next.caption ?? next.ai?.caption) !== caption && !next.ai?.caption_edited)
          throw new Error("Caption editing isn’t available on this server yet.");
        bindAI(next);
        toast("Caption saved");
      },
      box,
    );
    const decide = async (fid, action, value) => {
      let next;
      if (action === "accept") next = await acceptFinding(cid, fid, value);
      else {
        try {
          next = await call(`/captures/${cid}/findings/${fid}`, "POST", { action });
        } catch (e) {
          if (missing(e)) throw new Error("This server can’t record that yet.");
          throw e;
        }
      }
      bindAI(next);
      const order = d.querySelector("#order");
      if (order) {
        order.value = next.order_number || "";
        d.querySelector("#confirmed").checked = !!next.order_confirmed;
      }
      toast(action === "accept" ? "Confirmed" : "Dismissed");
    };
    on("[data-faccept]", "click", async (e, el) => decide(el.dataset.faccept, "accept"), box);
    on("[data-fdismiss]", "click", async (e, el) => decide(el.dataset.fdismiss, "dismiss"), box);
    on(
      "[data-fedit]",
      "click",
      async (e, el) => {
        const card = el.closest("[data-finding]");
        const f = cur.ai.findings.find((x) => x.id === el.dataset.fedit);
        card.querySelector(".actions").innerHTML =
          `<input aria-label="Correct value" value="${esc(f.value)}" data-fvalue><button class="small primary" data-fsave>Save &amp; confirm</button><button class="small ghost" data-fcancel>Cancel</button>`;
        card.querySelector("[data-fvalue]").focus();
        on("[data-fsave]", "click", async () =>
          decide(f.id, "accept", card.querySelector("[data-fvalue]").value.trim()), card);
        on("[data-fcancel]", "click", async () => bindAI(cur), card);
      },
      box,
    );
  };
  let polls = 0;
  const poll = (cur) => {
    if (cur.ai?.state !== "pending" || polls++ > 10) return;
    setTimeout(async () => {
      if (!d.isConnected) return;
      try {
        const next = await api(route(`/captures/${cid}`));
        if (!d.isConnected) return;
        bindAI(next);
        poll(next);
      } catch {}
    }, 3000);
  };
  bindAI(c);
  poll(c);
  on(
    "#save-detail-verify",
    "click",
    async () => {
      await call(`/captures/${cid}`, "PATCH", {
        order_number: d.querySelector("#order").value,
        order_confirmed: d.querySelector("#confirmed").checked,
      });
      toast("Verification saved");
    },
    d,
  );
  on(
    "#save-detail",
    "click",
    async () => {
      // Order number/confirmation is saved only from its own card.
      await call(`/captures/${cid}`, "PATCH", {
        address: d.querySelector("#address").value,
        note: d.querySelector("#note").value,
        collection: d.querySelector("#collection").value,
      });
      toast("Details saved");
    },
    d,
  );
  on(
    "#archive-original",
    "click",
    async () => {
      await call(`/captures/${cid}/archive`, "POST", {
        connector_id: d.querySelector("#archive-connector").value,
      });
      toast("Archive request recorded. Check the provider for status.");
    },
    d,
  );
  on(
    "#ocr",
    "click",
    async () => {
      const result = await call(`/captures/${cid}/extract`, "POST");
      // The server never replaces a confirmed number with OCR output; mirror it.
      d.querySelector("#order").value = result.order_number || "";
      d.querySelector("#confirmed").checked = !!result.order_confirmed;
      const found = result.ocr?.output?.order_numbers || [];
      toast(
        result.order_confirmed
          ? `Confirmed number kept. AI read: ${found.join(", ") || "nothing"}.`
          : found.length === 1
            ? "AI suggestion filled in. Check it against the photo, then confirm."
            : "No single order number found. Check the photo.",
      );
    },
    d,
  );
  on(
    "#transcribe",
    "click",
    async () => {
      const result = await call(`/captures/${cid}/transcribe`, "POST");
      d.querySelector("#note").value = result.transcript.text;
      toast("Transcribed. Review it and save.");
    },
    d,
  );
  on(
    "#render",
    "click",
    async (e, el) => {
      el.disabled = true;
      try {
        await call(`/captures/${cid}/render`, "POST", {
          template_id: d.querySelector("#render-template").value,
        });
      } finally {
        el.disabled = false;
      }
      d.remove();
      await detail(cid);
    },
    d,
  );
  const shareResult = (box, s, copied) => {
    box.innerHTML = `<div class="linkbox"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a><button class="small" data-copy-link>${copied ? "Copied ✓" : "Copy"}</button></div><p class="suggest-note">Expires ${esc(fmt(s.expires_at))}. Opening the link counts as a view, not as confirmation. <button class="ghost small" data-revoke-link>Revoke</button></p>`;
    on("[data-copy-link]", "click", async (e, el) => {
      el.textContent = (await copyText(s.url)) ? "Copied ✓" : "Select & copy";
    }, box);
    on("[data-revoke-link]", "click", async () => {
      await call(`/shares/${s.id}`, "DELETE");
      box.innerHTML = '<p class="muted">Link revoked. It no longer opens.</p>';
    }, box);
  };
  on(
    "#quick-share",
    "click",
    async (e, el) => {
      el.disabled = true;
      try {
        const s = await call(`/captures/${cid}/shares`, "POST", {
          ...(defaultTpl && !rendered ? { template_id: defaultTpl.id } : {}),
          days: 7,
          download: false,
          acknowledge: true,
        });
        const copied = await copyText(s.url);
        shareResult(d.querySelector("#quick-share-result"), s, copied);
        toast(copied ? "Share link copied" : "Share link ready");
      } finally {
        el.disabled = false;
      }
    },
    d,
  );
  on(
    "#share",
    "click",
    async () => {
      const otp = !!d.querySelector("#require-otp")?.checked;
      const s = await call(`/captures/${cid}/shares`, "POST", {
        template_id: d.querySelector("#render-template")?.value || undefined,
        days: Number(d.querySelector("#days").value),
        download: d.querySelector("#download").checked,
        acknowledge: d.querySelector("#acknowledge").checked,
        require_otp: otp,
        ...(otp
          ? {
              recipient_email: d.querySelector("#recipient-email").value.trim(),
              otp_connector_id: d.querySelector("#otp-connector").value,
            }
          : {}),
      });
      shareResult(d.querySelector("#share-result"), s, false);
    },
    d,
  );
}

/* ---------- Watermarks (Settings › Watermarks) ---------- */
const watermarkFields = [
  "date",
  "time",
  "timezone",
  "address",
  "gps",
  "accuracy",
  "company",
  "phone",
  "employee",
  "order_number",
  "plate",
  "meter",
  "serial",
  "note",
  "custom",
  "verification",
  "logo",
  "qr",
];
const fieldLabel = (f) =>
  ({
    gps: "GPS",
    qr: "QR code",
    order_number: "order number",
    serial: "serial number",
    meter: "meter reading",
    plate: "license plate",
  })[f] || f.replaceAll("_", " ");
const subBody = (html) => {
  const el = document.querySelector("#settings-body");
  el.innerHTML = html;
  labelize(el);
};
async function templates() {
  const ts = await call("/templates");
  subBody(
    `<div class="card-head"><div><h2>Watermarks</h2><p class="muted">What gets printed inside the photo. The original always stays untouched, and Snapoto never adds its own branding.</p></div>${button("Create template", "new-template", "primary")}</div>${ts.length ? `<div class="grid">${ts.map((t) => `<section class="card tpl-card"><div class="card-head"><h2>${esc(t.name)}</h2>${t.is_default ? '<span class="badge info">Default</span>' : ""}</div><small>Version ${esc(t.version)}</small><div class="fields-line">${t.fields.map((x) => `<span class="tag">${esc(fieldLabel(x))}${t.locked_fields?.includes(x) ? " 🔒" : ""}</span>`).join("")}</div><div class="actions"><button class="small" data-edit="${esc(t.id)}">Edit</button><button class="small" data-copy="${esc(t.id)}">Copy</button>${t.is_default ? "" : `<button class="small" data-default="${esc(t.id)}">Set as default</button>`}<button data-delete="${esc(t.id)}" class="small ghost danger" aria-label="Delete template ${esc(t.name)}">Delete</button></div></section>`).join("")}</div>` : empty("Make your watermark", "Describe your job in a sentence and AI suggests the fields. Or pick them yourself.", '<button class="primary" id="new-template-empty">Create template</button>')}`,
  );
  on("#new-template, #new-template-empty", "click", () => templateEditor());
  on("[data-edit]", "click", (e, el) =>
    templateEditor(ts.find((t) => t.id === el.dataset.edit)),
  );
  on("[data-copy]", "click", (e, el) => {
    const t = ts.find((t) => t.id === el.dataset.copy);
    // A copy never silently takes over as the space default.
    return templateEditor({ ...t, id: undefined, name: t.name + " copy", is_default: false });
  });
  on("[data-default]", "click", async (e, el) => {
    const t = ts.find((t) => t.id === el.dataset.default);
    await call(`/templates/${t.id}`, "PUT", { ...templateBody(t), is_default: true });
    toast(`“${t.name}” is now the default for new photos.`);
    await templates();
  });
  on("[data-delete]", "click", async (e, el) => {
    const t = ts.find((t) => t.id === el.dataset.delete);
    if (
      !confirm(
        `Delete “${t.name}”? Existing watermarked images stay; automations that froze this version keep using it.`,
      )
    )
      return;
    await call(`/templates/${el.dataset.delete}`, "DELETE");
    await templates();
  });
}
const templateBody = (t) => ({
  logo_data: t.logo_data || "",
  name: t.name,
  fields: t.fields,
  locked_fields: t.locked_fields || [],
  font_size: t.font_size,
  opacity: t.opacity,
  position: t.position,
  custom: t.custom || "",
  is_default: !!t.is_default,
});
function templateEditor(
  t = {
    name: "",
    fields: ["date", "time", "address"],
    locked_fields: [],
    font_size: 24,
    position: "bottom-left",
    opacity: 0.6,
    custom: "",
    is_default: false,
  },
) {
  const rowsHtml = (fields, locked) =>
    [...fields, ...watermarkFields.filter((f) => !fields.includes(f))]
      .map(
        (f) =>
          `<li data-field="${f}"><label class="grow"><input type="checkbox" name="fields" value="${f}" ${fields.includes(f) ? "checked" : ""}>${fieldLabel(f)}</label><label class="lock"><input type="checkbox" name="locked" value="${f}" ${locked.includes(f) ? "checked" : ""}>Required</label><button type="button" data-move="-1" aria-label="Move ${fieldLabel(f)} up">↑</button><button type="button" data-move="1" aria-label="Move ${fieldLabel(f)} down">↓</button></li>`,
      )
      .join("");
  const d = modal(
    t.id ? "Edit watermark" : "Create a watermark",
    `<form id="template-form"><div class="split even"><div>${
      isAdmin()
        ? `<div class="wizard"><h3>Describe your job ${AI}</h3><p class="muted" style="font-size:14px">One sentence. AI suggests the fields; nothing is saved until you press Save.</p><div class="ask"><input id="job-desc" placeholder="HVAC installs, need unit serial and customer name" aria-label="Describe your job"><button type="button" id="suggest" class="primary">Suggest</button></div><p class="suggest-note" id="suggest-note"></p></div>`
        : ""
    }<label>Template name</label><input name="name" value="${esc(t.name)}" required><fieldset class="fieldorder"><legend>Fields, in order</legend><p class="muted" style="font-size:13px;margin:4px 0">Tick to show. “Required” stops members from removing it.</p><ol id="field-rows">${rowsHtml(t.fields, t.locked_fields || [])}</ol></fieldset><label>Company logo (PNG/JPEG, up to 250 KB)</label><input name="logo" type="file" accept="image/png,image/jpeg"><label>Custom text</label><input name="custom" value="${esc(t.custom)}"><label><input type="checkbox" name="is_default" ${t.is_default ? "checked" : ""}>Use for new photos (default)</label></div><div><h3>Live preview</h3><div class="preview" style="margin-top:10px"><div class="watermark" id="watermark"></div></div><small>Sample photo. Render on a real photo to see the final result.</small><label>Position</label><select name="position">${["bottom-left", "bottom-right", "top-left", "top-right"].map((p) => `<option ${t.position === p ? "selected" : ""}>${p}</option>`).join("")}</select><label>Text size</label><input type="range" name="font_size" min="14" max="64" value="${esc(t.font_size)}"><label>Background darkness</label><input type="range" name="opacity" min="0.2" max="0.9" step="0.1" value="${esc(t.opacity)}"><p style="margin-top:24px"><button class="primary big">Save template</button></p></div></div></form>`,
    "wide",
  );
  const form = d.querySelector("form");
  const rows = d.querySelector("#field-rows");
  rows.addEventListener("click", (e) => {
    const b = e.target.closest("[data-move]");
    if (!b) return;
    const li = b.closest("li");
    const target =
      b.dataset.move === "-1" ? li.previousElementSibling : li.nextElementSibling;
    if (!target) return;
    if (b.dataset.move === "-1") target.before(li);
    else target.after(li);
    b.focus();
    preview();
  });
  // Required implies shown; unshowing clears required.
  rows.addEventListener("change", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    const show = li.querySelector("[name=fields]"),
      lock = li.querySelector("[name=locked]");
    if (e.target === lock && lock.checked) show.checked = true;
    if (e.target === show && !show.checked) lock.checked = false;
  });
  function preview() {
    const f = new FormData(form);
    const w = d.querySelector("#watermark");
    w.textContent = f
      .getAll("fields")
      .map(
        (x) =>
          ({
            date: new Date().toLocaleDateString(),
            time: "10:42:08 (device)",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            address: "1480 Market Street",
            gps: "37.77490, -122.41940",
            accuracy: "±8 m",
            phone: space.settings?.phone || "Contact phone",
            employee: me.name,
            order_number: "Order SO-48213",
            plate: "Plate 7ABC123",
            meter: "Meter 004512 kWh",
            serial: "S/N HX-20931",
            company: space.settings?.company || space.name,
            custom: f.get("custom") || "Custom text",
            verification: "Verify: snapoto link",
            note: "Delivered to dock B",
            logo: "[logo]",
            qr: "[QR]",
          })[x] || x.replaceAll("_", " "),
      )
      .join("\n");
    w.style.fontSize = f.get("font_size") / 1.7 + "px";
    w.style.background = `rgba(0,0,0,${f.get("opacity")})`;
    const p = f.get("position");
    Object.assign(w.style, {
      top: p.startsWith("top") ? "0" : "auto",
      bottom: p.startsWith("bottom") ? "0" : "auto",
      left: p.endsWith("left") ? "0" : "auto",
      right: p.endsWith("right") ? "0" : "auto",
    });
  }
  form.oninput = preview;
  preview();
  on(
    "#suggest",
    "click",
    async (e, el) => {
      const description = d.querySelector("#job-desc").value.trim();
      const note = d.querySelector("#suggest-note");
      if (description.length < 3) {
        d.querySelector("#job-desc").focus();
        throw new Error("Describe your job in a few words first.");
      }
      el.disabled = true;
      note.textContent = "Thinking…";
      try {
        const s = await call("/templates/suggest", "POST", { description });
        const fields = (s.fields || []).filter((f) => watermarkFields.includes(f));
        const locked = (s.locked_fields || []).filter((f) => fields.includes(f));
        rows.innerHTML = rowsHtml(fields, locked);
        if (s.name && !form.elements.name.value) form.elements.name.value = s.name;
        if (s.custom && !form.elements.custom.value) form.elements.custom.value = s.custom;
        note.innerHTML = `${AI} Suggested ${fields.length} fields${s.reason ? ": " + esc(s.reason) : "."} Adjust anything, then save.`;
        preview();
      } catch (err) {
        note.textContent =
          missing(err) || err.status === 503
            ? "AI suggestions aren’t available on this server right now. Pick the fields below."
            : err.message;
      } finally {
        el.disabled = false;
      }
    },
    d,
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const f = new FormData(form);
      let logo = t.logo_data || "";
      const logoFile = f.get("logo");
      if (logoFile?.size) {
        if (logoFile.size > 250000) throw new Error("Logo must be under 250 KB");
        logo = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(logoFile);
        });
      }
      const b = {
        logo_data: logo,
        name: f.get("name"),
        // FormData follows DOM order, which is the user's chosen order.
        fields: f.getAll("fields"),
        locked_fields: f.getAll("locked"),
        font_size: Number(f.get("font_size")),
        opacity: Number(f.get("opacity")),
        position: f.get("position"),
        custom: f.get("custom"),
        is_default: f.has("is_default"),
      };
      await call(t.id ? `/templates/${t.id}` : "/templates", t.id ? "PUT" : "POST", b);
      d.remove();
      if (document.querySelector("#settings-body")) await templates();
    } catch (e) {
      toast(e.message);
    }
  };
}

/* ---------- Automations ---------- */
const runState = {
  queued: "Queued",
  retry: "Retrying",
  needs_review: "Needs your review",
  paused: "Paused",
  completed: "Done",
};
async function automations() {
  const [rules, o] = await Promise.all([call("/rules"), call("/overview")]);
  const jobs = [...o.jobs].sort(
    (a, b) =>
      (a.state === "needs_review" ? 0 : 1) - (b.state === "needs_review" ? 0 : 1),
  );
  actions(button("New automation", "new-rule", "primary"));
  content(
    `<div class="notice">Describe what should happen after a photo, in plain words. Every automation is previewed, tested without sending, and approved by you. Anything unclear waits for you — it never guesses a recipient.</div>${
      rules.length
        ? `<div class="stack">${rules.map((r) => `<section class="card"><div class="card-head"><div><h2>${esc(r.name)}</h2><p class="muted" style="margin:4px 0 0">${r.dry_run_at ? `Tested ${esc(fmt(r.dry_run_at))}: ${esc(r.dry_run_result?.state === "ready_for_review" ? "one customer matched" : "would wait for your review")}` : "Not tested yet. Run a test before turning it on."}</p></div><span class="badge ${r.enabled ? "" : "neutral"}">${r.enabled ? "On" : "Draft / paused"}</span></div><p>${esc(r.draft_text)}</p><ol class="checklist">${r.dsl.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><small>Up to ${esc(r.dsl.daily_limit)} messages/day · ${esc(r.dsl.recipient_domain || "Approved sheet contacts")} · Version ${esc(r.version)}</small><div class="actions" style="margin-top:14px"><button class="small" data-edit-rule="${esc(r.id)}" ${r.enabled ? "disabled" : ""}>Edit</button><button class="small" data-test="${esc(r.id)}">Dry-run test</button><button class="small ${r.enabled ? "" : "primary"}" data-toggle="${esc(r.id)}" data-enabled="${r.enabled}" ${!r.enabled && !r.dry_run_at ? 'disabled title="Run a dry-run test first"' : ""}>${r.enabled ? "Pause" : "Approve & enable"}</button></div></section>`).join("")}</div>`
        : empty("Give your photos a next step", "Example: “Read the order number, find the customer in Sheets and email them the photo link. If anything is unclear, ask me.”", '<button class="primary" id="new-rule-empty">New automation</button>')
    }<div class="section-title"><h2>Runs</h2><small>Items that need you come first</small></div><section class="card">${jobs.map((j) => `<div class="row"><div><strong>${esc(j.rule.name)}</strong> <span class="badge ${j.state === "completed" ? "" : j.state === "needs_review" ? "warn" : "neutral"}">${esc(runState[j.state] || j.state)}</span><p class="muted">${esc(j.logs.at(-1)?.message || "Queued")}</p></div><div class="actions">${["needs_review", "paused", "retry"].includes(j.state) ? `<button class="small" data-retry-run="${esc(j.id)}">Retry</button>` : ""}<button class="small" data-photo="${esc(j.capture_id)}">Open photo</button></div></div>`).join("") || '<p class="muted">No runs yet. A message the provider already accepted is never sent twice.</p>'}</section>`,
  );
  on("#new-rule, #new-rule-empty", "click", () => ruleEditor());
  on("[data-edit-rule]", "click", (e, el) =>
    ruleEditor(rules.find((r) => r.id === el.dataset.editRule)),
  );
  on("[data-retry-run]", "click", async (e, el) => {
    await call(`/runs/${el.dataset.retryRun}/retry`, "POST");
    await automations();
  });
  on("[data-toggle]", "click", async (e, el) => {
    await call(`/rules/${el.dataset.toggle}`, "PATCH", {
      enabled: el.dataset.enabled !== "true",
    });
    await automations();
  });
  on("[data-test]", "click", async (e, el) => {
    const d = modal(
      "Test without sending",
      `<p>Uses a pretend customer list to check matching. No message is sent and no provider is called.</p><label>Order number read from the photo</label><input id="test-order" value="TEST-1001"><label>Customer rows (JSON)</label><textarea id="customers">[{"order":"TEST-1001","email":"customer@example.com"}]</textarea><p><button id="run-test" class="primary">Run test</button></p><pre id="test-result" class="code" hidden></pre>`,
    );
    on(
      "#run-test",
      "click",
      async () => {
        let customers;
        try {
          customers = JSON.parse(d.querySelector("#customers").value);
        } catch {
          throw new Error(
            'Customer rows must be valid JSON, e.g. [{"order":"TEST-1001","email":"a@b.com"}]',
          );
        }
        const result = await call(`/rules/${el.dataset.test}/test`, "POST", {
          order_number: d.querySelector("#test-order").value,
          customers,
        });
        const out = d.querySelector("#test-result");
        out.hidden = false;
        out.textContent = [
          `Result: ${result.state}`,
          result.state === "ready_for_review"
            ? "Exactly one customer matched. A live run would deliver to that contact."
            : `${result.matches} matching customers. A live run would hold this for your review and send nothing.`,
          "Nothing was sent.",
          result.estimated_cost,
          "",
          "Steps:",
          ...(result.steps || []).map((x, i) => `${i + 1}. ${x}`),
        ].join("\n");
        automations().catch(() => {});
      },
      d,
    );
  });
  bindPhotos();
}
async function ruleEditor(existing = null) {
  const [savedTemplates, connectors] = await Promise.all([
    call("/templates"),
    call("/connectors"),
  ]);
  const connected = new Set(
    connectors.filter((c) => c.status === "connected").map((c) => c.provider),
  );
  const d = modal(
    "What should happen after a photo?",
    `<label>Name</label><input id="rule-name" placeholder="Send customer photo records"><label>Describe it in plain words</label><textarea id="rule-text" placeholder="When a photo arrives, read the order number, find the customer in Sheets and email them a verification link. If anything is unclear, ask me."></textarea><p><button id="compile" class="primary">Preview workflow</button></p><div id="compiled"></div>`,
  );
  if (existing) {
    d.querySelector("#rule-name").value = existing.name;
    d.querySelector("#rule-text").value = existing.draft_text;
  }
  // Editing the description invalidates the preview it produced.
  d.querySelector("#rule-text").addEventListener("input", () => {
    d.querySelector("#compiled").innerHTML = "";
  });
  on(
    "#compile",
    "click",
    async () => {
      const text = d.querySelector("#rule-text").value;
      const r = await call("/rules/compile", "POST", { text });
      d.querySelector("#compiled").innerHTML =
        `<div class="notice">Here’s what it will do. Review every step; anything not listed won’t run.</div><ol class="checklist">${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><label>Send by</label><select id="channel"><option value="email">Email</option><option value="sms" ${r.channel === "sms" ? "selected" : ""}>SMS</option></select><label>Email action</label><select id="delivery-mode"><option value="send">Send after approval</option><option value="draft">Create draft only (email)</option></select><label>Watermark on shared photo</label><select id="rule-template"><option value="">Space default / original</option>${savedTemplates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} · v${esc(t.version)}</option>`).join("")}</select><label>Daily limit</label><input id="limit" type="number" value="100" min="1" max="1000"><label>Only send to this email domain (optional)</label><input id="domain" placeholder="customer.com"><div id="rule-readiness" class="card" style="margin:16px 0" aria-live="polite"></div><button id="save-rule" class="primary">Save draft</button>`;
      const readiness = () => {
        const channel = d.querySelector("#channel").value;
        const mode = d.querySelector("#delivery-mode");
        if (channel === "sms") mode.value = "send";
        mode.disabled = channel === "sms";
        const needs = [
          ["Google Sheets (customer lookup)", connected.has("sheets")],
          channel === "sms"
            ? ["Twilio SMS", connected.has("twilio")]
            : ["Gmail or Microsoft 365", connected.has("gmail") || connected.has("microsoft")],
        ];
        const domain = d.querySelector("#domain").value.trim();
        const limit = Number(d.querySelector("#limit").value) || 0;
        d.querySelector("#rule-readiness").innerHTML =
          `<h3>Before it can run</h3><ul class="checklist">${needs.map(([n, ok]) => `<li>${ok ? "✓" : "✗"} ${esc(n)}: ${ok ? "connected" : "<strong>not connected</strong> — connect it in Settings › Connections"}</li>`).join("")}<li>Who it can contact: only the one customer whose row uniquely matches a confirmed order number${domain ? `, and only addresses at ${esc(domain)}` : ""}. Anything ambiguous waits for you.</li><li>Cost: up to ${limit} ${channel === "sms" ? "text messages" : "emails"} a day, billed by your provider; reading order numbers uses one AI request per photo.</li><li>Next: save the draft, run a test (nothing is sent), then approve.</li></ul>`;
      };
      ["#channel", "#domain", "#limit"].forEach((sel) =>
        d.querySelector(sel).addEventListener("input", readiness),
      );
      labelize(d);
      if (existing) {
        d.querySelector("#channel").value = existing.dsl.channel;
        d.querySelector("#delivery-mode").value = existing.dsl.delivery_mode || "send";
        d.querySelector("#limit").value = existing.dsl.daily_limit;
        d.querySelector("#domain").value = existing.dsl.recipient_domain;
        d.querySelector("#rule-template").value = existing.template_snapshot?.id || "";
      }
      readiness();
      on(
        "#save-rule",
        "click",
        async () => {
          await call(existing ? `/rules/${existing.id}` : "/rules", existing ? "PUT" : "POST", {
            name: d.querySelector("#rule-name").value,
            text,
            channel: d.querySelector("#channel").value,
            delivery_mode: d.querySelector("#delivery-mode").value,
            daily_limit: Number(d.querySelector("#limit").value),
            recipient_domain: d.querySelector("#domain").value,
            template_id: d.querySelector("#rule-template").value || undefined,
          });
          d.remove();
          await automations();
        },
        d,
      );
    },
    d,
  );
}

/* ---------- Team ---------- */
async function team() {
  const members = await call("/members");
  actions(button("Invite member", "invite", "primary"));
  const roleHelp = {
    Owner: "Everything, including developer keys",
    Admin: "Confirms orders, shares, runs automations",
    Member: "Takes photos, sees their own",
    Viewer: "Read-only, gets daily reports",
  };
  content(
    `<div class="split"><section class="card"><div class="card-head"><h2>${esc(space.name)}</h2><span class="badge neutral">${members.length} ${members.length === 1 ? "person" : "people"}</span></div><div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>${members.map((m) => `<tr><td><span class="member"><span class="avatar" aria-hidden="true">${esc(initials(m.name))}</span>${esc(m.name)}${m.id === me.id ? ' <small>(you)</small>' : ""}</span></td><td>${esc(m.email)}</td><td>${space.role === "Owner" && m.id !== me.id ? `<select data-member-role="${esc(m.id)}" aria-label="Role for ${esc(m.name)}">${["Admin", "Member", "Viewer"].map((role) => `<option ${m.role === role ? "selected" : ""}>${role}</option>`).join("")}</select>` : esc(m.role)}</td></tr>`).join("")}</tbody></table></div>${members.length < 2 ? '<p class="muted" style="margin-top:14px">Just you so far. Invite your crew — they join with one link and their photos land here.</p>' : ""}</section><div class="stack"><section class="card"><h2>Roles</h2><dl class="facts" style="margin-top:10px">${Object.entries(roleHelp).map(([r, h]) => `<dt>${r}</dt><dd>${h}</dd>`).join("")}</dl></section><section class="card"><h2>Create another team</h2><p class="muted">Personal photos stay private. A new team gets its own members, photos and automations. Photos never move between spaces.</p><label>Team name</label><input id="team-name" placeholder="Your company"><p><button id="create-team">Create team</button></p></section></div></div>`,
  );
  on("[data-member-role]", "change", async (e, el) => {
    await call(`/members/${el.dataset.memberRole}`, "PATCH", { role: el.value });
    toast("Role updated");
  });
  on("#invite", "click", () => {
    const d = modal(
      "Invite to " + space.name,
      `<label>Role</label><select id="role"><option>Member</option><option>Admin</option><option>Viewer</option></select><p class="muted">The link works once and expires after 3 days.</p><button id="make-invite" class="primary">Create invitation link</button><div id="invite-result"></div>`,
    );
    on(
      "#make-invite",
      "click",
      async () => {
        const r = await call("/invites", "POST", { role: d.querySelector("#role").value });
        d.querySelector("#invite-result").innerHTML =
          `<div class="linkbox"><span>${esc(r.url)}</span><button class="small" id="copy-invite">Copy</button></div>`;
        on("#copy-invite", "click", async (e, el) => {
          el.textContent = (await copyText(r.url)) ? "Copied ✓" : "Select & copy";
        }, d);
      },
      d,
    );
  });
  on("#create-team", "click", async () => {
    const r = await api("/api/spaces", "POST", {
      name: document.querySelector("#team-name").value,
    });
    try {
      localStorage.space = r.id;
    } catch {}
    await init();
  });
}

/* ---------- Settings ---------- */
async function settings() {
  const admin = isAdmin();
  const tabs = admin
    ? ["General", "Watermarks", "Connections", ...(space.role === "Owner" ? ["Advanced"] : [])]
    : ["General"];
  if (!tabs.includes(settingsTab)) settingsTab = "General";
  content(
    `${tabs.length > 1 ? `<div class="subtabs" role="tablist">${tabs.map((t) => `<button role="tab" data-settings-tab="${t}" class="${t === settingsTab ? "active" : ""}" aria-selected="${t === settingsTab}">${t}</button>`).join("")}</div>` : ""}<div id="settings-body"><p class="loading">Loading…</p></div>`,
  );
  on("[data-settings-tab]", "click", async (e, el) => {
    settingsTab = el.dataset.settingsTab;
    await shell();
  });
  await { General: general, Watermarks: templates, Connections: connections, Advanced: developer }[settingsTab]();
}
async function general() {
  const admin = isAdmin();
  const s = space.settings || {};
  subBody(
    `<div class="split"><section class="card">${
      admin
        ? `<h2>Company</h2><p class="muted">Shown on watermarks and on what customers see.</p><label>Company name</label><input id="company" value="${esc(s.company || "")}"><label>Contact phone</label><input id="phone" value="${esc(s.phone || "")}"><label>Keep originals for (days)</label><input id="retention" type="number" value="${esc(s.retention_days || 90)}" min="1" max="3650"><hr><h3>Cloud &amp; AI</h3><label><input id="cloud" type="checkbox" ${s.cloud_enabled ? "checked" : ""}>Allow uploading original photos to this space</label><label><input id="ai-auto" type="checkbox" ${s.ai_auto !== false ? "checked" : ""}>Let AI describe new photos and suggest order numbers (you confirm)</label><p class="suggest-note">Photos stay private. Share links show only the chosen photo, never exact GPS. AI suggestions are never sent or applied without a person.</p><p><button id="save-settings" class="primary">Save settings</button></p>`
        : `<h2>${esc(space.name)}</h2><p class="muted">Company, cloud and AI settings are managed by your administrator.</p>`
    }</section><div class="stack"><section class="card"><h2>Your account</h2><dl class="facts" style="margin-top:10px"><dt>Name</dt><dd>${esc(me.name)}</dd><dt>Email</dt><dd>${esc(me.email)}</dd><dt>Role</dt><dd>${esc(space.role)}</dd></dl><p style="margin-top:16px"><button id="mobile-logout">Sign out</button></p></section><section class="card"><h2>Upload queue</h2><p id="queue-settings" class="muted">Checking…</p><button id="retry-sync">Retry pending uploads</button></section></div></div>`,
  );
  on("#save-settings", "click", async () => {
    const b = {
      company: document.querySelector("#company").value,
      phone: document.querySelector("#phone").value,
      retention_days: Number(document.querySelector("#retention").value),
      cloud_enabled: document.querySelector("#cloud").checked,
      ai_auto: document.querySelector("#ai-auto").checked,
    };
    await call("/settings", "PATCH", b);
    space.settings = { ...space.settings, ...b };
    toast("Settings saved");
  });
  on("#retry-sync", "click", async () => {
    await retryBlocked();
    toast("Upload queue checked");
    await general();
  });
  on("#mobile-logout", "click", async () => {
    await api("/api/auth/logout", "POST");
    auth();
  });
  const n = (await localAll()).filter((r) => r.user_id === me.id && r.space_id === space.id).length;
  const q = document.querySelector("#queue-settings");
  if (q) q.textContent = n ? `${n} photos saved on this device, waiting to upload.` : "Everything is uploaded ✓";
}
async function connections() {
  const [connectors, shares, usage] = await Promise.all([
    call("/connectors"),
    call("/shares"),
    maybe("/usage", null),
  ]);
  const names = { sheets: "Google Sheets", gmail: "Gmail", microsoft: "Microsoft 365", twilio: "Twilio SMS", drive: "Google Drive", onedrive: "OneDrive" };
  subBody(
    `<div class="split"><section class="card"><div class="card-head"><div><h2>Connected tools</h2><p class="muted">Automations use these to look up customers and send links. Credentials are encrypted and stay in this space.</p></div><button id="connect" class="primary">Connect a tool</button></div>${connectors.map((c) => `<div class="row"><div><strong>${esc(names[c.provider] || c.provider)}</strong> <span class="badge ${c.status === "connected" ? "" : "neutral"}">${esc(c.status)}</span></div>${c.status === "connected" ? `<button class="small" data-revoke-connector="${esc(c.id)}">Disconnect</button>` : ""}</div>`).join("") || '<p class="muted">Nothing connected yet.</p>'}</section><div class="stack"><section class="card"><h2>Active share links</h2>${
      shares
        .filter((s) => !s.revoked_at)
        .map(
          (s) =>
            `<div class="row"><div><a href="/s/${esc(s.token)}" target="_blank" rel="noopener">Photo ${esc(s.capture_id.slice(0, 8))}</a><p class="muted">Expires ${esc(fmt(s.expires_at))} · ${esc(s.views)} views</p></div><button class="small" data-revoke-share="${esc(s.id)}">Revoke</button></div>`,
        )
        .join("") || '<p class="muted">No active links.</p>'
    }</section>${usage ? `<section class="card"><h2>Usage</h2><p>${(usage.stored_bytes / 1048576).toFixed(1)} MB stored · ${esc(usage.captures)} photos · ${esc(usage.ai_calls)} AI requests</p><p class="suggest-note">Provider fees are billed by your connected services.</p></section>` : ""}</div></div>`,
  );
  on("#connect", "click", connectorEditor);
  on("[data-revoke-connector]", "click", async (e, el) => {
    await call(`/connectors/${el.dataset.revokeConnector}`, "DELETE");
    await connections();
  });
  on("[data-revoke-share]", "click", async (e, el) => {
    await call(`/shares/${el.dataset.revokeShare}`, "DELETE");
    await connections();
  });
}
function connectorEditor() {
  const d = modal(
    "Connect a tool",
    `<label>Tool</label><select id="provider"><option value="sheets">Google Sheets</option><option value="gmail">Gmail</option><option value="microsoft">Microsoft 365</option><option value="twilio">Twilio SMS</option><option value="drive">Google Drive</option><option value="onedrive">OneDrive</option></select><p><button id="oauth-connect" class="primary">Sign in with the provider</button></p><details class="fold"><summary>Developer setup: paste credentials</summary><p class="notice">Use your organization’s scoped OAuth access token or Twilio credentials. Never use someone else’s personal account.</p><div id="credential-fields"></div><label><input id="draft-permission" type="checkbox">Allow email drafts (asks for compose permission)</label><p><button id="save-connector">Save credentials</button></p></details>`,
  );
  const draw = () => {
    const p = d.querySelector("#provider").value;
    const fields =
      p === "twilio"
        ? ["account_sid", "auth_token", "from"]
        : p === "sheets"
          ? ["access_token", "spreadsheet_id", "range", "writeback_column"]
          : ["access_token"];
    d.querySelector("#credential-fields").innerHTML =
      fields
        .map(
          (f) =>
            `<label>${f.replaceAll("_", " ")}</label><input data-credential="${f}" type="${f.includes("token") ? "password" : "text"}" autocomplete="off" placeholder="${f === "range" ? "Customers!A:D" : ""}">`,
        )
        .join("") +
      (p === "sheets" ? "<p class='muted'>Sheet columns: order number, customer name, email, phone. First row is the header.</p>" : "") +
      (p === "twilio" ? '<label><input id="consent" type="checkbox">Recipients have consented to SMS. I will maintain opt-outs.</label>' : "");
    labelize(d);
  };
  d.querySelector("#provider").onchange = draw;
  draw();
  on(
    "#oauth-connect",
    "click",
    async () => {
      const provider = d.querySelector("#provider").value;
      if (provider === "twilio") throw new Error("Twilio uses account credentials — open Developer setup below.");
      const r = await call(`/oauth/${provider}`, "POST", {
        spreadsheet_id: d.querySelector("[data-credential=spreadsheet_id]")?.value,
        range: d.querySelector("[data-credential=range]")?.value,
        drafts: d.querySelector("#draft-permission").checked,
        writeback_column: d.querySelector("[data-credential=writeback_column]")?.value || undefined,
      });
      location.href = r.url;
    },
    d,
  );
  on(
    "#save-connector",
    "click",
    async () => {
      const credentials = {};
      d.querySelectorAll("[data-credential]").forEach((i) => (credentials[i.dataset.credential] = i.value));
      await call("/connectors", "POST", {
        provider: d.querySelector("#provider").value,
        credentials,
        sms_consent: d.querySelector("#consent")?.checked || false,
      });
      d.remove();
      if (document.querySelector("#settings-body")) await connections();
    },
    d,
  );
}
async function developer() {
  const data = await call("/developer");
  subBody(
    `<div class="notice">For developers. Keys read verification data in this space only and expire after 90 days. Requests need an HMAC signature, a timestamp and a one-time nonce.</div><div class="split even"><section class="card"><h2>API keys</h2>${data.keys.map((k) => `<div class="row"><div><strong>${esc(k.name)}</strong><p class="muted">${esc(k.scopes.join(", "))} · ${k.revoked ? "Revoked" : "Active"}</p></div>${!k.revoked ? `<button class="small" data-revoke-key="${esc(k.id)}">Revoke</button>` : ""}</div>`).join("")}<label>Key name</label><input id="key-name" placeholder="Operations dashboard"><p><button id="create-key" class="primary">Create read-only key</button></p><div id="key-result"></div></section><section class="card"><h2>Webhooks</h2><p class="muted">Signed, retryable events for verified photos, AI analysis and customer responses. Deduplicate by event ID.</p>${data.webhooks.map((w) => `<div class="row"><div>${esc(w.url)}<p class="muted">${w.enabled ? "Enabled" : "Disabled"}</p></div>${w.enabled ? `<button class="small" data-disable-hook="${esc(w.id)}">Disable</button>` : ""}</div>`).join("")}<label>HTTPS endpoint</label><input id="hook-url" type="url" placeholder="https://your-company.com/events"><p><button id="create-hook">Create webhook</button></p><div id="hook-result"></div></section></div><section class="card" style="margin-top:20px"><h2>Webhook delivery log</h2>${data.events.map((e) => `<p class="hash">${esc(e.state)} · attempt ${esc(e.attempts)} · ${esc(e.error || e.event_id)}</p>`).join("") || '<p class="muted">No deliveries yet.</p>'}</section>`,
  );
  on("#create-key", "click", async () => {
    const r = await call("/developer/keys", "POST", { name: document.querySelector("#key-name").value });
    document.querySelector("#key-result").innerHTML =
      `<p>Copy these now. They won’t be shown again.</p><pre class="code">${esc(JSON.stringify(r, null, 2))}</pre>`;
  });
  on("[data-revoke-key]", "click", async (e, el) => {
    await call("/developer/keys/" + el.dataset.revokeKey, "DELETE");
    await developer();
  });
  on("#create-hook", "click", async () => {
    const r = await call("/developer/webhooks", "POST", { url: document.querySelector("#hook-url").value });
    document.querySelector("#hook-result").innerHTML =
      `<p>Save this signing secret now.</p><pre class="code">${esc(JSON.stringify(r, null, 2))}</pre>`;
  });
  on("[data-disable-hook]", "click", async (e, el) => {
    await call("/developer/webhooks/" + el.dataset.disableHook, "DELETE");
    await developer();
  });
}

/* ---------- Local save + upload ---------- */
// IndexedDB transactions finish before a capture is reported as saved.
const localDB = new Promise((resolve, reject) => {
  const r = indexedDB.open("snapoto-local", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("captures", { keyPath: "id" });
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function localWrite(value, remove = false) {
  const db = await localDB;
  await new Promise((resolve, reject) => {
    const t = db.transaction("captures", "readwrite");
    if (remove) t.objectStore("captures").delete(value.id);
    else t.objectStore("captures").put(value);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Local save failed"));
  });
}
async function localAll() {
  const db = await localDB;
  return new Promise((resolve, reject) => {
    const r = db.transaction("captures").objectStore("captures").getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
let syncing = false;
// Upload failures that retrying cannot fix (logged out, no space access,
// read-only role, cloud consent off, bad payload). These wait for the user
// instead of burning the 30s background loop. 429/5xx/network errors keep
// retrying automatically.
const BLOCKED_STATUS = new Set([400, 401, 403, 404, 409, 410, 413, 422]);
async function sync({ manual = false } = {}) {
  if (syncing || !me || !navigator.onLine) return;
  syncing = true;
  let changed = false;
  try {
    for (const record of await localAll()) {
      if (record.user_id !== me.id) continue;
      if (record.blocked && !manual) continue;
      try {
        const { space_id, user_id, error, blocked, ...payload } = record;
        await api(`/api/spaces/${space_id}/captures`, "POST", payload);
        await localWrite(record, true);
        changed = true;
      } catch (e) {
        const next = { ...record, error: e.message };
        if (BLOCKED_STATUS.has(e.status)) next.blocked = e.message;
        else delete next.blocked;
        await localWrite(next);
        changed = true;
      }
    }
  } finally {
    syncing = false;
    drawPending().catch(() => {});
    if (changed) refreshPhotos?.();
  }
}
async function retryBlocked() {
  for (const record of await localAll()) {
    if (!record.blocked) continue;
    const next = { ...record, error: "" };
    delete next.blocked;
    await localWrite(next);
  }
  await sync({ manual: true });
}
async function saveBlob(blob) {
  if (!blob) throw new Error("Camera did not return an image");
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
  const data = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  const r = {
    id: crypto.randomUUID(),
    space_id: space.id,
    user_id: me.id,
    captured_at_device: new Date().toISOString(),
    gps: null,
    note: document.querySelector("#capture-note")?.value || "",
    address: "",
    collection: "",
    assets: [
      {
        kind: "original",
        mime: blob.type === "image/png" ? "image/png" : "image/jpeg",
        sha256,
        data,
      },
    ],
  };
  // "Saved" is reported only after the IndexedDB transaction completes.
  await localWrite(r);
  toast("Saved on this device ✓ Uploading in the background.");
  await drawPending();
  sync().catch(() => {});
}
async function camera() {
  actions(space.role !== "Viewer" && tabsFor(space.role).includes("Camera") ? "" : '<button id="back-photos">← Back to Photos</button>');
  content(
    `<div class="camera"><div class="notice">Each photo is saved on this device first, then uploaded. For all-day field work, use the Snapoto Android app.</div><p id="camera-status" class="muted">Opening camera…</p><video id="video" autoplay playsinline muted></video><button class="shutter" id="shutter" aria-label="Take photo" disabled>●</button><label>Photo note</label><input id="capture-note" placeholder="Optional, e.g. “Delivered to dock B”"><label>Or choose a photo from this device</label><input id="upload" type="file" accept="image/jpeg,image/png" capture="environment"><p><button id="sync">Retry uploads</button></p><div id="local-status"></div></div>`,
  );
  on("#back-photos", "click", () => go("Photos"));
  on("#upload", "change", async (e, el) => {
    if (el.files[0]) await saveBlob(el.files[0]);
  });
  on("#sync", "click", async () => {
    await retryBlocked();
    toast("Upload queue checked");
  });
  on("#shutter", "click", async () => {
    const v = document.querySelector("#video"),
      canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    if (!canvas.width) throw new Error("Camera is not ready");
    canvas.getContext("2d").drawImage(v, 0, 0);
    await saveBlob(await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.95)));
  });
  try {
    await navigator.storage?.persist?.();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    const v = document.querySelector("#video");
    if (!v) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    v.srcObject = stream;
    document.querySelector("#shutter").disabled = false;
    document.querySelector("#camera-status").textContent = "Ready";
  } catch (e) {
    const s = document.querySelector("#camera-status");
    if (s) s.textContent = "Camera unavailable. Allow camera permission, or choose a photo below.";
  }
  await drawPending();
}
async function drawPending() {
  const box = document.querySelector("#local-status");
  if (!box || !me || !space) return;
  const pending = (await localAll()).filter((r) => r.user_id === me.id && r.space_id === space.id);
  box.innerHTML = pending
    .map(
      (r) =>
        `<p class="notice ${r.blocked ? "warn" : ""}">${esc(fmt(r.captured_at_device))} · Saved on this device · ${esc(r.error || "Uploading…")}${r.blocked ? " · Automatic retry paused — fix access, then use Retry uploads." : ""}</p>`,
    )
    .join("");
}

/* ---------- Customer page (/s/:token) ---------- */
async function publicPage() {
  const token = location.pathname.split("/")[2];
  const shell = (inner) =>
    `<main class="verify"><header>${brand}<span class="badge neutral">Shared with you</span></header>${inner}<footer>Sent with Snapoto · Originals kept unchanged</footer></main>`;
  try {
    const r = await api(`/api/public/${token}`),
      c = r.capture;
    if (r.access_required) {
      app.innerHTML = shell(
        `<section class="card"><h1>Verify your email</h1><p>This photo was sent to ${esc(r.recipient_hint)}. We’ll email you a code to open it.</p><p><button id="request-code" class="primary big">Email verification code</button></p><div id="code-form" hidden><label>Six-digit code</label><input id="otp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"><p><button id="verify-code" class="primary">Open record</button></p></div></section>`,
      );
      let challenge;
      on("#request-code", "click", async (e, el) => {
        el.disabled = true;
        try {
          const result = await api(`/api/public/${token}/otp`, "POST", {});
          challenge = result.challenge_id;
          document.querySelector("#code-form").hidden = false;
          toast("Code sent. Check your email.");
        } finally {
          el.disabled = false;
        }
      });
      on("#verify-code", "click", async () => {
        await api(`/api/public/${token}/otp/verify`, "POST", {
          challenge_id: challenge,
          code: document.querySelector("#otp-code").value.trim(),
        });
        await publicPage();
      });
      return;
    }
    const rendered = c.assets.filter((a) => a.kind === "rendered" && a.available).at(-1);
    const original = c.assets.find((a) => ["original", "video"].includes(a.kind));
    const a = rendered || (original?.available ? original : null);
    const assetSrc = (x) => `/api/public/${token}/assets/${x.id}`;
    const assetName = (x) =>
      x.kind === "rendered" ? "Watermarked copy" : x.kind === "video" ? "Original video" : "Original photo";
    const late = receivedLate(c);
    const verified = c.hash_check === "verified" && original?.available;
    const company = r.company || c.company || r.space_name || "";
    const caption = c.caption || c.ai?.caption || "";
    const origHash = c.assets.find((x) => ["original", "video"].includes(x.kind))?.sha256 || "";
    app.innerHTML = shell(
      `<h1>A photo from the field.</h1><p class="muted">${company ? esc(company) + " · " : ""}Taken ${esc(fmt(c.captured_at_device))}${late ? " · uploaded later" : ""}</p>${caption ? `<p>${esc(caption)}</p>` : ""}${
        rendered && original?.available && original.kind === "original"
          ? '<div class="seg" role="group" aria-label="Photo version"><button data-pv="rendered" class="active">Watermarked</button><button data-pv="original">Original</button></div>'
          : ""
      }<div class="hero-photo">${
        a?.kind === "video"
          ? `<video controls src="${assetSrc(a)}"></video>`
          : a
            ? `<img id="pub-img" src="${assetSrc(a)}" alt="${a.kind === "rendered" ? "Watermarked copy of the field photo" : "Original field photo"}">`
            : '<div class="notice warn" style="margin:0">The original is no longer stored, so it can’t be shown or re-checked.</div>'
      }</div>${rendered ? '<p class="suggest-note">The watermark text is added for display. The proof is the original file below.</p>' : ""}<section class="verified ${verified ? "" : "warn"}"><span class="seal">${verified ? "✓" : "!"}</span><div><h2>${verified ? "Verified ✓" : "Can’t be re-checked"}</h2><p>${verified ? `This is the original file, unchanged since the server received it on ${esc(fmt(c.server_received_at))}. Its SHA-256 fingerprint matched at upload.` : "The original is no longer stored, so its fingerprint can’t be checked again."}</p></div></section><section class="card"><h2>Details</h2><dl class="facts" style="margin-top:10px"><dt>Taken</dt><dd>${esc(fmt(c.captured_at_device))} <small>(device clock${late ? "; uploaded later, e.g. offline" : ""})</small></dd><dt>Received</dt><dd>${esc(fmt(c.server_received_at))} <small>(server time)</small></dd>${c.address ? `<dt>Where</dt><dd>${esc(c.address)}</dd>` : ""}${c.location_evidence ? `<dt>Location</dt><dd>${esc(c.location_evidence)}</dd>` : ""}<dt>Device</dt><dd>${!["not_provided", undefined, null, ""].includes(c.attestation_state) ? esc(c.attestation_state) : "Not independently verified"}</dd><dt>Fingerprint</dt><dd class="hash">${esc(origHash.slice(0, 16))}…</dd></dl><details class="fold"><summary>Technical details</summary><p class="muted" style="font-size:14px">${late ? "This photo was uploaded some time after it was taken. The capture time comes from the device clock; the server only vouches for when it received the file." : esc(c.time_evidence || "Capture time is device-reported.")} The scene itself and the device identity have not been independently verified. Exact GPS is not shown on this page.</p>${c.assets.map((x) => `<p><strong>${assetName(x)}</strong><br><span class="hash">${esc(x.sha256)}</span>${r.download && x.available ? `<br><a href="${assetSrc(x)}?download=1">Download ${esc(assetName(x).toLowerCase())}</a>` : ""}</p>`).join("")}</details></section>${
        r.acknowledge
          ? `<section class="card" id="ack-panel"><h2>Let the team know</h2><p class="muted">Opening this page doesn’t count as confirmation. ${r.identity_check === "email_verified" ? "Your reply records verified access to the designated email." : "Your reply is self-reported."}</p><label>Your name</label><input id="ack-name" required autocomplete="name"><label>Comment (optional)</label><textarea id="ack-note" rows="3"></textarea><div class="ack-actions"><button data-ack="received" class="primary">Confirm received</button><button data-ack="issue">Report a problem</button></div></section>`
          : ""
      }<p class="suggest-note" style="text-align:center;margin-top:18px">This link expires ${esc(fmt(r.expires_at))} and can be turned off by the sender. ${r.identity_check === "email_verified" ? "" : "Please don’t forward it."}</p>`,
    );
    labelize(app);
    on("[data-pv]", "click", async (e, el) => {
      document.querySelector("#pub-img").src = assetSrc(el.dataset.pv === "rendered" ? rendered : original);
      document.querySelectorAll("[data-pv]").forEach((b) => b.classList.toggle("active", b === el));
    });
    on("[data-ack]", "click", async (e, el) => {
      const name = document.querySelector("#ack-name");
      if (!name.value.trim()) {
        name.focus();
        throw new Error("Please enter your name first.");
      }
      const buttons = document.querySelectorAll("[data-ack]");
      buttons.forEach((b) => (b.disabled = true));
      try {
        await api(`/api/public/${token}/ack`, "POST", {
          status: el.dataset.ack,
          name: name.value,
          note: document.querySelector("#ack-note").value,
        });
      } catch (err) {
        buttons.forEach((b) => (b.disabled = false));
        throw err;
      }
      document.querySelector("#ack-panel").innerHTML =
        `<h2>Response recorded</h2><p>You ${el.dataset.ack === "issue" ? "reported a problem" : "confirmed receipt"}. The team has been told, with the time. Thank you.</p>`;
    });
  } catch (e) {
    app.innerHTML = shell(
      `<section class="card"><h1>This record is unavailable.</h1><p>${esc(e.status === 410 || e.status === 404 ? "This link has expired or was turned off by the sender." : e.message)}</p><p class="muted">Ask the sender for a new link.</p></section>`,
    );
  }
}
window.addEventListener("online", () => sync().catch(() => {}));
setInterval(() => sync().catch(() => {}), 30000);
init();
