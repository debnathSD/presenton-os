/* Spotlight search UI for the Presenton OS Internals site.
 * Open with the header button, the home page search box, Cmd/Ctrl+K or "/".
 * The ranking engine runs in spotlight-worker.js.
 */
(function () {
  "use strict";

  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const RECENT_KEY = "spx-recent-v1";

  function siteBase() {
    let base = ".";
    try { base = JSON.parse(document.getElementById("__config").textContent).base || "."; } catch (e) { /* default */ }
    return new URL(base.replace(/\/?$/, "/"), location.href);
  }
  const BASE = siteBase();
  const assetUrl = (p) => new URL("assets/spotlight/" + p, BASE).href;
  const MAX_Q = 200; // longer queries are cut; the worker applies the same cap

  function readRecent() {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x).map((x) => x.slice(0, MAX_Q)).slice(0, 6) : [];
    } catch (e) { return []; }
  }
  function saveRecent(q) {
    try {
      q = String(q).slice(0, MAX_Q);
      const list = [q].concat(readRecent().filter((x) => x.toLowerCase() !== q.toLowerCase())).slice(0, 6);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch (e) { /* storage unavailable */ }
  }

  // ---------- DOM ----------
  const root = document.createElement("div");
  root.className = "spx";
  root.hidden = true;
  root.innerHTML = `
    <div class="spx__backdrop" data-spx-close></div>
    <div class="spx__panel" role="dialog" aria-modal="true" aria-labelledby="spx-title">
      <h2 id="spx-title" class="spx__sr">Search the tutorial</h2>
      <div class="spx__bar">
        <svg class="spx__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 3a6.5 6.5 0 0 1 5.18 10.43l5.45 5.44-1.42 1.42-5.44-5.45A6.5 6.5 0 1 1 9.5 3m0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9"/></svg>
        <input class="spx__input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
          role="combobox" aria-expanded="false" aria-controls="spx-list" aria-autocomplete="list"
          aria-describedby="spx-hint" placeholder="Ask a question or search a topic, file or function" />
        <span class="spx__spinner" aria-hidden="true"></span>
        <button type="button" class="spx__esc" data-spx-close aria-label="Close search">esc</button>
      </div>
      <div class="spx__body">
        <ul class="spx__list" id="spx-list" role="listbox" aria-label="Search results"></ul>
        <div class="spx__state" aria-hidden="false"></div>
      </div>
      <div class="spx__foot" id="spx-hint">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>${isMac ? "⌘" : "Ctrl"}</kbd><kbd>↵</kbd> new tab</span>
        <span><kbd>esc</kbd> close</span>
        <span class="spx__count" aria-hidden="true"></span>
      </div>
      <div class="spx__sr" aria-live="polite" aria-atomic="true"></div>
    </div>`;
  document.body.appendChild(root);

  const panel = root.querySelector(".spx__panel");
  const input = root.querySelector(".spx__input");
  const list = root.querySelector(".spx__list");
  const stateEl = root.querySelector(".spx__state");
  const live = root.querySelector("[aria-live]");
  const countEl = root.querySelector(".spx__count");

  document.querySelectorAll("[data-spx-mod]").forEach((el) => { el.textContent = isMac ? "⌘" : "Ctrl "; });

  // ---------- Worker ----------
  let worker = null, ready = false, failed = false, suggestions = [], qid = 0, lastQ = "";
  function fail() {
    failed = true; ready = false;
    if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; }
    root.classList.remove("spx--loading");
    if (isOpen && lastQ) renderState("error");
    else if (isOpen) renderHome();
  }
  function ensureWorker() {
    if (worker || ready) return;
    failed = false; // a previous failure is retried on the next open
    try {
      worker = new Worker(assetUrl("spotlight-worker.js"));
    } catch (e) { worker = null; fail(); return; }
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "ready") {
        ready = true; suggestions = Array.isArray(m.suggestions) ? m.suggestions : [];
        root.classList.remove("spx--loading");
        if (isOpen && lastQ) run(input.value);
        else if (isOpen) { const keep = active; renderHome(); if (keep > 0) select(Math.min(keep, options.length - 1), false); }
      } else if (m.type === "results") {
        if (m.id === qid && isOpen) render(m);
      } else if (m.type === "error") {
        fail();
      }
    };
    // Script 404, syntax error or blocked worker: without this the dialog would stay "loading".
    worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); if (!ready) fail(); };
    worker.postMessage({ type: "init", indexUrl: assetUrl("index.json"), answersUrl: assetUrl("answers.json") });
  }

  // ---------- Open / close ----------
  // isOpen flips immediately; root.hidden only after the closing animation, so all
  // state checks use isOpen (otherwise focus restore is undone by the focus trap).
  let lastFocus = null, isOpen = false, closeTimer = null;
  function open(prefill) {
    if (isOpen) { input.focus(); return; }
    isOpen = true;
    clearTimeout(closeTimer);
    const ae = document.activeElement;
    lastFocus = ae && !root.contains(ae) ? ae : lastFocus;
    root.hidden = false;
    document.documentElement.classList.add("spx-open");
    requestAnimationFrame(() => { if (isOpen) root.classList.add("spx--open"); });
    ensureWorker();
    if (!ready && !failed) root.classList.add("spx--loading");
    if (typeof prefill === "string") input.value = prefill.slice(0, MAX_Q);
    input.focus();
    input.select();
    run(input.value);
  }
  function close(restoreFocus) {
    if (!isOpen) return;
    isOpen = false;
    clearTimeout(timer);
    qid += 1; // drop any in-flight response
    root.classList.remove("spx--open");
    document.documentElement.classList.remove("spx-open");
    const done = () => { if (!isOpen) root.hidden = true; };
    if (reduceMotion) done(); else closeTimer = setTimeout(done, 140);
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    if (restoreFocus !== false && lastFocus && lastFocus.focus && document.contains(lastFocus)) {
      try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-spotlight-open]");
    if (t) { e.preventDefault(); open(t.getAttribute("data-spotlight-query") || undefined); return; }
    if (e.target.closest("[data-spx-close]")) close();
  });

  function isEditable(el) {
    if (!el || el === input) return false;
    const tag = el.tagName || "";
    return /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || !!el.isContentEditable;
  }

  document.addEventListener("keydown", (e) => {
    const k = e.key;
    // IME composition (CJK input etc.): Enter, arrows and Escape belong to the IME.
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (k === "k" || k === "K")) {
      // On macOS Ctrl+K in a text field is "delete to end of line": leave it alone there.
      if (isMac && e.ctrlKey && !e.metaKey && isEditable(e.target)) return;
      e.preventDefault();
      if (e.repeat) return;
      isOpen ? close() : open();
      return;
    }
    if (!isOpen) {
      if (k === "/" && !isEditable(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey && !e.defaultPrevented) {
        e.preventDefault(); e.stopPropagation(); open();
      }
      return;
    }
    if (k === "Escape") { e.preventDefault(); e.stopPropagation(); if (input.value) { input.value = ""; run(""); } else close(); }
    else if (k === "ArrowDown") { e.preventDefault(); move(1); }
    else if (k === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (k === "Enter") { e.preventDefault(); e.stopPropagation(); if (!e.repeat) activate(e.metaKey || e.ctrlKey); }
    else if (k === "Tab") { e.preventDefault(); move(e.shiftKey ? -1 : 1); }
  }, true);

  // Keep focus inside the dialog.
  document.addEventListener("focusin", (e) => { if (isOpen && !panel.contains(e.target)) input.focus(); });

  // ---------- Querying ----------
  let timer = null;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => run(input.value), 70); });

  function run(q) {
    q = (q || "").trim().slice(0, MAX_Q);
    lastQ = q;
    qid += 1; // invalidates any response still in flight, including for the empty query
    if (!q) { renderHome(); return; }
    if (!ready || !worker) { renderState(failed ? "error" : "loading"); return; }
    worker.postMessage({ type: "query", id: qid, q });
  }

  // ---------- Rendering ----------
  let options = [], active = -1;

  // Clicking a result row must not pull focus off the combobox input (keeps typing and
  // aria-activedescendant working after a mouse pick of a recent search or suggestion).
  list.addEventListener("mousedown", (e) => { if (e.button === 0) e.preventDefault(); });

  const ICONS = {
    answer: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 1 4 12.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26A7 7 0 0 1 12 2m-3 18h6v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1z"/></svg>',
    page: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5zM8 13v2h8v-2zm0 4v2h5v-2z"/></svg>',
    section: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.41 21 6.12 17H2.12l.36-2h4l1.06-6h-4l.35-2h4l.71-4h2l-.71 4h6l.71-4h2l-.71 4h4l-.35 2h-4l-1.06 6h4l-.35 2h-4l-.71 4h-2l.71-4h-6l-.71 4zM9.53 9l-1.06 6h6l1.06-6z"/></svg>',
    recent: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3m-1 5v5l4.25 2.52.77-1.28-3.52-2.09V8z"/></svg>',
    ask: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 18h2v-2h-2zm1-16a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16m0-14a4 4 0 0 0-4 4h2a2 2 0 1 1 4 0c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5a4 4 0 0 0-4-4"/></svg>',
  };

  // Index and answer links are site-relative ("presenton/08-standard-pipeline/#x"); resolve
  // them against the site root so they work at any page depth and under /presenton-os/.
  // Anything that is not http(s) (for example "javascript:") is dropped.
  function href(u) {
    try {
      const url = new URL(String(u || ""), BASE);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch (e) { return null; }
  }

  function setOptions(items) {
    list.innerHTML = "";
    options = [];
    active = -1;
    let i = 0;
    for (const item of items) {
      if (item.group) {
        const li = document.createElement("li");
        li.className = "spx__group";
        li.setAttribute("role", "presentation");
        li.textContent = item.group;
        list.appendChild(li);
        continue;
      }
      const li = document.createElement("li");
      li.className = "spx__item spx__item--" + item.kind;
      li.id = "spx-opt-" + options.length;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      if (!reduceMotion) li.style.setProperty("--i", String(Math.min(i, 14)));
      li.innerHTML = item.html;
      li.addEventListener("mousemove", () => select(options.indexOf(li), false));
      li.addEventListener("click", (e) => {
        const a = e.target.closest("a");
        if (a) {
          remember();
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // new tab/window: keep the dialog
          e.preventDefault();
          go(a.href, false);
          return;
        }
        select(options.indexOf(li), false); activate(e.metaKey || e.ctrlKey);
      });
      li._spx = item;
      list.appendChild(li);
      options.push(li);
      i++;
    }
    input.setAttribute("aria-expanded", options.length ? "true" : "false");
    if (options.length) select(0, false);
    else input.removeAttribute("aria-activedescendant");
  }

  function select(i, scroll) {
    if (i < 0 || i >= options.length) return;
    if (active >= 0 && options[active]) { options[active].classList.remove("is-active"); options[active].setAttribute("aria-selected", "false"); }
    active = i;
    const el = options[i];
    el.classList.add("is-active");
    el.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", el.id);
    if (scroll !== false) el.scrollIntoView({ block: "nearest" });
  }
  function move(d) { if (options.length) select((active + d + options.length) % options.length); }

  function remember() { if (lastQ) saveRecent(lastQ); }

  function activate(newTab) {
    const el = options[active];
    if (!el) return;
    const item = el._spx;
    if (item.query !== undefined) { input.value = item.query; input.focus(); run(item.query); return; }
    if (!item.url) return;
    remember();
    go(item.url, newTab);
  }

  function samePath(a, b) {
    const norm = (p) => p.replace(/\/index\.html$/, "/");
    return norm(a) === norm(b);
  }

  function go(url, newTab) {
    let target;
    try { target = new URL(url); } catch (e) { return; }
    if (newTab) { window.open(target.href, "_blank", "noopener"); return; }
    if (target.origin === location.origin && samePath(target.pathname, location.pathname) && target.hash) {
      // Same page: jump to the section and move focus there instead of reloading.
      close(false);
      let id = target.hash.slice(1);
      try { id = decodeURIComponent(id); } catch (e) { /* keep raw */ }
      const node = document.getElementById(id);
      if (location.hash !== target.hash) location.hash = target.hash; // fires hashchange for Material
      if (node) {
        node.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
        if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "-1");
        try { node.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        flash(node);
      } else if (lastFocus && lastFocus.focus) {
        try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      }
    } else {
      close(false);
      location.href = target.href;
    }
  }

  function flash(node) {
    node.classList.remove("spx-flash"); void node.offsetWidth; node.classList.add("spx-flash");
  }

  function renderState(kind, q) {
    list.innerHTML = ""; options = []; active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    countEl.textContent = "";
    if (kind === "loading") {
      stateEl.innerHTML = '<div class="spx__skeleton"><span></span><span></span><span></span></div><p class="spx__muted">Preparing the search index…</p>';
    } else if (kind === "error") {
      stateEl.innerHTML = '<p class="spx__muted">Search could not load. Check your connection, then close and reopen search.</p>';
      live.textContent = "Search could not load";
    } else if (kind === "empty") {
      stateEl.innerHTML = `<p class="spx__muted">No results for “${escapeHtml(q)}”. Try fewer words, a file or function name, or one of the questions below.</p>`;
    } else {
      stateEl.innerHTML = "";
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderHome() {
    renderState("none");
    const items = [];
    const recent = readRecent();
    if (recent.length) {
      items.push({ group: "Recent searches" });
      for (const r of recent) items.push({ kind: "recent", query: r, html: row(ICONS.recent, escapeHtml(r), "", "") });
    }
    const picks = (suggestions.length ? suggestions : [
      "How does Presenton pass context to each slide?",
      "How is a template turned into a JSON schema?",
      "How does PPTX export work?",
      "How do slides get live Superset data?",
    ]).slice(0, 6);
    items.push({ group: "Try asking" });
    for (const s of picks) items.push({ kind: "ask", query: s, html: row(ICONS.ask, escapeHtml(s), "", "") });
    setOptions(items);
    countEl.textContent = "";
    if (failed) stateEl.innerHTML = '<p class="spx__muted spx__tiny">Search could not load. Check your connection, then close and reopen search.</p>';
    else if (!ready) stateEl.innerHTML = '<p class="spx__muted spx__tiny">Loading the index in the background…</p>';
  }

  function row(icon, title, crumb, snippet, extra) {
    return `<div class="spx__row"><span class="spx__ico">${icon}</span><div class="spx__main">
      <div class="spx__title">${title}</div>${crumb ? `<div class="spx__crumb">${crumb}</div>` : ""}
      ${snippet ? `<div class="spx__snippet">${snippet}</div>` : ""}${extra || ""}</div>
      <span class="spx__enter" aria-hidden="true">↵</span></div>`;
  }

  function render(m) {
    // a.q, a.a, s.t, s.crumb and s.s arrive as HTML that the worker built with every
    // index/answer string escaped (only <mark> is added). Everything else is escaped here.
    const answers = Array.isArray(m.answers) ? m.answers : [];
    const sections = Array.isArray(m.sections) ? m.sections : [];
    const items = [];
    if (answers.length) {
      items.push({ group: "Quick answers" });
      for (const a of answers) {
        const resolved = (a.links || []).map((l) => ({ url: href(l && l.href), title: String((l && l.title) || "") }))
          .filter((l) => l.url);
        const links = resolved.map((l) =>
          `<a class="spx__chip" href="${escapeHtml(l.url)}" tabindex="-1">${escapeHtml(l.title)}</a>`).join("");
        items.push({ kind: "answer", url: resolved.length ? resolved[0].url : null,
          html: row(ICONS.answer, a.q, "", a.a, links ? `<div class="spx__chips">${links}</div>` : "") });
      }
    }
    if (sections.length) {
      items.push({ group: "Pages and sections" });
      for (const s of sections) {
        const url = href(s.u);
        if (!url) continue;
        items.push({ kind: s.page ? "page" : "section", url,
          html: row(s.page ? ICONS.page : ICONS.section, s.t, s.crumb, s.s) });
      }
    }
    if (!items.length) { renderState("empty", m.q); appendSuggestions(); return; }
    renderState("none");
    setOptions(items);
    const n = options.length;
    countEl.textContent = n + (n === 1 ? " result" : " results");
    live.textContent = n + (n === 1 ? " result" : " results") + " for " + m.q;
    list.scrollTop = 0;
  }

  function appendSuggestions() {
    const items = suggestions.length ? [{ group: "Try asking" }] : [];
    for (const s of suggestions.slice(0, 5)) items.push({ kind: "ask", query: s, html: row(ICONS.ask, escapeHtml(s), "", "") });
    setOptions(items);
    live.textContent = "No results";
  }

  // Warm the index when the user shows intent (hover or focus on a trigger, or a modifier key),
  // so the first search is fast without downloading the index on every page view.
  const warm = () => ensureWorker();
  document.querySelectorAll("[data-spotlight-open]").forEach((el) => {
    el.addEventListener("pointerenter", warm, { once: true });
    el.addEventListener("focus", warm, { once: true });
  });
  // Not { once: true }: that would drop the listener on the first unrelated key press.
  const warmOnModifier = (e) => {
    if (e.key === "Meta" || e.key === "Control") { document.removeEventListener("keydown", warmOnModifier); warm(); }
  };
  document.addEventListener("keydown", warmOnModifier);

  // Allow deep links like ?q=pptx+export to open the search.
  try {
    const q = new URLSearchParams(location.search).get("q");
    if (q) open(q);
  } catch (e) { /* ignore */ }
})();
