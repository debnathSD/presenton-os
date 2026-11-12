// Vector elements and decorated boxes -> PowerPoint shapes. Rectangles and uniformly rounded rectangles become
// preset shapes (rect / roundRect), ellipses become ellipse, everything else a custom geometry (custGeom) whose
// outline is sampled exactly like Presenton's renderer (roundedPolygonPoints + sampleSmoothCurve).

import { arr, clamp, inch, num, parseColor, pt, rec, str, transparency } from "./units";
import type { Box } from "./units";

type P = { x: number; y: number };

const at = (ps: P[], i: number) => ps[((i % ps.length) + ps.length) % ps.length];
const lerp = (a: P, b: P, t: number): P => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function roundedPolygon(points: P[], radii: number[], segments = 8): P[] {
  if (points.length < 3 || !radii.length) return points;
  const out: P[] = [];
  points.forEach((p, i) => {
    const prev = at(points, i - 1), next = at(points, i + 1);
    const dp = Math.hypot(p.x - prev.x, p.y - prev.y), dn = Math.hypot(p.x - next.x, p.y - next.y);
    const r = Math.min(radii[i] ?? 0, dp / 2, dn / 2);
    if (r <= 0) { out.push(p); return; }
    const from = lerp(p, prev, r / dp), to = lerp(p, next, r / dn);
    out.push(from);
    for (let s = 1; s < segments; s++) {
      const t = s / segments;
      out.push({ x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * p.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * p.y + t * t * to.y });
    }
    out.push(to);
  });
  return out;
}

function smooth(points: P[], closed: boolean, tension: number, segments: number): P[] {
  if (points.length < 3 || tension <= 0) return points;
  const out: P[] = [];
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const p0 = closed ? at(points, i - 1) : points[Math.max(0, i - 1)];
    const p1 = at(points, i), p2 = at(points, i + 1);
    const p3 = closed ? at(points, i + 2) : points[Math.min(points.length - 1, i + 2)];
    if (i === 0) out.push(p1);
    const k = tension * 0.5;
    const t1 = { x: (p2.x - p0.x) * k, y: (p2.y - p0.y) * k }, t2 = { x: (p3.x - p1.x) * k, y: (p3.y - p1.y) * k };
    for (let s = 1; s <= segments; s++) {
      const t = s / segments, t2_ = t * t, t3 = t2_ * t;
      const h00 = 2 * t3 - 3 * t2_ + 1, h10 = t3 - 2 * t2_ + t, h01 = -2 * t3 + 3 * t2_, h11 = t3 - t2_;
      out.push({ x: h00 * p1.x + h10 * t1.x + h01 * p2.x + h11 * t2.x, y: h00 * p1.y + h10 * t1.y + h01 * p2.y + h11 * t2.y });
    }
  }
  return out;
}

export function vectorClosed(item: any, points: P[]): boolean {
  if (str(item.shape) === "ellipse") return true;
  const v = item.closed;
  if (v === false || v === "false" || v === "0") return false;
  if (v === true || v === "true" || v === "1") return true;
  return points.length > 2;
}

const isAxisRect = (ps: P[]) => {
  if (ps.length !== 4) return false;
  const xs = new Set(ps.map((p) => Math.round(p.x * 100))), ys = new Set(ps.map((p) => Math.round(p.y * 100)));
  return xs.size === 2 && ys.size === 2;
};

/** pptxgenjs fill props from a Presenton fill (+ element opacity). */
export function fillProps(fill: any, opacity?: number | null) {
  const c = parseColor(rec(fill).color);
  if (!c) return undefined;
  return { color: c.hex, transparency: transparency(c.alpha, num(rec(fill).opacity), opacity) };
}

const ARROWS: Record<string, string> = { arrow: "arrow", open: "arrow", stealth: "stealth", triangle: "triangle", circle: "oval", oval: "oval", diamond: "diamond" };

/** pptxgenjs line props from a Presenton stroke. Open paths default to a black 1px line (renderer rule). */
export function lineProps(stroke: any, opacity?: number | null, openPath = false, markers?: { start?: unknown; end?: unknown }) {
  const s = rec(stroke);
  const c = parseColor(s.color) ?? (openPath ? { hex: "000000", alpha: 1 } : null);
  const width = Math.max(0, num(s.width) ?? 1);
  if (!c || width <= 0) return undefined;
  const dash = arr(s.dash).map(num).filter((d): d is number => d != null);
  const m = (v: unknown) => ARROWS[String(rec(v).type ?? v ?? "")];
  return {
    color: c.hex, width: pt(width), transparency: transparency(c.alpha, num(s.opacity), opacity),
    ...(dash.length ? { dashType: dash[0] <= width * 1.5 ? "sysDot" : "dash" } : {}),
    ...(markers && m(markers.start) ? { beginArrowType: m(markers.start) } : {}),
    ...(markers && m(markers.end) ? { endArrowType: m(markers.end) } : {}),
  };
}

/** pptxgenjs outer shadow from a Presenton shadow. */
export function shadowProps(shadow: any) {
  const s = rec(shadow);
  if (!Object.keys(s).length) return undefined;
  const opacity = num(s.opacity) ?? 1;
  if (opacity <= 0) return undefined;
  const dx = num(s.offset_x ?? s.offsetX) ?? 0, dy = num(s.offset_y ?? s.offsetY) ?? 0;
  const c = parseColor(s.color) ?? { hex: "000000", alpha: 1 };
  return {
    type: "outer", color: c.hex, opacity: clamp(opacity * c.alpha, 0, 1), blur: pt(num(s.blur) ?? 0),
    offset: pt(Math.hypot(dx, dy)), angle: Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360),
  };
}

export type ShapeSpec = { shape: string; box: Box; options: Record<string, any> };

/** A Presenton vector (absolute points) as a pptxgenjs shape, or null when it would draw nothing. */
export function vectorShape(item: any, points: P[]): ShapeSpec | null {
  const opacity = num(item.opacity);
  const closed = vectorClosed(item, points);
  const fill = closed ? fillProps(item.fill, opacity) : undefined;
  const line = lineProps(item.stroke, opacity, !closed, { start: item.start_marker ?? rec(item.stroke).start_marker, end: item.end_marker ?? rec(item.stroke).end_marker });
  if (!fill && !line) return null;
  const common = { ...(fill ? { fill } : {}), line: line ?? { type: "none" }, ...(shadowProps(item.shadow) ? { shadow: shadowProps(item.shadow) } : {}) };

  if (str(item.shape) === "ellipse") {
    return { shape: "ellipse", box: bbox(points), options: common };
  }
  const radii = arr(item.corner_radii ?? item.cornerRadii).map(num).filter((v): v is number => v != null).slice(0, points.length).map((v) => Math.max(0, v));
  const curve = rec(item.curve);
  const smoothCurve = String(curve.type ?? "").toLowerCase() === "smooth";
  if (closed && !smoothCurve && isAxisRect(points)) {
    const b = bbox(points);
    const uniform = radii.length === 0 || radii.every((r) => Math.abs(r - radii[0]) < 0.01);
    if (uniform) {
      const r = Math.min(radii[0] ?? 0, b.w / 2, b.h / 2);
      return r > 0.01
        ? { shape: "roundRect", box: b, options: { ...common, rectRadius: inch(r) } }
        : { shape: "rect", box: b, options: common };
    }
  }
  let ps = closed ? roundedPolygon(points, radii) : points;
  if (smoothCurve) {
    ps = smooth(ps, closed, clamp(num(curve.tension) ?? 0.4, 0, 1), Math.max(1, Math.min(96, Math.round(num(curve.segments) ?? 16))));
  }
  return customGeometry(ps, closed, common);
}

function bbox(ps: P[]): Box {
  const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** custGeom with points relative to the bounding box, in inches. Degenerate (zero width/height) lines get 1px. */
export function customGeometry(ps: P[], closed: boolean, options: Record<string, any>): ShapeSpec {
  const b = bbox(ps);
  const box = { x: b.x, y: b.y, w: Math.max(b.w, 1), h: Math.max(b.h, 1) };
  const points: any[] = ps.map((p, i) => ({ x: inch(p.x - box.x), y: inch(p.y - box.y), ...(i === 0 ? { moveTo: true } : {}) }));
  if (closed) points.push({ close: true });
  return { shape: "custGeom", box, options: { ...options, points } };
}

/** The renderer's boxStyle for layout elements and containers: fill, border, radius, shadow, opacity. */
export function boxShape(item: any, box: Box): ShapeSpec | null {
  const opacity = num(item.opacity);
  const fill = fillProps(item.fill, opacity);
  const s = rec(item.stroke);
  const line = (str(s.color) || num(s.width) != null) ? lineProps({ ...s, color: s.color ?? "transparent" }, opacity) : undefined;
  if (!fill && !line) return null;
  const common = { ...(fill ? { fill } : {}), line: line ?? { type: "none" }, ...(shadowProps(item.shadow) ? { shadow: shadowProps(item.shadow) } : {}) };
  const r = rec(item.border_radius ?? item.borderRadius);
  const tl = num(r.tl) ?? 0, tr = num(r.tr) ?? tl, br = num(r.br) ?? tl, bl = num(r.bl) ?? tl;
  const max = Math.min(box.w, box.h) / 2;
  if (!tl && !tr && !br && !bl) return { shape: "rect", box, options: common };
  if (tl === tr && tr === br && br === bl) return { shape: "roundRect", box, options: { ...common, rectRadius: inch(Math.min(tl, max)) } };
  const corners = [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }];
  const sampled = roundedPolygon(corners, [tl, tr, br, bl].map((v) => Math.min(v, max)));
  const spec = customGeometry(sampled, true, common);
  return { ...spec, box };
}
