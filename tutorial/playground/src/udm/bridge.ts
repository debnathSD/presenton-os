// Thin wrapper over the Part X prototype (tutorial/prototypes/udm): one registry with the adapters the playground
// needs, plus deck-level glue (slide ids, per-slide patch bases, content mode). All conversion logic lives in the
// prototype; this file only decides which layouts each section may use and maps loss entries for the UI.

import { createRegistry } from "../../../prototypes/udm/core/registry.mjs";
import { clone, hashId } from "../../../prototypes/udm/core/udm-runtime.mjs";
import { createPresentonAdapter } from "../../../prototypes/udm/adapters/presenton/index.mjs";
import { NS } from "../../../prototypes/udm/adapters/presenton/from-presenton.mjs";
import { createTiptapAdapter } from "../../../prototypes/udm/adapters/tiptap/index.mjs";
import { markdownAdapter } from "../../../prototypes/udm/adapters/markdown.mjs";
import type { TemplateData } from "../data";

export type DeckSlide = { id: string; templateId: string; layoutId: string; title: string; ui: unknown };
export type Deck = { templateId: string; templateName: string; slides: DeckSlide[] };
export type Loss = { code: string; message: string; blockId?: string; detail?: unknown };
/** Native-format check results (Tiptap schema check, Presenton Template v2 rules such as max_length warnings). */
export type Issue = { level: "error" | "warning"; code: string; path: string; message: string };

export { NS as PRESENTON_NS };

// The catalog is passed per call (layouts depend on the deck), so the adapter is registered with an empty one.
export const registry = createRegistry();
registry.register(createPresentonAdapter({ layouts: {} }), ["slides"]);
registry.register(createTiptapAdapter({ id: "tiptap" }), ["tiptap-doc"]);
registry.register(markdownAdapter, ["md"]);
const P = registry.get(NS);
const T = registry.get("tiptap");

/** The exact extension list the tiptap adapter's schema is built from. The editor must use this list. */
export function tiptapExtensions(): any[] {
  return [...T.extensions];
}

/** Validate a tiptap.json doc against the adapter schema (nodeFromJSON().check() plus dropped-attr diff). */
export function validateTiptap(doc: any): Issue[] {
  return T.validateNative(doc);
}

// ---------- loss entries ----------

const MESSAGES: Record<string, string> = {
  no_slot: "No free slot for this block in the layout; it is not on the slide",
  slot_unmapped: "Layout slot left empty (no block maps to it)",
  block_degraded: "Block converted to a simpler type the target supports",
  block_dropped: "Block dropped (the target cannot hold it)",
  block_retyped: "Block placed in a slot of another type",
  mark_dropped: "Text formatting the target cannot hold was dropped",
  mark_absorbed_by_slot_style: "Formatting already applied by the slot style",
  text_clipped: "Text clipped to the target limit",
  text_reduced: "Converted block holds less text than the original",
  table_as_chart: "Table data written into a chart slot",
  caption_dropped: "Caption dropped (the slot has no caption)",
  caption_to_paragraph: "Caption moved into a paragraph",
  notes_dropped: "Speaker notes dropped",
  summary_dropped: "Section summary dropped",
  ext_dropped: "Target-specific provenance dropped",
  groups_dropped: "Card grouping dropped",
  roles_dropped: "Block roles dropped",
  section_role_dropped: "Section role dropped",
  heading_clamped: "Heading level clamped",
  list_flattened: "Nested list flattened",
  chart_kind_fallback: "Chart type replaced by one the target supports",
  diagram_extra_to_ext: "Infographic-only fields kept as provenance",
  native_node_degraded: "Unknown editor node converted to a paragraph",
  native_mark_dropped: "Unknown editor mark dropped",
  inline_node_degraded: "Unknown inline node converted to text",
  table_no_header: "Table has no header row",
  table_ragged: "Table rows had different lengths",
  slide_removed: "Slide removed (its section is no longer in the document)",
  title_slide_added: "Document title placed on its own slide",
  tiptap_invalid: "Generated document fails the Tiptap schema check",
  text_autofit: "Text shrunk to fit its box",
};

export function toLoss(e: any): Loss {
  const blockId = String(e.path ?? "").split("/").find((p: string) => p.startsWith("blk_"));
  const extra = [e.detail, e.droppedText ? `dropped: "${String(e.droppedText).slice(0, 80)}"` : ""].filter(Boolean).join("; ");
  return {
    code: e.code,
    message: `${MESSAGES[e.code] ?? e.code.replace(/_/g, " ")}${extra ? ` (${extra})` : ""}`,
    ...(blockId ? { blockId } : {}),
    detail: { path: e.path, ...(e.detail !== undefined ? { detail: e.detail } : {}), ...(e.droppedText ? { droppedText: e.droppedText } : {}) },
  };
}
const losses = (list: any[]): Loss[] => list.map(toLoss);

// ---------- conversions ----------

function toNative(deck: Deck) {
  return {
    templateId: deck.templateId,
    slides: deck.slides.map((s) => ({ id: s.id, layout_group: s.templateId, layout: s.layoutId, ui: s.ui })),
  };
}

/** Presenton deck -> UDM (presenton.slides deserialize). Every block keeps its slot path in ext["presenton.slides"]. */
export function deckToUdm(deck: Deck): { udm: any; loss: Loss[] } {
  const { udm, loss } = P.deserialize(toNative(deck));
  return { udm, loss: losses(loss) };
}

/** UDM -> tiptap.json, negotiated for the 'tiptap' (page profile) adapter. Schema problems are returned in `issues`. */
export function udmToTiptap(udm: any): { doc: any; loss: Loss[]; issues: Issue[] } {
  const r = registry.convert(udm, "tiptap");
  const issues = T.validateNative(r.native) as Issue[];
  return { doc: r.native, loss: losses(r.loss), issues };
}

/** tiptap.json (from this adapter or hand-written) -> UDM. */
export function tiptapToUdm(doc: any): { udm: any; loss: Loss[] } {
  const { udm, loss } = T.deserialize(doc);
  return { udm, loss: losses(loss) };
}

/** UDM -> Markdown (GFM). */
export function udmToMarkdown(udm: any): { markdown: string; loss: Loss[] } {
  const r = registry.convert(udm, "markdown");
  return { markdown: r.native, loss: losses(r.loss) };
}


// ---------- text auto-fit ----------

const isBold = (f: any) => Number(f?.weight) >= 600 || f?.bold === true || /bold|heavy|black|semibold/i.test(String(f?.family ?? ""));

/** Approximate advance width of one character in em (Latin text in a sans-serif face). */
function charEm(c: string) {
  if (c === " ") return 0.28;
  if (/[il.,:;'|!]/.test(c)) return 0.28;
  if (/[mwMW@]/.test(c)) return 0.85;
  if (/[A-Z]/.test(c)) return 0.64;
  if (/[0-9]/.test(c)) return 0.56;
  return 0.5;
}

/** Wrapped height estimate: greedy word wrap over per-character widths (bold adds 6%). */
function textHeight(text: string, width: number, size: number, lineHeight: number, spacing: number, bold: boolean) {
  const k = bold ? 1.06 : 1;
  const wordW = (w: string) => [...w].reduce((sum, c) => sum + charEm(c) * size * k + spacing, 0);
  const spaceW = charEm(" ") * size * k + spacing;
  let lines = 0;
  for (const para of text.split(/\r?\n/)) {
    let used = 0; let n = 1;
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const ww = wordW(w);
      if (used && used + spaceW + ww > width) { n++; used = 0; }
      if (ww > width) { n += Math.floor(ww / width); used = ww % width; } else used += (used ? spaceW : 0) + ww;
    }
    lines += n;
  }
  return lines * size * lineHeight;
}

type TextEl = { name?: string; size: { width: number; height: number }; font: any; runs: any[] };
const isTextEl = (n: any): n is TextEl =>
  n?.type === "text" && n.size?.width > 0 && n.size?.height > 0 && n.font?.size > 0 && Array.isArray(n.runs);

function estimate(n: TextEl, k = 1) {
  const text = n.runs.map((r: any) => String(r?.text ?? "")).join("");
  const lh = Number(n.font.line_height ?? n.font.lineHeight ?? 1.2);
  const ls = Number(n.font.letter_spacing ?? n.font.letterSpacing ?? 0);
  const bold = isBold(n.font) || n.runs.some((r: any) => isBold(r?.font));
  return { text, h: textHeight(text, n.size.width, Number(n.font.size) * k, lh, ls * k, bold) };
}

function textElements(ui: any, visit: (n: TextEl, path: string) => void) {
  (function walk(n: any, path: string) {
    if (!n || typeof n !== "object") return;
    if (isTextEl(n)) visit(n, path);
    for (const [key, v] of Object.entries(n)) if (v && typeof v === "object") walk(v, `${path}/${key}`);
  })(ui, "");
}

/**
 * Shrink text elements whose new text no longer fits their box (Presenton's slots are sized for the sample copy).
 * `reference` is the layout as designed (template ui or the slide before the edit): for each slot name it tells how
 * far the width estimate is off for that font, so text that fits as well as the sample copy is never shrunk.
 * Font size, run sizes and letter spacing scale together, down to 45%. Returns one `text_autofit` loss entry per
 * element changed. Mutates `ui`.
 */
export function autofitText(ui: any, slideId: string, reference?: any): Loss[] {
  const calib = new Map<string, number>();
  if (reference) textElements(reference, (n) => {
    const { text, h } = estimate(n);
    if (n.name && text.trim() && !calib.has(n.name)) calib.set(n.name, Math.max(1, h / n.size.height));
  });
  const out: Loss[] = [];
  textElements(ui, (n, path) => {
    const room = n.size.height * (calib.get(n.name ?? "") ?? 1) * 1.08;
    if (!estimate(n).text.trim() || estimate(n).h <= room) return;
    let k = 1;
    while (k > 0.45 && estimate(n, k).h > room) k = Math.max(0.45, Math.round((k - 0.05) * 100) / 100);
    const scale = (f: any) => {
      if (!f) return;
      if (typeof f.size === "number") f.size = Math.round(f.size * k * 100) / 100;
      for (const key of ["letter_spacing", "letterSpacing"]) if (typeof f[key] === "number") f[key] = Math.round(f[key] * k * 100) / 100;
    };
    scale(n.font);
    for (const r of n.runs) scale(r?.font);
    out.push(toLoss({ code: "text_autofit", path: `${slideId}${path}`, detail: `${n.name ?? "text"} ${Math.round(k * 100)}%` }));
  });
  return out;
}

const humanize = (id: string) => id.replace(/_\d+$/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function uniqueId(seed: string, taken: Set<string>) {
  let id = seed;
  for (let n = 2; taken.has(id); n++) id = `${seed}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Provenance (patch) mode: UDM -> the same deck. A section linked to a base slide (ext slideId) is patched on top of
 * that slide's current ui, so an unchanged slide comes back byte-identical and an edited one changes only the slots
 * whose blocks changed. A section with no linked slide (added in the editor, or a duplicate) gets a layout from
 * `template` (or, without it, from the layouts already in the deck) chosen by slot capacity.
 */
export function udmToDeck(udm: any, base: Deck, template?: TemplateData):
  { deck: Deck; loss: Loss[]; changedSlideIds: string[]; issues: Issue[] } {
  const u = clone(udm);
  const byId = new Map(base.slides.map((s) => [s.id, s]));
  const claimed = new Set<string>();
  const seen = new Set<string>();
  const fallback = template
    ? template.layouts.map((l) => l.ui)
    : base.slides.map((s) => s.ui as any).filter((ui) => ui?.id && !seen.has(ui.id) && seen.add(ui.id));
  const layouts: Record<string, any[]> = { [base.templateId]: fallback };
  const origin: (DeckSlide | undefined)[] = [];
  for (const s of u.sections) {
    const pe = s.ext?.[NS];
    const slide = pe?.slideId && !claimed.has(pe.slideId) ? byId.get(pe.slideId) : undefined;
    const ui = slide?.ui as any;
    if (slide && ui) {
      claimed.add(slide.id);
      const key = `slide:${slide.id}`;
      layouts[key] = [ui.id ? ui : { ...ui, id: slide.layoutId }];
      s.ext[NS] = { ...pe, templateId: key, layoutId: ui.id ?? slide.layoutId };
      origin.push(slide);
    } else {
      if (pe) {
        const { slideId, ...rest } = pe;
        s.ext[NS] = { ...rest, templateId: base.templateId };
      }
      origin.push(undefined);
    }
  }
  u.ext = { ...(u.ext ?? {}), [NS]: { ...(u.ext?.[NS] ?? {}), templateId: base.templateId } };

  const r = registry.convert(u, NS, { layouts, defaultTemplateId: base.templateId });
  const loss = losses(r.loss);
  const taken = new Set(base.slides.map((s) => s.id));
  const sections = r.negotiated.sections;
  const changedSlideIds: string[] = [];
  const slides: DeckSlide[] = r.native.slides.map((ns: any, i: number) => {
    const orig = origin[i];
    const sec = sections[i];
    const id = orig?.id ?? uniqueId(`${base.templateId}-new-${hashId("slide", sec?.id ?? String(i))}`, taken);
    const slide: DeckSlide = { id, templateId: orig?.templateId ?? base.templateId, layoutId: ns.layout,
      title: sec?.title ?? orig?.title ?? humanize(ns.layout), ui: ns.ui };
    if (!orig || JSON.stringify(ns.ui) !== JSON.stringify(orig.ui)) {
      changedSlideIds.push(id);
      loss.push(...autofitText(slide.ui, id, orig?.ui ?? template?.layouts.find((l) => l.id === ns.layout)?.ui));
    }
    return slide;
  });
  for (const s of base.slides) if (!claimed.has(s.id)) loss.push(toLoss({ code: "slide_removed", path: s.id, detail: s.layoutId }));
  return { deck: { templateId: base.templateId, templateName: base.templateName, slides }, loss, changedSlideIds,
    issues: P.validateNative(r.native) };
}

function stripNs(o: any) {
  if (!o?.ext?.[NS]) return;
  delete o.ext[NS];
  if (!Object.keys(o.ext).length) delete o.ext;
}

/**
 * Content mode: UDM -> a new deck in `template`. Presenton provenance is removed first, so every section gets a
 * layout chosen by slot capacity (the prototype's chooseLayout) from the template's curated layouts, and its blocks
 * fill slots by type in reading order. Blocks that find no slot come back as `no_slot` losses. A document title
 * (H1) becomes its own title slide.
 */
export function udmToNewDeck(udm: any, template: TemplateData): { deck: Deck; loss: Loss[]; issues: Issue[] } {
  const u = clone(udm);
  stripNs(u);
  for (const s of u.sections) { stripNs(s); for (const b of s.blocks) stripNs(b); }
  u.sections = u.sections.filter((s: any) => s.title || s.blocks.length);
  const pre: Loss[] = [];
  if (u.title) {
    u.sections.unshift({ id: `sec_${hashId("doc-title", u.title)}`, title: u.title, role: "title", blocks: [] });
    pre.push(toLoss({ code: "title_slide_added", path: u.sections[0].id }));
  }
  if (!u.sections.length) return { deck: { templateId: template.id, templateName: template.name, slides: [] }, loss: pre, issues: [] };
  const layouts = { [template.id]: template.layouts.map((l) => l.ui) };
  const r = registry.convert(u, NS, { layouts, defaultTemplateId: template.id });
  const taken = new Set<string>();
  const slides: DeckSlide[] = r.native.slides.map((ns: any, i: number) => {
    const sec = r.negotiated.sections[i];
    return { id: uniqueId(`${template.id}-gen-${i + 1}-${hashId("slide", sec?.id ?? String(i))}`, taken), templateId: template.id,
      layoutId: ns.layout, title: sec?.title ?? humanize(ns.layout), ui: ns.ui };
  });
  const fit = slides.flatMap((sl) => autofitText(sl.ui, sl.id, template.layouts.find((l) => l.id === sl.layoutId)?.ui));
  return { deck: { templateId: template.id, templateName: template.name, slides }, loss: [...pre, ...losses(r.loss), ...fit],
    issues: P.validateNative(r.native) };
}
