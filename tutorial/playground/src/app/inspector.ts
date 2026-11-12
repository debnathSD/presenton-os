// Inspector: five read-only views of the current stage (Presenton JSON, UDM, tiptap.json, Markdown, Loss report),
// each a <pre> with its size and a copy button. Only the active tab's text is computed and rendered.

import { h, svgIcon, ICONS, tablistKeys } from "./dom";
import { byteSize, fmtBytes, lineCount } from "./format";

export type InspectorTab = "presenton" | "udm" | "tiptap" | "markdown" | "loss";
export type InspectorContent = { text: string; empty?: boolean };
export type BadgeTone = "info" | "warn" | "error";

export const INSPECTOR_TABS: { id: InspectorTab; label: string }[] = [
  { id: "presenton", label: "Presenton JSON" },
  { id: "udm", label: "UDM" },
  { id: "tiptap", label: "tiptap.json" },
  { id: "markdown", label: "Markdown" },
  { id: "loss", label: "Loss report" },
];

export type Inspector = {
  el: HTMLElement;
  refresh(): void;
  select(tab: InspectorTab): void;
  current(): InspectorTab;
  /** Show a count next to a tab label (used for the loss report); null hides it. */
  setBadge(tab: InspectorTab, value: string | null, tone?: BadgeTone): void;
};

export function createInspector(opts: {
  idPrefix: string;
  initial: InspectorTab;
  content(tab: InspectorTab): InspectorContent;
  onSelect(tab: InspectorTab): void;
  copy(text: string, what: string): void;
}): Inspector {
  let active = opts.initial;
  const panelId = `${opts.idPrefix}-inspector-panel`;
  const tabs = new Map<InspectorTab, HTMLButtonElement>();
  const badges = new Map<InspectorTab, HTMLElement>();

  const list = h("div", { class: "udm-tabs udm-tabs--small", role: "tablist", "aria-label": "Inspector views" });
  for (const t of INSPECTOR_TABS) {
    const badge = h("span", { class: "udm-tab__badge", hidden: true });
    const b = h("button", {
      type: "button", class: "udm-tab", role: "tab", id: `${opts.idPrefix}-itab-${t.id}`, "aria-controls": panelId,
      onClick: () => { select(t.id); opts.onSelect(t.id); },
    }, t.label, badge);
    tabs.set(t.id, b);
    badges.set(t.id, badge);
    list.append(b);
  }
  tablistKeys(list, (tab) => {
    const id = INSPECTOR_TABS.find((t) => tabs.get(t.id) === tab)?.id;
    if (id) { select(id); opts.onSelect(id); }
  });

  const size = h("span", { class: "udm-inspector__size" });
  const copyBtn = h("button", { type: "button", class: "udm-btn udm-btn--ghost udm-btn--sm" }, svgIcon(ICONS.copy), "Copy");
  // Focusable so keyboard users can scroll it; a named region so the focus stop is announced.
  const pre = h("pre", { class: "udm-pre", tabindex: "0", role: "region" });
  const panel = h("div", { class: "udm-inspector__panel", role: "tabpanel", id: panelId },
    h("div", { class: "udm-inspector__meta" }, size, copyBtn), pre);

  let text = "";
  copyBtn.addEventListener("click", () => {
    const label = INSPECTOR_TABS.find((t) => t.id === active)!.label;
    opts.copy(text, label);
  });

  function refresh() {
    for (const t of INSPECTOR_TABS) {
      const on = t.id === active;
      const b = tabs.get(t.id)!;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    panel.setAttribute("aria-labelledby", tabs.get(active)!.id);
    const c = opts.content(active);
    text = c.text;
    pre.textContent = c.text;
    pre.classList.toggle("is-empty", !!c.empty);
    pre.setAttribute("aria-label", `${INSPECTOR_TABS.find((t) => t.id === active)!.label} (read only)`);
    size.textContent = c.empty ? "Nothing here yet" : `${fmtBytes(byteSize(c.text))} · ${lineCount(c.text).toLocaleString("en-US")} lines`;
    copyBtn.disabled = !!c.empty;
  }

  function select(tab: InspectorTab) {
    active = tab;
    refresh();
  }

  function setBadge(tab: InspectorTab, value: string | null, tone: BadgeTone = "info") {
    const b = badges.get(tab)!;
    b.hidden = !value;
    // Visually a bare count; read as "Loss report, 3 items" (without the hidden text it would be "Loss report3").
    b.replaceChildren(...(value ? [h("span", { class: "udm-sr" }, ", "), value, h("span", { class: "udm-sr" }, value === "1" ? " item" : " items")] : []));
    b.dataset.tone = tone;
  }

  const el = h("div", { class: "udm-inspector" }, list, panel);
  refresh();
  return { el, refresh, select, current: () => active, setBadge };
}
