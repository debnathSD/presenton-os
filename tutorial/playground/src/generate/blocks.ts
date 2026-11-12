// Model output -> UDM. Pure and light (no SDK, no zod), so the recorded sample run uses the same conversion as a
// live run. Every section is checked with the prototype's checkUdm; on failure the outline text is used instead.

import { checkUdm, hashId, normalizeRichText, UDM_PROFILE, UDM_VERSION } from "../../../prototypes/udm/core/udm-runtime.mjs";
import type { Outline, OutlineSection, TargetManifest, UdmSection } from "./types";
import { MAX_OUTLINE_CONTENT_WORDS, MAX_SECTIONS } from "./types";

/** Block types the generator may emit, in prompt order (spec: heading, paragraph, list, quote, callout, table, chart, divider). */
export const GENERATOR_BLOCKS = ["paragraph", "heading", "list", "table", "chart", "callout", "quote", "divider"] as const;
/** Chart kinds offered to the model (a readable subset; negotiation handles the rest). */
export const GENERATOR_CHART_KINDS = ["bar", "horizontal_bar", "stacked_bar", "line", "area", "pie", "donut"] as const;
/** ext namespace marking data the model wrote (static sample data, never live). */
export const GEN_NS = "playground.generate";

/** The section schema is built from these: generator blocks the target manifest can hold. */
export function generatedBlockTypes(manifest: TargetManifest): string[] {
  return GENERATOR_BLOCKS.filter((t) => manifest.blocks.includes(t) && (t !== "chart" || chartKinds(manifest).length > 0));
}
export function chartKinds(manifest: TargetManifest): string[] {
  return GENERATOR_CHART_KINDS.filter((k) => manifest.chartKinds?.includes(k));
}
export function headingLevels(manifest: TargetManifest): number[] {
  return [1, 2, 3].filter((l) => l <= Math.max(1, manifest.structure.maxHeadingLevel));
}

/**
 * Size caps for model output (the schemas leave counts out on purpose; see schema.ts). Output is bounded by max_tokens
 * anyway; these keep one section from flooding the editor or a slide. Cuts are reported in UdmSection.notes.
 */
export const LIMITS = { titleChars: 200, blocks: 40, listItems: 40, tableColumns: 12, tableRows: 60, chartCategories: 40, chartSeries: 8 } as const;

// ---------- outline ----------

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const clipWords = (s: string, n: number) => { const w = words(s); return w.length > n ? w.slice(0, n).join(" ") : s.trim(); };
const clipChars = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const stripHeading = (s: string) => clipChars(s.replace(/\s+/g, " ").replace(/^#+\s*/, "").replace(/^\d+[.)]\s+/, "").trim(), LIMITS.titleChars);

/** Normalize a raw outline (model output or Outline review edits): plain titles, ids, max sections, max words. */
export function normalizeOutline(raw: any, opts: { nSections?: number | null; runId: string; fallbackTitle?: string }): Outline {
  const max = opts.nSections ? Math.min(MAX_SECTIONS, Math.max(1, Math.floor(opts.nSections))) : MAX_SECTIONS;
  const title = stripHeading(String(raw?.title ?? "")) || (opts.fallbackTitle ?? "").trim().slice(0, 80) || "Untitled page";
  const taken = new Set<string>();
  const sections: OutlineSection[] = [];
  for (const s of Array.isArray(raw?.sections) ? raw.sections : []) {
    const t = stripHeading(String(s?.title ?? ""));
    const content = clipWords(String(s?.content ?? ""), MAX_OUTLINE_CONTENT_WORDS);
    if (!t && !content) continue;
    let id = typeof s?.id === "string" && s.id ? s.id : `out_${hashId(opts.runId, String(sections.length), t)}`;
    while (taken.has(id)) id = `${id}x`;
    taken.add(id);
    sections.push({ id, title: t || `Section ${sections.length + 1}`, content });
    if (sections.length >= max) break;
  }
  return { title, sections };
}

// ---------- inline text ----------

/** "**bold**", "*italic*", "`code`" -> RichText, keeping only marks the target holds. Anything else stays literal. */
export function inlineMarkdown(src: string, marks: string[]): any[] {
  const s = String(src ?? "").replace(/\r\n?/g, "\n").trim();
  const out: any[] = [];
  const re = /\*\*\*([^*\n]+?)\*\*\*|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])|`([^`\n]+)`/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push({ text: s.slice(last, m.index) });
    const [, bi, b1, b2, i, c] = m;
    const want = bi ? ["bold", "italic"] : b1 || b2 ? ["bold"] : i ? ["italic"] : ["code"];
    const keep = want.filter((x) => marks.includes(x));
    out.push(keep.length ? { text: bi ?? b1 ?? b2 ?? i ?? c, marks: keep } : { text: bi ?? b1 ?? b2 ?? i ?? c });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return normalizeRichText(out);
}

const plainText = (src: string) => inlineMarkdown(src, []).map((x: any) => x.text).join("");
const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/[,%\s]/g, "")) : NaN);

// ---------- section ----------

export type SectionContext = { runId: string; index: number; outline: Outline; manifest: TargetManifest };

export function sectionId(ctx: { runId: string; index: number; outline: Outline }) {
  const o = ctx.outline.sections[ctx.index];
  return `sec_${hashId("gen", ctx.runId, o?.id ?? String(ctx.index))}`;
}

/** Raw section output ({ blocks: [...] }) -> UdmSection. Throws nothing: invalid output becomes the outline fallback. */
export function toUdmSection(raw: any, ctx: SectionContext): UdmSection {
  const o = ctx.outline.sections[ctx.index];
  const sid = sectionId(ctx);
  const allowed = new Set(generatedBlockTypes(ctx.manifest));
  const kinds = chartKinds(ctx.manifest);
  const levels = headingLevels(ctx.manifest);
  const marks = ctx.manifest.marks;
  const rt = (s: unknown) => inlineMarkdown(str(s), marks);
  const notes: string[] = [];
  const bindings: Record<string, any> = {};
  const blocks: any[] = [];
  const sample = { [GEN_NS]: { data: "illustrative" } };

  const all = Array.isArray(raw?.blocks) ? raw.blocks : null;
  if (!all) return fallbackSection(ctx, "invalid_output", "The model output has no blocks array.");
  const list = all.slice(0, LIMITS.blocks);
  if (all.length > list.length) notes.push(`${all.length - list.length} blocks over the limit of ${LIMITS.blocks} dropped`);
  const cap = <T,>(arr: T[], n: number, what: string, i: number): T[] => {
    if (arr.length > n) notes.push(`block ${i}: ${what} cut to ${n}`);
    return arr.slice(0, n);
  };

  list.forEach((b: any, i: number) => {
    const type = str(b?.type);
    if (!allowed.has(type)) { notes.push(`block ${i}: type "${type}" is not allowed by the target; dropped`); return; }
    const id = `blk_${hashId(sid, String(i), type)}`;
    switch (type) {
      case "paragraph": case "callout": {
        const text = rt(b.text);
        if (!text.length) { notes.push(`block ${i}: empty ${type} dropped`); return; }
        blocks.push(type === "callout"
          ? { id, type, tone: ["info", "warning", "success"].includes(b.tone) ? b.tone : "info", text }
          : { id, type, text });
        return;
      }
      case "heading": {
        const text = rt(b.text);
        if (!text.length) { notes.push(`block ${i}: empty heading dropped`); return; }
        if (i === 0 && plainText(str(b.text)).toLowerCase() === o.title.toLowerCase()) { notes.push("repeated section title dropped"); return; }
        const lv = Number(b.level);
        blocks.push({ id, type, level: levels.includes(lv) ? lv : levels[0], text });
        return;
      }
      case "quote": {
        const text = rt(b.text);
        if (!text.length) { notes.push(`block ${i}: empty quote dropped`); return; }
        const attribution = str(b.attribution);
        blocks.push({ id, type, text, ...(attribution ? { attribution } : {}) });
        return;
      }
      case "list": {
        const items = cap((Array.isArray(b.items) ? b.items : []).map((it: unknown) => rt(it)).filter((t: any[]) => t.length), LIMITS.listItems, "list items", i);
        if (!items.length) { notes.push(`block ${i}: empty list dropped`); return; }
        blocks.push({ id, type, ordered: Boolean(b.ordered), items });
        return;
      }
      case "divider":
        if (blocks.length && blocks[blocks.length - 1].type !== "divider") blocks.push({ id, type });
        return;
      case "table": {
        const columns = cap((Array.isArray(b.columns) ? b.columns : []).map((c: unknown) => plainText(str(c))), LIMITS.tableColumns, "table columns", i);
        const rows0 = cap((Array.isArray(b.rows) ? b.rows : []).filter(Array.isArray), LIMITS.tableRows, "table rows", i);
        if (!columns.length || columns.every((c: string) => !c) || !rows0.length) { notes.push(`block ${i}: table without columns or rows dropped`); return; }
        let ragged = false;
        const rows = rows0.map((r: unknown[]) => {
          if (r.length !== columns.length) ragged = true;
          return columns.map((_: string, k: number) => plainText(str(r[k])));
        });
        if (ragged) notes.push(`block ${i}: table rows padded or cut to ${columns.length} cells`);
        const bindingId = `b_${hashId(sid, id, "table")}`;
        bindings[bindingId] = { kind: "table", source: { type: "static", origin: "user", data: { columns, rows } } };
        const caption = rt(b.caption);
        blocks.push({ id, type, bindingId, ...(caption.length ? { caption } : {}), ext: sample });
        return;
      }
      case "chart": {
        const categories = cap((Array.isArray(b.categories) ? b.categories : []).map((c: unknown) => plainText(str(c))), LIMITS.chartCategories, "chart categories", i);
        const series = cap((Array.isArray(b.series) ? b.series : [])
          .map((s: any) => ({ name: plainText(str(s?.name)) || "Value", values: (Array.isArray(s?.values) ? s.values : []).map(num) }))
          .filter((s: any) => s.values.length && s.values.every(Number.isFinite)), LIMITS.chartSeries, "chart series", i);
        const n = Math.min(categories.length, ...series.map((s: any) => s.values.length));
        if (!categories.length || !series.length || n < 1) {
          notes.push(`block ${i}: chart without usable data`);
          const text = rt([b.title, b.caption].map(str).filter(Boolean).join(". "));
          if (text.length) blocks.push({ id, type: "paragraph", text });
          return;
        }
        if (n < categories.length || series.some((s: any) => s.values.length !== n)) notes.push(`block ${i}: chart data cut to ${n} categories`);
        const bindingId = `b_${hashId(sid, id, "chart")}`;
        bindings[bindingId] = { kind: "chart", source: { type: "static", origin: "user",
          data: { categories: categories.slice(0, n), series: series.map((s: any) => ({ name: s.name, values: s.values.slice(0, n) })) } } };
        const chartType = kinds.includes(b.chartType) ? b.chartType : (kinds.includes("bar") ? "bar" : kinds[0]);
        const x = plainText(str(b.xAxisLabel)), y = plainText(str(b.yAxisLabel));
        const title = plainText(str(b.title));
        const caption = rt(b.caption);
        blocks.push({ id, type, bindingId, chartType, ...(title ? { title } : {}),
          ...(x || y ? { axes: { ...(x ? { x } : {}), ...(y ? { y } : {}) } } : {}),
          ...(caption.length ? { caption } : {}), ext: sample });
        return;
      }
    }
  });
  while (blocks.length && blocks[blocks.length - 1].type === "divider") blocks.pop();
  if (!blocks.length) return fallbackSection(ctx, "invalid_output", "The model output has no usable blocks.");

  const result: UdmSection = { index: ctx.index, outlineId: o.id, section: { id: sid, title: o.title, blocks }, bindings, notes };
  const issues = checkSection(result);
  if (issues.length) return fallbackSection(ctx, "invalid_output", `checkUdm: ${issues.map((x: any) => `${x.code} ${x.message}`).join("; ")}`);
  return result;
}

/** The outline's own text as one paragraph (Markdown list lines kept as line breaks). Always valid. */
export function fallbackSection(ctx: SectionContext, reason: NonNullable<UdmSection["fallback"]>["reason"], message: string): UdmSection {
  const o = ctx.outline.sections[ctx.index];
  const sid = sectionId(ctx);
  const lines = String(o.content ?? "").split("\n").map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^#+\s*/, "").trim())
    .filter((l) => l && !/^\|?[\s:-]+(\|[\s:-]+)+\|?$/.test(l));
  const text = inlineMarkdown(lines.join("\n"), ctx.manifest.marks);
  const blocks = text.length ? [{ id: `blk_${hashId(sid, "fallback")}`, type: "paragraph", text }] : [];
  return { index: ctx.index, outlineId: o.id, section: { id: sid, title: o.title, blocks }, bindings: {}, fallback: { reason, message }, notes: [] };
}

/** checkUdm on a one-section artifact. */
export function checkSection(s: UdmSection): any[] {
  return checkUdm(sectionToUdm(s));
}

// ---------- assembling ----------

export type PageMeta = { runId: string; model?: string; prompt?: string; createdAt?: string; language?: string };

/** A UDM holding only this section (no title): convert with bridge.udmToTiptap and append the nodes. */
export function sectionToUdm(s: UdmSection): any {
  return { version: UDM_VERSION, profile: UDM_PROFILE, id: `art_${hashId("gen-section", s.section.id)}`,
    provenance: { origin: "generated" }, sections: [s.section], bindings: s.bindings };
}

/** The whole page as one UDM: outline title, sections in outline order, merged bindings, generated provenance. */
export function assemblePage(outline: Outline, sections: UdmSection[], meta: PageMeta): any {
  const ordered = [...sections].sort((a, b) => a.index - b.index);
  const lang = meta.language && meta.language !== "auto-detect" ? meta.language : undefined;
  return {
    version: UDM_VERSION, profile: UDM_PROFILE, id: `art_${hashId("gen", meta.runId)}`,
    title: outline.title,
    ...(lang ? { language: lang } : {}),
    provenance: { origin: "generated", runId: meta.runId, ...(meta.model ? { model: meta.model } : {}),
      ...(meta.prompt ? { prompt: meta.prompt } : {}), ...(meta.createdAt ? { createdAt: meta.createdAt } : {}) },
    sections: ordered.map((s) => s.section),
    bindings: Object.assign({}, ...ordered.map((s) => s.bindings)),
  };
}
