// Units and colors for the demo PPTX exporter.
// Template v2 geometry is in CSS px on a 1280x720 canvas; the deck is LAYOUT_WIDE (13.333 x 7.5 in), so 96 px = 1 in
// exactly (1280 / 96 = 13.333). Font sizes and stroke widths are CSS px too: 1 px = 0.75 pt.

export const SLIDE_W_PX = 1280;
export const SLIDE_H_PX = 720;
export const PX_PER_IN = 96;

export type Box = { x: number; y: number; w: number; h: number };

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** px -> inches (pptxgenjs positions and sizes). */
export const inch = (px: number): number => round(px / PX_PER_IN);
/** px -> points (font sizes, line widths, spacing). */
export const pt = (px: number): number => round(px * 0.75, 2);

export const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
export const rec = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
export const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type Rgba = { hex: string; alpha: number };

const NAMED: Record<string, string> = {
  white: "FFFFFF", black: "000000", red: "FF0000", green: "008000", blue: "0000FF", gray: "808080", grey: "808080",
};

/**
 * Parse a Presenton color ("#RRGGBB", "RRGGBB", "#RGB", "#RRGGBBAA", "rgb()/rgba()", a few names) into the
 * pptxgenjs form (hex without "#") plus alpha. Returns null for "transparent", "none" or anything unreadable.
 */
export function parseColor(value: unknown): Rgba | null {
  const s = str(value)?.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === "transparent" || lower === "none") return null;
  if (NAMED[lower]) return { hex: NAMED[lower], alpha: 1 };
  const h = s.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) return { hex: h.split("").map((c) => c + c).join("").toUpperCase(), alpha: 1 };
  if (/^[0-9a-f]{6}$/i.test(h)) return { hex: h.toUpperCase(), alpha: 1 };
  if (/^[0-9a-f]{8}$/i.test(h)) return { hex: h.slice(0, 6).toUpperCase(), alpha: parseInt(h.slice(6), 16) / 255 };
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = parts.slice(0, 3).map((p) => (p.endsWith("%") ? (Number(p.slice(0, -1)) / 100) * 255 : Number(p)));
    if (ch.length < 3 || ch.some((c) => !Number.isFinite(c))) return null;
    const a = parts[3] == null ? 1 : parts[3].endsWith("%") ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]);
    const hex = ch.map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, "0")).join("").toUpperCase();
    return { hex, alpha: Number.isFinite(a) ? clamp(a, 0, 1) : 1 };
  }
  return null;
}

/** Hex for pptxgenjs, or the fallback. */
export const hex = (value: unknown, fallback?: string): string | undefined => parseColor(value)?.hex ?? fallback;

/** pptxgenjs transparency (0 opaque .. 100 invisible) from one or more opacity factors in 0..1. */
export function transparency(...opacities: Array<number | null | undefined>): number {
  const o = opacities.reduce<number>((acc, v) => acc * (v == null ? 1 : clamp(v, 0, 1)), 1);
  return round((1 - o) * 100, 1);
}

/** A color blended over white (pptx chart gridlines have no alpha). */
export function blendOnWhite(hexColor: string, alpha: number): string {
  const v = parseInt(hexColor, 16);
  const mix = (c: number) => Math.round(c * alpha + 255 * (1 - alpha)).toString(16).padStart(2, "0");
  return (mix((v >> 16) & 255) + mix((v >> 8) & 255) + mix(v & 255)).toUpperCase();
}

export function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r - x > 0.01 && btm - y > 0.01 ? { x, y, w: r - x, h: btm - y } : null;
}

export const sameBox = (a: Box, b: Box, eps = 0.5) =>
  Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.w - b.w) < eps && Math.abs(a.h - b.h) < eps;
