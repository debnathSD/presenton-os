// Slides pane: an enlarged view of the selected slide plus a strip of numbered thumbnails.
// Slides are drawn by src/render (Presenton's real renderer in sandboxed iframes), which is loaded lazily so the
// renderer and katex stay out of the first chunk. Changed slides (after "Apply edits") carry a badge and an outline.

import { h } from "./dom";
import type { Deck, DeckSlide } from "../udm/bridge";
import type { TemplateData } from "../data";

type RenderModule = typeof import("../render/index");
let renderMod: Promise<RenderModule> | null = null;
export const loadRenderer = (): Promise<RenderModule> => (renderMod ??= import("../render/index"));

export type SlidesPane = {
  el: HTMLElement;
  show(deck: Deck | null, template: TemplateData | null, opts: { changed?: string[]; selected?: number; empty?: string }): Promise<void>;
  /** Resolves when the last show() finished rendering (tests). */
  idle(): Promise<void>;
};

export function createSlidesPane(onSelect: (index: number) => void, onError: (e: unknown) => void): SlidesPane {
  const heading = h("h3", { class: "udm-pane__title", id: "udm-slides-title" }, "Slides");
  const count = h("span", { class: "udm-pane__count" });
  const main = h("div", { class: "udm-slides__main" });
  const caption = h("p", { class: "udm-slides__caption" });
  const strip = h("ol", { class: "udm-slides__strip", "aria-label": "Slide thumbnails" });
  const empty = h("div", { class: "udm-empty" });
  const el = h("section", { class: "udm-pane udm-pane--slides", "aria-labelledby": "udm-slides-title" },
    h("div", { class: "udm-pane__head" }, heading, count), empty, main, caption, strip);

  const thumbs = new Map<string, HTMLElement>(); // slide id -> thumb render box (iframe reused across renders)
  let pending: Promise<void> = Promise.resolve();
  let token = 0;

  function show(deck: Deck | null, t: TemplateData | null, opts: { changed?: string[]; selected?: number; empty?: string }): Promise<void> {
    const my = ++token;
    const slides = deck?.slides ?? [];
    const hasSlides = !!(deck && t && slides.length);
    empty.hidden = hasSlides;
    main.hidden = caption.hidden = strip.hidden = !hasSlides;
    count.textContent = hasSlides ? `${slides.length} · ${deck!.templateName}` : "";
    if (!hasSlides) {
      empty.textContent = opts.empty ?? "No slides yet.";
      strip.replaceChildren();
      thumbs.clear();
      return (pending = Promise.resolve());
    }
    const changed = new Set(opts.changed ?? []);
    const sel = Math.min(Math.max(opts.selected ?? 0, 0), slides.length - 1);
    const cur = slides[sel];
    caption.textContent = `Slide ${sel + 1} of ${slides.length}: ${cur.title || cur.layoutId}` +
      (changed.has(cur.id) ? " (changed by the last apply)" : "");

    const seen = new Set<string>();
    const items = slides.map((s: DeckSlide, i: number) => {
      seen.add(s.id);
      let box = thumbs.get(s.id);
      // The button carries the name; the thumbnail iframe inside it is decoration for assistive technology.
      if (!box) { box = h("div", { class: "udm-thumb__frame", "aria-hidden": "true" }); thumbs.set(s.id, box); }
      const isChanged = changed.has(s.id);
      const btn = h("button", {
        type: "button", class: `udm-thumb${i === sel ? " is-selected" : ""}${isChanged ? " is-changed" : ""}`,
        "aria-current": i === sel ? "true" : null,
        "aria-label": `Slide ${i + 1}: ${s.title || s.layoutId}${isChanged ? ", changed" : ""}`,
        "data-slide-id": s.id,
      },
        h("span", { class: "udm-thumb__num", "aria-hidden": "true" }, String(i + 1)),
        box,
        isChanged ? h("span", { class: "udm-thumb__badge", "aria-hidden": "true" }, "changed") : null);
      btn.addEventListener("click", () => onSelect(i));
      return h("li", {}, btn);
    });
    for (const id of [...thumbs.keys()]) if (!seen.has(id)) thumbs.delete(id);
    // The strip is rebuilt on every selection: keep keyboard focus on the (new) selected thumbnail.
    const hadFocus = strip.contains(document.activeElement);
    strip.replaceChildren(...items);
    if (hadFocus) strip.querySelector<HTMLElement>(".is-selected")?.focus();
    strip.querySelector(".is-selected")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });

    pending = loadRenderer().then(async (R) => {
      if (my !== token) return;
      await R.renderSlide(main, cur, t!, { highlight: changed.has(cur.id), label: `Slide ${sel + 1}: ${cur.title || cur.layoutId}`, fallbackWidth: 640 });
      await Promise.all(slides.map((s, i) => (my === token
        ? R.renderThumb(thumbs.get(s.id)!, s, t!, { highlight: changed.has(s.id), label: `Thumbnail ${i + 1}`, fallbackWidth: 160, timeoutMs: 1500 })
        : undefined)));
    }).catch((e) => { onError(e); });
    return pending;
  }

  show(null, null, { empty: "No slides yet." });
  return { el, show, idle: () => pending };
}
