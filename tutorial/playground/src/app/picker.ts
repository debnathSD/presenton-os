// Template / deck picker: one card per curated template (thumbnail, name, description, layout count).
// Cards are toggle buttons in a labelled group; the chosen one has aria-pressed="true".

import { h } from "./dom";
import type { TemplateSummary } from "../data";

export type Picker = { el: HTMLElement; select(id: string | null): void; value(): string | null; setDisabled(d: boolean): void };

export function createPicker(opts: {
  label: string;
  hint?: string;
  templates: TemplateSummary[];
  selected?: string | null;
  action?: string;
  onPick(id: string): void;
}): Picker {
  let current = opts.selected ?? null;
  const cards = new Map<string, HTMLButtonElement>();
  const labelId = `udm-picker-${Math.random().toString(36).slice(2, 8)}`;
  const grid = h("div", { class: "udm-picker__grid", role: "group", "aria-labelledby": labelId });
  for (const t of opts.templates) {
    const img = h("img", { src: t.thumbnail, alt: "", loading: "lazy", decoding: "async", width: "320", height: "180" });
    const b = h("button", { type: "button", class: "udm-card", "aria-pressed": "false", "data-template": t.id },
      h("span", { class: "udm-card__thumb" }, img),
      h("span", { class: "udm-card__body" },
        h("span", { class: "udm-card__name" }, t.name),
        h("span", { class: "udm-card__meta" }, `${t.layoutCount} layouts`),
        t.description ? h("span", { class: "udm-card__desc" }, t.description) : null,
        opts.action ? h("span", { class: "udm-card__action", "aria-hidden": "true" }, opts.action) : null));
    b.addEventListener("click", () => { select(t.id); opts.onPick(t.id); });
    cards.set(t.id, b);
    grid.append(b);
  }
  function select(id: string | null) {
    current = id;
    for (const [k, b] of cards) b.setAttribute("aria-pressed", String(k === id));
  }
  select(current);
  const el = h("div", { class: "udm-picker" },
    h("p", { class: "udm-picker__label", id: labelId }, opts.label),
    opts.hint ? h("p", { class: "udm-hint" }, opts.hint) : null,
    grid);
  return {
    el, select, value: () => current,
    setDisabled(d) { for (const b of cards.values()) b.disabled = d; },
  };
}
