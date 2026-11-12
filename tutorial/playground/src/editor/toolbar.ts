// Editor toolbar: role="toolbar" with a roving tabindex (one Tab stop; Left/Right/Home/End move between buttons).
// Toggle buttons expose aria-pressed; commands that cannot run here are disabled and skipped by the arrow keys.

import { SAMPLE_CHART } from "./chart";
import { h, openTextDialog } from "./dialog";

type Item = {
  id: string; label: string; text: string; keys?: string; toggle?: boolean;
  run: (e: any, btn: HTMLElement) => void;
  active?: (e: any) => boolean;
  can?: (e: any) => boolean;
};

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
const mod = () => (isMac() ? "Cmd" : "Ctrl");

/** Allow http(s), mailto, tel, in-page and relative links; refuse javascript:, data: and the like. */
export function safeHref(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (/^(https?:|mailto:|tel:)/i.test(s) || /^[#/?.]/.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  return /^[\w-]+(\.[\w-]+)+/.test(s) ? `https://${s}` : s;
}

let bindingSeq = 0;
/** A binding id not used in the current doc ("b_" + base36), like the adapter's own ids. */
export function newBindingId(editor: any): string {
  const used = new Set<string>();
  editor.state.doc.descendants((n: any) => {
    if (n.attrs?.bindingId) used.add(n.attrs.bindingId);
    if (n.attrs?.udmMeta?.bindingId) used.add(n.attrs.udmMeta.bindingId);
  });
  let id: string;
  do id = `b_ed${(Date.now() % 1e6).toString(36)}${(++bindingSeq).toString(36)}`; while (used.has(id));
  return id;
}

/** Attrs for a new chart dataBlock with sample data. */
export function newChartAttrs(editor: any) {
  return {
    kind: "chart",
    bindingId: newBindingId(editor),
    block: { chartType: "bar", title: "New chart" },
    binding: { kind: "chart", source: { type: "static", origin: "user", data: JSON.parse(JSON.stringify(SAMPLE_CHART)) } },
  };
}

function items(): (Item | "|")[] {
  const c = (e: any) => e.chain().focus();
  const can = (e: any) => e.can().chain().focus();
  const inTable = (e: any) => e.isActive("table");
  return [
    { id: "undo", label: "Undo", text: "↶", keys: `${mod()}+Z`, run: (e) => c(e).undo().run(), can: (e) => can(e).undo().run() },
    { id: "redo", label: "Redo", text: "↷", keys: `${mod()}+Shift+Z`, run: (e) => c(e).redo().run(), can: (e) => can(e).redo().run() },
    "|",
    { id: "paragraph", label: "Paragraph", text: "¶", keys: `${mod()}+Alt+0`, toggle: true, run: (e) => c(e).setParagraph().run(), active: (e) => e.isActive("paragraph"), can: (e) => can(e).setParagraph().run() },
    ...[1, 2, 3].map((level) => ({
      // The name contains the visible "H1" so speech users can say what they see (WCAG 2.5.3).
      id: `h${level}`, label: `Heading ${level} (H${level})`, text: `H${level}`, keys: `${mod()}+Alt+${level}`, toggle: true,
      run: (e: any) => c(e).toggleHeading({ level }).run(), active: (e: any) => e.isActive("heading", { level }),
      can: (e: any) => can(e).toggleHeading({ level }).run(),
    } as Item)),
    "|",
    { id: "bold", label: "Bold", text: "B", keys: `${mod()}+B`, toggle: true, run: (e) => c(e).toggleBold().run(), active: (e) => e.isActive("bold"), can: (e) => can(e).toggleBold().run() },
    { id: "italic", label: "Italic", text: "I", keys: `${mod()}+I`, toggle: true, run: (e) => c(e).toggleItalic().run(), active: (e) => e.isActive("italic"), can: (e) => can(e).toggleItalic().run() },
    { id: "underline", label: "Underline", text: "U", keys: `${mod()}+U`, toggle: true, run: (e) => c(e).toggleUnderline().run(), active: (e) => e.isActive("underline"), can: (e) => can(e).toggleUnderline().run() },
    { id: "strike", label: "Strikethrough", text: "S", keys: `${mod()}+Shift+S`, toggle: true, run: (e) => c(e).toggleStrike().run(), active: (e) => e.isActive("strike"), can: (e) => can(e).toggleStrike().run() },
    { id: "code", label: "Inline code", text: "</>", keys: `${mod()}+E`, toggle: true, run: (e) => c(e).toggleCode().run(), active: (e) => e.isActive("code"), can: (e) => can(e).toggleCode().run() },
    { id: "link", label: "Link", text: "Link", toggle: true, run: (e, btn) => editLink(e, btn), active: (e) => e.isActive("link"),
      can: (e) => e.isActive("link") || (!e.state.selection.empty && can(e).setLink({ href: "https://example.com" }).run()) },
    "|",
    { id: "bulletList", label: "Bullet list", text: "•", keys: `${mod()}+Shift+8`, toggle: true, run: (e) => c(e).toggleBulletList().run(), active: (e) => e.isActive("bulletList"), can: (e) => can(e).toggleBulletList().run() },
    { id: "orderedList", label: "Numbered list", text: "1.", keys: `${mod()}+Shift+7`, toggle: true, run: (e) => c(e).toggleOrderedList().run(), active: (e) => e.isActive("orderedList"), can: (e) => can(e).toggleOrderedList().run() },
    { id: "blockquote", label: "Quote", text: "❝", keys: `${mod()}+Shift+B`, toggle: true, run: (e) => c(e).toggleBlockquote().run(), active: (e) => e.isActive("blockquote"), can: (e) => can(e).toggleBlockquote().run() },
    { id: "horizontalRule", label: "Horizontal rule", text: "―", run: (e) => c(e).setHorizontalRule().run(), can: (e) => can(e).setHorizontalRule().run() },
    "|",
    { id: "insertTable", label: "Insert table (3 x 3)", text: "Table", run: (e) => c(e).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), can: (e) => !inTable(e) && can(e).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: "addRow", label: "Add row below", text: "+Row", run: (e) => c(e).addRowAfter().run(), can: (e) => inTable(e) && can(e).addRowAfter().run() },
    { id: "deleteRow", label: "Delete row", text: "−Row", run: (e) => c(e).deleteRow().run(), can: (e) => inTable(e) && can(e).deleteRow().run() },
    { id: "addColumn", label: "Add column right", text: "+Col", run: (e) => c(e).addColumnAfter().run(), can: (e) => inTable(e) && can(e).addColumnAfter().run() },
    { id: "deleteColumn", label: "Delete column", text: "−Col", run: (e) => c(e).deleteColumn().run(), can: (e) => inTable(e) && can(e).deleteColumn().run() },
    "|",
    { id: "insertChart", label: "Insert chart (sample data)", text: "Chart", run: (e) => c(e).insertContent({ type: "dataBlock", attrs: newChartAttrs(e) }).run(),
      can: (e) => can(e).insertContent({ type: "dataBlock", attrs: { kind: "chart" } }).run() },
  ];
}

function editLink(editor: any, btn: HTMLElement) {
  const current = editor.getAttributes("link")?.href ?? "";
  openTextDialog({
    title: current ? "Edit link" : "Add link", label: "URL", value: current, type: "url", opener: btn,
    hint: "Leave empty to remove the link.",
    validate: (v) => (v && !safeHref(v) ? "Use an http(s), mailto: or relative link" : null),
    onSave: (v) => {
      const chain = editor.chain().focus().extendMarkRange("link");
      if (!v) chain.unsetLink().run();
      else chain.setLink({ href: safeHref(v) }).run();
    },
  });
}

export type Toolbar = { el: HTMLElement; refresh: () => void; destroy: () => void; /** Focus the toolbar's tab stop; false when every button is disabled. */ focus: () => boolean };

export function createToolbar(mount: HTMLElement, editor: any, label = "Formatting"): Toolbar {
  const el = h("div", { class: "udm-toolbar", role: "toolbar", "aria-label": label, "aria-controls": editor.view.dom.id || null });
  const buttons: { item: Item; btn: HTMLButtonElement }[] = [];
  let group = h("div", { class: "udm-toolbar__group", role: "group" });
  el.append(group);
  for (const it of items()) {
    if (it === "|") {
      group = h("div", { class: "udm-toolbar__group", role: "group" });
      el.append(h("span", { class: "udm-toolbar__sep", role: "separator", "aria-orientation": "vertical" }), group);
      continue;
    }
    const btn = h("button", {
      type: "button", class: "udm-toolbar__btn", "data-cmd": it.id, "aria-label": it.label,
      title: it.keys ? `${it.label} (${it.keys})` : it.label, tabindex: "-1",
      ...(it.keys ? { "aria-keyshortcuts": it.keys.replace(/Cmd/g, "Meta").replace(/Ctrl/g, "Control") } : {}),
      ...(it.toggle ? { "aria-pressed": "false" } : {}),
    }, h("span", { "aria-hidden": "true", text: it.text })) as HTMLButtonElement;
    // keep the editor selection: do not move focus on mousedown
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      setRoving(btn);
      it.run(editor, btn);
    });
    group.append(btn);
    buttons.push({ item: it, btn });
  }

  let current: HTMLButtonElement | null = null;
  const enabled = () => buttons.map((b) => b.btn).filter((b) => !b.disabled);
  function setRoving(btn: HTMLButtonElement | null) {
    for (const b of buttons) b.btn.tabIndex = -1;
    current = btn ?? enabled()[0] ?? null;
    if (current) current.tabIndex = 0;
  }
  el.addEventListener("keydown", (e) => {
    const list = enabled();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % list.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Escape") { e.preventDefault(); editor.commands.focus(); return; }
    if (next < 0) return;
    e.preventDefault();
    setRoving(list[next]);
    list[next].focus();
  });

  const refresh = () => {
    if (editor.isDestroyed) return;
    for (const { item, btn } of buttons) {
      let ok = true;
      try { ok = editor.isEditable && (item.can ? Boolean(item.can(editor)) : true); } catch { ok = false; }
      btn.disabled = !ok;
      if (item.toggle) {
        let on = false;
        try { on = Boolean(item.active?.(editor)); } catch { on = false; }
        btn.setAttribute("aria-pressed", String(on));
      }
    }
    if (!current || current.disabled) setRoving(null);
  };

  editor.on("transaction", refresh);
  editor.on("focus", refresh);
  // setEditable() emits "update", not "transaction": without this the buttons stayed enabled while the page was
  // locked (sections streaming in) and could still change the document.
  editor.on("update", refresh);
  mount.replaceChildren(el);
  setRoving(null);
  refresh();
  return {
    el, refresh,
    focus: () => {
      refresh();
      if (!current) return false;
      current.focus();
      return true;
    },
    destroy: () => {
      editor.off("transaction", refresh);
      editor.off("focus", refresh);
      editor.off("update", refresh);
      el.remove();
    },
  };
}
