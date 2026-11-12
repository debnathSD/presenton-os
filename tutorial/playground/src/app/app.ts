// The playground shell: header, mode tabs, step indicator, the three-pane workspace (slides | editor | inspector),
// the aria-live status bar and toasts. One Tiptap editor is shared by the three modes; each mode keeps its own
// workspace (deck, last UDM, losses, saved editor doc) in the store and swaps it in when its tab is selected.

import { h, tablistKeys, prefersReducedMotion } from "./dom";
import { createStore } from "./store";
import { createToaster } from "./toast";
import { createInspector, type InspectorTab } from "./inspector";
import { renderSteps } from "./steps";
import { createSlidesPane, type SlidesPane } from "./slides";
import { createDownloadMenu, saveFile } from "./downloads";
import { byteSize, fmtBytes, countBy } from "./format";
import { emptyMode, errorMessage, MODES, type AppState, type Ctx, type ModeId, type ModeState, type StatusKind } from "./state";
import { createEditor } from "../editor/index";
import { tiptapToUdm, udmToMarkdown } from "../udm/bridge";
import { loadIndex, loadTemplate, type TemplateSummary } from "../data";
import { createCreateMode } from "./create-mode";
import { createDeckMode } from "./deck-mode";
import { createPageMode } from "./page-mode";
import { exportDeckPptx } from "./pptx";
import { EMPTY_DOC, isEmptyDoc, presentonJson, slug } from "./doc";

export { EMPTY_DOC, isEmptyDoc, presentonJson };

export type ModeView = { id: ModeId; panel: HTMLElement; activate(): void; refresh(): void };

export type AppHandle = {
  root: HTMLElement;
  ctx: Ctx;
  selectMode(id: ModeId): void;
  views: Record<ModeId, ModeView>;
  slides: SlidesPane;
  destroy(): void;
};

export type MountOptions = {
  /** Template list (default: loaded from data/index.json). */
  index?: TemplateSummary[];
  /** Replay speed of "Watch a sample run" (default 2: about 20 s; tests use more). */
  sampleSpeed?: number;
};

export async function mountApp(mount: HTMLElement, opts: MountOptions = {}): Promise<AppHandle> {
  mount.classList.add("udm-root");
  if (prefersReducedMotion()) mount.classList.add("udm-reduced-motion");
  mount.replaceChildren(h("p", { class: "udm-loading", role: "status" }, "Loading the playground…"));

  let index: TemplateSummary[];
  try {
    index = opts.index ?? await loadIndex();
  } catch (e) {
    mount.replaceChildren(h("div", { class: "udm-fatal", role: "alert" },
      h("strong", {}, "The playground could not load its sample data. "), errorMessage(e)));
    throw e;
  }

  const store = createStore<AppState>({
    mode: "create",
    busy: null,
    inspectorTab: "tiptap",
    modes: {
      create: emptyMode("create", "Generate a page, then choose “Create slides from this page”."),
      deck: emptyMode("deck", "Pick a sample deck above."),
      page: emptyMode("page", "Load a page, pick a template, then “Generate slides from page”."),
    },
  });

  // ---------- chrome ----------
  const toast = createToaster();
  const statusText = h("span", { class: "udm-status__text" }, "Ready.");
  const statusBar = h("div", { class: "udm-status", role: "status", "aria-live": "polite", "aria-atomic": "true", "data-kind": "info" },
    h("span", { class: "udm-status__dot", "aria-hidden": "true" }), statusText);

  const header = h("header", { class: "udm-head" },
    h("p", { class: "udm-eyebrow" }, "Live demo · runs in your browser"),
    h("h2", { class: "udm-head__title" }, "Presenton makes decks from a prompt. This makes pages."),
    h("p", { class: "udm-head__lead" },
      "The playground runs Presenton’s generation pipeline with a Tiptap page as the target: a prompt becomes an outline, the " +
      "outline becomes sections that stream into the editor, and the finished page can turn back into Presenton slides. " +
      "Every step goes through the Unified Document Model (UDM) with the prototype’s real adapters, and every stage is in the inspector."),
    h("ul", { class: "udm-facts" },
      h("li", {}, "“Watch a sample run” needs no key: it replays a recorded generation."),
      h("li", {}, "Live generation uses your own Anthropic key, sent only to api.anthropic.com."),
      h("li", {}, "No backend. The PPTX exporter is a demo built on pptxgenjs, not Presenton’s export package.")));

  const tabList = h("div", { class: "udm-tabs udm-modes", role: "tablist", "aria-label": "Playground mode" });
  const tabs = new Map<ModeId, HTMLButtonElement>();
  for (const m of MODES) {
    const b = h("button", { type: "button", role: "tab", class: "udm-tab", id: `udm-mode-${m.id}`, "aria-controls": `udm-panel-${m.id}` },
      // Only one label is displayed at a time (CSS swaps them at narrow widths), so only one is in the accessibility
      // tree: the tab is never left without a name.
      h("span", { class: "udm-tab__long" }, m.label), h("span", { class: "udm-tab__short" }, m.short));
    b.addEventListener("click", () => selectMode(m.id));
    tabs.set(m.id, b);
    tabList.append(b);
  }
  tablistKeys(tabList, (tab) => {
    const m = MODES.find((x) => tabs.get(x.id) === tab);
    if (m) selectMode(m.id);
  });

  const stepsList = h("ol", { class: "udm-steps", "aria-label": "Conversion stages" });

  // ---------- workspace ----------
  const toolbarMount = h("div", { class: "udm-editor-toolbar" });
  const editorMount = h("div", { class: "udm-editor-mount" });
  const editorExtra = h("div", { class: "udm-editor-extra" }); // skeletons and progress (create mode)
  const editorKeys = h("p", { class: "udm-hint udm-editor-keys", id: "udm-editor-keys" },
    "Keyboard: Esc or Alt+F10 moves from the page to the toolbar, and Esc goes back. In a table, Tab moves between " +
    "cells; the arrow keys leave the table.");
  const editorPane = h("section", { class: "udm-pane udm-pane--editor", "aria-labelledby": "udm-editor-title" },
    h("div", { class: "udm-pane__head" }, h("h3", { class: "udm-pane__title", id: "udm-editor-title" }, "Tiptap page"),
      h("span", { class: "udm-pane__count", id: "udm-editor-meta" })),
    toolbarMount, h("div", { class: "udm-editor-scroll" }, editorMount, editorExtra, editorKeys));

  let ctx!: Ctx;
  let inspector!: ReturnType<typeof createInspector>;
  const slides = createSlidesPane((i) => { ctx.patchMode(store.get().mode, { selected: i }); void ctx.refreshSlides(); },
    (e) => ctx.fail(store.get().mode, "A slide could not be rendered", e));

  const editor = createEditor(editorMount, toolbarMount, undefined, {
    label: "Page editor",
    describedBy: "udm-editor-keys",
    placeholder: "The page appears here. Generate one from a prompt, convert a deck, or start writing.",
    onContentError: (e) => ctx?.fail(store.get().mode, "The editor refused a document", e.error),
    onChartError: (e) => toast.show("Chart preview unavailable", "error", errorMessage(e)),
  });

  // ---------- context ----------
  let statusTimer: any;
  ctx = {
    root: mount, store, editor, toast, index,
    mode: (id) => store.get().modes[id ?? store.get().mode],
    patchMode(id, patch) {
      store.set((s) => ({ modes: { ...s.modes, [id]: { ...s.modes[id], ...patch } } }));
    },
    setDoc(id, doc) {
      if (store.get().mode !== id) { ctx.patchMode(id, { doc, dirty: false }); return true; }
      const ok = editor.setJSON(doc);
      if (ok) { ctx.patchMode(id, { doc: null, dirty: false }); scheduleInspector(0); updateEditorMeta(); }
      return ok;
    },
    getDoc(id) { return store.get().mode === id ? editor.getJSON() : store.get().modes[id].doc ?? EMPTY_DOC; },
    status(text, kind: StatusKind = "info") {
      clearTimeout(statusTimer);
      // Re-announce identical messages: clear first, then set on the next tick.
      statusText.textContent = "";
      statusBar.dataset.kind = kind;
      statusTimer = setTimeout(() => { statusText.textContent = text; }, 20);
    },
    fail(id, what, e) {
      const msg = errorMessage(e);
      console.error(`[udm playground] ${what}`, e);
      toast.show(what, "error", msg);
      ctx.status(`${what}: ${msg}`, "error");
      const m = store.get().modes[id];
      ctx.patchMode(id, { errors: [...m.errors, `${what}: ${msg}`].slice(-20) });
      if (id === store.get().mode) { inspector.select("loss"); store.set({ inspectorTab: "loss" }); }
    },
    loadTemplate: (id) => loadTemplate(id),
    async run(id, label, fn) {
      if (store.get().busy) return undefined;
      // Buttons are disabled while busy, so the control that started the run loses focus. Put it back when the run
      // ends, unless the run moved focus somewhere on purpose (or the user did).
      const before = document.activeElement as HTMLElement | null;
      store.set({ busy: label });
      try { return await fn(); } catch (e) { ctx.fail(id, `${label} failed`, e); return undefined; } finally {
        store.set({ busy: null });
        const a = document.activeElement;
        if (before && before !== document.body && (!a || a === document.body || a === before) && before.isConnected &&
          !(before as HTMLButtonElement).disabled && !before.closest("[hidden]")) before.focus();
      }
    },
    refreshSlides() {
      const m = ctx.mode();
      return slides.show(m.deck, m.template, { changed: m.changed, selected: m.selected, empty: m.emptySlides });
    },
  };

  // ---------- inspector ----------
  const liveUdm = () => {
    const doc = editor.getJSON();
    if (!isEmptyDoc(doc)) return tiptapToUdm(doc).udm;
    return ctx.mode().udm;
  };
  inspector = createInspector({
    idPrefix: "udm",
    initial: store.get().inspectorTab,
    onSelect: (tab: InspectorTab) => store.set({ inspectorTab: tab }),
    copy: (text, what) => {
      const done = () => toast.show(`${what} copied`, "success");
      try {
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => toast.show("Copy failed", "error", "The browser blocked clipboard access; select the text instead."));
        else toast.show("Copy unavailable", "error", "Select the text and copy it instead.");
      } catch (e) { toast.show("Copy failed", "error", errorMessage(e)); }
    },
    content(tab) {
      const m = ctx.mode();
      try {
        switch (tab) {
          case "presenton":
            return m.deck ? { text: JSON.stringify(presentonJson(m.deck), null, 2) } : { text: "No Presenton slides in this mode yet.", empty: true };
          case "tiptap": {
            const doc = editor.getJSON();
            return isEmptyDoc(doc) ? { text: "The editor is empty.", empty: true } : { text: JSON.stringify(doc, null, 2) };
          }
          case "udm": {
            const u = liveUdm();
            return u ? { text: JSON.stringify(u, null, 2) } : { text: "No UDM yet.", empty: true };
          }
          case "markdown": {
            const u = liveUdm();
            return u ? { text: udmToMarkdown(u).markdown } : { text: "No page yet.", empty: true };
          }
          case "loss":
            return { text: lossReport(m) };
        }
      } catch (e) {
        return { text: `Could not build this view: ${errorMessage(e)}` };
      }
    },
  });
  const inspectorToggle = h("button", { type: "button", class: "udm-btn udm-btn--ghost udm-btn--sm udm-inspector-toggle",
    "aria-expanded": "true", "aria-controls": "udm-inspector-pane" }, "Hide inspector");
  const inspectorPane = h("section", { class: "udm-pane udm-pane--inspector", id: "udm-inspector-pane", "aria-labelledby": "udm-inspector-title" },
    h("div", { class: "udm-pane__head" }, h("h3", { class: "udm-pane__title", id: "udm-inspector-title" }, "Inspector")), inspector.el);

  // ---------- downloads ----------
  const fileBase = () => {
    const m = ctx.mode();
    const u = liveUdm();
    return slug(u?.title || m.deck?.templateName || "udm-playground");
  };
  const hasPage = () => !isEmptyDoc(editor.getJSON());
  const download = createDownloadMenu("udm", [
    { id: "pptx", label: "PPTX", hint: "demo exporter (pptxgenjs)", enabled: () => !!(ctx.mode().deck?.slides.length && ctx.mode().template),
      run: () => ctx.run(store.get().mode, "PPTX export", async () => {
        const m = ctx.mode();
        await exportDeckPptx(m.deck!, m.template!, `${fileBase()}.pptx`);
        ctx.status(`PPTX saved: ${m.deck!.slides.length} slides.`, "success");
      }) },
    { id: "presenton", label: "Presenton JSON", hint: "slides with layout + ui", enabled: () => !!ctx.mode().deck,
      run: () => saveFile(`${fileBase()}-presenton.json`, JSON.stringify(presentonJson(ctx.mode().deck!), null, 2)) },
    { id: "udm", label: "UDM JSON", enabled: () => hasPage() || !!ctx.mode().udm,
      run: () => saveFile(`${fileBase()}.udm.json`, JSON.stringify(liveUdm(), null, 2)) },
    { id: "tiptap", label: "tiptap.json", enabled: hasPage,
      run: () => saveFile(`${fileBase()}.tiptap.json`, JSON.stringify(editor.getJSON(), null, 2)) },
    { id: "markdown", label: "Markdown", enabled: () => hasPage() || !!ctx.mode().udm,
      run: () => saveFile(`${fileBase()}.md`, udmToMarkdown(liveUdm()).markdown, "text/markdown") },
  ]);

  const workspace = h("div", { class: "udm-workspace" }, slides.el, editorPane, inspectorPane);
  inspectorToggle.addEventListener("click", () => {
    const hide = !workspace.classList.contains("is-inspector-hidden");
    workspace.classList.toggle("is-inspector-hidden", hide);
    inspectorPane.hidden = hide;
    inspectorToggle.setAttribute("aria-expanded", String(!hide));
    inspectorToggle.textContent = hide ? "Show inspector" : "Hide inspector";
    if (!hide) scheduleInspector(0);
  });

  // ---------- modes ----------
  const views: Record<ModeId, ModeView> = {
    create: createCreateMode(ctx, { editorExtra, sampleSpeed: opts.sampleSpeed }),
    deck: createDeckMode(ctx),
    page: createPageMode(ctx),
  };
  const panels = MODES.map((m) => {
    const p = views[m.id].panel;
    p.id = `udm-panel-${m.id}`;
    p.setAttribute("role", "tabpanel");
    p.setAttribute("aria-labelledby", `udm-mode-${m.id}`);
    p.classList.add("udm-panel");
    return p;
  });

  const bar = h("div", { class: "udm-bar" }, stepsList,
    h("div", { class: "udm-bar__actions" }, download.el, inspectorToggle));

  mount.replaceChildren(h("div", { class: "udm-app" }, header, tabList, ...panels, bar, workspace, statusBar, toast.el));

  // ---------- reactions ----------
  let inspectorTimer: any;
  function scheduleInspector(delay = 250) {
    clearTimeout(inspectorTimer);
    inspectorTimer = setTimeout(() => { if (!inspectorPane.hidden) inspector.refresh(); updateBadge(); }, delay);
  }
  function updateBadge() {
    const m = ctx.mode();
    const errs = m.errors.length + m.issues.filter((i) => i.level === "error").length;
    const n = m.loss.length + m.issues.length + m.errors.length;
    inspector.setBadge("loss", n ? String(n) : null, errs ? "error" : m.issues.length ? "warn" : "info");
  }
  function updateEditorMeta() {
    const doc = editor.getJSON();
    const meta = mount.querySelector("#udm-editor-meta");
    if (meta) meta.textContent = isEmptyDoc(doc) ? "" : fmtBytes(byteSize(JSON.stringify(doc)));
  }
  editor.onChange(() => {
    const id = store.get().mode;
    if (!ctx.mode().dirty) ctx.patchMode(id, { dirty: true });
    updateEditorMeta();
    scheduleInspector();
  });

  function selectMode(id: ModeId) {
    const prev = store.get().mode;
    if (prev !== id) {
      ctx.patchMode(prev, { doc: editor.getJSON() });
      store.set({ mode: id });
      const saved = ctx.mode(id).doc;
      editor.setJSON(saved ?? EMPTY_DOC);
      ctx.patchMode(id, { doc: null });
      editor.editor.setEditable?.(!(store.get().busy && id === "create"));
    }
    for (const [k, b] of tabs) {
      const on = k === id;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const m of MODES) views[m.id].panel.hidden = m.id !== id;
    views[id].activate();
    renderAll();
  }

  function renderAll() {
    const m = ctx.mode();
    renderSteps(stepsList, m.flow, m.stage);
    download.refresh();
    void ctx.refreshSlides();
    scheduleInspector(0);
    updateEditorMeta();
    for (const v of Object.values(views)) v.refresh();
  }
  store.subscribe((s, prev) => {
    const cur = s.modes[s.mode];
    const was = prev.modes[prev.mode];
    if (s.mode !== prev.mode) return; // selectMode renders everything
    if (s.busy !== prev.busy) {
      mount.classList.toggle("is-busy", !!s.busy);
      // aria-busy on the workspace only: on the whole app it would also hold back the status bar's announcements.
      workspace.setAttribute("aria-busy", String(!!s.busy));
      for (const v of Object.values(views)) v.refresh();
      download.refresh();
    }
    if (s.modes === prev.modes) return;
    if (cur.flow !== was.flow || cur.stage !== was.stage) renderSteps(stepsList, cur.flow, cur.stage);
    if (cur.deck !== was.deck || cur.template !== was.template || cur.changed !== was.changed || cur.selected !== was.selected) void ctx.refreshSlides();
    if (cur.loss !== was.loss || cur.issues !== was.issues || cur.errors !== was.errors || cur.deck !== was.deck || cur.udm !== was.udm) scheduleInspector(0);
    download.refresh();
    for (const v of Object.values(views)) v.refresh();
  });

  selectMode("create");
  return {
    root: mount, ctx, selectMode, views, slides,
    destroy() { editor.destroy(); mount.replaceChildren(); },
  };
}

function lossReport(m: ModeState): string {
  const out: string[] = [];
  out.push(m.op ? `Last operation: ${m.op}` : "No conversion has run in this mode yet.");
  if (m.errors.length) {
    out.push("", `Errors (${m.errors.length})`);
    for (const e of m.errors) out.push(`  ! ${e}`);
  }
  out.push("", `Losses (${m.loss.length})`);
  if (m.loss.length) {
    for (const [code, n] of countBy(m.loss, (l) => l.code)) out.push(`  ${code} × ${n}`);
    out.push("");
    for (const l of m.loss) out.push(`  [${l.code}] ${l.message}${l.blockId ? ` (block ${l.blockId})` : ""}`);
  } else out.push("  none");
  out.push("", `Checks (${m.issues.length})`);
  if (m.issues.length) for (const i of m.issues) out.push(`  ${i.level === "error" ? "error  " : "warning"} ${i.code} at ${i.path}: ${i.message}`);
  else out.push("  none");
  return out.join("\n");
}
