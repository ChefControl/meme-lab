/* Meme Lab frontend: library, harvest/seed, rating queue, duels, leaderboard. */

const $ = (id) => document.getElementById(id);
let state = { templates: [], busy: null, harvested: 0 };
let queue = [];
let current = null;
let duelPair = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

function setStatus(msg) { $("status").textContent = msg ?? ""; }
function lockButtons(locked) {
  document.querySelectorAll("button:not([data-view])").forEach((b) => (b.disabled = locked));
}

/* ---------------------------------------------------------------- nav */

function showView(name) {
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("hidden", v.dataset.view !== name));
  document.querySelectorAll("#nav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
}

document.querySelectorAll("#nav button").forEach((b) => {
  b.onclick = () => showView(b.dataset.view);
});

function updateNavBadges({ duelReady, boardCount }) {
  $("navLib").textContent = state.templates.length || "";
  $("navRate").textContent = queue.length || "";
  if (duelReady !== undefined) $("navDuel").textContent = duelReady ? "⚡" : "";
  if (boardCount !== undefined) $("navBoard").textContent = boardCount || "";
}

let serverBusyWatch = false;

async function refresh() {
  state = await api("/api/state");
  $("harvestCount").textContent = `(${state.harvested} memes harvested)`;
  renderLibrary();
  buildQueue();
  renderRating();
  updateNavBadges({});
  loadDuel();
  loadLeaderboard();
  watchBusy();
}

/** If another client/job holds the server, lock the UI and poll until free. */
function watchBusy() {
  if (state.busy) {
    serverBusyWatch = true;
    lockButtons(true);
    setStatus(`⏳ Server busy: ${state.busy}… buttons unlock when it finishes`);
    setTimeout(refresh, 3000);
  } else if (serverBusyWatch) {
    serverBusyWatch = false;
    lockButtons(false);
    setStatus("Server free again — carry on.");
  }
}

/* ---------------------------------------------------------------- library */

function renderLibrary() {
  const grid = $("templates");
  grid.innerHTML = "";
  $("emptyLib").classList.toggle("hidden", state.templates.length > 0);

  for (const t of state.templates) {
    const pct = Math.min(100, Math.round((t.examples / t.min_examples) * 100));
    const card = document.createElement("div");
    card.className = "tpl-card";
    card.innerHTML = `
      <img src="/proxy?url=${encodeURIComponent(t.blank_url)}" alt="${t.name}" loading="lazy">
      <h3>${t.name}
        ${t.analyzed ? `<span class="badge">analyzed${t.revision > 1 ? " · r" + t.revision : ""}</span>` : ""}
        ${t.revision > 1 ? '<span class="badge revised">format-corrected</span>' : ""}
        ${t.learnings ? '<span class="badge learned">learning active</span>' : ""}
      </h3>
      <div class="meta-line">
        ${t.examples}/${t.min_examples} examples ·
        <span class="f">😂 ${t.funny}</span> /
        <span class="m">😐 ${t.meh}</span> /
        <span class="x">🧠 ${t.bad_context ?? 0}</span> /
        <span class="s">📐 ${t.bad_structure ?? 0}</span>
        ${t.pending.length ? ` · ${t.pending.length} to rate` : ""}
      </div>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <div class="btns"></div>`;
    const btns = card.querySelector(".btns");

    if (t.examples < t.min_examples) {
      btns.appendChild(actionBtn(`🌱 Seed more (${t.min_examples - t.examples} needed)`, () => seed(t.name)));
    }
    if (!t.analyzed && t.examples >= t.min_examples) {
      btns.appendChild(actionBtn("🔬 Analyze", () => doJob(`/api/analyze/${t.slug}`, `Analyzing ${t.name}…`)));
    }
    if (t.analyzed) {
      btns.appendChild(actionBtn("⚡ Generate 10", () => doJob(`/api/generate/${t.slug}`, `Generating candidates for ${t.name}…`)));
    }
    grid.appendChild(card);
  }
}

function actionBtn(label, onClick) {
  const b = document.createElement("button");
  b.className = "secondary";
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

async function doJob(path, msg) {
  setStatus(msg);
  lockButtons(true);
  try {
    await api(path, { method: "POST", body: {} });
    setStatus("Done.");
    if (path.includes("/api/generate/")) {
      await refresh();
      showView("rate"); // fresh candidates — jump straight to rating
      return;
    }
  } catch (e) {
    if (e.message.startsWith("Busy:")) {
      setStatus(`⏳ ${e.message.replace("Busy:", "Server is already working on")} — will auto-refresh when done.`);
    } else {
      setStatus(`Error: ${e.message}`);
    }
  } finally {
    lockButtons(false);
    refresh();
  }
}

async function seed(name) {
  setStatus(`Seeding "${name}" from imgflip + transcribing with Claude vision…`);
  lockButtons(true);
  try {
    const r = await api("/api/seed", { method: "POST", body: { name } });
    setStatus(`Seeded ${r.seeded} examples of "${r.template}" — now ${r.total} total.`);
  } catch (e) {
    setStatus(`Seed error: ${e.message}`);
  } finally {
    lockButtons(false);
    refresh();
  }
}

/* ---------------------------------------------------------------- seed gallery */

let imgflipList = [];
let seedSelection = new Set();
let seedFilter = "";

async function loadImgflipList() {
  try {
    imgflipList = await api("/api/imgflip");
  } catch { /* non-fatal */ }
}

function renderSeedGallery() {
  const gallery = $("seedGallery");
  gallery.innerHTML = "";
  if (!imgflipList.length) {
    gallery.innerHTML = `<div class="gallery-loading">Loading templates…</div>`;
    return;
  }
  const inLib = new Set(state.templates.map((t) => t.name.toLowerCase()));
  const q = seedFilter.trim().toLowerCase();
  const matches = imgflipList.filter((t) => !q || t.name.toLowerCase().includes(q));

  for (const t of matches) {
    const alreadyIn = inLib.has(t.name.toLowerCase());
    const selected = seedSelection.has(t.name);
    const tile = document.createElement("div");
    tile.className = `seed-tile${alreadyIn ? " in-lib" : selected ? " selected" : ""}`;
    tile.innerHTML = `
      <img src="/proxy?url=${encodeURIComponent(t.url)}" alt="${t.name}" loading="lazy">
      <div class="tile-name">${t.name}<small>${alreadyIn ? "already in library" : t.box_count + " text boxes"}</small></div>`;
    if (!alreadyIn) {
      tile.onclick = () => {
        selected ? seedSelection.delete(t.name) : seedSelection.add(t.name);
        renderSeedGallery();
      };
    }
    gallery.appendChild(tile);
  }
  if (!matches.length) {
    gallery.innerHTML = `<div class="empty" style="grid-column: 1/-1">No templates match “${seedFilter}”.</div>`;
  }
  updateSeedFooter();
}

function updateSeedFooter() {
  $("seedCount").textContent = `${seedSelection.size} selected`;
  $("seedConfirm").disabled = seedSelection.size === 0;
}

async function openSeedModal() {
  seedSelection.clear();
  seedFilter = "";
  $("seedSearch").value = "";
  $("seedModal").classList.remove("hidden");
  renderSeedGallery(); // shows everything immediately (or "Loading…")
  if (!imgflipList.length) {
    await loadImgflipList();
    renderSeedGallery();
  }
  $("seedSearch").focus();
}

function closeSeedModal() {
  $("seedModal").classList.add("hidden");
}

async function confirmSeeds() {
  const names = [...seedSelection];
  if (!names.length) return;
  closeSeedModal();
  lockButtons(true);
  let ok = 0;
  for (let i = 0; i < names.length; i++) {
    setStatus(`Seeding ${i + 1}/${names.length}: "${names[i]}" — pulling memes + Claude transcription…`);
    try {
      const r = await api("/api/seed", { method: "POST", body: { name: names[i] } });
      ok++;
      setStatus(`Seeded "${r.template}" (${r.seeded} examples). ${i + 1}/${names.length} done.`);
    } catch (e) {
      setStatus(`Seed error on "${names[i]}": ${e.message}`);
    }
  }
  seedSelection.clear();
  lockButtons(false);
  setStatus(`Seeding complete — ${ok}/${names.length} templates added.`);
  refresh();
}

$("seedBtn").onclick = openSeedModal;
$("seedClose").onclick = closeSeedModal;
$("seedClear").onclick = () => { seedSelection.clear(); renderSeedGallery(); };
$("seedConfirm").onclick = confirmSeeds;
$("seedSearch").oninput = (e) => { seedFilter = e.target.value; renderSeedGallery(); };
$("seedModal").onclick = (e) => { if (e.target === $("seedModal")) closeSeedModal(); };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeSeedModal(); closeLightbox(); closeFlagModal(); }
  if (!$("lightbox").classList.contains("hidden")) {
    if (e.key === "ArrowLeft") lightboxStep(-1);
    if (e.key === "ArrowRight") lightboxStep(1);
  }
});

$("harvestBtn").onclick = async () => {
  setStatus("Harvesting top memes + Claude vision template identification — this takes a few minutes…");
  lockButtons(true);
  try {
    const r = await api("/api/harvest", { method: "POST", body: { max: 30 } });
    const top = Object.entries(r.byTemplate ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([n, c]) => `${n} +${c}`).join(", ");
    setStatus(`Harvest done: ${r.new_images} new images, ${r.templated} filed into templates. ${top ? "Top: " + top : ""}`);
  } catch (e) {
    setStatus(`Harvest error: ${e.message}`);
  } finally {
    lockButtons(false);
    refresh();
  }
};

/* ---------------------------------------------------------------- rating */

function buildQueue() {
  queue = [];
  for (const t of state.templates) {
    for (const c of t.pending) {
      queue.push({ slug: t.slug, name: t.name, blank_url: t.blank_url, box_layout: t.box_layout, candidate: c });
    }
  }
}

function renderRating() {
  const stage = $("ratingStage");
  const hasWork = queue.length > 0;
  stage.classList.toggle("hidden", !hasWork);
  $("emptyRate").classList.toggle("hidden", hasWork);
  if (!hasWork) { current = null; $("ratingProgress").textContent = ""; return; }
  current = queue[0];
  $("ratingProgress").textContent = `— ${queue.length} in queue (${current.name})`;
  drawMeme(current);
}

function drawMeme(item) {
  renderCandidate($("memeCanvas"), item, 700);
}

/** Shared renderer: box-aware when the template has a vision-derived layout. */
function renderCandidate(canvas, { blank_url, box_layout, candidate }, targetW = 700) {
  const ctx = canvas.getContext("2d");
  const img = new Image();
  img.onload = () => {
    const w = Math.max(420, Math.min(img.width, targetW));
    const h = Math.round(img.height * (w / img.width));
    canvas.width = w; canvas.height = h;
    ctx.drawImage(img, 0, 0, w, h);

    const labels = splitLabels(candidate);
    if (box_layout?.length && labels.length === box_layout.length) {
      box_layout.forEach((box, i) => drawBoxText(ctx, labels[i], box, w, h));
    } else {
      drawStripText(ctx, candidate.top, w, h, true);
      drawStripText(ctx, candidate.bottom, w, h, false);
    }
  };
  img.onerror = () => setStatus("Failed to load template image");
  img.src = `/proxy?url=${encodeURIComponent(blank_url)}`;
}

/** "A | B" / "C | D" -> ["A","B","C","D"] for multi-box templates. */
function splitLabels(candidate) {
  return [...String(candidate.top ?? "").split("|"), ...String(candidate.bottom ?? "").split("|")]
    .map((s) => s.trim()).filter(Boolean);
}

function setMemeStyle(ctx, fontSize) {
  ctx.font = `bold ${fontSize}px Impact, "Arial Black", sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = "white";
  ctx.strokeStyle = "black";
  ctx.lineWidth = Math.max(2, fontSize / 11);
  ctx.lineJoin = "round";
}

function wrapText(ctx, text, maxW) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const probe = line ? line + " " + word : word;
    if (ctx.measureText(probe).width > maxW && line) { lines.push(line); line = word; }
    else line = probe;
  }
  if (line) lines.push(line);
  return lines;
}

/** Classic top/bottom strips (fallback when no box layout is known). */
function drawStripText(ctx, text, w, h, top) {
  if (!text) return;
  const fontSize = Math.max(22, Math.floor(w / 13));
  setMemeStyle(ctx, fontSize);
  const lines = wrapText(ctx, text, w * 0.92);
  const lineH = fontSize * 1.15;
  lines.forEach((l, i) => {
    const y = top ? fontSize + 8 + i * lineH : h - 14 - (lines.length - 1 - i) * lineH;
    ctx.strokeText(l, w / 2, y);
    ctx.fillText(l, w / 2, y);
  });
}

/** Draw text inside a vision-located caption box, shrinking the font to fit. */
function drawBoxText(ctx, text, box, w, h) {
  if (!text) return;
  const bx = (box.x_pct / 100) * w;
  const by = (box.y_pct / 100) * h;
  const bw = Math.max(40, (box.w_pct / 100) * w);
  const bh = Math.max(24, (box.h_pct / 100) * h);

  let fontSize = Math.min(Math.floor(bh * 0.55), Math.floor(w / 12));
  let lines;
  for (; fontSize >= 13; fontSize -= 2) {
    setMemeStyle(ctx, fontSize);
    lines = wrapText(ctx, text, bw);
    if (lines.length * fontSize * 1.15 <= bh) break;
  }
  setMemeStyle(ctx, Math.max(13, fontSize));
  const lineH = Math.max(13, fontSize) * 1.15;
  const totalH = lines.length * lineH;
  const startY = by + Math.max(0, (bh - totalH) / 2) + Math.max(13, fontSize); // vertically centered
  lines.forEach((l, i) => {
    ctx.strokeText(l, bx + bw / 2, startY + i * lineH);
    ctx.fillText(l, bx + bw / 2, startY + i * lineH);
  });
}

async function rate(rating) {
  if (!current) return;
  const image = $("memeCanvas").toDataURL("image/png");
  const reason = $("reasonBox").value.trim();
  lockButtons(true);
  try {
    await api("/api/rate", {
      method: "POST",
      body: { slug: current.slug, id: current.candidate.id, rating, image, reason },
    });
    $("reasonBox").value = "";
    queue.shift();
    renderRating();
    api("/api/state").then((s) => { state = s; renderLibrary(); });
    if (rating === "funny") { loadDuel(); loadLeaderboard(); }
  } catch (e) {
    setStatus(`Rating error: ${e.message}`);
  } finally {
    lockButtons(false);
  }
}

$("funnyBtn").onclick = () => rate("funny");
$("mehBtn").onclick = () => rate("meh");

/* ------------------------------------------------ bulk wrong-format flagging */

let flagItems = [];
let flagSelection = new Set();
const flagCanvases = new Map();
let flagType = "bad_context";

const FLAG_KINDS = {
  bad_context: {
    title: "🧠 Flag wrong-idea candidates",
    hint: "Select every pending candidate that misses this template's core idea (structurally fine, but it isn't what this meme is about). One shared reason sharpens the analysis.",
    confirm: "🧠 Flag selected as wrong idea",
    placeholder: "Shared reason: the idea is wrong because… e.g. \"this template is about impulsiveness, these captions are just comparisons\"",
  },
  bad_structure: {
    title: "📐 Flag structural failures",
    hint: "Select every pending candidate that breaks the template's structure — caption too long, mispositioned, wrong number of labels, merged boxes. One shared reason hardens the structural rules.",
    confirm: "📐 Flag selected as structural fail",
    placeholder: "Shared reason: the structure is wrong because… e.g. \"labels overflow their boxes\" / \"two ideas crammed into one label\"",
  },
};

function openFlagModal(type) {
  if (!current) return;
  flagType = type;
  const kind = FLAG_KINDS[type];
  $("flagTitle").textContent = kind.title;
  $("flagHint").textContent = kind.hint;
  $("flagConfirm").textContent = kind.confirm;
  $("flagReason").placeholder = kind.placeholder;
  flagItems = queue.filter((q) => q.slug === current.slug);
  flagSelection = new Set([current.candidate.id]); // the one on screen starts selected
  flagCanvases.clear();

  const grid = $("flagGrid");
  grid.innerHTML = "";
  for (const item of flagItems) {
    const tile = document.createElement("div");
    tile.className = "flag-tile" + (flagSelection.has(item.candidate.id) ? " selected" : "");
    const canvas = document.createElement("canvas");
    tile.appendChild(canvas);
    renderCandidate(canvas, item, 480);
    flagCanvases.set(item.candidate.id, canvas);
    tile.onclick = () => {
      flagSelection.has(item.candidate.id)
        ? flagSelection.delete(item.candidate.id)
        : flagSelection.add(item.candidate.id);
      tile.classList.toggle("selected");
      updateFlagFooter();
    };
    grid.appendChild(tile);
  }
  $("flagReason").value = $("reasonBox").value; // carry over anything already typed
  updateFlagFooter();
  $("flagModal").classList.remove("hidden");
  $("flagReason").focus();
}

function updateFlagFooter() {
  $("flagCount").textContent = `${flagSelection.size} selected`;
  $("flagConfirm").disabled = flagSelection.size === 0;
}

function closeFlagModal() {
  $("flagModal").classList.add("hidden");
}

async function confirmFlags() {
  const reason = $("flagReason").value.trim();
  const chosen = flagItems.filter((i) => flagSelection.has(i.candidate.id));
  if (!chosen.length) return;
  closeFlagModal();
  lockButtons(true);
  try {
    for (let i = 0; i < chosen.length; i++) {
      const item = chosen[i];
      setStatus(`Flagging ${i + 1}/${chosen.length} as ${flagType === "bad_context" ? "wrong idea" : "structural fail"}…`);
      const canvas = flagCanvases.get(item.candidate.id);
      await api("/api/rate", {
        method: "POST",
        body: {
          slug: item.slug, id: item.candidate.id, rating: flagType, reason,
          image: canvas ? canvas.toDataURL("image/png") : undefined,
        },
      });
    }
    const flaggedIds = new Set(chosen.map((c) => c.candidate.id));
    queue = queue.filter((q) => !(q.slug === current?.slug && flaggedIds.has(q.candidate.id)));
    $("reasonBox").value = "";
    setStatus(`${flagType === "bad_context" ? "🧠" : "📐"} Flagged ${chosen.length} candidate(s) — the analysis will revise on the next Generate.`);
  } catch (e) {
    setStatus(`Flagging error: ${e.message}`);
  } finally {
    lockButtons(false);
    renderRating();
    refresh();
  }
}

$("flagCtxBtn").onclick = () => openFlagModal("bad_context");
$("flagStructBtn").onclick = () => openFlagModal("bad_structure");
$("flagClose").onclick = closeFlagModal;
$("flagCancel").onclick = closeFlagModal;
$("flagConfirm").onclick = confirmFlags;
$("flagModal").onclick = (e) => { if (e.target === $("flagModal")) closeFlagModal(); };

/* ---------------------------------------------------------------- duels */

async function loadDuel() {
  try {
    const { pair } = await api("/api/duel");
    duelPair = pair;
    $("duelStage").classList.toggle("hidden", !pair);
    $("emptyDuel").classList.toggle("hidden", !!pair);
    updateNavBadges({ duelReady: !!pair });
    if (!pair) return;
    renderFighter($("duelA"), pair[0]);
    renderFighter($("duelB"), pair[1]);
  } catch { /* non-fatal */ }
}

function renderFighter(el, fighter) {
  el.querySelector("img").src = fighter.image;
  el.querySelector(".duel-meta").textContent =
    `${fighter.template} · elo ${fighter.elo} · ${fighter.duels} duels`;
}

async function vote(winnerIdx) {
  if (!duelPair) return;
  const winner = duelPair[winnerIdx];
  const loser = duelPair[1 - winnerIdx];
  try {
    const r = await api("/api/duel", {
      method: "POST",
      body: {
        winner: { slug: winner.slug, id: winner.id },
        loser: { slug: loser.slug, id: loser.id },
      },
    });
    setStatus(`Winner climbs to elo ${r.winnerElo}, loser drops to ${r.loserElo}.`);
    loadDuel();
    loadLeaderboard();
  } catch (e) {
    setStatus(`Duel error: ${e.message}`);
  }
}

$("duelA").onclick = () => vote(0);
$("duelB").onclick = () => vote(1);
$("skipDuel").onclick = () => loadDuel();

/* ---------------------------------------------------------------- leaderboard */

let boardRows = [];

function rankIcon(i) {
  return i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "#" + (i + 1);
}

async function loadLeaderboard() {
  try {
    const rows = await api("/api/leaderboard");
    boardRows = rows;
    const board = $("leaderboard");
    $("emptyBoard").classList.toggle("hidden", rows.length > 0);
    updateNavBadges({ boardCount: rows.length });
    board.innerHTML = "";
    if (!rows.length) return;
    rows.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "board-row";
      row.innerHTML = `
        <div class="rank">${rankIcon(i)}</div>
        <img src="${f.image}" alt="" loading="lazy">
        <div class="cap">“${f.top}”${f.bottom ? ` / “${f.bottom}”` : ""}<small>${f.template}</small></div>
        <div class="elo">${f.elo}<small>${f.duels} duels</small></div>`;
      row.onclick = () => openLightbox(i);
      board.appendChild(row);
    });
  } catch { /* non-fatal */ }
}

/* ---------------------------------------------------------------- lightbox */

let lbIndex = 0;

function openLightbox(i) {
  if (!boardRows.length) return;
  lbIndex = i;
  renderLightbox();
  $("lightbox").classList.remove("hidden");
}

function closeLightbox() {
  $("lightbox").classList.add("hidden");
}

function lightboxStep(delta) {
  if (!boardRows.length) return;
  lbIndex = (lbIndex + delta + boardRows.length) % boardRows.length; // wraps around
  renderLightbox();
}

function renderLightbox() {
  const f = boardRows[lbIndex];
  $("lbImg").src = f.image;
  $("lbMeta").innerHTML = `
    ${rankIcon(lbIndex)} “${f.top}”${f.bottom ? ` / “${f.bottom}”` : ""}
    <small>${f.template} · <span class="elo-inline">elo ${f.elo}</span> · ${f.duels} duels</small>`;
  $("lbPos").textContent = `${lbIndex + 1} / ${boardRows.length}`;
}

$("lbClose").onclick = closeLightbox;
$("lbPrev").onclick = () => lightboxStep(-1);
$("lbNext").onclick = () => lightboxStep(1);
$("lightbox").onclick = (e) => { if (e.target === $("lightbox")) closeLightbox(); };

refresh();
loadImgflipList();
setInterval(() => { if (!current) refresh(); }, 30_000);
