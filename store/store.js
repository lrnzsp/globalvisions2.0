// Global Visions track store: client logic for every store page.
// Strings come from the per-page JSON block #store-i18n (written by tools/build-store.mjs).
// API: same-origin /api/store/* (Vercel rewrite to the Cloudflare Worker), see docs/store/CONTRACT.md.
(() => {
  "use strict";

  const cfgEl = document.getElementById("store-i18n");
  if (!cfgEl) return;
  const cfg = JSON.parse(cfgEl.textContent);
  const s = cfg.s;
  const lang = cfg.lang;
  const API = "/api/store";
  const $ = (sel, root = document) => root.querySelector(sel);
  const locale = lang === "it" ? "it-IT" : "en-GB";

  // ---------------------------------------------------------------- demo mode
  const params = new URLSearchParams(location.search);
  let DEMO = false;
  try {
    if (params.get("demo") === "1") sessionStorage.setItem("gv_demo", "1");
    if (params.get("demo") === "0") sessionStorage.removeItem("gv_demo");
    DEMO = sessionStorage.getItem("gv_demo") === "1";
  } catch (e) {
    DEMO = params.get("demo") === "1";
  }

  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const demoState = {
    me: { ok: true, signed_in: true, kind: "steam", steam_id: "76561198012345678" },
    licences: [
      {
        id: "lic_demo7k2m9x4qh3w8v6t5r1p0", track_id: "example-circuit", track_name: "Example Circuit",
        type: "personal", status: "active", max_machines: 2, created_at: iso(86400000 * 12),
        machines: [
          { id: "mac_demoa1", first_seen: iso(86400000 * 12), last_seen: iso(120000), active_now: true },
          { id: "mac_demob2", first_seen: iso(86400000 * 5), last_seen: iso(86400000 * 2), active_now: false },
        ],
        release_available_at: null,
      },
      {
        id: "lic_demo3n8b5c2d7f1g6h4j9k0", track_id: "lago-ring", track_name: "Lago Ring (demo)",
        type: "personal", status: "refunded", max_machines: 2, created_at: iso(86400000 * 40),
        machines: [], release_available_at: null,
      },
    ],
    adminLicences: [
      { id: "lic_demo7k2m9x4qh3w8v6t5r1p0", steam_id: "76561198012345678", track_id: "example-circuit", type: "personal", status: "active", max_machines: 2, machines: [{}, {}], created_at: iso(86400000 * 12), order_id: "cs_live_demo_a1" },
      { id: "lic_demo3n8b5c2d7f1g6h4j9k0", steam_id: "76561198012345678", track_id: "lago-ring", type: "personal", status: "refunded", max_machines: 2, machines: [], created_at: iso(86400000 * 40), order_id: "cs_live_demo_b2" },
      { id: "lic_democom9q8w7e6r5t4y3u2i1", steam_id: null, track_id: "example-circuit", type: "commercial", status: "active", max_machines: 10, machines: [{}, {}, {}, {}, {}, {}], created_at: iso(86400000 * 3), order_id: "cs_live_demo_c3" },
    ],
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function demoApi(method, path, body) {
    await wait(350);
    const p = path.split("?")[0];
    if (p === "/me") return demoState.me;
    if (p === "/licences") return { ok: true, licences: demoState.licences };
    if (p === "/auth/logout") { demoState.me = { ok: true, signed_in: false, kind: null }; return { ok: true }; }
    if (p === "/checkout") return { ok: true, url: `${cfg.base}account/?session_id=${body.type === "commercial" ? "cs_demo_com" : "cs_demo_per"}` };
    if (p === "/checkout/result") {
      const sid = new URLSearchParams(path.split("?")[1]).get("session_id") || "";
      demoState.polls = (demoState.polls || 0) + 1;
      if (demoState.polls < 2) return { ok: true, status: "pending" };
      return sid.includes("com")
        ? { ok: true, status: "ready", type: "commercial", track_id: "example-circuit", licence_id: "lic_democom9q8w7e6r5t4y3u2i1", licence_key: "GVC-7KQ2-M9XD-4TPA-ZR3H" }
        : { ok: true, status: "ready", type: "personal", track_id: "example-circuit", licence_id: demoState.licences[0].id };
    }
    if (p === "/downloads") return { ok: true, url: "#demo-download", expires_at: iso(-900000), copy_id: "cp_demo4f7g2h9" };
    if (p === "/machines/release") {
      const lic = demoState.licences.find((l) => l.id === body.licence_id);
      if (lic && lic.release_available_at) throw { error: "release_cooldown", retry_at: lic.release_available_at };
      if (lic) {
        lic.machines = lic.machines.filter((m) => m.id !== body.machine_id);
        lic.release_available_at = new Date(Date.now() + 7 * 86400000).toISOString();
      }
      return { ok: true };
    }
    if (p === "/commercial/login") {
      if (!/^GVC-/i.test(body.licence_key || "")) throw { error: "not_found" };
      demoState.me = { ok: true, signed_in: true, kind: "commercial", licence_ids: ["lic_democom9q8w7e6r5t4y3u2i1"] };
      return { ok: true };
    }
    if (p === "/admin/licences") {
      const q = new URLSearchParams(path.split("?")[1] || "");
      return {
        ok: true,
        licences: demoState.adminLicences.filter((l) =>
          (!q.get("steam_id") || l.steam_id === q.get("steam_id")) &&
          (!q.get("track_id") || l.track_id === q.get("track_id")) &&
          (!q.get("status") || l.status === q.get("status")) &&
          (!q.get("q") || l.id.includes(q.get("q")) || l.order_id.includes(q.get("q")))),
      };
    }
    let m = p.match(/^\/admin\/licences\/([^/]+)\/(revoke|reactivate|reset-machines)$/);
    if (m) {
      const l = demoState.adminLicences.find((x) => x.id === m[1]);
      if (l) { if (m[2] === "revoke") l.status = "disabled"; if (m[2] === "reactivate") l.status = "active"; if (m[2] === "reset-machines") l.machines = []; }
      return { ok: true };
    }
    if (p === "/admin/stats") return { ok: true, tracks: [{ track_id: "example-circuit", licences: 2, active: 2, refunded: 0, downloads: 9 }, { track_id: "lago-ring", licences: 1, active: 0, refunded: 1, downloads: 1 }] };
    m = p.match(/^\/admin\/copies\/(.+)$/);
    if (m) {
      if (m[1] !== "cp_demo4f7g2h9") throw { error: "not_found" };
      return { ok: true, copy_id: m[1], licence_id: "lic_demo7k2m9x4qh3w8v6t5r1p0", steam_id: "76561198012345678", track_id: "example-circuit", created_at: iso(86400000 * 2) };
    }
    throw { error: "not_found" };
  }

  // ---------------------------------------------------------------- API
  async function api(method, path, body, headers = {}) {
    if (DEMO) return demoApi(method, path, body || {});
    let res;
    try {
      res = await fetch(API + path, {
        method,
        credentials: "same-origin",
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw { error: "unreachable" };
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON, e.g. a 404 page before the Worker exists */ }
    if (!data) throw { error: res.status === 401 || res.status === 403 ? "unauthorized" : (res.status >= 500 || res.status === 404 ? "unreachable" : "server_error") };
    if (!res.ok || data.ok === false) throw { ...data, error: data.error || (res.status === 401 ? "unauthorized" : "server_error"), status: res.status };
    return data;
  }
  const errText = (e) => (e && s.errors[e.error]) || s.errors.server_error;

  // ---------------------------------------------------------------- UI helpers
  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };
  const cursor = document.querySelector(".cursor");
  const hoverable = (node) => {
    if (!cursor) return node;
    node.querySelectorAll?.("a, button").forEach((x) => {
      x.addEventListener("mouseenter", () => cursor.classList.add("is-hover"));
      x.addEventListener("mouseleave", () => cursor.classList.remove("is-hover"));
    });
    return node;
  };
  let toastTimer;
  function toast(text) {
    const t = $("#store-toast");
    if (!t) return;
    t.textContent = text;
    t.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("is-on"), 3800);
  }
  function notice(text) {
    const n = $("#store-notice");
    if (!n) return;
    n.textContent = text;
    n.hidden = false;
  }
  const fmtDate = (d) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(new Date(d));
  const fmtDateTime = (d) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(d));
  const shortId = (id) => (id ? `${id.slice(0, 5)}...${id.slice(-4)}` : "");
  const loginUrl = (next) => `${API}/auth/steam/login?next=${encodeURIComponent(next || location.pathname)}&lang=${lang}`;
  const setBusy = (btn, busy) => { if (btn) { btn.classList.toggle("is-busy", busy); btn.setAttribute("aria-busy", busy ? "true" : "false"); } };
  const trackName = (id, fallback) => (cfg.tracks.find((t) => t.track_id === id) || {}).name || fallback || id;
  const trackPoster = (id) => `/store/media/${id}/poster.svg`;

  if (DEMO) {
    const ribbon = el("div", { class: "demo-ribbon", role: "note" }, [
      s.demo,
      el("button", { type: "button", onclick: () => { try { sessionStorage.removeItem("gv_demo"); } catch (e) {} location.href = location.pathname; } }, s.demoExit),
    ]);
    document.body.append(ribbon);
  }

  // ---------------------------------------------------------------- session
  const state = { me: null, apiDown: false };
  async function loadMe() {
    try {
      state.me = await api("GET", "/me");
    } catch (e) {
      state.me = { signed_in: false };
      if (e.error === "unreachable" || e.error === "server_error") {
        state.apiDown = true;
        notice(s.setup);
      }
    }
    paintAuth();
    return state.me;
  }
  function paintAuth() {
    const a = $("#store-auth");
    if (!a) return;
    const label = a.querySelector(".store-auth__label");
    if (state.me && state.me.signed_in) {
      a.href = `${cfg.base}account/`;
      label.textContent = s.myTracks;
      a.setAttribute("aria-label", s.myTracks);
    } else {
      a.href = loginUrl(cfg.page === "admin" ? `${cfg.base}account/` : location.pathname);
      a.setAttribute("aria-label", label.textContent);
    }
  }

  // ---------------------------------------------------------------- track page
  function initTrack() {
    const tr = cfg.track;
    // Gallery + lightbox
    const shots = tr.screenshots;
    const main = $("#gallery-main");
    const mainImg = main && main.querySelector("img");
    const thumbs = [...document.querySelectorAll(".gallery__thumb")];
    const dlg = $("#lightbox");
    let idx = 0;
    const show = (i) => {
      idx = (i + shots.length) % shots.length;
      if (mainImg) mainImg.src = shots[idx];
      main.dataset.index = idx;
      thumbs.forEach((t, j) => t.classList.toggle("is-active", j === idx));
      if (dlg && dlg.open) paintLightbox();
    };
    const paintLightbox = () => {
      $("#lightbox-img").src = shots[idx];
      $("#lightbox-img").alt = `${tr.name} ${idx + 1}`;
      $("#lightbox-count").textContent = `${idx + 1} / ${shots.length}`;
    };
    thumbs.forEach((t) => t.addEventListener("click", () => show(Number(t.dataset.index))));
    if (main && dlg && typeof dlg.showModal === "function") {
      main.addEventListener("click", () => { paintLightbox(); dlg.showModal(); $("#lightbox-close").focus(); });
      $("#lightbox-close").addEventListener("click", () => dlg.close());
      $("#lightbox-prev").addEventListener("click", () => show(idx - 1));
      $("#lightbox-next").addEventListener("click", () => show(idx + 1));
      dlg.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft") show(idx - 1);
        if (e.key === "ArrowRight") show(idx + 1);
      });
      dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
      dlg.addEventListener("close", () => main.focus());
    }

    // Buy
    const btn = $("#buy-btn");
    const label = $("#buy-label");
    const status = $("#buy-status");
    if (!btn || tr.status !== "available") return;
    const type = () => (document.querySelector('input[name="licence-type"]:checked') || {}).value || "personal";
    const paint = () => {
      if (type() === "commercial") label.textContent = s.buyCommercial;
      else label.textContent = state.me && state.me.signed_in && state.me.kind === "steam" ? s.buyPersonal : s.buySignin;
      btn.disabled = state.apiDown;
    };
    document.querySelectorAll('input[name="licence-type"]').forEach((r) => r.addEventListener("change", paint));
    paint();
    btn.addEventListener("click", async () => {
      status.textContent = "";
      status.classList.remove("is-error");
      if (type() === "commercial") { location.href = `${cfg.base}commercial/?track=${encodeURIComponent(tr.track_id)}`; return; }
      if (!(state.me && state.me.signed_in && state.me.kind === "steam")) { location.href = loginUrl(location.pathname); return; }
      setBusy(btn, true);
      status.textContent = s.redirecting;
      try {
        const r = await api("POST", "/checkout", { track_id: tr.track_id, type: "personal", lang });
        location.href = r.url;
      } catch (e) {
        if (e.error === "login_required") { location.href = loginUrl(location.pathname); return; }
        status.textContent = errText(e);
        status.classList.add("is-error");
        setBusy(btn, false);
      }
    });
    return paint;
  }

  // ---------------------------------------------------------------- account page
  async function initAccount() {
    const list = $("#licence-list");
    const who = $("#account-who");
    const signin = $("#signin-panel");
    const sid = params.get("session_id");
    if (sid) pollCheckout(sid);

    if (!state.me || !state.me.signed_in) {
      signin.hidden = false;
      $("#signin-steam").href = loginUrl(`${cfg.base}account/`);
      return;
    }
    who.hidden = false;
    who.replaceChildren(
      el("span", {}, state.me.kind === "steam"
        ? [`${s.signedAs} `, el("strong", { text: `${s.steamId} ${state.me.steam_id}` })]
        : [el("strong", { text: s.venueSession })]),
      el("button", { type: "button", class: "btn-small", onclick: signOut }, s.signout),
    );
    hoverable(who);
    await renderLicences(list);
  }

  async function signOut() {
    try { await api("POST", "/auth/logout", {}); } catch (e) { /* the cookie may already be gone */ }
    location.href = cfg.base;
  }

  async function renderLicences(list) {
    let data;
    try {
      data = await api("GET", "/licences");
    } catch (e) {
      list.replaceChildren(el("p", { class: "licence-empty", text: errText(e) }));
      return;
    }
    const lics = data.licences || [];
    if (!lics.length) {
      list.replaceChildren(el("div", { class: "licence-empty" }, [
        el("p", { text: s.none }),
        el("a", { class: "btn btn--ghost", href: cfg.base }, s.browse),
      ]));
      hoverable(list);
      return;
    }
    list.replaceChildren(...lics.map(licenceCard));
    hoverable(list);
  }

  function licenceCard(l) {
    const active = l.status === "active";
    const statusClass = active ? "badge--ok" : `badge--${l.status}`;
    const machines = l.machines || [];
    const cooldown = l.release_available_at && new Date(l.release_available_at) > new Date();
    const dlBtn = active ? el("button", { type: "button", class: "btn btn--primary", onclick: (ev) => download(ev.currentTarget, l) }, [el("span", { text: s.download })]) : null;
    const machineItems = machines.map((m, i) => {
      const rel = el("button", {
        type: "button", class: "btn-small", disabled: !active || cooldown,
        onclick: (ev) => release(ev.currentTarget, l, m),
      }, s.release);
      return el("li", { class: "machine" }, [
        el("span", { class: "machine__name" }, [el("span", { class: `machine__dot${m.active_now ? " is-on" : ""}`, "aria-hidden": "true" }), `${s.machineN} ${i + 1}`, m.active_now ? el("span", { class: "visually-hidden", text: `, ${s.activeNow}` }) : null]),
        el("span", { class: "machine__times", text: `${s.firstSeen} ${fmtDate(m.first_seen)} · ${s.lastSeen} ${fmtDateTime(m.last_seen)}${m.active_now ? ` · ${s.activeNow}` : ""}` }),
        active ? rel : null,
      ]);
    });
    return el("article", { class: "licence-card", "aria-labelledby": `lic-${l.id}` }, [
      el("div", { class: "licence-card__media" }, el("img", { src: trackPoster(l.track_id), alt: "", loading: "lazy", width: "1600", height: "900", onerror: (e) => { e.currentTarget.src = "/store/media/example-circuit/poster.svg"; } })),
      el("div", { class: "licence-card__body" }, [
        el("div", { class: "licence-card__head" }, [
          el("h3", { class: "licence-card__name", id: `lic-${l.id}`, text: l.track_name || trackName(l.track_id) }),
          el("div", { class: "licence-card__badges" }, [
            el("span", { class: "badge", text: l.type === "commercial" ? s.commercial : s.personal }),
            el("span", { class: `badge ${statusClass}`, text: s[l.status] || l.status }),
          ]),
        ]),
        el("p", { class: "licence-card__meta", text: `${s.bought} ${fmtDate(l.created_at)} · ${l.id}` }),
        l.status === "refunded" ? el("p", { class: "licence-card__note", text: s.refundedNote }) : null,
        l.status === "disabled" ? el("p", { class: "licence-card__note", text: s.disabledNote }) : null,
        dlBtn ? el("div", { class: "licence-card__actions" }, [dlBtn, el("span", { class: "form-status", role: "status", "aria-live": "polite" })]) : null,
        active ? el("div", { class: "machines" }, [
          el("div", { class: "machines__head" }, [el("span", { text: s.machines }), el("span", { text: s.slots.replace("{u}", machines.length).replace("{m}", l.max_machines) })]),
          machines.length ? el("ul", {}, machineItems) : el("p", { class: "machines__note", text: s.noMachines }),
          cooldown ? el("p", { class: "machines__note", text: `${s.cooldown} ${fmtDateTime(l.release_available_at)}.` }) : null,
        ]) : null,
      ]),
    ]);
  }

  async function download(btn, l) {
    const status = btn.parentElement.querySelector(".form-status");
    setBusy(btn, true);
    status.textContent = s.preparing;
    status.classList.remove("is-error");
    try {
      const r = await api("POST", "/downloads", { licence_id: l.id });
      if (DEMO) { toast(s.demoDownload); status.textContent = ""; }
      else { location.href = r.url; status.textContent = ""; }
    } catch (e) {
      status.textContent = errText(e);
      status.classList.add("is-error");
    }
    setBusy(btn, false);
  }

  async function release(btn, l, m) {
    if (!btn.classList.contains("is-confirm")) {
      btn.classList.add("is-confirm");
      btn.textContent = s.confirm;
      setTimeout(() => { if (btn.isConnected) { btn.classList.remove("is-confirm"); btn.textContent = s.release; } }, 4000);
      return;
    }
    setBusy(btn, true);
    try {
      await api("POST", "/machines/release", { licence_id: l.id, machine_id: m.id });
      toast(s.released);
    } catch (e) {
      toast(e.error === "release_cooldown" && e.retry_at ? `${s.errors.release_cooldown} ${s.cooldown} ${fmtDateTime(e.retry_at)}.` : errText(e));
    }
    await renderLicences($("#licence-list"));
  }

  async function pollCheckout(sid) {
    const box = $("#checkout-status");
    box.hidden = false;
    const card = el("div", { class: "store-card" }, [el("p", {}, [el("span", { class: "checkout-spinner", "aria-hidden": "true" }), s.finalising])]);
    box.replaceChildren(card);
    const started = Date.now();
    while (Date.now() - started < 60000) {
      try {
        const r = await api("GET", `/checkout/result?session_id=${encodeURIComponent(sid)}`);
        if (r.status === "ready") {
          const parts = [el("h2", { text: s.finalised })];
          if (r.licence_key) {
            const copyBtn = el("button", { type: "button", class: "btn-small" }, s.copy);
            copyBtn.addEventListener("click", async () => {
              try { await navigator.clipboard.writeText(r.licence_key); copyBtn.textContent = s.copied; } catch (e) { /* user can select it */ }
            });
            parts.push(el("p", { class: "section__tag", text: s.keyTitle }), el("div", { class: "key-box" }, [el("code", { text: r.licence_key }), copyBtn]), el("p", { text: s.keyNote }));
            if (r.type === "commercial" && !(state.me && state.me.signed_in)) {
              try { await api("POST", "/commercial/login", { licence_key: r.licence_key }); state.me = await api("GET", "/me"); } catch (e) { /* the buyer can sign in with the key */ }
            }
          }
          box.replaceChildren(hoverable(el("div", { class: "store-card" }, parts)));
          const url = new URL(location.href);
          url.searchParams.delete("session_id");
          history.replaceState(null, "", url.pathname + url.search);
          if (state.me && state.me.signed_in) {
            $("#signin-panel").hidden = true;
            await initAccountSignedIn();
          }
          return;
        }
      } catch (e) {
        if (e.error === "unreachable") break;
      }
      await wait(2000);
    }
    box.replaceChildren(el("div", { class: "store-card" }, [el("p", { text: s.slow })]));
  }
  async function initAccountSignedIn() {
    const who = $("#account-who");
    if (who.hidden) {
      who.hidden = false;
      who.replaceChildren(
        el("span", {}, state.me.kind === "steam" ? [`${s.signedAs} `, el("strong", { text: `${s.steamId} ${state.me.steam_id}` })] : [el("strong", { text: s.venueSession })]),
        el("button", { type: "button", class: "btn-small", onclick: signOut }, s.signout),
      );
    }
    paintAuth();
    await renderLicences($("#licence-list"));
  }

  // ---------------------------------------------------------------- commercial page
  function initCommercial() {
    const buy = $("#com-buy");
    const sel = $("#com-track");
    const pre = params.get("track");
    if (pre && sel && [...sel.options].some((o) => o.value === pre)) sel.value = pre;
    buy && buy.addEventListener("submit", async (e) => {
      e.preventDefault();
      const status = $("#com-buy-status");
      const btn = buy.querySelector("button[type=submit]");
      status.classList.remove("is-error");
      status.textContent = s.redirecting;
      setBusy(btn, true);
      try {
        const r = await api("POST", "/checkout", { track_id: sel.value, type: "commercial", lang });
        location.href = r.url;
      } catch (err) {
        status.textContent = errText(err);
        status.classList.add("is-error");
        setBusy(btn, false);
      }
    });
    const key = $("#key-login");
    key && key.addEventListener("submit", async (e) => {
      e.preventDefault();
      const status = $("#key-status");
      const btn = key.querySelector("button[type=submit]");
      status.classList.remove("is-error");
      status.textContent = "";
      setBusy(btn, true);
      try {
        await api("POST", "/commercial/login", { licence_key: $("#licence-key").value.trim() });
        location.href = `${cfg.base}account/`;
      } catch (err) {
        status.textContent = err.error === "not_found" ? s.keyInvalid : errText(err);
        status.classList.add("is-error");
        setBusy(btn, false);
      }
    });
  }

  // ---------------------------------------------------------------- admin page
  function initAdmin() {
    const a = s.admin;
    const KEY = "gv_admin_token";
    let token = "";
    try { token = sessionStorage.getItem(KEY) || ""; } catch (e) { /* private mode */ }
    const auth = () => ({ Authorization: `Bearer ${token}` });
    const form = $("#admin-token-form");
    const app = $("#admin-app");
    const status = $("#admin-status");

    const open = async () => {
      try {
        await loadStats();
        form.hidden = true;
        app.hidden = false;
        await search();
      } catch (e) {
        $("#admin-token-status").textContent = errText(e);
        $("#admin-token-status").classList.add("is-error");
        form.hidden = false;
        app.hidden = true;
      }
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      token = $("#admin-token").value.trim();
      try { sessionStorage.setItem(KEY, token); } catch (err) { /* keep in memory */ }
      open();
    });
    $("#admin-forget").addEventListener("click", () => {
      try { sessionStorage.removeItem(KEY); } catch (e) { /* nothing */ }
      token = "";
      app.hidden = true;
      form.hidden = false;
      $("#admin-token").value = "";
    });

    async function loadStats() {
      const r = await api("GET", "/admin/stats", null, auth());
      const rows = (r.tracks || []).map((t) => el("tr", {}, [
        el("td", { text: trackName(t.track_id) }), el("td", { text: t.licences }), el("td", { text: t.active }), el("td", { text: t.refunded }), el("td", { text: t.downloads }),
      ]));
      $("#admin-stats").replaceChildren(el("table", { class: "admin-table" }, [
        el("thead", {}, el("tr", {}, [a.track, a.total, a.activeCol, a.refundedCol, a.downloads].map((h) => el("th", { scope: "col", text: h })))),
        el("tbody", {}, rows),
      ]));
    }

    async function search(ev) {
      if (ev) ev.preventDefault();
      const q = new URLSearchParams();
      for (const [k, v] of new FormData($("#admin-search"))) if (String(v).trim()) q.set(k, String(v).trim());
      status.textContent = "";
      status.classList.remove("is-error");
      try {
        const r = await api("GET", `/admin/licences${q.toString() ? `?${q}` : ""}`, null, auth());
        const lics = r.licences || [];
        if (!lics.length) { $("#admin-licences").replaceChildren(el("p", { text: a.empty })); return; }
        const act = (l, what, confirmText) => async (e) => {
          if (confirmText && !window.confirm(confirmText)) return;
          setBusy(e.currentTarget, true);
          try {
            await api("POST", `/admin/licences/${encodeURIComponent(l.id)}/${what}`, {}, auth());
            status.textContent = a.done;
          } catch (err) {
            status.textContent = errText(err);
            status.classList.add("is-error");
          }
          await search();
          await loadStats();
        };
        $("#admin-licences").replaceChildren(hoverable(el("table", { class: "admin-table" }, [
          el("thead", {}, el("tr", {}, [a.id, a.steam, a.track, a.type, a.status, a.machines, a.created, a.actions].map((h) => el("th", { scope: "col", text: h })))),
          el("tbody", {}, lics.map((l) => el("tr", {}, [
            el("td", {}, [el("code", { text: l.id }), el("br"), el("small", { text: `${a.order}: ${l.order_id || ""}` })]),
            el("td", {}, el("code", { text: l.steam_id || "-" })),
            el("td", { text: trackName(l.track_id) }),
            el("td", { text: l.type }),
            el("td", {}, el("span", { class: `badge ${l.status === "active" ? "badge--ok" : `badge--${l.status}`}`, text: l.status })),
            el("td", { text: `${(l.machines || []).length} / ${l.max_machines}` }),
            el("td", { text: fmtDate(l.created_at) }),
            el("td", {}, [
              l.status === "active"
                ? el("button", { type: "button", class: "btn-small", onclick: act(l, "revoke", a.confirmRevoke) }, a.revoke)
                : el("button", { type: "button", class: "btn-small", onclick: act(l, "reactivate") }, a.reactivate),
              el("button", { type: "button", class: "btn-small", onclick: act(l, "reset-machines", a.confirmReset) }, a.reset),
            ]),
          ]))),
        ])));
      } catch (e) {
        status.textContent = errText(e);
        status.classList.add("is-error");
      }
    }
    $("#admin-search").addEventListener("submit", search);

    $("#admin-trace").addEventListener("submit", async (e) => {
      e.preventDefault();
      const out = $("#trace-result");
      const id = $("#trace-id").value.trim();
      try {
        const r = await api("GET", `/admin/copies/${encodeURIComponent(id)}`, null, auth());
        out.replaceChildren(el("div", { class: "trace-card" }, el("dl", {}, [
          ["Copy", r.copy_id], [a.id, r.licence_id], [a.steam, r.steam_id || "-"], [a.track, trackName(r.track_id)], [a.created, fmtDateTime(r.created_at)],
        ].map(([k, v]) => el("div", {}, [el("dt", { text: k }), el("dd", {}, el("code", { text: v }))])))));
      } catch (err) {
        out.replaceChildren(el("p", { class: "form-status is-error", text: err.error === "not_found" ? a.notFound : errText(err) }));
      }
    });

    if (token) open();
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    const page = cfg.page;
    let repaintBuy = null;
    if (page === "track") repaintBuy = initTrack();
    if (page === "commercial") initCommercial();
    if (page === "admin") { initAdmin(); await loadMe(); return; }
    await loadMe();
    if (repaintBuy) repaintBuy();
    if (page === "account") await initAccount();
  }
  boot();
})();
