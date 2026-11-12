// Demo PPTX exporter (lazy-loaded): Presenton Template v2 `ui` trees -> a real .pptx built with pptxgenjs.
// This is the playground's own exporter, not Presenton's closed export package. Every slide is rebuilt from its
// ui tree with native PowerPoint objects:
//   text -> text boxes with runs; text-list -> bulleted/numbered paragraphs; vector -> rect / roundRect / ellipse /
//   custom geometry; image -> embedded picture (cover/contain/crop via srcRect, icons recolored); table -> native
//   table; chart -> native chart (bar, horizontal/stacked bar, line, area, pie, donut, scatter, bubble, radar);
//   groups, containers, flex and grid are flattened with their offsets, rotations and clips; paint order is kept.
// Geometry: 1280x720 px -> LAYOUT_WIDE 13.333x7.5 in (96 px per inch); font sizes px -> pt (x 0.75).
//
// Use from the app (keeps pptxgenjs out of the initial bundle):
//   const { exportPptx } = await import("../pptx/index");
//   await exportPptx(deck, template, "my-deck.pptx");

import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import { assetsRoot, resolveAsset } from "../data";
import type { TemplateData } from "../data";
import type { Deck, DeckSlide } from "../udm/bridge";
import { flattenSlide, place } from "./walk";
import type { Leaf } from "./walk";
import { ImageCache, sameOriginLoader } from "./images";
import type { AssetLoader } from "./images";
import { vectorShape, boxShape, shadowProps } from "./shapes";
import type { ShapeSpec } from "./shapes";
import { textElement, textListElement, tableRows } from "./text";
import { nativeChart } from "./charts";
import { arr, clamp, inch, intersect, num, parseColor, rec, sameBox, str, transparency, pt } from "./units";
import type { Box } from "./units";

export const EXPORT_FOOTER = "Exported by the UDM Playground demo exporter";

export type ExportWarning = { slideId: string; code: string; message: string };
export type ExportReport = {
  slides: number;
  /** Native objects written, by kind: text, list, shape, image, table, chart, infographic. */
  counts: Record<string, number>;
  /** Chart type names written per slide id (pptxgenjs names: bar, line, pie, doughnut, ...). */
  charts: Record<string, string[]>;
  warnings: ExportWarning[];
};

export type BuildOptions = {
  /** How images are fetched (default: fetch, same origin as the assets root only). Tests pass a file loader. */
  loadAsset?: AssetLoader;
  /** Base for relative asset URLs (default: the playground assets root). */
  assetsBase?: string;
  /** Presentation title (default: the template name). */
  title?: string;
};

type Ctx = {
  pptx: PptxGenJS;
  slide: any;
  slideId: string;
  images: ImageCache;
  base: string;
  fontFace: string;
  report: ExportReport;
};

const count = (r: ExportReport, k: string) => { r.counts[k] = (r.counts[k] ?? 0) + 1; };
const warn = (c: Ctx, code: string, message: string) => {
  if (!c.report.warnings.some((w) => w.slideId === c.slideId && w.code === code && w.message === message)) {
    c.report.warnings.push({ slideId: c.slideId, code, message });
  }
};

const pos = (p: { x: number; y: number; w: number; h: number; rotate: number }) => ({
  x: inch(p.x), y: inch(p.y), w: inch(Math.max(p.w, 0.5)), h: inch(Math.max(p.h, 0.5)),
  ...(p.rotate ? { rotate: p.rotate } : {}),
});

function templateFont(t: TemplateData): string {
  const theme = rec(t.theme);
  return str(rec(rec(theme.fonts).textFont).name) ?? Object.keys(t.fonts ?? {})[0] ?? "Arial";
}

function addShape(c: Ctx, spec: ShapeSpec, ownRotation: number, leaf: Leaf, flip?: { h?: boolean; v?: boolean }) {
  const p = place(spec.box, ownRotation, leaf.xf);
  c.slide.addShape(spec.shape, { ...pos(p), ...spec.options, ...(flip?.h ? { flipH: true } : {}), ...(flip?.v ? { flipV: true } : {}) });
  count(c.report, "shape");
}

// ---- images -----------------------------------------------------------------------------------------------------

/** Bounding box of a CSS clip-path path('M ... Z') in element px, or null. */
function clipPathBox(value: unknown): Box | null {
  const s = str(value);
  if (!s) return null;
  const m = s.match(/^path\(\s*['"]([^'"]*)['"]\s*\)$/i);
  if (!m) return null;
  const nums = (m[1].match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number);
  if (nums.length < 4) return null;
  const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

async function addImage(c: Ctx, leaf: Leaf, src: string) {
  const el = leaf.el;
  const box = leaf.box;
  const url = /^(data:|https?:|blob:)/i.test(src) ? src : resolveAsset(src, c.base);
  const iconColor = el.is_icon || el.isIcon ? str(el.color) : null;
  let img;
  try {
    img = await c.images.get(url, iconColor ? (parseColor(iconColor) ? `#${parseColor(iconColor)!.hex}` : iconColor) : null);
  } catch (e: any) {
    warn(c, "image_unavailable", `Image could not be loaded (${e?.message ?? e}); a placeholder box was written`);
    addShape(c, { shape: "rect", box, options: { fill: { color: "E5E7EB" }, line: { type: "none" } } }, num(el.rotation) ?? 0, leaf);
    return;
  }
  if (img.notRecolored) warn(c, "icon_not_recolored", "A raster icon keeps its original color (no canvas available)");

  // visible area: the element box, minus the clip-path and any clipping container
  let visible: Box | null = box;
  const cp = clipPathBox(el.clip_path ?? el.clipPath);
  if (cp) visible = intersect(visible, { x: box.x + cp.x, y: box.y + cp.y, w: cp.w, h: cp.h });
  if (visible && leaf.clip) visible = intersect(visible, leaf.clip);
  if (!visible) return;

  // where the whole picture is painted (object-fit + object-position + crop_scale, as in the renderer)
  const fit = el.fit === "cover" || el.fit === "fill" ? el.fit : "contain";
  const fx = clamp(num(el.focus_x ?? el.focusX) ?? 50, 0, 100) / 100, fy = clamp(num(el.focus_y ?? el.focusY) ?? 50, 0, 100) / 100;
  let content: Box = box;
  if (fit !== "fill" && img.width && img.height) {
    const s = fit === "cover" ? Math.max(box.w / img.width, box.h / img.height) : Math.min(box.w / img.width, box.h / img.height);
    const w = img.width * s, h = img.height * s;
    content = { x: box.x + (box.w - w) * fx, y: box.y + (box.h - h) * fy, w, h };
  } else if (fit !== "fill") {
    warn(c, "image_size_unknown", "An image's natural size could not be read; it was stretched to its box");
  }
  const cropScale = clamp(num(el.crop_scale ?? el.cropScale) ?? 1, 1, 6);
  if (cropScale > 1) {
    const ox = box.x + box.w * fx, oy = box.y + box.h * fy;
    content = { x: ox + (content.x - ox) * cropScale, y: oy + (content.y - oy) * cropScale, w: content.w * cropScale, h: content.h * cropScale };
  }
  visible = intersect(visible, content);
  if (fit === "cover" || cropScale > 1) visible = visible && intersect(visible, box);
  if (!visible) return;

  const p = place(visible, num(el.rotation) ?? 0, leaf.xf);
  const r = rec(el.border_radius ?? el.borderRadius);
  const radius = Math.min(num(r.tl) ?? 0, num(r.tr) ?? num(r.tl) ?? 0, num(r.bl) ?? num(r.tl) ?? 0, num(r.br) ?? num(r.tl) ?? 0);
  const circle = radius > 0 && radius >= Math.min(visible.w, visible.h) / 2 - 0.5;
  if (radius > 0 && !circle) warn(c, "image_corners_square", "Rounded image corners are written square");
  const opacity = num(el.opacity);
  const opts: Record<string, any> = {
    data: img.data,
    ...(opacity != null && opacity < 1 ? { transparency: transparency(opacity) } : {}),
    ...(circle ? { rounding: true } : {}),
    ...(el.flip_h || el.flipH ? { flipH: true } : {}),
    ...(el.flip_v || el.flipV ? { flipV: true } : {}),
    altText: str(el.prompt) ?? str(el.name) ?? "",
  };
  if (p.rotate) opts.rotate = p.rotate;
  if (sameBox(visible, content)) {
    Object.assign(opts, { x: inch(p.x), y: inch(p.y), w: inch(visible.w), h: inch(visible.h) });
  } else {
    // crop: w/h are the full painted picture, sizing.{x,y,w,h} the visible part of it (pptxgenjs srcRect)
    Object.assign(opts, {
      x: inch(p.x), y: inch(p.y), w: inch(content.w), h: inch(content.h),
      sizing: { type: "crop", x: inch(visible.x - content.x), y: inch(visible.y - content.y), w: inch(visible.w), h: inch(visible.h) },
    });
  }
  c.slide.addImage(opts);
  count(c.report, "image");
}

// ---- infographics (no native equivalent: simplified) --------------------------------------------------------------

function infographicLabels(data: any): string[] {
  const out: string[] = [];
  const walk = (v: any, depth: number) => {
    if (depth > 4 || out.length >= 12) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    const r = rec(v);
    const label = ["title", "label", "name", "text", "heading"].map((k) => str(r[k])).find(Boolean);
    const detail = ["description", "value", "subtitle"].map((k) => (typeof r[k] === "number" ? String(r[k]) : str(r[k]))).find(Boolean);
    if (label) out.push(detail ? `${label}: ${detail}` : label);
    for (const [k, x] of Object.entries(r)) if (typeof x === "object" && k !== "icon") walk(x, depth + 1);
  };
  walk(data, 0);
  return out;
}

function addInfographic(c: Ctx, leaf: Leaf) {
  const el = leaf.el;
  const data = rec(el.data);
  const type = str(data.type) ?? "infographic";
  const colors = arr(el.colors).map((x) => parseColor(x)?.hex).filter(Boolean) as string[];
  const main = colors[0] ?? "155DFC";
  const rot = num(el.rotation) ?? 0;
  if (type === "progress_bar" || type === "gauge") {
    const min = num(data.min_value) ?? 0, max = num(data.max_value) ?? 100, v = num(data.value) ?? 0;
    const frac = clamp((v - min) / (max - min || 1), 0, 1);
    const h = Math.min(leaf.box.h, 24);
    const track = { x: leaf.box.x, y: leaf.box.y + (leaf.box.h - h) / 2, w: leaf.box.w, h };
    addShape(c, { shape: "roundRect", box: track, options: { fill: { color: colors[1] ?? "E5E7EB" }, rectRadius: inch(h / 2) } }, rot, leaf);
    if (frac > 0) addShape(c, { shape: "roundRect", box: { ...track, w: track.w * frac }, options: { fill: { color: main }, rectRadius: inch(h / 2) } }, rot, leaf);
  } else {
    const lines = infographicLabels(data);
    c.slide.addText(lines.length ? lines.map((t, i) => ({ text: t, options: { bullet: true, ...(i < lines.length - 1 ? { breakLine: true } : {}) } })) : type.replace(/_/g, " "), {
      ...pos(place(leaf.box, rot, leaf.xf)), margin: 6, fontFace: c.fontFace, fontSize: 12, color: parseColor(el.text_color)?.hex ?? "344054",
      fill: { color: "F8FAFC" }, line: { color: main, width: 1 }, valign: "top", isTextBox: true,
    });
    count(c.report, "infographic");
    warn(c, "infographic_simplified", `Infographic "${type}" has no native PowerPoint form; written as a labelled text box`);
  }
}

// ---- one slide ----------------------------------------------------------------------------------------------------

async function addLeaf(c: Ctx, leaf: Leaf) {
  const el = leaf.el;
  const rot = num(el.rotation) ?? 0;
  if (leaf.kind === "box") {
    const spec = boxShape(el, leaf.box);
    if (spec) addShape(c, spec, rot, leaf);
    return;
  }
  const type = str(el.type);
  switch (type) {
    case "vector": {
      const spec = vectorShape(el, leaf.points ?? []);
      if (spec) addShape(c, spec, rot, leaf, { h: !!el.flip_h, v: !!el.flip_v });
      return;
    }
    case "text":
    case "math": {
      const { runs, options } = type === "math"
        ? textElement({ ...el, runs: [{ type: "latex", latex: String(el.latex ?? "") }] })
        : textElement(el);
      const shadow = shadowProps(el.shadow);
      c.slide.addText(runs, { ...pos(place(leaf.box, rot, leaf.xf)), ...options, ...(shadow ? { shadow } : {}),
        ...(el.flip_h ? { flipH: true } : {}), ...(el.flip_v ? { flipV: true } : {}) });
      count(c.report, "text");
      if (type === "math" || arr(el.runs).some((r) => rec(r).type === "latex")) warn(c, "math_as_text", "Math is written as LaTeX source text");
      return;
    }
    case "text-list": {
      const { runs, options } = textListElement(el);
      c.slide.addText(runs, { ...pos(place(leaf.box, rot, leaf.xf)), ...options });
      count(c.report, "list");
      return;
    }
    case "image": {
      const src = str(el.data);
      if (src) await addImage(c, leaf, src);
      return;
    }
    case "svg": {
      const svg = str(el.svg);
      if (!svg) return;
      const bytes = new TextEncoder().encode(svg);
      let s = "";
      bytes.forEach((b) => { s += String.fromCharCode(b); });
      await addImage(c, { ...leaf, el: { ...el, fit: "fill" } }, `data:image/svg+xml;base64,${btoa(s)}`);
      return;
    }
    case "table": {
      const { rows, cols } = tableRows(el);
      if (!rows.length) return;
      const p = place(leaf.box, rot, leaf.xf);
      const w = inch(leaf.box.w), h = inch(leaf.box.h);
      c.slide.addTable(rows, {
        x: inch(p.x), y: inch(p.y), w, h,
        colW: Array.from({ length: cols }, () => Math.round((w / cols) * 10000) / 10000),
        rowH: Array.from({ length: rows.length }, () => Math.round((h / rows.length) * 10000) / 10000),
        autoPage: false,
      });
      if (rot) warn(c, "table_not_rotated", "A rotated table is written unrotated");
      count(c.report, "table");
      return;
    }
    case "chart": {
      const chart = nativeChart(el, leaf.box.h, c.fontFace);
      if (chart.warning) warn(c, "chart_type_mapped", chart.warning);
      c.slide.addChart(chart.type, chart.data, { ...pos(place(leaf.box, rot, leaf.xf)), ...chart.options,
        altText: str(el.title) ?? str(el.name) ?? "chart" });
      (c.report.charts[c.slideId] ??= []).push(chart.type);
      count(c.report, "chart");
      return;
    }
    case "infographic":
      addInfographic(c, leaf);
      return;
    default:
      if (type) warn(c, "element_skipped", `Element type "${type}" is not exported`);
  }
}

function notesFor(slide: DeckSlide): string {
  const s = slide as any;
  const own = [s.speakerNote, s.speaker_note, s.notes, rec(slide.ui).speaker_note]
    .map((v) => (Array.isArray(v) ? v.map((x) => rec(x).text ?? x).join("\n") : v))
    .find((v) => typeof v === "string" && v.trim());
  return `${own ? `${String(own).trim()}\n\n` : slide.title ? `${slide.title}\n\n` : ""}${EXPORT_FOOTER}`;
}

/** Build the presentation in memory (no download). The report lists what was written and what was simplified. */
export async function buildPptx(deck: Deck, t: TemplateData, opts: BuildOptions = {}): Promise<{ pptx: PptxGenJS; report: ExportReport }> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = opts.title ?? deck.templateName ?? t.name;
  pptx.subject = "UDM Playground demo export";
  pptx.author = "UDM Playground";
  pptx.company = "";
  const fontFace = templateFont(t);
  pptx.theme = { headFontFace: fontFace, bodyFontFace: fontFace };
  const report: ExportReport = { slides: 0, counts: {}, charts: {}, warnings: [] };
  const base = opts.assetsBase ?? assetsRoot();
  const images = new ImageCache(opts.loadAsset ?? sameOriginLoader(base));

  for (const s of deck.slides) {
    const slide = pptx.addSlide();
    const ui = rec(s.ui);
    const bg = parseColor(ui.background) ?? { hex: "FFFFFF", alpha: 1 };
    slide.background = { color: bg.hex };
    const c: Ctx = { pptx, slide, slideId: s.id, images, base, fontFace, report };
    for (const leaf of flattenSlide(ui)) {
      try {
        await addLeaf(c, leaf);
      } catch (e: any) {
        warn(c, "element_failed", `${str(leaf.el?.type) ?? "element"}: ${e?.message ?? e}`);
      }
    }
    slide.addNotes(notesFor(s));
    report.slides++;
  }
  return { pptx, report };
}

export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * pptxgenjs writes an <a:pPr> before every run of a multi-run paragraph; the schema (CT_TextParagraph) allows one,
 * first. Keep the first and drop the rest, in slides, layouts and notes.
 */
export function fixParagraphProperties(xml: string): string {
  return xml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (_m, body: string) => {
    let seen = false;
    const fixed = body.replace(/<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g, (pPr) => (seen ? "" : ((seen = true), pPr)));
    return `<a:p>${fixed}</a:p>`;
  });
}

/** The finished .pptx bytes: pptxgenjs output with the paragraph fix applied, DEFLATE-compressed. */
export async function pptxBytes(pptx: PptxGenJS): Promise<Uint8Array> {
  const raw = (await pptx.write({ outputType: "uint8array" })) as Uint8Array;
  const zip = await JSZip.loadAsync(raw);
  const parts = Object.keys(zip.files).filter((f) => /^ppt\/(slides|slideLayouts|slideMasters|notesSlides|notesMasters)\/[^/]+\.xml$/.test(f));
  for (const f of parts) zip.file(f, fixParagraphProperties(await zip.file(f)!.async("string")));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: PPTX_MIME });
}

function save(bytes: Uint8Array, fileName: string): void {
  const g = globalThis as any;
  if (g.document?.createElement && g.URL?.createObjectURL) {
    const url = g.URL.createObjectURL(new g.Blob([bytes], { type: PPTX_MIME }));
    const a = g.document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    a.style.display = "none";
    g.document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => g.URL.revokeObjectURL(url), 1000);
    return;
  }
  const fs = g.process?.getBuiltinModule?.("node:fs");
  if (!fs) throw new Error("No way to save a file in this environment");
  fs.writeFileSync(fileName, bytes);
}

/** Build and download a .pptx of the deck (browser: a file download; Node: a file written to `fileName`). */
export async function exportPptx(deck: Deck, t: TemplateData, fileName: string): Promise<void> {
  const { pptx } = await buildPptx(deck, t);
  const name = (fileName || `${deck.templateId || "deck"}.pptx`).replace(/[\\/:*?"<>|]+/g, "-");
  save(await pptxBytes(pptx), /\.pptx$/i.test(name) ? name : `${name}.pptx`);
}

// exported for tests and for callers that want the report or a Blob
export { flattenSlide } from "./walk";
export { nativeChart, chartKind } from "./charts";
export { imageSize, sniffType } from "./images";
export type { AssetLoader } from "./images";
export { pt as pxToPt, inch as pxToInch };
