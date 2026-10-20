"use strict";

/* ---------- storage ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const DEFAULT_CATS = ["Travel", "Meme", "My Work", "Food", "Learning", "Inspiration", "Shopping", "Other"];
const state = {
  items: LS.get("items", []),
  cats: LS.get("cats", DEFAULT_CATS),
  apiKey: LS.get("apiKey", ""),
  model: LS.get("model", "gemini-2.5-flash"),
  filter: "All",
  q: "",
  editingId: null,
};
const save = () => { LS.set("items", state.items); LS.set("cats", state.cats); };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- helpers ---------- */
function platformOf(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    if (/(^|\.)instagram\.com$/.test(h)) return "Instagram";
    if (/(^|\.)(pinterest\.[a-z.]+|pin\.it)$/.test(h)) return "Pinterest";
    if (/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/.test(h)) return "Facebook";
    return "Web";
  } catch { return "Web"; }
}
function firstUrl(...parts) {
  for (const p of parts) {
    const m = (p || "").match(/https?:\/\/[^\s<>"']+/);
    if (m) return m[0].replace(/[).,]+$/, "");
  }
  return "";
}
function cleanUrl(u) {
  try { const x = new URL(u); ["igsh", "igshid", "utm_source", "utm_medium", "utm_campaign", "fbclid", "mibextid"].forEach((k) => x.searchParams.delete(k)); return x.toString(); } catch { return u; }
}
function banner(msg, err) {
  const b = $("banner");
  b.textContent = msg; b.className = "banner" + (err ? " err" : ""); b.hidden = false;
  clearTimeout(banner.t); banner.t = setTimeout(() => (b.hidden = true), 6000);
}

/* ---------- AI ---------- */
function buildPrompt(url, sharedText, note) {
  return `You sort saved social media posts into categories.
Allowed categories: ${state.cats.join(", ")}.
Pick exactly one allowed category. Only if none fits at all, use "Other".
Post URL: ${url}
Text that came with the share: ${sharedText || "(none)"}
${note ? "User note: " + note : ""}
Look at what the post is actually about (caption, hashtags, place names, visible content). If you cannot read the post, judge from the URL and shared text, and set "confidence" low.
Reply with ONLY a JSON object, no markdown fence:
{"category":"...","title":"short title, max 8 words","summary":"one sentence","tags":["3 to 5 short lowercase tags"],"confidence":0.0-1.0}`;
}
function parseJson(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("No JSON in reply");
  return JSON.parse(text.slice(s, e + 1));
}
async function callGemini(prompt, useUrlTool) {
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } };
  if (useUrlTool) body.tools = [{ url_context: {} }];
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(state.model)}:generateContent`,
    { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": state.apiKey }, body: JSON.stringify(body) }
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(j?.error?.message || `HTTP ${r.status}`); err.status = r.status; throw err; }
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Empty reply");
  return parseJson(text);
}
async function analyze(item) {
  if (!state.apiKey) throw new Error("Settings এ Gemini API key দিন");
  const prompt = buildPrompt(item.url, item.sharedText, item.note);
  let out;
  try { out = await callGemini(prompt, true); }
  catch (e) {
    if (e.status === 401 || e.status === 403 || e.status === 429) throw e;
    out = await callGemini(prompt, false); // retry without page fetching
  }
  const cat = state.cats.find((c) => c.toLowerCase() === String(out.category || "").toLowerCase()) || "Other";
  return {
    category: cat,
    title: String(out.title || "").slice(0, 120),
    summary: String(out.summary || "").slice(0, 400),
    tags: Array.isArray(out.tags) ? out.tags.slice(0, 6).map(String) : [],
    confidence: Number(out.confidence) || 0,
  };
}

/* ---------- items ---------- */
async function addItem({ url, sharedText = "", note = "" }) {
  url = cleanUrl(url);
  const dup = state.items.find((i) => i.url === url);
  if (dup) { banner("এটা আগেই সেভ করা আছে (" + dup.category + ")"); return; }
  const item = {
    id: crypto.randomUUID(), url, platform: platformOf(url), sharedText, note,
    category: "Unsorted", title: "", summary: "", tags: [], confidence: 0, status: "pending", added: Date.now(),
  };
  state.items.unshift(item); save(); render();
  await runAnalysis(item);
}
async function runAnalysis(item) {
  item.status = "pending"; render();
  try {
    Object.assign(item, await analyze(item), { status: "done" });
    banner("সেভ হয়েছে → " + item.category);
  } catch (e) {
    item.status = "error"; item.error = e.message;
    banner("AI বিশ্লেষণ হয়নি: " + e.message + ". লিংকটা Unsorted এ সেভ আছে, হাতে ক্যাটাগরি দিন।", true);
  }
  save(); render();
}

/* ---------- render ---------- */
function render() {
  const chips = ["All", ...state.cats, "Unsorted"];
  $("chips").innerHTML = chips.map((c) => {
    const n = c === "All" ? state.items.length : state.items.filter((i) => i.category === c).length;
    if (c === "Unsorted" && !n) return "";
    return `<button class="chip ${state.filter === c ? "on" : ""}" data-c="${esc(c)}">${esc(c)} ${n}</button>`;
  }).join("");

  const q = state.q.toLowerCase();
  const rows = state.items.filter((i) =>
    (state.filter === "All" || i.category === state.filter) &&
    (!q || [i.title, i.summary, i.note, i.url, i.tags.join(" ")].join(" ").toLowerCase().includes(q))
  );
  $("list").innerHTML = rows.length ? rows.map((i) => `
    <article class="item ${i.status === "pending" ? "pending" : ""}" data-id="${i.id}">
      <div class="top"><span><span class="badge">${esc(i.platform)}</span> <span class="badge cat">${esc(i.status === "pending" ? "বিশ্লেষণ চলছে…" : i.category)}</span></span><span>${new Date(i.added).toLocaleDateString("bn-IN")}</span></div>
      <h3>${esc(i.title || i.url)}</h3>
      ${i.summary ? `<p>${esc(i.summary)}</p>` : ""}
      ${i.note ? `<p>📝 ${esc(i.note)}</p>` : ""}
      <div class="tags">${i.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</div>
      <div class="btns"><a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">খুলুন ↗</a><button data-edit="${i.id}">এডিট</button></div>
    </article>`).join("") : `<div class="empty">কিছু নেই। Instagram/Pinterest/Facebook থেকে Share → SortBox</div>`;
}

/* ---------- events ---------- */
$("chips").addEventListener("click", (e) => { const c = e.target.closest("[data-c]"); if (c) { state.filter = c.dataset.c; render(); } });
$("search").addEventListener("input", (e) => { state.q = e.target.value; render(); });
$("btnAdd").addEventListener("click", () => {
  const u = firstUrl($("manualUrl").value) ;
  if (!u) return banner("সঠিক লিংক দিন", true);
  $("manualUrl").value = ""; addItem({ url: u });
});
$("list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-edit]"); if (!b) return;
  const it = state.items.find((i) => i.id === b.dataset.edit); if (!it) return;
  state.editingId = it.id;
  $("editTitle").textContent = it.title || it.url;
  $("editCat").innerHTML = [...state.cats, "Unsorted"].map((c) => `<option ${c === it.category ? "selected" : ""}>${esc(c)}</option>`).join("");
  $("editNote").value = it.note || "";
  $("editor").showModal();
});
$("editor").addEventListener("close", () => {
  const it = state.items.find((i) => i.id === state.editingId); if (!it) return;
  const rv = $("editor").returnValue;
  if (rv === "delete") { state.items = state.items.filter((i) => i.id !== it.id); save(); render(); return; }
  it.category = $("editCat").value; it.note = $("editNote").value.trim(); save(); render();
  if (rv === "reanalyze") runAnalysis(it);
});
$("btnSettings").addEventListener("click", () => {
  $("apiKey").value = state.apiKey; $("model").value = state.model; $("cats").value = state.cats.join(", ");
  $("settings").showModal();
});
$("settings").addEventListener("close", () => {
  if ($("settings").returnValue !== "ok") return;
  state.apiKey = $("apiKey").value.trim(); state.model = $("model").value.trim() || "gemini-2.5-flash";
  const cats = [...new Set($("cats").value.split(",").map((s) => s.trim()).filter(Boolean))];
  state.cats = cats.length ? cats : DEFAULT_CATS;
  LS.set("apiKey", state.apiKey); LS.set("model", state.model); save(); render();
});
$("btnExport").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state.items, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = "sortbox-" + new Date().toISOString().slice(0, 10) + ".json"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

/* ---------- boot ---------- */
(function boot() {
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const p = new URLSearchParams(location.search);
  const title = p.get("title") || "", text = p.get("text") || "", url = p.get("url") || "";
  const link = firstUrl(url, text, title);
  if (link) {
    history.replaceState(null, "", location.pathname); // so a refresh doesn't re-add
    const shared = [title, text.replace(link, "").trim()].filter(Boolean).join(" — ");
    addItem({ url: link, sharedText: shared });
  } else if (p.has("text") || p.has("title")) {
    history.replaceState(null, "", location.pathname);
    banner("শেয়ারে কোনো লিংক পাওয়া যায়নি", true);
  }
  if (!state.apiKey) banner("শুরুতে ⚙︎ Settings এ ফ্রি Gemini API key বসান");
})();
