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
let me,
  space,
  view = "Overview",
  stream,
  photoFilter = null;
const selectedPhotos = new Set();
const isAdmin = () => ["Owner", "Admin"].includes(space.role);
const fmt = (d) => new Date(d).toLocaleString();
let toastTimer;
function toast(text) {
  const t = document.querySelector("#toast");
  t.textContent = text;
  t.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.display = "none"), 5000);
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
const on = (selector, event, fn) =>
  document.querySelectorAll(selector).forEach((el) => {
    el["on" + event] = async (e) => {
      try {
        await fn(e, el);
      } catch (err) {
        if (!err.stale) toast(err.message);
      }
    };
  });
const empty = (title, body, button = "") =>
  `<div class="empty"><h2>${title}</h2><p>${body}</p>${button}</div>`;
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
function modal(title, html) {
  document.querySelectorAll(".modalback").forEach((el) => el.remove());
  const div = document.createElement("div");
  div.className = "modalback";
  div.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button class="close" aria-label="Close dialog">✕</button></header>${html}</section>`;
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
  div.querySelector("input,button")?.focus();
  return div;
}
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
  app.innerHTML = `<div class="auth"><section class="auth-story">${brand}<h1>The work happened.<br>Keep the record.</h1><p>Take the photo. Keep the original. Let your approved workflows handle what comes next.</p><p>Built for the people out there doing the work.</p></section><form class="auth-form"><h1>${register ? "Create your workspace" : "Good to see you."}</h1><p class="muted">${register ? "Start with a private personal space. Add a team when you’re ready." : "Sign in to your photos, team and automations."}</p>${register ? '<label for="name">Your name</label><input id="name" name="name" required autocomplete="name">' : ""}<label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email"><label for="password">Password</label><input id="password" name="password" type="password" minlength="12" required autocomplete="${register ? "new-password" : "current-password"}"><small>At least 12 characters</small><p class="error" id="auth-error"></p><button class="primary" type="submit">${register ? "Create account" : "Sign in"}</button><p><button type="button" id="switch-auth">${register ? "Already have an account? Sign in" : "New to Snapoto? Create an account"}</button></p></form></div>`;
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
async function shell() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  const isAdmin = ["Owner", "Admin"].includes(space.role);
  const tabs = isAdmin
    ? [
        "Overview",
        "Photos",
        "Camera",
        "Automations",
        "Templates",
        "Team",
        "Settings",
        "Developer",
      ]
    : ["Camera", "Photos", "Me"];
  if (!tabs.includes(view)) view = tabs[0];
  navSeq++;
  app.innerHTML = `<aside class="sidebar">${brand}<select id="space" aria-label="Current space">${me.spaces.map((s) => `<option value="${s.id}" ${s.id === space.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select><nav>${tabs.map((t) => `<button data-nav="${t}" class="${t === view ? "active" : ""}" ${t === view ? 'aria-current="page"' : ""}>${t}</button>`).join("")}</nav><footer><strong>${esc(me.name)}</strong><p>${esc(space.role)} · ${esc(space.name)}</p><button id="logout">Sign out</button></footer></aside><main class="workspace"><header class="topbar"><div><h1>${view}</h1><p class="muted">${esc(space.name)} <span class="badge neutral">${esc(space.role)}</span></p></div><div class="actions" id="page-actions"></div></header><div id="content"><p>Loading…</p></div></main>`;
  on("[data-nav]", "click", async (e, el) => {
    view = el.dataset.nav;
    await shell();
  });
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
    Overview: overview,
    Photos: photos,
    Camera: camera,
    Automations: automations,
    Templates: templates,
    Team: team,
    Settings: settings,
    Me: settings,
    Developer: developer,
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
async function overview() {
  const [o, photos, acknowledgments] = await Promise.all([
    call("/overview"),
    call("/captures"),
    call("/acknowledgments"),
  ]);
  const needsReview = o.jobs.filter((j) => j.state === "needs_review");
  // One record can both need a run review and an order check; count it once.
  const toVerify = new Set([
    ...needsReview.map((j) => j.capture_id),
    ...photos
      .filter((c) => c.order_number && !c.order_confirmed)
      .map((c) => c.id),
  ]).size;
  const pendingDelivery = o.jobs.filter((j) =>
    ["queued", "retry"].includes(j.state),
  );
  const issueCount = acknowledgments.filter((a) => a.status === "issue").length;
  const todoCard = (filter, count, title, body) =>
    `<button class="todo" data-todo="${filter}"><strong>${count}</strong><span class="todo-title">${title}</span><span class="todo-body">${body}</span><span class="todo-go">Open filtered view</span></button>`;
  content(
    `<section class="hero"><div><h2>Every photo, accounted for.</h2><p>Keep your field records in one place. Review anything that needs your attention before it reaches a customer.</p></div>${button("Take a photo", "take", "primary")}</section><section aria-label="Work queue"><h2>Work queue</h2><div class="todos">${todoCard("review", toVerify, "Records to verify", "Confirm order numbers against originals")}${todoCard("delivery", pendingDelivery.length, "Deliveries to follow up", "Queued or retrying workflow runs")}${todoCard("issues", issueCount, "Customer issues", "Responses that reported a problem")}</div><p class="muted">Each card opens a filtered view so nothing waits without an owner.</p></section><div class="metrics">${[
      [o.captures, "Photos saved"],
      [o.verified, "Originals verified"],
      [o.sent, "Delivery requests accepted"],
      [o.review, "Need your review"],
    ]
      .map(
        ([n, l]) =>
          `<div class="metric"><strong>${n}</strong><span>${l}</span></div>`,
      )
      .join(
        "",
      )}</div><p class="muted">Delivery requests accepted means the provider received the request. It is not a carrier delivery receipt and not a customer confirmation.</p><div class="split"><section><h2>Latest photos</h2>${photos.length ? `<div class="grid">${photos.slice(0, 4).map(photoCard).join("")}</div>` : empty("Your first record starts with a photo", "Open Camera, or upload a photo from your device.")}</section><section><h2>Needs attention</h2><div class="panel">${
      o.jobs
        .filter((j) => j.state !== "completed")
        .map(
          (j) =>
            `<div class="row"><div><strong>${esc(j.rule.name)}</strong><p>${esc(j.logs.at(-1)?.message || "Waiting for processing")}</p><span class="badge warn">${esc(j.state)}</span></div><button data-photo="${j.capture_id}">Review</button></div>`,
        )
        .join("") ||
      '<p class="muted">All clear. Exceptions will appear here.</p>'
    }</div><h2>Customer responses</h2><div class="panel">${
      acknowledgments
        .slice(0, 6)
        .map(
          (a) =>
            `<div class="row"><div><strong>${esc(a.name)} · ${a.status === "issue" ? "Reported an issue" : "Confirmed received"}</strong><p>${esc(a.note)}</p><small>${fmt(a.timestamp)} · ${a.identity_check === "email_verified" ? "Verified email access" : "Self-reported identity"}</small></div></div>`,
        )
        .join("") ||
      '<p class="muted">Customer confirmations and issues will appear here.</p>'
    }</div><h2>Recent activity</h2><div class="panel">${
      o.activity
        .slice(0, 6)
        .map(
          (a) =>
            `<div class="row"><div><p>${esc({ "capture.cloud_verified": "Original stored and verified", "share.created": "Verification link created", "share.acknowledged": "Customer response received", "settings.changed": "Space settings updated", "space.created": "Team created", "connector.connected": "Tool connected", "member.invited": "Member invited" }[a.event] || a.event.replaceAll(".", " ").replaceAll("_", " "))}</p><small>${fmt(a.created_at)}</small></div></div>`,
        )
        .join("") ||
      '<p class="muted">Your workspace activity will appear here.</p>'
    }</div></section></div>`,
  );
  on("#take", "click", async () => {
    view = "Camera";
    await shell();
  });
  on("[data-todo]", "click", async (e, el) => {
    const f = el.dataset.todo;
    if (f === "delivery") {
      view = "Automations";
      await shell();
      return;
    }
    photoFilter = f;
    view = "Photos";
    await shell();
  });
  bindPhotos();
}
const OFFLINE_GAP_MS = 5 * 60 * 1000;
// True when the server received the record well after the device says it was
// taken (offline capture or delayed upload). Capture time is then device-only.
const receivedLate = (c) =>
  c.server_received_at &&
  c.captured_at_device &&
  Date.parse(c.server_received_at) - Date.parse(c.captured_at_device) >
    OFFLINE_GAP_MS;
function integrityBadge(c) {
  if (c.deleted_at || c.hash_check === "original_unavailable")
    return '<span class="badge warn">Original unavailable</span>';
  if (c.hash_check === "verified")
    return '<span class="badge">Original verified</span>';
  return `<span class="badge warn">${esc(c.hash_check || "Not verified")}</span>`;
}
// PRD §6: show each verification dimension separately, never one blanket claim.
function evidenceList(c) {
  const row = (label, ok, text, badge = ok ? "Yes" : "No") =>
    `<div class="evidence-row"><dt>${label}</dt><dd><span class="badge ${ok ? "" : "warn"}">${badge}</span> ${esc(text)}</dd></div>`;
  const stored = c.cloud_state === "stored" && !c.deleted_at;
  const verified = c.hash_check === "verified" && !c.deleted_at;
  const attested = !["not_provided", undefined, null, ""].includes(
    c.attestation_state,
  );
  const late = receivedLate(c);
  return `<dl class="evidence">${[
    row("Saved on device", true, "Reached the cloud, so the device had saved it first."),
    row(
      "Stored in cloud",
      stored,
      stored
        ? `Received ${fmt(c.server_received_at)}`
        : "Original no longer stored; cloud re-verification is not possible.",
    ),
    row(
      "File integrity",
      verified,
      verified
        ? "SHA-256 matched at upload"
        : "Cannot re-check: " + (c.hash_check || "unknown"),
    ),
    row(
      "Device source",
      attested,
      attested
        ? String(c.attestation_state)
        : "No device integrity proof provided; device identity is not verified.",
      attested ? "Provided" : "Unverified",
    ),
    row(
      "Capture time",
      false,
      `Device clock: ${fmt(c.captured_at_device)}. ${
        late
          ? "Uploaded later (offline or delayed), so the server cannot vouch for the capture moment."
          : c.time_evidence || "Device-reported time."
      }`,
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
function photoCard(c) {
  const a =
    c.assets.filter((a) => a.kind === "rendered").at(-1) ||
    c.assets.find((a) => a.kind === "original");
  return `<button class="photo" data-photo="${c.id}">${a && !c.deleted_at ? `<img src="${route(`/captures/${c.id}/assets/${a.id}`)}" alt="Field photo" loading="lazy">` : '<div class="preview">Video record</div>'}<div class="meta">${integrityBadge(c)}<p>${esc(c.address || c.collection || "Field record")}</p><small>${fmt(c.captured_at_device)}</small></div></button>`;
}
function bindPhotos() {
  on("[data-photo]", "click", async (e, el) => detail(el.dataset.photo));
}
function batchItem(c) {
  const checked = selectedPhotos.has(c.id) ? "checked" : "";
  const box = isAdmin()
    ? `<label class="pick"><input type="checkbox" data-pick="${c.id}" ${checked}>Select</label>`
    : "";
  return `<div class="batch-item">${box}${photoCard(c)}</div>`;
}
async function runExport(kind, taskBox) {
  const names = { csv: "CSV records", zip: "Originals ZIP", pdf: "PDF report" };
  const paths = { csv: "/export.csv", zip: "/export.zip", pdf: "/report.pdf" };
  const id = "exp-" + Date.now();
  const el = document.createElement("div");
  el.className = "panel export-task";
  el.id = id;
  taskBox.prepend(el);
  const draw = (step, state, note = "") => {
    const steps = ["Prepare", "Download", "Done"];
    el.innerHTML =
      `<div class="row"><div><strong>${esc(names[kind])}</strong><p>${esc(note || steps[step] + "…")}</p><ol class="steps compact">${steps.map((s, i) => `<li class="${i < step ? "done" : i === step ? "current" : ""}">${s}</li>`).join("")}</ol></div><div class="actions">${state === "failed" ? `<button data-retry-export="${kind}">Retry</button>` : ""}</div></div>`;
    el.querySelector("[data-retry-export]")?.addEventListener("click", () =>
      runExport(kind, taskBox),
    );
  };
  try {
    draw(0, "running", "Preparing export on the server");
    const r = await fetch(route(paths[kind]));
    if (!r.ok) throw new Error("Export failed: " + r.status);
    draw(1, "running", "Downloading file");
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download =
      kind === "csv"
        ? "snapoto-records.csv"
        : kind === "zip"
          ? "snapoto-originals.zip"
          : "snapoto-report.pdf";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    draw(3, "done", "Saved to your device");
  } catch (e) {
    draw(1, "failed", e.message + ". Nothing was changed. You can retry.");
  }
}
async function photos() {
  document.querySelector("#page-actions").innerHTML = "";
  const admin = isAdmin();
  content(
    `<div class="chips" role="group" aria-label="Quick filters">${[["", "All"], ["review", "To verify"], ["pending", "To deliver"], ["issues", "Customer issues"]].map(([v, l]) => `<button data-chip="${v}" class="${photoFilter === v || (!photoFilter && !v) ? "active" : ""}">${l}</button>`).join("")}</div><div class="filters"><input id="search" placeholder="Search text, order:123 date:2026-01-05 email:a@b.com" aria-label="Search photos" value="${esc("")}"><input id="from" type="date" aria-label="From date"><input id="to" type="date" aria-label="To date"><button id="filter">Filter photos</button><button id="ai-search">Search with AI</button><button id="summarize">Summarize records</button><button id="map">Photo map</button><button id="compare">Compare records</button></div><p class="muted">Prefix search: order:number, email:address, date:YYYY-MM-DD. AI search sends text to the provider; prefix search stays local.</p><div id="batchbar" class="batchbar" hidden></div><div id="photos"></div><section aria-label="Exports"><h2>Exports</h2><div class="actions"><button data-export="csv">CSV records</button><button data-export="zip">Originals ZIP</button><button data-export="pdf">PDF report</button></div><div id="export-tasks"></div></section>`,
  );
  let cache = [];
  let loadSeq = 0;
  const load = async () => {
    // Only the newest filter request may draw the list.
    const mine = ++loadSeq;
    const raw = document.querySelector("#search").value;
    const p = parsePhotoQuery(raw);
    const q = new URLSearchParams({
      q: p.text,
      from: document.querySelector("#from").value,
      to: document.querySelector("#to").value,
    });
    let rows = await call("/captures?" + q);
    if (p.order)
      rows = rows.filter((c) =>
        (c.order_number || "").toLowerCase().includes(p.order.toLowerCase()),
      );
    if (p.date)
      rows = rows.filter((c) =>
        (c.captured_at_device || "").slice(0, 10) === p.date,
      );
    let emailIds = null;
    if (p.email || photoFilter === "issues") {
      let shares = [];
      try {
        shares = admin ? await call("/shares") : [];
      } catch {
        shares = [];
      }
      const acks = await call("/acknowledgments");
      const byShare = new Map(shares.map((s) => [s.id, s]));
      emailIds = new Set();
      for (const s of shares) {
        if (
          p.email &&
          (s.recipient_email || "").toLowerCase().includes(p.email.toLowerCase())
        )
          emailIds.add(s.capture_id);
      }
      for (const a of acks) {
        const s = byShare.get(a.share_id);
        if (!s) continue;
        if (photoFilter === "issues" && a.status !== "issue") continue;
        if (
          (photoFilter === "issues" && a.status === "issue") ||
          (p.email &&
            (a.identity_email || "")
              .toLowerCase()
              .includes(p.email.toLowerCase()))
        )
          emailIds.add(s.capture_id);
      }
      rows = rows.filter((c) => emailIds.has(c.id));
    }
    if (photoFilter === "review") {
      const o = await call("/overview");
      const reviewIds = new Set(
        o.jobs.filter((j) => j.state === "needs_review").map((j) => j.capture_id),
      );
      rows = rows.filter(
        (c) => reviewIds.has(c.id) || (c.order_number && !c.order_confirmed),
      );
    }
    if (photoFilter === "pending") {
      const o = await call("/overview");
      const pendingIds = new Set(
        o.jobs
          .filter((j) => ["queued", "retry"].includes(j.state))
          .map((j) => j.capture_id),
      );
      rows = rows.filter((c) => pendingIds.has(c.id));
    }
    if (mine !== loadSeq) return;
    cache = rows;
    const issueNote =
      photoFilter === "issues" && !admin
        ? '<p class="notice">Customer-issue mapping needs the share list, which is limited to administrators. Ask an administrator for the linked records.</p>'
        : "";
    document.querySelector("#photos").innerHTML =
      issueNote +
      (rows.length
        ? `<div class="grid">${rows.map(batchItem).join("")}</div>`
        : empty(
            "No photos here yet",
            "Take a photo in this space to create a private, verifiable record.",
          ));
    bindPhotos();
    wirePicks();
    drawBatch();
  };
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
    if (!admin || !cache.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.innerHTML =
      `<span>${selectedPhotos.size} of ${cache.length} selected</span><div class="actions"><button id="select-all">Select all</button><button id="select-none">Clear</button><button id="batch-confirm">Confirm checked orders</button><button id="batch-unconfirm">Reopen checked</button></div>`;
    document.querySelector("#select-all").onclick = () => {
      cache.forEach((c) => selectedPhotos.add(c.id));
      load();
    };
    document.querySelector("#select-none").onclick = () => {
      selectedPhotos.clear();
      load();
    };
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
          await call(`/captures/${id}`, "PATCH", {
            order_confirmed: confirmed,
          });
          ok++;
          selectedPhotos.delete(id);
        } catch {
          skip++;
        }
      }
      toast(`Updated ${ok} records${skip ? `, ${skip} skipped` : ""}`);
      await load();
    };
    document.querySelector("#batch-confirm").onclick = () => adjudicate(true);
    document.querySelector("#batch-unconfirm").onclick = () => adjudicate(false);
  };
  on("#filter", "click", load);
  document.querySelector("#search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") load().catch((err) => toast(err.message));
  });
  on("[data-chip]", "click", async (e, el) => {
    photoFilter = el.dataset.chip || null;
    selectedPhotos.clear();
    await photos();
  });
  on("[data-export]", "click", async (e, el) => {
    await runExport(
      el.dataset.export,
      document.querySelector("#export-tasks"),
    );
  });
  on("#ai-search", "click", async () => {
    const r = await call("/search", "POST", {
      text: document.querySelector("#search").value,
    });
    cache = r.captures;
    document.querySelector("#photos").innerHTML =
      '<p class="notice">Search interpreted as: ' +
      esc(JSON.stringify(r.filters)) +
      (r.fallback ? " (local exact match; AI unavailable)" : "") +
      '</p><div class="grid">' +
      r.captures.map(batchItem).join("") +
      "</div>";
    bindPhotos();
    wirePicks();
    drawBatch();
  });
  on("#summarize", "click", async () => {
    const records = await call("/captures");
    const result = await call("/summary", "POST", {
      capture_ids: records.slice(0, 30).map((c) => c.id),
    });
    const summaryDialog = modal(
      "Photo summary",
      '<p class="notice">AI draft. Review against the original records.</p><textarea id="summary-edit" rows="10">' +
        esc(result.summary) +
        '</textarea><p><button id="save-summary" class="primary">Save reviewed summary</button></p><h3>Sources</h3>' +
        result.sources
          .map(
            (cid) =>
              '<p><button data-photo="' + cid + '">' + cid + "</button></p>",
          )
          .join(""),
    );
    on("#save-summary", "click", async () => {
      await call(`/summaries/${result.id}`, "PATCH", {
        summary: summaryDialog.querySelector("#summary-edit").value,
      });
      toast("Reviewed summary saved");
    });
    bindPhotos();
  });
  on("#map", "click", showMap);
  on("#compare", "click", comparePhotos);
  await load();
}
async function detail(cid) {
  const c = await call(`/captures/${cid}`);
  const ts = await call("/templates");
  const a =
    c.assets.filter((a) => a.kind === "rendered").at(-1) ||
    c.assets.find((a) => ["original", "video"].includes(a.kind));
  const allConnectors = ["Owner", "Admin"].includes(space.role)
    ? (await call("/connectors")).filter((c) => c.status === "connected")
    : [];
  const archiveConnectors = allConnectors.filter((c) =>
    ["drive", "onedrive"].includes(c.provider),
  );
  const emailConnectors = allConnectors.filter((c) =>
    ["gmail", "microsoft"].includes(c.provider),
  );
  const admin = isAdmin();
  const d = modal(
    "Photo record",
    `<div>${a?.kind === "video" ? `<video controls class="detail" src="${route(`/captures/${cid}/assets/${a.id}`)}"></video>` : a ? `<img class="detail" src="${route(`/captures/${cid}/assets/${a.id}`)}" alt="Photo record">` : "<p>Video / audio record</p>"}<div class="panel"><h3>Verification</h3>${evidenceList(c)}<p class="muted">The watermark is display text drawn on a copy. Evidence comes from the original file and its hash.</p>${c.assets.map((a) => `<p><strong>${esc({ rendered: "Watermarked copy", original: "Original photo", selfie: "Front camera original", video: "Original video", audio: "Voice note" }[a.kind] || a.kind)}</strong><br><span class="hash">${esc(a.sha256)}</span><br><a href="${route(`/captures/${cid}/assets/${a.id}`)}" download>Download ${esc(a.kind)}</a></p>`).join("")}</div><ol class="steps"><li data-goto="0" class="current">1 Record</li><li data-goto="1">2 Verify</li><li data-goto="2">3 Deliver</li></ol><div data-step="0"><p class="hash">Record ${cid}</p><p class="muted">Step 1 of 3. Describe what was captured. Saving here never changes the original photo or GPS.</p><label>Display address</label><input id="address" value="${esc(c.address)}"><small>Editing the label does not change original GPS.</small><label>Notes</label><textarea id="note">${esc(c.note)}</textarea><label>Collection</label><input id="collection" value="${esc(c.collection)}"><p><button id="save-detail" class="primary">Save record</button></p></div><div data-step="1" hidden><p class="muted">Step 2 of 3. Check AI output against the original before confirming. Nothing here sends anything.</p><p>${admin ? '<button id="ocr">Read order number with AI</button>' : ""}${c.assets.some((a) => a.kind === "audio") ? '<button id="transcribe">Transcribe voice note</button>' : ""}</p>${admin ? "" : '<p class="muted">Only an Owner or Admin can set or confirm the order number.</p>'}<label>Order number</label><input id="order" value="${esc(c.order_number)}" ${admin ? "" : "disabled"}><label><input type="checkbox" id="confirmed" ${c.order_confirmed ? "checked" : ""} ${admin ? "" : "disabled"}>I checked this number against the original</label><button id="save-detail-verify" class="primary">Save verification</button><label>Watermark template</label><select id="render-template">${ts.map((t) => `<option value="${t.id}">${esc(t.name)} · v${t.version}</option>`).join("")}</select><p><button id="render" ${ts.length ? "" : "disabled"}>Create watermarked image</button></p></div><div data-step="2" hidden><p class="muted">Step 3 of 3. Archive or share this record. Sharing creates a private link you can revoke.</p>${archiveConnectors.length ? `<label>Archive original to</label><select id="archive-connector">${archiveConnectors.map((c) => `<option value="${c.id}">${esc(c.provider)}</option>`).join("")}</select><p><button id="archive-original">Archive original</button></p>` : ""}<hr><h3>Share a verification link</h3><label>Expires after (days)</label><input id="days" type="number" value="7" min="1" max="365"><label><input id="download" type="checkbox">Allow original download</label><label><input id="acknowledge" type="checkbox" checked>Allow customer acknowledgment</label>${emailConnectors.length ? `<label><input id="require-otp" type="checkbox">Require recipient email verification</label><label>Recipient email</label><input id="recipient-email" type="email"><label>Send verification codes using</label><select id="otp-connector">${emailConnectors.map((c) => `<option value="${c.id}">${esc(c.provider)}</option>`).join("")}</select>` : ""}<button id="share" class="primary">Create private link</button><div id="share-result"></div></div><div class="actions"><button id="prev-step">Back</button><button id="next-step" class="primary">Next</button></div></div>`,
  );
  let step = 0;
  const showStep = (n) => {
    step = Math.max(0, Math.min(2, n));
    d.querySelectorAll("[data-step]").forEach((s) => {
      s.hidden = s.dataset.step !== String(step);
    });
    d.querySelectorAll("[data-goto]").forEach((t) => {
      t.classList.toggle("current", t.dataset.goto === String(step));
    });
    d.querySelector("#prev-step").disabled = step === 0;
    d.querySelector("#next-step").textContent =
      step === 2 ? "Done" : "Next";
  };
  on("#prev-step", "click", async () => showStep(step - 1));
  on("#next-step", "click", async () => {
    if (step === 2) d.remove();
    else showStep(step + 1);
  });
  on("[data-goto]", "click", async (e, el) => showStep(Number(el.dataset.goto)));
  on("#save-detail-verify", "click", async () => {
    const b = {
      address: d.querySelector("#address").value,
      note: d.querySelector("#note").value,
      collection: d.querySelector("#collection").value,
    };
    if (admin) {
      b.order_number = d.querySelector("#order").value;
      b.order_confirmed = d.querySelector("#confirmed").checked;
    }
    await call(`/captures/${cid}`, "PATCH", b);
    toast("Verification saved");
  });
  on("#archive-original", "click", async () => {
    await call(`/captures/${cid}/archive`, "POST", {
      connector_id: d.querySelector("#archive-connector").value,
    });
    toast("Archive request recorded. Check provider and logs for status.");
  });
  on("#ocr", "click", async () => {
    const result = await call(`/captures/${cid}/extract`, "POST");
    // The server never replaces a confirmed number with OCR output; mirror it.
    d.querySelector("#order").value = result.order_number || "";
    d.querySelector("#confirmed").checked = !!result.order_confirmed;
    const found = result.ocr?.output?.order_numbers || [];
    toast(
      result.order_confirmed
        ? `Confirmed number kept. AI read: ${found.join(", ") || "nothing"}.`
        : found.length === 1
          ? "Review the extracted number before confirming."
          : "No unique order number found. Check the original.",
    );
  });
  on("#transcribe", "click", async () => {
    const result = await call(`/captures/${cid}/transcribe`, "POST");
    d.querySelector("#note").value = result.transcript.text;
    toast("Transcribed. Review and save your edits.");
  });
  on("#save-detail", "click", async () => {
    // Order number/confirmation is saved only from the Verify step.
    await call(`/captures/${cid}`, "PATCH", {
      address: d.querySelector("#address").value,
      note: d.querySelector("#note").value,
      collection: d.querySelector("#collection").value,
    });
    toast("Record saved");
  });
  on("#render", "click", async () => {
    await call(`/captures/${cid}/render`, "POST", {
      template_id: d.querySelector("#render-template").value,
    });
    d.remove();
    await detail(cid);
  });
  on("#share", "click", async () => {
    const s = await call(`/captures/${cid}/shares`, "POST", {
      template_id: d.querySelector("#render-template").value || undefined,
      days: Number(d.querySelector("#days").value),
      download: d.querySelector("#download").checked,
      acknowledge: d.querySelector("#acknowledge").checked,
      require_otp: !!d.querySelector("#require-otp")?.checked,
      ...(d.querySelector("#require-otp")?.checked
        ? {
            recipient_email: d.querySelector("#recipient-email").value.trim(),
            otp_connector_id: d.querySelector("#otp-connector").value,
          }
        : {}),
    });
    d.querySelector("#share-result").innerHTML =
      `<div class="linkbox"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></div><p class="muted">Expires ${fmt(s.expires_at)}. Opening the link is recorded as a view, not as confirmation of receipt.</p><button id="revoke">Revoke this link</button>`;
    on("#revoke", "click", async () => {
      await call(`/shares/${s.id}`, "DELETE");
      d.querySelector("#share-result").textContent = "Link revoked";
    });
  });
}
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
  "note",
  "custom",
  "verification",
  "logo",
  "qr",
];
const fieldLabel = (f) =>
  ({ gps: "GPS", qr: "QR code", order_number: "order number" })[f] ||
  f.replaceAll("_", " ");
async function templates() {
  document.querySelector("#page-actions").innerHTML = button(
    "Create template",
    "new-template",
    "primary",
  );
  // Bind before loading so the button works on slow connections.
  on("#new-template", "click", () => templateEditor());
  const ts = await call("/templates");
  content(
    `<p class="muted">Choose your fields. Put them inside the photo. Keep the original untouched.</p>${ts.length ? `<div class="grid">${ts.map((t) => `<section class="panel"><h2>${esc(t.name)}</h2><span class="badge neutral">Version ${t.version}${t.is_default ? " · Default" : ""}</span><p>${t.fields.map((x) => esc(fieldLabel(x)) + (t.locked_fields?.includes(x) ? " (required)" : "")).join(" → ")}</p><div class="actions"><button data-edit="${t.id}">Edit</button><button data-copy="${t.id}">Copy</button>${t.is_default ? "" : `<button data-default="${t.id}">Set as default</button>`}<button data-delete="${t.id}" class="danger" aria-label="Delete template ${esc(t.name)}">Delete</button></div></section>`).join("")}</div>` : empty("Make it your own", "Start with time and address, then add only the fields your team needs. No industry presets.")}`,
  );
  on("[data-edit]", "click", (e, el) =>
    templateEditor(ts.find((t) => t.id === el.dataset.edit)),
  );
  on("[data-copy]", "click", (e, el) => {
    const t = ts.find((t) => t.id === el.dataset.copy);
    // A copy never silently takes over as the space default.
    return templateEditor({
      ...t,
      id: undefined,
      name: t.name + " copy",
      is_default: false,
    });
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
        `Delete “${t.name}”? Existing watermarked images stay; rules that froze this version keep using it.`,
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
    fields: ["date", "address"],
    locked_fields: [],
    font_size: 24,
    position: "bottom-left",
    opacity: 0.6,
    custom: "",
    is_default: false,
  },
) {
  const d = modal(
    t.id ? "Edit template" : "Create a watermark template",
    `<form id="template-form"><div class="split"><div><label>Template name</label><input name="name" value="${esc(t.name)}" required><fieldset class="fieldorder"><legend>Fields, in display order</legend><p class="muted">Show a field to add it to the overlay. “Required” stops members from removing it.</p><ol id="field-rows">${[...t.fields, ...watermarkFields.filter((f) => !t.fields.includes(f))].map((f) => `<li data-field="${f}"><label class="grow"><input type="checkbox" name="fields" value="${f}" ${t.fields.includes(f) ? "checked" : ""}>${fieldLabel(f)}</label><label class="lock"><input type="checkbox" name="locked" value="${f}" ${t.locked_fields.includes(f) ? "checked" : ""}>Required</label><button type="button" data-move="-1" aria-label="Move ${fieldLabel(f)} up">↑</button><button type="button" data-move="1" aria-label="Move ${fieldLabel(f)} down">↓</button></li>`).join("")}</ol></fieldset><label>Company logo (PNG/JPEG, up to 250 KB)</label><input name="logo" type="file" accept="image/png,image/jpeg"><label>Custom text</label><input name="custom" value="${esc(t.custom)}"><label><input type="checkbox" name="is_default" ${t.is_default ? "checked" : ""}>Default template for this space</label></div><div><h3>Overlay preview</h3><div class="preview"><div class="watermark" id="watermark"></div></div><small>Illustrative preview. Render on a real record to see the final photo.</small><label>Position</label><select name="position">${["bottom-left", "bottom-right", "top-left", "top-right"].map((p) => `<option ${t.position === p ? "selected" : ""}>${p}</option>`).join("")}</select><label>Font size</label><input type="range" name="font_size" min="14" max="64" value="${t.font_size}"><label>Background opacity</label><input type="range" name="opacity" min="0.2" max="0.9" step="0.1" value="${t.opacity}"></div></div><p><button class="primary">Save template</button></p></form>`,
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
            order_number: "Order #",
            company: space.settings?.company || space.name,
            custom: f.get("custom") || "Custom text",
          })[x] || x.replaceAll("_", " "),
      )
      .join("\n");
    w.style.fontSize = f.get("font_size") / 1.5 + "px";
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
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const f = new FormData(form);
      let logo = t.logo_data || "";
      const logoFile = f.get("logo");
      if (logoFile?.size) {
        if (logoFile.size > 250000)
          throw new Error("Logo must be under 250 KB");
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
      await call(
        t.id ? `/templates/${t.id}` : "/templates",
        t.id ? "PUT" : "POST",
        b,
      );
      d.remove();
      await templates();
    } catch (e) {
      toast(e.message);
    }
  };
}
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
  document.querySelector("#page-actions").innerHTML = button(
    "New automation",
    "new-rule",
    "primary",
  );
  content(
    `<div class="notice">You decide what happens after a photo. Every rule needs a preview, a test and your approval before it can send anything.</div>${rules.length ? rules.map((r) => `<section class="panel"><div class="row"><div><h2>${esc(r.name)}</h2><span class="badge ${r.enabled ? "" : "neutral"}">${r.enabled ? "Enabled" : "Draft / paused"}</span></div><div class="actions"><button data-edit-rule="${r.id}" ${r.enabled ? "disabled" : ""}>Edit</button><button data-test="${r.id}">Dry-run test</button><button data-toggle="${r.id}" data-enabled="${r.enabled}" ${!r.enabled && !r.dry_run_at ? 'disabled title="Run a dry-run test first"' : ""}>${r.enabled ? "Pause" : "Approve & enable"}</button></div></div><p class="muted">${r.dry_run_at ? `Dry-run ${fmt(r.dry_run_at)}: ${esc(r.dry_run_result?.state === "ready_for_review" ? "one customer matched" : "would wait for your review")}` : "Not tested yet. Run a dry-run before enabling."}</p><p>${esc(r.draft_text)}</p><ol class="checklist">${r.dsl.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><small>Up to ${r.dsl.daily_limit} messages/day · ${esc(r.dsl.recipient_domain || "Approved sheet contacts")} · Version ${r.version}</small></section>`).join("") : empty("Give your photos a next step", "Describe the workflow. Review the actions before turning it on.")}<h2>Processing history</h2><p class="muted">Items that need you are listed first. Retry re-runs the rule's checks; a message the provider already accepted is never sent twice.</p><section class="panel">${jobs.map((j) => `<div class="row"><div><strong>${esc(j.rule.name)}</strong><p>${esc(j.logs.at(-1)?.message || "Queued")}</p><span class="badge ${j.state === "completed" ? "" : j.state === "needs_review" ? "warn" : "neutral"}">${esc(runState[j.state] || j.state)}</span></div><div class="actions">${["needs_review", "paused", "retry"].includes(j.state) ? `<button data-retry-run="${j.id}">Retry</button>` : ""}<button data-photo="${j.capture_id}">Open record</button></div></div>`).join("") || '<p class="muted">No workflow runs yet.</p>'}</section>`,
  );
  on("#new-rule", "click", () => ruleEditor());
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
      `<p>Use a simulated customer row to check matching. No provider will be called.</p><label>Extracted order number</label><input id="test-order" value="TEST-1001"><label>Customer table rows (JSON)</label><textarea id="customers">[{"order":"TEST-1001","email":"customer@example.com"}]</textarea><button id="run-test" class="primary">Run test</button><pre id="test-result" class="code"></pre>`,
    );
    on("#run-test", "click", async () => {
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
      d.querySelector("#test-result").textContent = [
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
    });
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
    `<label>Automation name</label><input id="rule-name" placeholder="Send customer photo records"><label>Describe your workflow</label><textarea id="rule-text" placeholder="When a photo arrives, read the order number, find the customer in Sheets and email them a verification link. If anything is unclear, ask me."></textarea><button id="compile" class="primary">Preview workflow</button><div id="compiled"></div>`,
  );
  if (existing) {
    d.querySelector("#rule-name").value = existing.name;
    d.querySelector("#rule-text").value = existing.draft_text;
  }
  // Editing the description invalidates the preview it produced.
  d.querySelector("#rule-text").addEventListener("input", () => {
    d.querySelector("#compiled").innerHTML = "";
  });
  on("#compile", "click", async () => {
    const text = d.querySelector("#rule-text").value;
    const r = await call("/rules/compile", "POST", { text });
    d.querySelector("#compiled").innerHTML =
      `<p class="notice">This first compiler supports order lookup → customer link delivery. Review every field below; unrecognized instructions are not executed.</p><ol class="checklist">${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><label>Delivery channel</label><select id="channel"><option value="email">Email</option><option value="sms" ${r.channel === "sms" ? "selected" : ""}>SMS</option></select><label>Email action</label><select id="delivery-mode"><option value="send">Send after approval</option><option value="draft">Create draft only (email)</option></select><label>Share image template</label><select id="rule-template"><option value="">Space default / original</option>${savedTemplates.map((t) => `<option value="${t.id}">${esc(t.name)} · v${t.version}</option>`).join("")}</select><label>Daily limit</label><input id="limit" type="number" value="100" min="1" max="1000"><label>Allowed email domain (optional)</label><input id="domain" placeholder="customer.com"><div id="rule-readiness" class="panel" aria-live="polite"></div><button id="save-rule" class="primary">Save draft</button>`;
    const readiness = () => {
      const channel = d.querySelector("#channel").value;
      const mode = d.querySelector("#delivery-mode");
      if (channel === "sms") mode.value = "send";
      mode.disabled = channel === "sms";
      const needs = [
        ["Google Sheets (customer lookup)", connected.has("sheets")],
        channel === "sms"
          ? ["Twilio SMS", connected.has("twilio")]
          : [
              "Gmail or Microsoft 365",
              connected.has("gmail") || connected.has("microsoft"),
            ],
      ];
      const domain = d.querySelector("#domain").value.trim();
      const limit = Number(d.querySelector("#limit").value) || 0;
      d.querySelector("#rule-readiness").innerHTML =
        `<h3>Before it can run</h3><ul class="checklist">${needs.map(([n, ok]) => `<li>${ok ? "✓" : "✗"} ${esc(n)}: ${ok ? "connected" : "<strong>not connected</strong> — connect it in Settings"}</li>`).join("")}<li>Who it can contact: only the one customer whose row uniquely matches a confirmed order number${domain ? `, and only addresses at ${esc(domain)}` : ""}. Anything ambiguous waits for you.</li><li>Estimated cost: up to ${limit} ${channel === "sms" ? "text messages" : "emails"} a day, billed by your provider${channel === "sms" ? " per message" : ""}; reading order numbers uses one AI request per photo.</li><li>Next: save the draft, run a dry-run (nothing is sent), then approve.</li></ul>`;
    };
    ["#channel", "#domain", "#limit"].forEach((sel) =>
      d.querySelector(sel).addEventListener("input", readiness),
    );
    labelize(d);
    if (existing) {
      d.querySelector("#channel").value = existing.dsl.channel;
      d.querySelector("#delivery-mode").value =
        existing.dsl.delivery_mode || "send";
      d.querySelector("#limit").value = existing.dsl.daily_limit;
      d.querySelector("#domain").value = existing.dsl.recipient_domain;
      d.querySelector("#rule-template").value =
        existing.template_snapshot?.id || "";
    }
    readiness();
    on("#save-rule", "click", async () => {
      await call(
        existing ? `/rules/${existing.id}` : "/rules",
        existing ? "PUT" : "POST",
        {
          name: d.querySelector("#rule-name").value,
          text,
          channel: d.querySelector("#channel").value,
          delivery_mode: d.querySelector("#delivery-mode").value,
          daily_limit: Number(d.querySelector("#limit").value),
          recipient_domain: d.querySelector("#domain").value,
          template_id: d.querySelector("#rule-template").value || undefined,
        },
      );
      d.remove();
      await automations();
    });
  });
}
async function team() {
  const members = await call("/members");
  document.querySelector("#page-actions").innerHTML = button(
    "Invite member",
    "invite",
    "primary",
  );
  content(
    `<div class="panel"><div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>${members.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td><td>${space.role === "Owner" && m.id !== me.id ? `<select data-member-role="${m.id}" aria-label="Role for ${esc(m.name)}">${["Admin", "Member", "Viewer"].map((role) => `<option ${m.role === role ? "selected" : ""}>${role}</option>`).join("")}</select>` : esc(m.role)}</td></tr>`).join("")}</tbody></table></div></div><section class="panel"><h2>Create another team</h2><p class="muted">Personal photos stay private. A new team gets its own members, photos and rules.</p><label>Team name</label><input id="team-name" placeholder="Your company"><p><button id="create-team">Create team</button></p></section>`,
  );
  on("[data-member-role]", "change", async (e, el) => {
    await call(`/members/${el.dataset.memberRole}`, "PATCH", {
      role: el.value,
    });
    toast("Member role updated");
  });
  on("#invite", "click", () => {
    const d = modal(
      "Invite to " + space.name,
      `<label>Role</label><select id="role"><option>Member</option><option>Admin</option><option>Viewer</option></select><p>Invitation links expire after 3 days and can be used once.</p><button id="make-invite" class="primary">Create invitation link</button><div id="invite-result"></div>`,
    );
    on("#make-invite", "click", async () => {
      const r = await call("/invites", "POST", {
        role: d.querySelector("#role").value,
      });
      d.querySelector("#invite-result").innerHTML =
        `<div class="linkbox">${esc(r.url)}</div>`;
    });
  });
  on("#create-team", "click", async () => {
    const r = await api("/api/spaces", "POST", {
      name: document.querySelector("#team-name").value,
    });
    localStorage.space = r.id;
    await init();
  });
}
async function settings() {
  const admin = ["Owner", "Admin"].includes(space.role);
  const connectors = admin ? await call("/connectors") : [];
  const shares = admin ? await call("/shares") : [];
  const usage = admin ? await call("/usage") : null;
  content(
    `<div class="split"><section class="panel"><h2>Space settings</h2><p>${esc(me.email)} · ${esc(space.name)}</p>${admin ? `<label>Company name</label><input id="company" value="${esc(space.settings.company || "")}"><label>Contact phone</label><input id="phone" value="${esc(space.settings.phone || "")}"><label>Retention (days)</label><input id="retention" type="number" value="${space.settings.retention_days || 90}" min="1" max="3650"><label><input id="cloud" type="checkbox" ${space.settings.cloud_enabled ? "checked" : ""}>I authorize uploading originals to this space</label><p class="muted">Photos remain private. Links expose only the selected record. Exact GPS is not included on the customer page.</p><button id="save-settings" class="primary">Save settings</button>` : "<p>Cloud and team settings are managed by your administrator.</p>"}<h3>Local upload queue</h3><div id="queue-settings"></div><button id="retry-sync">Retry pending uploads</button><p><button id="mobile-logout">Sign out</button></p></section><section>${
      admin
        ? `<div class="panel"><h2>Usage</h2><p>${(usage.stored_bytes / 1048576).toFixed(1)} MB stored · ${usage.captures} records · ${usage.ai_calls} AI requests</p><p class="muted">Provider fees are billed by your connected services. Team subscription pricing is not enabled in this build.</p><h2>Connected tools</h2><p class="muted">Credentials are encrypted on the server and isolated to this space. Access tokens may expire; reconnect when needed.</p>${connectors.map((c) => `<div class="row"><div><strong>${esc(c.provider)}</strong><p>${esc(c.status)}</p></div>${c.status === "connected" ? `<button data-revoke-connector="${c.id}">Disconnect</button>` : ""}</div>`).join("")}<p><button id="connect">Connect a tool</button></p></div><div class="panel"><h2>Active share links</h2>${
            shares
              .filter((s) => !s.revoked_at)
              .map(
                (s) =>
                  `<div class="row"><div><a href="/s/${s.token}" target="_blank">${s.capture_id.slice(0, 12)}</a><p>Expires ${fmt(s.expires_at)}</p></div><button data-revoke-share="${s.id}">Revoke</button></div>`,
              )
              .join("") || '<p class="muted">No active links.</p>'
          }</div>`
        : ""
    }</section></div>`,
  );
  on("#save-settings", "click", async () => {
    const b = {
      company: document.querySelector("#company").value,
      phone: document.querySelector("#phone").value,
      retention_days: Number(document.querySelector("#retention").value),
      cloud_enabled: document.querySelector("#cloud").checked,
    };
    await call("/settings", "PATCH", b);
    space.settings = { ...space.settings, ...b };
    toast("Settings saved");
  });
  on("#connect", "click", connectorEditor);
  on("[data-revoke-connector]", "click", async (e, el) => {
    await call(`/connectors/${el.dataset.revokeConnector}`, "DELETE");
    await settings();
  });
  on("[data-revoke-share]", "click", async (e, el) => {
    await call(`/shares/${el.dataset.revokeShare}`, "DELETE");
    await settings();
  });
  on("#retry-sync", "click", async () => {
    await retryBlocked();
    toast("Upload queue checked");
  });
  on("#mobile-logout", "click", async () => {
    await api("/api/auth/logout", "POST");
    auth();
  });
  document.querySelector("#queue-settings").textContent =
    `${(await localAll()).filter((r) => r.user_id === me.id && r.space_id === space.id).length} photos waiting for upload.`;
}
function connectorEditor() {
  const d = modal(
    "Connect a tool",
    `<p class="notice">Developer setup: use your organization’s scoped OAuth access token or Twilio credentials. Never use a personal account belonging to someone else.</p><label>Provider</label><select id="provider"><option value="sheets">Google Sheets</option><option value="gmail">Gmail</option><option value="microsoft">Microsoft 365</option><option value="twilio">Twilio SMS</option><option value="drive">Google Drive</option><option value="onedrive">OneDrive</option></select><div id="credential-fields"></div><label><input id="draft-permission" type="checkbox">Allow email drafts (requests compose permissions)</label><div class="actions"><button id="oauth-connect" class="primary">Authorize with provider</button><button id="save-connector">Save manual credentials</button></div>`,
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
      (p === "sheets"
        ? "<p>Sheet columns: order number, customer name, email, phone. First row is the header.</p>"
        : "") +
      (p === "twilio"
        ? '<label><input id="consent" type="checkbox">Recipients have consented to SMS. I will maintain opt-outs.</label>'
        : "");
  };
  d.querySelector("#provider").onchange = draw;
  draw();
  on("#oauth-connect", "click", async () => {
    const provider = d.querySelector("#provider").value;
    if (provider === "twilio")
      throw new Error("Use Twilio account credentials below.");
    const spreadsheet_id = d.querySelector(
        "[data-credential=spreadsheet_id]",
      )?.value,
      range = d.querySelector("[data-credential=range]")?.value;
    const r = await call(`/oauth/${provider}`, "POST", {
      spreadsheet_id,
      range,
      drafts: d.querySelector("#draft-permission").checked,
      writeback_column:
        d.querySelector("[data-credential=writeback_column]")?.value ||
        undefined,
    });
    location.href = r.url;
  });
  on("#save-connector", "click", async () => {
    const credentials = {};
    d.querySelectorAll("[data-credential]").forEach(
      (i) => (credentials[i.dataset.credential] = i.value),
    );
    await call("/connectors", "POST", {
      provider: d.querySelector("#provider").value,
      credentials,
      sms_consent: d.querySelector("#consent")?.checked || false,
    });
    d.remove();
    await settings();
  });
}
// IndexedDB transactions finish before a capture is reported as saved.
const localDB = new Promise((resolve, reject) => {
  const r = indexedDB.open("snapoto-local", 1);
  r.onupgradeneeded = () =>
    r.result.createObjectStore("captures", { keyPath: "id" });
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
  try {
    for (const record of await localAll()) {
      if (record.user_id !== me.id) continue;
      if (record.blocked && !manual) continue;
      try {
        const { space_id, user_id, error, blocked, ...payload } = record;
        await api(`/api/spaces/${space_id}/captures`, "POST", payload);
        await localWrite(record, true);
      } catch (e) {
        const next = { ...record, error: e.message };
        if (BLOCKED_STATUS.has(e.status)) next.blocked = e.message;
        else delete next.blocked;
        await localWrite(next);
      }
    }
  } finally {
    syncing = false;
    drawPending().catch(() => {});
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
  const sha256 = Array.from(new Uint8Array(digest), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
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
  await localWrite(r);
  toast("Saved on this device. Upload continues in the background.");
  await drawPending();
  sync().catch(() => {});
}
async function camera() {
  content(
    `<div class="camera"><div class="notice">Photos save on this device before upload. Keep this browser’s site data to preserve pending originals. Use the Android app for durable field capture.</div><p id="camera-status" class="muted">Opening camera…</p><video id="video" autoplay playsinline muted></video><button class="shutter" id="shutter" aria-label="Take photo" disabled>●</button><label>Photo note</label><input id="capture-note" placeholder="Optional context"><label>Or select an original photo</label><input id="upload" type="file" accept="image/jpeg,image/png" capture="environment"><p><button id="sync">Retry uploads</button></p><div id="local-status"></div></div>`,
  );
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
    await saveBlob(
      await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.95)),
    );
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
    document.querySelector("#camera-status").textContent = "Ready to capture";
  } catch (e) {
    document.querySelector("#camera-status").textContent =
      "Camera unavailable. Allow camera permission or select a photo below.";
  }
  await drawPending();
}
async function drawPending() {
  const box = document.querySelector("#local-status");
  if (!box || !me || !space) return;
  const pending = (await localAll()).filter(
    (r) => r.user_id === me.id && r.space_id === space.id,
  );
  box.innerHTML = pending
    .map(
      (r) =>
        `<p class="notice">${fmt(r.captured_at_device)} · ${esc(r.error || "Waiting for upload")}${r.blocked ? " · Automatic retry paused — fix access, then use Retry uploads." : ""}</p>`,
    )
    .join("");
}
async function publicPage() {
  const token = location.pathname.split("/")[2];
  try {
    const r = await api(`/api/public/${token}`),
      c = r.capture;
    if (r.access_required) {
      app.innerHTML = `<main class="verify">${brand}<section class="panel"><h1>Verify your email</h1><p>This record is restricted to ${esc(r.recipient_hint)}. Request a code to open it.</p><button id="request-code" class="primary">Email verification code</button><div id="code-form" hidden><label>Six-digit code</label><input id="otp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"><button id="verify-code">Open record</button></div></section></main>`;
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
    const a =
      c.assets.filter((a) => a.kind === "rendered").at(-1) ||
      c.assets.find((a) => ["original", "video"].includes(a.kind));
    const assetName = (x) =>
      x.kind === "rendered"
        ? "Watermarked copy"
        : x.kind === "video"
          ? "Original video"
          : "Original photo";
    const original = c.assets.find((x) => x.kind === "original");
    const integrity =
      c.hash_check === "verified"
        ? '<span class="badge">File matched its uploaded hash</span>'
        : '<span class="badge warn">Original no longer stored; integrity cannot be re-checked</span>';
    const late = receivedLate(c);
    app.innerHTML = `<main class="verify"><header>${brand}<span class="badge neutral">Shared record</span></header><h1>A photo from the field.</h1><p class="muted">Captured ${fmt(c.captured_at_device)} · device-reported time${late ? " · uploaded later" : ""}</p>${a?.available && a.kind === "video" ? `<video controls style="width:100%" src="/api/public/${token}/assets/${a.id}"></video>` : a?.available ? `<figure><img src="/api/public/${token}/assets/${a.id}" alt="${a.kind === "rendered" ? "Watermarked copy of the field photo" : "Original field photo"}"><figcaption class="muted">${a.kind === "rendered" ? "Watermarked copy. The text overlay is added for display and is not itself proof; the original file below is what was verified." : "Original photo as uploaded."}</figcaption></figure>` : '<div class="notice">Original unavailable. Cloud re-verification cannot be performed.</div>'}${original?.available && a?.kind === "rendered" ? `<details class="panel"><summary>View the original (no watermark)</summary><img src="/api/public/${token}/assets/${original.id}" alt="Original photo preview"></details>` : ""}<section class="panel"><h2>What this record verifies</h2><p>${integrity}</p><p>Received by server: ${fmt(c.server_received_at)}</p><p>${late ? "This photo was uploaded some time after it was taken (for example, offline). The capture time comes from the device clock; the server only vouches for when it received the file." : esc(c.time_evidence) + "."} Device identity and the scene itself have not been independently verified.</p>${c.assets.map((x) => `<p><strong>${assetName(x)}</strong><br><span class="hash">${esc(x.sha256)}</span>${r.download && x.available ? `<br><a href="/api/public/${token}/assets/${x.id}?download=1">Download ${esc(assetName(x).toLowerCase())}</a>` : ""}</p>`).join("")}<small>This link expires ${fmt(r.expires_at)} and can be revoked by the sender at any time. ${r.identity_check === "email_verified" ? "Access requires verification of the designated email." : "Anyone with this link can open it; please don’t forward it."}</small></section>${r.acknowledge ? `<section class="panel" id="ack-panel"><h2>Let the team know</h2><p>Viewing this page does not confirm receipt. ${r.identity_check === "email_verified" ? "Your response will record verified access to the designated email; it does not independently verify your identity." : "Your response below is self-reported, without identity verification."}</p><label>Your name</label><input id="ack-name" required><label>Comment (optional)</label><textarea id="ack-note"></textarea><div class="actions"><button data-ack="received" class="primary">Confirm received</button><button data-ack="issue">Report an issue</button></div></section>` : ""}</main>`;
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
        `<h2>Response recorded</h2><p>You ${el.dataset.ack === "issue" ? "reported an issue" : "confirmed receipt"}. Your response and its time have been saved and sent to the team. Thank you.</p>`;
    });
  } catch (e) {
    app.innerHTML = `<main class="verify">${brand}<section class="panel"><h1>This record is unavailable.</h1><p>${esc(e.status === 410 || e.status === 404 ? "This link has expired or was turned off by the sender." : e.message)}</p><p>Ask the sender for a new link.</p></section></main>`;
  }
}
window.addEventListener("online", () => sync().catch(() => {}));
setInterval(() => sync().catch(() => {}), 30000);
init();

async function showMap() {
  const rows = (await call("/captures")).filter((c) => c.gps);
  if (!rows.length) return toast("No GPS-tagged records in this space.");
  const d = modal(
    "Photo locations",
    '<p class="muted">Device-reported locations; accuracy varies. Map tiles are provided by OpenStreetMap.</p><div id="photo-map" style="height:480px"></div>',
  );
  const map = L.map(d.querySelector("#photo-map"));
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
      (c.address || "Field record") + " · " + fmt(c.captured_at_device);
    const open = document.createElement("button");
    open.textContent = "Open record";
    open.onclick = () => detail(c.id);
    popup.append(open);
    L.circleMarker(point, { radius: 8, color: "#235edb", fillOpacity: 0.8 })
      .addTo(map)
      .bindPopup(popup);
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
async function comparePhotos() {
  const rows = await call("/captures");
  if (rows.length < 2) return toast("Add at least two records to compare.");
  const d = modal(
    "Compare photo records",
    '<p class="muted">Compare originals side by side. Capture times are device-reported; no automatic claim of completion is made.</p><div class="split">' +
      [0, 1]
        .map(
          (i) =>
            '<div><select data-comparison="' +
            i +
            '">' +
            rows
              .map(
                (c, j) =>
                  '<option value="' +
                  c.id +
                  '" ' +
                  (j === i ? "selected" : "") +
                  ">" +
                  esc(c.collection || c.address || c.id.slice(0, 12)) +
                  " · " +
                  fmt(c.captured_at_device) +
                  "</option>",
              )
              .join("") +
            '</select><div id="comparison-' +
            i +
            '"></div></div>',
        )
        .join("") +
      "</div>",
  );
  const draw = () => {
    d.querySelectorAll("[data-comparison]").forEach((select) => {
      const c = rows.find((c) => c.id === select.value),
        a = c.assets.find((a) => a.kind === "original");
      d.querySelector("#comparison-" + select.dataset.comparison).innerHTML =
        (a
          ? '<img class="detail" src="' +
            route("/captures/" + c.id + "/assets/" + a.id) +
            '" alt="Original comparison photo">'
          : "") +
        "<p>" +
        esc(c.note) +
        "</p><small>" +
        esc(c.hash_check) +
        "</small>";
    });
  };
  d.querySelectorAll("select").forEach((s) => (s.onchange = draw));
  draw();
}
async function developer() {
  const data = await call("/developer");
  content(
    '<div class="notice">Keys can read verification metadata in this space only. Requests require an HMAC signature, a timestamp and a one-time nonce. Keys expire after 90 days.</div><section class="panel"><h2>API keys</h2>' +
      data.keys
        .map(
          (k) =>
            '<div class="row"><div><strong>' +
            esc(k.name) +
            "</strong><p>" +
            esc(k.scopes.join(", ")) +
            " · " +
            (k.revoked ? "Revoked" : "Active") +
            "</p></div>" +
            (!k.revoked
              ? '<button data-revoke-key="' + k.id + '">Revoke</button>'
              : "") +
            "</div>",
        )
        .join("") +
      '<label>Key name</label><input id="key-name" placeholder="Operations dashboard"><p><button id="create-key" class="primary">Create read-only key</button></p><div id="key-result"></div></section><section class="panel"><h2>Webhooks</h2><p class="muted">Signed, retryable events for cloud-verified photos and customer responses. Receivers must deduplicate by event ID.</p>' +
      data.webhooks
        .map(
          (w) =>
            '<div class="row"><div>' +
            esc(w.url) +
            "<p>" +
            (w.enabled ? "Enabled" : "Disabled") +
            "</p></div>" +
            (w.enabled
              ? '<button data-disable-hook="' + w.id + '">Disable</button>'
              : "") +
            "</div>",
        )
        .join("") +
      '<label>Approved HTTPS endpoint</label><input id="hook-url" type="url" placeholder="https://your-company.com/events"><p><button id="create-hook">Create webhook</button></p><div id="hook-result"></div></section><section class="panel"><h2>Webhook delivery log</h2>' +
      data.events
        .map(
          (e) =>
            "<p>" +
            esc(e.state) +
            " · attempt " +
            e.attempts +
            " · " +
            esc(e.error || e.event_id) +
            "</p>",
        )
        .join("") +
      "</section>",
  );
  on("#create-key", "click", async () => {
    const r = await call("/developer/keys", "POST", {
      name: document.querySelector("#key-name").value,
    });
    document.querySelector("#key-result").innerHTML =
      '<p>Copy these now. They will not be shown again.</p><pre class="code">' +
      esc(JSON.stringify(r, null, 2)) +
      "</pre>";
  });
  on("[data-revoke-key]", "click", async (e, el) => {
    await call("/developer/keys/" + el.dataset.revokeKey, "DELETE");
    await developer();
  });
  on("#create-hook", "click", async () => {
    const r = await call("/developer/webhooks", "POST", {
      url: document.querySelector("#hook-url").value,
    });
    document.querySelector("#hook-result").innerHTML =
      '<p>Save this signing secret now.</p><pre class="code">' +
      esc(JSON.stringify(r, null, 2)) +
      "</pre>";
  });
  on("[data-disable-hook]", "click", async (e, el) => {
    await call("/developer/webhooks/" + el.dataset.disableHook, "DELETE");
    await developer();
  });
}
