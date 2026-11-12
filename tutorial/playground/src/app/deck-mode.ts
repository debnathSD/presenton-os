// Mode "Presenton deck to page": pick a sample deck, convert its slides to a Tiptap page, edit, apply the edits
// back into the same layouts (provenance mode). Changed slides are highlighted.

import { h, svgIcon, ICONS } from "./dom";
import { createPicker } from "./picker";
import { deckToUdm, udmToTiptap, tiptapToUdm, udmToDeck } from "../udm/bridge";
import { sampleDeck } from "../data";
import { fmtMs, lossSummary, now, plural } from "./format";
import type { Ctx } from "./state";
import type { ModeView } from "./app";
import { prepareTextMeasure } from "../render/measure";

export function createDeckMode(ctx: Ctx): ModeView {
  const ID = "deck" as const;
  const picker = createPicker({
    label: "1. Pick a sample deck",
    hint: "Each deck is a built-in Presenton template: its curated layouts with their own sample content, rendered by Presenton’s real renderer.",
    templates: ctx.index,
    onPick: (id) => void pick(id),
  });
  const convertBtn = h("button", { type: "button", class: "udm-btn udm-btn--primary", "data-action": "convert" },
    "Convert slides to Tiptap", svgIcon(ICONS.arrow));
  const applyBtn = h("button", { type: "button", class: "udm-btn udm-btn--primary", "data-action": "apply" },
    svgIcon(ICONS.back), "Apply edits to slides");
  const resetBtn = h("button", { type: "button", class: "udm-btn udm-btn--ghost", "data-action": "reset" }, "Reset deck");
  const hint = h("p", { class: "udm-hint" });
  convertBtn.addEventListener("click", () => void convert());
  applyBtn.addEventListener("click", () => void apply());
  resetBtn.addEventListener("click", () => { const t = ctx.mode(ID).template; if (t) void pick(t.id); });

  const panel = h("div", {},
    h("p", { class: "udm-panel__lead" },
      "Presenton slides become a flowing Tiptap page and go back into the same layouts. Each slot keeps its place: " +
      "the UDM records the slot path in its Presenton extension, so an edited paragraph lands in the slot it came from."),
    picker.el,
    h("div", { class: "udm-actions", role: "group", "aria-label": "Deck actions" },
      h("span", { class: "udm-actions__label" }, "2."), convertBtn, h("span", { class: "udm-actions__label" }, "3. Edit the page, then"), applyBtn, resetBtn),
    hint);

  async function pick(id: string) {
    await ctx.run(ID, "Loading the deck", async () => {
      const t = await ctx.loadTemplate(id);
      const deck = sampleDeck(t);
      picker.select(id);
      ctx.patchMode(ID, { template: t, deck, udm: null, loss: [], issues: [], errors: [], changed: [], selected: 0, stage: 0,
        op: `Loaded ${t.name}: ${plural(deck.slides.length, "slide")}` });
      ctx.setDoc(ID, { type: "doc", content: [{ type: "paragraph" }] });
      ctx.status(`${t.name} loaded: ${plural(deck.slides.length, "slide")}. Next: Convert slides to Tiptap.`);
    });
  }

  async function convert() {
    const m = ctx.mode(ID);
    if (!m.deck) return;
    await ctx.run(ID, "Convert slides to Tiptap", () => {
      const t0 = now();
      const a = deckToUdm(m.deck!);
      const t1 = now();
      const b = udmToTiptap(a.udm);
      const t2 = now();
      const loss = [...a.loss, ...b.loss];
      if (!ctx.setDoc(ID, b.doc)) throw new Error("The converted page did not pass the editor schema (see the Loss report).");
      ctx.patchMode(ID, { udm: a.udm, loss, issues: b.issues, errors: [], changed: [], stage: 2,
        op: `Convert slides to Tiptap: deserialize ${fmtMs(t1 - t0)}, serialize ${fmtMs(t2 - t1)}` });
      ctx.status(`Converted ${plural(m.deck!.slides.length, "slide")} to a Tiptap page in ${fmtMs(t2 - t0)} ` +
        `(Presenton → UDM ${fmtMs(t1 - t0)}, UDM → Tiptap ${fmtMs(t2 - t1)}) · ${lossSummary(loss, b.issues)}. Edit the page, then apply.`, "success");
    });
  }

  async function apply() {
    const m = ctx.mode(ID);
    if (!m.deck || !m.template) return;
    await prepareTextMeasure(m.template);
    await ctx.run(ID, "Apply edits to slides", () => {
      const before = m.deck!;
      const t0 = now();
      const a = tiptapToUdm(ctx.getDoc(ID));
      const t1 = now();
      const r = udmToDeck(a.udm, before, m.template!);
      const t2 = now();
      const loss = [...a.loss, ...r.loss];
      const known = new Set(before.slides.map((s) => s.id));
      const added = r.deck.slides.filter((s) => !known.has(s.id)).length;
      const removed = r.loss.filter((l) => l.code === "slide_removed").length;
      const firstChanged = r.deck.slides.findIndex((s) => r.changedSlideIds.includes(s.id));
      ctx.patchMode(ID, { deck: r.deck, udm: a.udm, loss, issues: r.issues, errors: [], changed: r.changedSlideIds,
        selected: firstChanged >= 0 ? firstChanged : Math.min(m.selected, r.deck.slides.length - 1), stage: 4,
        op: `Apply edits to slides: Tiptap → UDM ${fmtMs(t1 - t0)}, UDM → Presenton ${fmtMs(t2 - t1)}` });
      // New or removed slides change the slide ids the page refers to: reload the page from the new deck so the
      // next apply patches the right slides.
      let resynced = false;
      if (added || removed) {
        const b = udmToTiptap(deckToUdm(r.deck).udm);
        resynced = ctx.setDoc(ID, b.doc);
      } else ctx.patchMode(ID, { dirty: false });
      const changed = r.changedSlideIds.length;
      ctx.status(`Applied in ${fmtMs(t2 - t0)}: ${changed ? `${plural(changed, "slide")} changed (highlighted)` : "no slide changed"}` +
        `${added ? `, ${added} added` : ""}${removed ? `, ${removed} removed` : ""} · ${lossSummary(loss, r.issues)}` +
        `${resynced ? " · page reloaded from the new deck" : ""}.`, changed ? "success" : "info");
    });
  }

  function refresh() {
    const m = ctx.mode(ID);
    const busy = !!ctx.store.get().busy;
    picker.setDisabled(busy);
    convertBtn.disabled = busy || !m.deck;
    applyBtn.disabled = busy || !m.deck || m.stage < 2;
    resetBtn.disabled = busy || !m.template;
    hint.textContent = !m.deck ? "Pick a deck to start."
      : m.stage < 2 ? "Convert the slides to open them as a page in the editor."
      : m.dirty ? "You have edits that are not on the slides yet: Apply edits to slides."
      : m.stage === 4 ? "Slides are up to date. Changed slides are outlined in the strip."
      : "Edit any text, list, table or chart in the editor, then apply.";
  }

  return {
    id: ID, panel, refresh,
    activate() {
      const m = ctx.mode(ID);
      picker.select(m.template?.id ?? null);
      if (!m.deck && ctx.index[0] && !ctx.store.get().busy) void pick(ctx.index[0].id);
    },
  };
}
