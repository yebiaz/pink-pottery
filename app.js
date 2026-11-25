(() => {
  "use strict";
  const CFG = window.AUCTION_CONFIG || {};
  // Accept any form of the Supabase URL: "https://ref.supabase.co", ".../rest/v1/", or the dashboard link.
  (function normalizeUrl() {
    let u = String(CFG.supabaseUrl || "").trim();
    if (!u) return;
    const dash = u.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
    if (dash) u = "https://" + dash[1] + ".supabase.co";
    if (!/^https?:\/\//.test(u)) u = "https://" + u;
    try { u = new URL(u).origin; } catch {}
    CFG.supabaseUrl = u;
    CFG.supabaseAnonKey = String(CFG.supabaseAnonKey || "").trim();
  })();
  const LIVE = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
  const DEADLINE = new Date(CFG.deadline || "2026-11-30T00:00:00+08:00");
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ---------- small storage helpers (never throw) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };

  // ---------- state ----------
  let catalog = { ribbons: [], pieces: [] };
  let byId = {};
  let stats = {};          // piece_id -> { top, count, history: [] }
  let shuffleOrder = {};   // piece_id -> random rank (per visit)
  let myBids = store.get("pp_mybids", {}); // piece_id -> my highest amount
  let current = null;      // piece open in modal
  let slideIdx = 0;

  const num = p => Number(String(p.id).replace(/\D/g, ""));
  const title = p => p.name || (p._kind === "ribbons" ? "Ribbon " : "Piece ") + num(p);
  const isClosed = () => Date.now() >= DEADLINE.getTime();
  const yuan = n => "¥" + Number(n).toLocaleString("en-US");
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- data layer ----------
  const api = {
    headers() {
      const h = { apikey: CFG.supabaseAnonKey, "Content-Type": "application/json" };
      // old-style anon keys are JWTs (eyJ…) and also go in Authorization; new sb_publishable_ keys must not
      if (CFG.supabaseAnonKey.startsWith("eyJ")) h.Authorization = "Bearer " + CFG.supabaseAnonKey;
      return h;
    },
    async loadBids() {
      if (!LIVE) return store.get("pp_demo_bids", []);
      const url = CFG.supabaseUrl.replace(/\/$/, "") +
        "/rest/v1/public_bids?select=piece_id,amount,netid_masked,created_at&order=amount.desc&limit=5000";
      const r = await fetch(url, { headers: this.headers(), cache: "no-store" });
      if (!r.ok) throw new Error("Couldn't load bids (" + r.status + ")");
      return r.json();
    },
    async placeBid(pieceId, netid, amount) {
      if (!LIVE) {
        if (isClosed()) throw new Error("Bidding has closed.");
        const bids = store.get("pp_demo_bids", []);
        const top = Math.max(0, ...bids.filter(b => b.piece_id === pieceId).map(b => b.amount));
        if (top && amount <= top) throw new Error(`Someone has already bid ${yuan(top)} — your bid must be at least ${yuan(top + 1)}.`);
        bids.push({ piece_id: pieceId, amount, netid_masked: netid.slice(0, 2) + "•".repeat(Math.max(netid.length - 2, 1)), created_at: new Date().toISOString() });
        store.set("pp_demo_bids", bids);
        return { ok: true };
      }
      const r = await fetch(CFG.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/place_bid", {
        method: "POST", headers: this.headers(),
        body: JSON.stringify({ p_piece_id: pieceId, p_netid: netid, p_amount: amount })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.message || "Something went wrong — please try again.");
      return body;
    }
  };

  function computeStats(bids) {
    const s = {};
    for (const b of bids) {
      const x = s[b.piece_id] || (s[b.piece_id] = { top: 0, count: 0, history: [] });
      x.count++; x.history.push(b);
      if (b.amount > x.top) x.top = b.amount;
    }
    for (const k in s) s[k].history.sort((a, b) => b.amount - a.amount);
    return s;
  }

  async function refresh(opts = {}) {
    try {
      const bids = await api.loadBids();
      const prev = stats;
      stats = computeStats(bids);
      renderAll(opts.animate ? prev : null);
      if (current) renderModalBidInfo();
    } catch (e) {
      console.warn(e);
      if (opts.loud) toast("Couldn't reach the bid server. Check your connection and try again.");
    }
  }

  // ---------- placeholder art (used until real photos are added) ----------
  function placeholderSVG(p, kind) {
    const c = p.color || "#f2a6c0";
    const shape = kind === "ribbons" ? "ribbon" : (p.shape || "bowl");
    const shapes = {
      ribbon: `<path d="M100 38c-19 0-30 14-30 30 0 13 9 27 17 39L60 158l19 5 21-35 21 35 19-5-27-51c8-12 17-26 17-39 0-16-11-30-30-30zm0 17c8 0 13 6 13 13 0 7-6 17-13 26-7-9-13-19-13-26 0-7 5-13 13-13z" fill="${c}" stroke="rgba(0,0,0,.15)" stroke-width="2"/>`,
      bowl: `<path d="M40 92h120c0 34-26 58-60 58S40 126 40 92z" fill="${c}"/><ellipse cx="100" cy="92" rx="60" ry="14" fill="${c}" stroke="rgba(0,0,0,.15)" stroke-width="2"/><ellipse cx="100" cy="93" rx="52" ry="10" fill="rgba(0,0,0,.12)"/>`,
      cup: `<rect x="62" y="56" width="76" height="92" rx="10" fill="${c}"/><ellipse cx="100" cy="57" rx="38" ry="9" fill="rgba(0,0,0,.15)"/>`,
      mug: `<rect x="56" y="60" width="74" height="86" rx="12" fill="${c}" stroke="rgba(0,0,0,.12)" stroke-width="2"/><path d="M130 78c22 0 22 44 0 44" fill="none" stroke="${c}" stroke-width="12"/><ellipse cx="93" cy="61" rx="37" ry="8" fill="rgba(0,0,0,.12)"/>`,
      vase: `<path d="M88 48h24v14c22 10 32 30 32 48 0 26-20 40-44 40s-44-14-44-40c0-18 10-38 32-48z" fill="${c}"/><ellipse cx="100" cy="48" rx="13" ry="4" fill="rgba(0,0,0,.18)"/>`,
      dish: `<path d="M38 104c8-22 36-30 62-30s54 8 62 30c-6 18-32 28-62 28s-56-10-62-28z" fill="${c}"/><ellipse cx="100" cy="102" rx="44" ry="14" fill="rgba(0,0,0,.14)"/>`,
      plate: `<ellipse cx="100" cy="104" rx="66" ry="40" fill="${c}"/><ellipse cx="100" cy="104" rx="46" ry="27" fill="rgba(0,0,0,.1)"/><path d="M100 77v54M54 104h92M68 85l64 38M132 85l-64 38" stroke="rgba(0,0,0,.18)" stroke-width="3"/>`,
      tray: `<rect x="48" y="66" width="104" height="72" rx="8" fill="${c}"/><rect x="58" y="74" width="84" height="56" rx="5" fill="rgba(0,0,0,.08)"/><path d="M100 118c-14-10-22-17-22-25 0-6 5-10 10-10 5 0 9 3 12 7 3-4 7-7 12-7 5 0 10 4 10 10 0 8-8 15-22 25z" fill="#c76c5e"/>`,
      figure: `<ellipse cx="100" cy="150" rx="40" ry="8" fill="rgba(0,0,0,.12)"/><path d="M70 148c-4-30 6-60 30-62 4-14 16-22 26-16-4 6-4 10-2 16 10 12 12 40 4 62z" fill="${c}"/><circle cx="118" cy="82" r="3" fill="#fff"/>`
    };
    return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(title(p))} (photo coming soon)">
      <rect width="200" height="200" fill="#fde4ec"/><circle cx="100" cy="100" r="78" fill="#fff" opacity=".6"/>
      ${shapes[shape] || shapes.bowl}
      <text x="100" y="186" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#b02a60" opacity=".8">photo coming soon</text></svg>`;
  }

  function coverHTML(p, kind) {
    const imgs = p.images || [];
    if (imgs.length) {
      const thumb = imgs[0].replace(/^images\//, "images/thumbs/");
      return `<img src="${esc(thumb)}" alt="${esc(title(p))}" loading="lazy" onerror="this.onerror=null;this.src='${esc(imgs[0])}'">`;
    }
    return placeholderSVG(p, kind);
  }

  // ---------- rendering ----------
  function myStatus(id) {
    const mine = myBids[id];
    if (!mine) return null;
    const top = stats[id]?.top || 0;
    return mine >= top ? "win" : "lose";
  }

  function cardHTML(p, kind) {
    const s = stats[p.id];
    const st = myStatus(p.id);
    const tag = st === "win" ? `<span class="tag win">You're winning</span>`
      : st === "lose" ? `<span class="tag lose">Outbid</span>`
      : !s ? `<span class="tag new">No bids yet</span>` : "";
    const nPhotos = (p.images || []).length;
    const priceLabel = s ? "Top bid" : "Starts at";
    const price = s ? s.top : (p.startingBid || 0);
    return `<button class="card" data-id="${esc(p.id)}" data-kind="${kind}">
      <div class="thumb">${coverHTML(p, kind)}${tag}${nPhotos > 1 ? `<span class="photos-badge">${nPhotos} photos</span>` : ""}</div>
      <div class="meta">
        ${p.name ? `<span class="id">${esc(p.id)}</span>` : ""}
        <span class="name">${esc(title(p))}</span>${p.funFact ? `<span class="fact">${esc(p.funFact)}</span>` : ""}
        <div class="bidline"><span class="price"><small>${priceLabel}</small>${yuan(price)}</span><span class="count">${s ? s.count + (s.count === 1 ? " bid" : " bids") : ""}</span></div>
        <span class="bid-cta">${isClosed() ? "View" : "Bid"}</span>
      </div></button>`;
  }

  function sortList(list, mode) {
    const top = p => stats[p.id]?.top ?? (p.startingBid || 0);
    const arr = [...list];
    if (mode === "shuffle") arr.sort((a, b) => shuffleOrder[a.id] - shuffleOrder[b.id]);
    else if (mode === "low") arr.sort((a, b) => top(a) - top(b));
    else if (mode === "high") arr.sort((a, b) => top(b) - top(a));
    else if (mode === "nobids") arr.sort((a, b) => (stats[a.id] ? 1 : 0) - (stats[b.id] ? 1 : 0) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    else arr.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    return arr;
  }

  function renderGrid(kind, prev) {
    const grid = $("#grid-" + kind);
    const q = ($(`[data-search="${kind}"]`).value || "").trim().toLowerCase();
    const mode = $(`[data-sort="${kind}"]`).value;
    const numOnly = /^\d+$/.test(q);
    let list = catalog[kind].filter(p => !q || (numOnly
      ? Number(p.id.replace(/\D/g, "")) === Number(q)
      : (p.id + " " + title(p) + " " + (p.group || "") + " " + (p.description || "") + " " + (p.funFact || "")).toLowerCase().includes(q)));
    list = sortList(list, mode);
    grid.innerHTML = list.map(p => cardHTML(p, kind)).join("") || `<p class="empty">Nothing matches “${esc(q)}”.</p>`;
    if (prev) list.forEach(p => { if ((prev[p.id]?.top || 0) !== (stats[p.id]?.top || 0)) grid.querySelector(`[data-id="${CSS.escape(p.id)}"] .meta`)?.classList.add("bump"); });
  }

  function renderMyBids() {
    const ids = Object.keys(myBids).filter(id => byId[id]);
    $("#grid-mybids").innerHTML = ids.map(id => cardHTML(byId[id], byId[id]._kind)).join("");
    $("#mybids-empty").hidden = ids.length > 0;
    const losing = ids.filter(id => myStatus(id) === "lose").length;
    $("#count-mybids").textContent = ids.length ? (losing ? `· ${losing} outbid` : `· ${ids.length}`) : "";
  }

  function renderTotals() {
    let total = 0, n = 0;
    for (const p of [...catalog.ribbons, ...catalog.pieces]) if (stats[p.id]) { total += stats[p.id].top; n++; }
    $("#raised").textContent = yuan(total);
    $("#raised-sub").textContent = `across ${n} of ${catalog.ribbons.length + catalog.pieces.length} pieces`;
    $("#count-ribbons").textContent = catalog.ribbons.length ? `· ${catalog.ribbons.length}` : "";
    $("#count-pieces").textContent = catalog.pieces.length ? `· ${catalog.pieces.length}` : "";
  }

  function renderAll(prev) {
    renderGrid("ribbons", prev);
    renderGrid("pieces", prev);
    renderMyBids();
    renderTotals();
    document.body.classList.toggle("closed-mode", isClosed());
    $("#closed-banner").hidden = !isClosed();
  }

  // ---------- tabs ----------
  const TABS = ["ribbons", "pieces", "mybids", "about", "how"];
  function showTab() {
    let t = location.hash.replace("#", "");
    if (t.startsWith("piece-")) { const id = t.slice(6); t = byId[id]?._kind || "ribbons"; setTimeout(() => byId[id] && openModal(id), 0); }
    if (!TABS.includes(t)) t = "ribbons";
    $$(".tabs a").forEach(a => a.setAttribute("aria-selected", a.dataset.tab === t));
    $$(".tab-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === t));
  }

  // ---------- modal + slideshow ----------
  function openModal(id) {
    const p = byId[id]; if (!p) return;
    current = p; slideIdx = 0;
    $("#m-id").textContent = p.name ? p.id : (p._kind === "ribbons" ? "RIBBON" : "LARGER PIECE");
    $("#m-title").textContent = title(p);
    const twin = p.sameGlaze && byId[p.sameGlaze];
    $("#m-fact").innerHTML = p.funFact ? "<b>Fun fact:</b> " + esc(p.funFact) + (twin
      ? `<button type="button" class="twin" data-twin="${esc(twin.id)}"><img src="${esc((twin.images || [])[0]?.replace(/^images\//, "images/thumbs/") || "")}" alt=""><span>Same glaze: <b>${esc(title(twin))}</b><br>Tap to see it →</span></button>` : "") : "";
    $("#m-desc").textContent = p.description || (p._kind === "ribbons" ? "A hand-shaped clay ribbon magnet made during Pink Week." : "");
    const imgs = p.images || [];
    $("#m-track").innerHTML = imgs.length ? imgs.map((src, i) => `<img src="${esc(src)}" alt="${esc(title(p))} photo ${i + 1}">`).join("") : placeholderSVG(p, p._kind);
    const n = Math.max(imgs.length, 1);
    $("#m-dots").innerHTML = n > 1 ? Array.from({ length: n }, (_, i) => `<button aria-label="Photo ${i + 1}" data-i="${i}"></button>`).join("") : "";
    $("#m-prev").hidden = $("#m-next").hidden = n < 2;
    goSlide(0);

    const saved = store.get("pp_me", {});
    const f = $("#bid-form");
    f.netid.value = saved.netid || ""; f.agree.checked = !!saved.agree;
    $("#m-error").textContent = "";
    renderModalBidInfo(true);
    $("#modal").hidden = false;
    document.body.style.overflow = "hidden";
    if (location.hash !== "#piece-" + p.id) history.replaceState(null, "", "#piece-" + p.id);
    setTimeout(() => (f.netid.value ? f.amount : f.netid).focus({ preventScroll: true }), 50);
  }

  function closeModal() {
    if ($("#modal").hidden) return;
    $("#modal").hidden = true; document.body.style.overflow = "";
    if (current) history.replaceState(null, "", "#" + current._kind);
    current = null;
  }

  function minBid(p) { const s = stats[p.id]; return s ? s.top + 1 : Math.max(1, p.startingBid || 0); }

  function renderModalBidInfo(resetAmount) {
    const p = current; if (!p) return;
    const s = stats[p.id];
    $("#m-top").textContent = s ? yuan(s.top) : "No bids yet";
    $("#m-count").textContent = s ? s.count : 0;
    const min = minBid(p);
    const f = $("#bid-form");
    f.amount.min = min;
    if (resetAmount || !f.amount.value || Number(f.amount.value) < min) f.amount.value = min;
    const steps = min < 50 ? [0, 5, 10] : min < 200 ? [0, 10, 20] : [0, 20, 50];
    $("#m-quick").innerHTML = steps.map(d => `<button type="button" data-v="${min + d}">${yuan(min + d)}</button>`).join("");
    f.amount.placeholder = "at least " + min;

    const st = myStatus(p.id), box = $("#m-status");
    box.hidden = !st;
    box.className = "m-status " + (st || "");
    box.textContent = st === "win" ? `You're the top bidder at ${yuan(myBids[p.id])} 🎉` : st === "lose" ? `You've been outbid. Your last bid was ${yuan(myBids[p.id])}.` : "";

    $("#m-history").innerHTML = s ? s.history.map(b =>
      `<li><span>${esc(b.netid_masked)}</span><span>${new Date(b.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span><b>${yuan(b.amount)}</b></li>`).join("")
      : "<li><span>Be the first to bid!</span></li>";

    const closed = isClosed();
    $$("#bid-form input, #bid-form button").forEach(el => el.disabled = closed);
    $("#m-submit").textContent = closed ? "Bidding closed" : "Place bid";
  }

  function goSlide(i) {
    const n = Math.max((current?.images || []).length, 1);
    slideIdx = (i + n) % n;
    $("#m-track").style.transform = `translateX(-${slideIdx * 100}%)`;
    $$("#m-dots button").forEach((b, j) => b.classList.toggle("on", j === slideIdx));
  }

  // ---------- bidding ----------
  async function submitBid(e) {
    e.preventDefault();
    const f = e.target, err = $("#m-error"), btn = $("#m-submit");
    err.textContent = "";
    const netid = f.netid.value.trim().toLowerCase().split("@")[0];
    const amount = Number(f.amount.value);
    const min = minBid(current);
    if (!/^[a-z0-9]{2,16}$/.test(netid)) return (err.textContent = "Please enter a valid NetID (e.g. ab123), not your full email.");
    if (!Number.isInteger(amount)) return (err.textContent = "Bids must be whole yuan (no decimals).");
    if (amount < min) return (err.textContent = `Your bid must be at least ${yuan(min)}.`);
    if (amount > 10000) return (err.textContent = "Bids above ¥10,000? Please talk to us at the booth!");
    if (!f.agree.checked) return (err.textContent = "Please tick the box to confirm you'll donate if you win.");
    if (amount >= Math.max(500, min * 5) && !confirm(`Just checking: bid ${yuan(amount)} on ${title(current)}?`)) return;

    btn.disabled = true; btn.textContent = "Placing bid…";
    try {
      await api.placeBid(current.id, netid, amount);
      store.set("pp_me", { netid, agree: true });
      myBids[current.id] = Math.max(myBids[current.id] || 0, amount);
      store.set("pp_mybids", myBids);
      toast(`Bid placed: ${yuan(amount)} on ${title(current)}. Thank you! 💗`);
      await refresh();
      renderModalBidInfo(true);
    } catch (ex) {
      err.textContent = ex.message;
      await refresh();
      renderModalBidInfo(false);
    } finally {
      btn.disabled = isClosed(); btn.textContent = isClosed() ? "Bidding closed" : "Place bid";
    }
  }

  // ---------- countdown ----------
  function tick() {
    const ms = DEADLINE.getTime() - Date.now();
    if (ms <= 0) {
      ["d", "h", "m", "s"].forEach(k => $("#cd-" + k).textContent = "0");
      $("#countdown-label").textContent = "Bidding has closed. Thank you!";
      if (!document.body.classList.contains("closed-mode")) renderAll();
      return;
    }
    const s = Math.floor(ms / 1000);
    $("#cd-d").textContent = Math.floor(s / 86400);
    $("#cd-h").textContent = String(Math.floor(s / 3600) % 24).padStart(2, "0");
    $("#cd-m").textContent = String(Math.floor(s / 60) % 60).padStart(2, "0");
    $("#cd-s").textContent = String(s % 60).padStart(2, "0");
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 4200);
  }

  // ---------- boot ----------
  async function init() {
    $("#demo-banner").hidden = LIVE;
    const parts = String(CFG.boothText || "").split("·").map(x => x.trim()).filter(Boolean);
    $("#booth").innerHTML = parts.length ? `<div class="place">📍 ${esc(parts[0])}</div>` +
      (parts.length > 1 ? `<div class="when">${parts.slice(1).map(x => `<span>${esc(x)}</span>`).join("")}</div>` : "") +
      `<div class="visit">Want to see the pieces in person? Come find us at the booth, or bid online any time right here.</div>` : "";
    $("#booth").hidden = !parts.length;
    const lb = $("#lightbox");
    $("#flyer-open").onclick = () => { lb.hidden = false; document.body.style.overflow = "hidden"; };
    lb.onclick = () => { lb.hidden = true; document.body.style.overflow = ""; };
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !lb.hidden) lb.onclick(); });
    $("#booth-2").textContent = CFG.boothText || "";
    if (CFG.contactEmail) $("#contact").innerHTML = `Questions? <a href="mailto:${esc(CFG.contactEmail)}">${esc(CFG.contactEmail)}</a>`;

    try {
      const r = await fetch("pieces.json", { cache: "no-cache" });
      catalog = await r.json();
    } catch (e) { console.error("Couldn't load pieces.json", e); }
    catalog.ribbons = catalog.ribbons || []; catalog.pieces = catalog.pieces || [];
    catalog.ribbons.forEach(p => { p._kind = "ribbons"; byId[p.id] = p; });
    catalog.pieces.forEach(p => { p._kind = "pieces"; byId[p.id] = p; });
    // Shuffle per visit, but pieces sharing a "group" (frogs, cats, mugs…) stay side by side.
    const groupRank = {};
    catalog.pieces.forEach(p => {
      const g = p.group ? "g:" + p.group : "p:" + p.id;
      if (!(g in groupRank)) groupRank[g] = Math.random();
      shuffleOrder[p.id] = groupRank[g] + num(p) / 1e6;
    });

    // events
    $$("[data-search],[data-sort]").forEach(el => el.addEventListener("input", () => renderGrid(el.dataset.search || el.dataset.sort)));
    document.addEventListener("click", e => {
      const card = e.target.closest(".card"); if (card) return openModal(card.dataset.id);
      if (e.target.closest("[data-close]")) return closeModal();
      const q = e.target.closest(".quick button"); if (q) { $("#bid-form").amount.value = q.dataset.v; return; }
      const dot = e.target.closest("#m-dots button"); if (dot) return goSlide(+dot.dataset.i);
      const tw = e.target.closest(".twin"); if (tw) return openModal(tw.dataset.twin);
    });
    $("#m-prev").onclick = () => goSlide(slideIdx - 1);
    $("#m-next").onclick = () => goSlide(slideIdx + 1);
    document.addEventListener("keydown", e => {
      if ($("#modal").hidden) return;
      if (e.key === "Escape") closeModal();
      if (e.target.tagName !== "INPUT") { if (e.key === "ArrowLeft") goSlide(slideIdx - 1); if (e.key === "ArrowRight") goSlide(slideIdx + 1); }
    });
    let x0 = null;
    $("#m-slides").addEventListener("touchstart", e => x0 = e.touches[0].clientX, { passive: true });
    $("#m-slides").addEventListener("touchend", e => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 40) goSlide(slideIdx + (dx < 0 ? 1 : -1)); x0 = null; });
    $("#bid-form").addEventListener("submit", submitBid);
    window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#piece-")) closeModal(); showTab(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh({ animate: true }); });

    renderAll();
    showTab();
    tick(); setInterval(tick, 1000);
    await refresh({ loud: true });
    setInterval(() => { if (!document.hidden) refresh({ animate: true }); }, (CFG.refreshSeconds || 30) * 1000);
  }

  init();
})();
