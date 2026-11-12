// Document helpers shared by the shell and the modes.

import type { Deck } from "../udm/bridge";

export const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

export function isEmptyDoc(doc: any): boolean {
  const c = doc?.content ?? [];
  return !c.length || (c.length === 1 && c[0].type === "paragraph" && !(c[0].content?.length));
}

/** Presenton's shape for a deck: slides with their layout id and ui (what slides.ui holds in Presenton's DB). */
export function presentonJson(deck: Deck): any {
  return {
    template: deck.templateId,
    slides: deck.slides.map((s, i) => ({ id: s.id, index: i, layout: s.layoutId, layout_group: s.templateId, ui: s.ui })),
  };
}

export const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").slice(0, 48) || "page";
