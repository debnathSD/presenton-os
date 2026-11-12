// Mode "Page to slides": start from a sample Tiptap page (or a blank one), pick a template, generate a new deck
// (content mode: a layout per section chosen by slot capacity; blocks that fit no slot are reported).

import { h, svgIcon, ICONS } from "./dom";
import { createPicker } from "./picker";
import { samplePage, blankPage } from "./sample-page";
import { slidesFromPage } from "./to-slides";
import { isEmptyDoc } from "./doc";
import type { ModeView } from "./app";
import type { Ctx } from "./state";

export function createPageMode(ctx: Ctx): ModeView {
  const ID = "page" as const;
  let templateId: string | null = ctx.index[0]?.id ?? null;
  const sampleBtn = h("button", { type: "button", class: "udm-btn", "data-action": "sample-page" }, "Load the sample page");
  const blankBtn = h("button", { type: "button", class: "udm-btn udm-btn--ghost", "data-action": "blank-page" }, "Start blank");
  const picker = createPicker({
    label: "2. Pick the template for the slides",
    templates: ctx.index,
    selected: templateId,
    onPick: (id) => { templateId = id; refresh(); },
  });
  const generateBtn = h("button", { type: "button", class: "udm-btn udm-btn--primary", "data-action": "generate-slides" },
    "Generate slides from page", svgIcon(ICONS.arrow));
  const hint = h("p", { class: "udm-hint" });

  sampleBtn.addEventListener("click", () => load(samplePage(), "Sample page loaded: a title, four sections, a list, a chart and a table."));
  blankBtn.addEventListener("click", () => load(blankPage(), "Blank page. Use H2 headings for sections: each becomes a slide."));
  generateBtn.addEventListener("click", () => void generate());

  const panel = h("div", {},
    h("p", { class: "udm-panel__lead" },
      "A page written in Tiptap becomes a new Presenton deck. Each H2 section gets the template layout whose slots fit " +
      "its blocks best; what fits no slot is listed in the Loss report rather than dropped silently."),
    h("div", { class: "udm-actions", role: "group", "aria-label": "Start from" },
      h("span", { class: "udm-actions__label" }, "1. Start from"), sampleBtn, blankBtn),
    picker.el,
    h("div", { class: "udm-actions" }, h("span", { class: "udm-actions__label" }, "3."), generateBtn),
    hint);

  function load(doc: any, msg: string) {
    if (ctx.setDoc(ID, doc)) {
      ctx.patchMode(ID, { deck: null, udm: null, loss: [], issues: [], errors: [], changed: [], selected: 0, stage: 0, op: "" });
      ctx.status(msg);
    }
  }

  async function generate() {
    if (!templateId) return;
    const id = templateId;
    await ctx.run(ID, "Generate slides from page", () => slidesFromPage(ctx, ID, id, 2));
  }

  function refresh() {
    const busy = !!ctx.store.get().busy;
    const m = ctx.mode(ID);
    const empty = isEmptyDoc(ctx.getDoc(ID));
    sampleBtn.disabled = blankBtn.disabled = busy;
    picker.setDisabled(busy);
    generateBtn.disabled = busy || !templateId || empty;
    hint.textContent = empty ? "Load the sample page or write one in the editor."
      : m.deck && m.dirty ? "The page changed since the slides were made: generate again to update them."
      : m.deck ? "Slides generated. Download them as PPTX from the Download menu."
      : "Pick a template and generate.";
  }

  return {
    id: ID, panel, refresh,
    activate() {
      if (isEmptyDoc(ctx.getDoc(ID)) && !ctx.mode(ID).deck) load(samplePage(), "Sample page loaded. Pick a template, then Generate slides from page.");
    },
  };
}
