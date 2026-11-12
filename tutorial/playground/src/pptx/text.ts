// Text, text lists and tables -> native PowerPoint text boxes and tables. Runs are normalized with Presenton's own
// normalizeRawTextMarkdownElement (the renderer's step: inline Markdown such as **bold** becomes runs, fonts are
// completed), then each run keeps its font family, size, weight, style, underline, color, opacity and letter
// spacing. LaTeX runs are written as their LaTeX source (PowerPoint equations are out of scope for the demo).

import { normalizeRawTextMarkdownElement } from "@/components/slide-editor/text/template-v2-text";
import { normalizeMathLatex } from "@/lib/math";
import { arr, num, parseColor, pt, rec, str, transparency } from "./units";

type Run = { text: string; options: Record<string, any> };

/** pptxgenjs run options from a Presenton font. */
export function runOptions(font: any): Record<string, any> {
  const f = rec(font);
  const c = parseColor(f.color) ?? { hex: "111827", alpha: 1 };
  const o: Record<string, any> = { color: c.hex };
  const tr = transparency(c.alpha, num(f.opacity));
  if (tr > 0) o.transparency = tr;
  if (str(f.family)) o.fontFace = String(f.family).split(",")[0].replace(/["']/g, "").trim();
  if (num(f.size) != null) o.fontSize = pt(num(f.size)!);
  if (f.bold === true) o.bold = true;
  if (f.italic === true) o.italic = true;
  if (f.underline === true || f.text_decoration === "underline" || f.textDecoration === "underline") o.underline = { style: "sng" };
  const ls = num(f.letter_spacing ?? f.letterSpacing);
  if (ls) o.charSpacing = pt(ls);
  return o;
}

function normalizedRuns(runs: any[], text: unknown, font: unknown): any[] {
  try {
    return normalizeRawTextMarkdownElement({ type: "text", font, text: typeof text === "string" ? text : undefined, runs } as any).runs as any[];
  } catch {
    return runs;
  }
}

const joined = (runs: any[]) => runs.map((r) => (rec(r).type === "latex" ? normalizeMathLatex(rec(r).latex) : String(rec(r).text ?? ""))).join("");

/**
 * Presenton runs -> pptxgenjs text runs, split at "\n" into paragraphs (breakLine on the last run of a line).
 * `para` options (bullet, spacing) go on the first run of every paragraph.
 */
export function toRuns(rawRuns: any[], elementFont: any, text?: unknown, para: Record<string, any> = {}, patch: Record<string, any> = {}): Run[] {
  const base = rec(elementFont);
  const runs = normalizedRuns(rawRuns.map(rec), text ?? joined(rawRuns), base);
  const out: Run[] = [];
  let lineStart = true;
  runs.forEach((r) => {
    const font = { ...base, ...rec(r.font), ...patch };
    const content = r.type === "latex" ? normalizeMathLatex(r.latex) : String(r.text ?? "");
    const lines = content.split(/\r?\n/);
    lines.forEach((line, i) => {
      const last = i === lines.length - 1;
      if (line === "" && !lineStart && out.length) {
        // an empty piece inside a started paragraph: end that paragraph on its last run instead of an empty run
        if (!last) { out[out.length - 1].options.breakLine = true; lineStart = true; }
        return;
      }
      if (line === "" && last && lines.length > 1) return; // text ended with "\n": the next run opens the paragraph
      const options = { ...runOptions(font), ...(lineStart ? para : {}), ...(last ? {} : { breakLine: true }) };
      out.push({ text: line, options });
      lineStart = !last;
    });
  });
  if (!out.length) out.push({ text: "", options: { ...runOptions(base), ...para } });
  return out;
}

const H_ALIGN: Record<string, string> = { left: "left", center: "center", right: "right", justify: "justify" };
const V_ALIGN: Record<string, string> = { top: "top", middle: "middle", center: "middle", bottom: "bottom" };

/** addText arguments for a `text` element (position added by the caller). */
export function textElement(el: any): { runs: Run[]; options: Record<string, any> } {
  const font = rec(el.font);
  const al = rec(el.alignment);
  const align = H_ALIGN[String(al.horizontal)] ?? "left";
  const size = num(font.size) ?? 16;
  const lh = num(font.line_height ?? font.lineHeight) ?? 1.1;
  // align stays on the text box only: pptxgenjs starts a new paragraph whenever a run's align differs from the
  // previous run's, so per-run align would split mixed-format lines
  const runs = toRuns(arr(el.runs).length ? arr(el.runs) : [{ text: String(el.text ?? "") }], font,
    Object.prototype.hasOwnProperty.call(el, "text") ? el.text : undefined);
  return {
    runs,
    options: {
      margin: 0, valign: V_ALIGN[String(al.vertical)] ?? "top", align, wrap: true, fit: "none",
      lineSpacing: pt(size * lh), isTextBox: true,
    },
  };
}

/** addText arguments for a `text-list` element: one paragraph per item with bullet or number markers. */
export function textListElement(el: any): { runs: Run[]; options: Record<string, any> } {
  const font = rec(el.font);
  const size = num(font.size) ?? 16;
  const lh = num(font.line_height ?? font.lineHeight) ?? 1.2;
  const marker = str(el.marker) ?? "bullet";
  const gap = Math.max(0, num(el.gap) ?? 0);
  const markerGap = num(el.marker_gap ?? el.markerGap);
  const indent = pt(markerGap != null ? markerGap + size * 0.6 : 24);
  const runs: Run[] = [];
  arr(el.items).forEach((item, i) => {
    const r = rec(item);
    const raw = Array.isArray(item) ? item : arr(r.runs).length ? arr(r.runs)
      : Object.prototype.hasOwnProperty.call(r, "text") ? [{ text: String(r.text ?? ""), font: r.font }] : [{ text: String(item ?? "") }];
    const bullet = marker === "none" ? false : marker === "number" ? { type: "number", indent } : { indent };
    const para: Record<string, any> = { bullet, ...(i > 0 && gap ? { paraSpaceBefore: pt(gap) } : {}) };
    const itemRuns = toRuns(raw, font, undefined, para);
    if (i < arr(el.items).length - 1) itemRuns[itemRuns.length - 1].options.breakLine = true;
    runs.push(...itemRuns);
  });
  return {
    runs: runs.length ? runs : [{ text: "", options: runOptions(font) }],
    options: { margin: 0, valign: "top", wrap: true, fit: "none", lineSpacing: pt(size * lh), isTextBox: true },
  };
}

function cellBorders(cell: any): any[] {
  const borders = rec(cell.borders);
  if (Object.keys(borders).length) {
    return ["top", "right", "bottom", "left"].map((side) => {
      const s = rec(borders[side]);
      const c = parseColor(s.color);
      const w = Math.max(0, num(s.width) ?? 0);
      return c && w > 0 ? { type: arr(s.dash).length ? "dash" : "solid", pt: pt(w), color: c.hex } : { type: "none" };
    });
  }
  const s = rec(cell.stroke);
  const c = parseColor(s.color ?? "#D1D5DB");
  const w = num(s.width) ?? 1;
  const b = c && w > 0 ? { type: "solid", pt: pt(w), color: c.hex } : { type: "none" };
  return [b, b, b, b];
}

const luminance = (hex?: string | null) => {
  if (!hex) return null;
  const v = parseInt(hex, 16);
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => {
    const n = c / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};

/** The renderer's readableTableTextColor: body text keeps >= 3:1 contrast with its cell fill. */
function readable(color: string, fill: string | null): string {
  const tl = luminance(color), fl = luminance(fill);
  if (tl == null || fl == null) return color;
  const contrast = (Math.max(tl, fl) + 0.05) / (Math.min(tl, fl) + 0.05);
  return contrast >= 3 ? color : fl > 0.5 ? "111827" : "FFFFFF";
}

/** addTable rows for a `table` element: header row from `columns` (bold unless the cell sets bold), body rows. */
export function tableRows(el: any): { rows: any[][]; cols: number } {
  const columns = arr(el.columns);
  const rows = (columns.length ? [columns, ...arr(el.rows).map(arr)] : arr(el.rows).map(arr)).filter(Array.isArray);
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const tableFont = { family: "Arial", size: 18, color: "#111827", ...rec(el.font) };
  const out = rows.map((row, ri) => Array.from({ length: cols }, (_, ci) => {
    const raw = row[ci];
    const cell = typeof raw === "string" || typeof raw === "number" ? { runs: [{ text: String(raw) }] } : rec(raw);
    const header = ri === 0;
    const firstRunFont = rec(rec(arr(cell.runs)[0]).font);
    const explicitBold = "bold" in rec(cell.font) || "bold" in firstRunFont;
    const fill = parseColor(rec(cell.color ?? cell.fill).color);
    const align = str(cell.alignment) ?? str(rec(cell.alignment).horizontal) ?? "left";
    const font = { ...tableFont, ...rec(cell.font) };
    const patch = header && !explicitBold ? { bold: true } : {};
    const runs = toRuns(arr(cell.runs).length ? arr(cell.runs) : [{ text: String(cell.text ?? "") }], font, undefined, {}, patch)
      .map((r) => ({ text: r.text, options: { ...r.options, ...(header ? {} : { color: readable(r.options.color, fill?.hex ?? null) }) } }));
    return {
      text: runs,
      options: {
        ...(fill ? { fill: { color: fill.hex, ...(fill.alpha < 1 ? { transparency: transparency(fill.alpha) } : {}) } } : {}),
        border: cellBorders(cell),
        align: H_ALIGN[align] ?? "left",
        valign: "middle",
        margin: [4 / 96, 6 / 96, 4 / 96, 6 / 96],
      },
    };
  }));
  return { rows: out, cols };
}
