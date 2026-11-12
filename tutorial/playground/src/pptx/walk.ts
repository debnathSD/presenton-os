// Flattens a Template v2 `ui` tree into positioned leaves in paint order (z-order), the same order and geometry
// Presenton's HTML renderer (servers/nextjs/lib/template-v2-json-to-html.ts) uses:
//   - root `elements`, then `components` (each component is a group at its position);
//   - group children are absolute inside the group; container children are absolute when they have a position,
//     otherwise placed by the container's alignment inside its padding;
//   - flex/grid children are laid out by Presenton's own flow layout (components/slide-editor/layout/flowLayout,
//     the module the renderer and the canvas editor use);
//   - rotations nest: every ancestor rotation is kept (innermost last) and applied around that ancestor's center.
// Layout elements that carry a fill or stroke (container cards, mostly) are emitted as a "box" leaf before their
// children, so decorative backgrounds keep their place in the z-order.

import { layoutFlowChildren, intrinsicFlowSize } from "@/components/slide-editor/layout/flowLayout";
import { displayText, rawFont, rawTextContent } from "@/components/slide-editor/text/template-v2-text";
import { arr, num, rec, str, intersect } from "./units";
import type { Box } from "./units";

export type Rot = { angle: number; cx: number; cy: number };

export type Leaf = {
  kind: "element" | "box";
  el: any;
  /** Unrotated absolute box in slide px. */
  box: Box;
  /** Ancestor rotations, outermost first. */
  xf: Rot[];
  /** Clip rectangle from a clipping ancestor (unrotated absolute px), if any. */
  clip: Box | null;
  /** For vectors: absolute points (unrotated). */
  points?: Array<{ x: number; y: number }>;
};

const LAYOUT_TYPES = new Set(["group", "container", "flex", "list-view", "grid", "grid-view"]);
const ELEMENT_TYPES = new Set(["text", "container", "image", "text-list", "table", "vector", "svg", "chart",
  "infographic", "flex", "grid", "group", "list-view", "grid-view", "math"]);

export function isComponent(item: any): boolean {
  const t = str(item?.type);
  return Array.isArray(item?.elements) && (!t || !ELEMENT_TYPES.has(t));
}

// ---- boxes (ports of the renderer's readBox / htmlElementSize) --------------------------------------------------

function vectorSourcePoints(item: any) {
  return arr(item.points).map(rec)
    .map((p) => ({ x: num(p.x), y: num(p.y) }))
    .filter((p): p is { x: number; y: number } => p.x != null && p.y != null);
}

export function pointsBox(item: any, points: Array<{ x: number; y: number }>): Box {
  if (!points.length) return { x: 0, y: 0, w: 1, h: 1 };
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const sw = Math.max(1, num(rec(item.stroke).width) ?? 1);
  return { x: minX, y: minY, w: Math.max(Math.max(...xs) - minX, sw, 1), h: Math.max(Math.max(...ys) - minY, sw, 1) };
}

type RBox = { x: number; y: number; width?: number; height?: number };

function readBox(item: any, fallback?: { width: number; height: number }): RBox {
  if (str(item.type) === "vector") {
    const b = pointsBox(item, vectorSourcePoints(item));
    return { x: b.x, y: b.y, width: b.w, height: b.h };
  }
  const p = rec(item.position), s = rec(item.size);
  return { x: num(p.x) ?? 0, y: num(p.y) ?? 0, width: num(s.width) ?? fallback?.width, height: num(s.height) ?? fallback?.height };
}

function childrenBounds(children: any[]): { width: number; height: number } {
  return children.reduce((b, c) => {
    const box = readBox(rec(c));
    return { width: Math.max(b.width, box.x + (box.width ?? 1)), height: Math.max(b.height, box.y + (box.height ?? 1)) };
  }, { width: 1, height: 1 });
}

function layoutChildren(item: any): any[] {
  const children = arr(item.children);
  if (children.length) return children;
  const elements = arr(item.elements);
  if (elements.length) return elements;
  const child = rec(item.item);
  const count = Math.max(0, Math.floor(num(item.count) ?? 0));
  return Object.keys(child).length && count ? Array.from({ length: count }, () => child) : [];
}

function elementSize(item: any, fallback?: { width: number; height: number }): { width: number; height: number } {
  const box = readBox(item);
  if (box.width != null && box.height != null) return { width: box.width, height: box.height };
  const type = str(item.type);
  if (type === "group") return childrenBounds(arr(item.children).map(rec));
  if (type === "container") {
    const pad = rec(item.padding);
    const child = Object.keys(rec(item.child)).length ? rec(item.child) : null;
    const cs = child ? elementSize(child, fallback) : fallback;
    if (cs) {
      return {
        width: cs.width + (num(pad.left) ?? 0) + (num(pad.right) ?? 0),
        height: cs.height + (num(pad.top) ?? 0) + (num(pad.bottom) ?? 0),
      };
    }
  }
  if (type === "text") {
    if (fallback) return fallback;
    const font = rawFont(item);
    const text = displayText(rawTextContent(item));
    const longest = text.split(/\r?\n/).reduce((m, l) => Math.max(m, l.length), 0);
    const width = Math.max(font.size, longest * font.size * (font.bold ? 0.56 : 0.5));
    const perLine = Math.max(1, Math.floor(width / Math.max(1, font.size * 0.5)));
    const lines = text.split(/\r?\n/).reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
    return { width, height: Math.max(font.size * font.lineHeight, lines * font.size * font.lineHeight) };
  }
  if (type === "flex" || type === "grid" || type === "list-view" || type === "grid-view") {
    return fallback ?? intrinsicFlowSize(item, layoutChildren(item).map(rec), deps);
  }
  return fallback ?? { width: box.width ?? 1, height: box.height ?? 1 };
}

function completeBox(item: any) {
  const box = readBox(item);
  const fb = elementSize(item);
  return { x: box.x, y: box.y, width: box.width ?? fb.width, height: box.height ?? fb.height };
}

const deps = {
  elementBox: completeBox,
  elementSize,
  isManualPositioned: (e: any) => e?.__presenton_manual_position === true,
};

/** Does a container clip its child? (port of the renderer's containerOverflowStyle) */
function containerClips(item: any, child: any | null): boolean {
  const overflow = str(item.overflow);
  if (overflow === "hidden") return true;
  if (overflow === "visible") return false;
  if (item.clip === true) return true;
  if (!child || str(child.type) !== "image" || !Object.keys(rec(child.position)).length) return false;
  if (str(child.clip_path ?? child.clipPath)) return true;
  const cb = readBox(item), kb = readBox(child);
  if (cb.width == null || cb.height == null) return false;
  const e = 0.01;
  return kb.x < -e || kb.y < -e || (kb.width != null && kb.x + kb.width > cb.width + e)
    || (kb.height != null && kb.y + kb.height > cb.height + e);
}

const hasBoxStyle = (item: any) =>
  !!(str(rec(item.fill).color) || str(rec(item.stroke).color) || num(rec(item.stroke).width) != null);

// ---- walk -------------------------------------------------------------------------------------------------------

type Ctx = { xf: Rot[]; clip: Box | null };
type Place = { x: number; y: number; size?: { width: number; height: number } };

/** All drawable leaves of a slide, in paint order. */
export function flattenSlide(ui: any): Leaf[] {
  const out: Leaf[] = [];
  const root = rec(ui);
  for (const item of [...arr(root.elements), ...arr(root.components)]) visit(rec(item), 0, 0, null, { xf: [], clip: null }, out);
  return out;
}

function visit(item: any, ox: number, oy: number, flow: Place | null, ctx: Ctx, out: Leaf[]): void {
  if (isComponent(item)) {
    const { size: _size, elements, ...rest } = item;
    visit({ ...rest, type: "group", children: elements }, ox, oy, flow, ctx, out);
    return;
  }
  const type = str(item.type) ?? (Array.isArray(item.children) ? "group" : Object.keys(rec(item.child)).length ? "container" : "");
  if (!type) return;

  if (type === "vector") {
    const src = vectorSourcePoints(item);
    if (src.length < 2) return;
    const b = pointsBox(item, src);
    // absolute mode: points are relative to the parent; flow mode: the polygon is placed at the flow position
    const dx = flow ? flow.x - b.x : ox, dy = flow ? flow.y - b.y : oy;
    const pts = src.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    out.push({ kind: "element", el: item, box: { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, xf: ctx.xf, clip: ctx.clip, points: pts });
    return;
  }

  // absolute mode: own position inside the parent; flow mode: the position the flow layout assigned
  const x = flow ? flow.x : ox + (num(rec(item.position).x) ?? 0);
  const y = flow ? flow.y : oy + (num(rec(item.position).y) ?? 0);

  if (!LAYOUT_TYPES.has(type)) {
    const s = flow?.size ?? elementSize(item);
    out.push({ kind: "element", el: item, box: { x, y, w: s.width, h: s.height }, xf: ctx.xf, clip: ctx.clip });
    return;
  }

  // layout elements: frame box, optional decoration, then children in a (possibly rotated) frame
  let size: { width: number; height: number };
  if (type === "group") size = flow?.size ?? (() => { const b = readBox(item, childrenBounds(arr(item.children).map(rec))); return { width: b.width ?? 1, height: b.height ?? 1 }; })();
  else { const b = completeBox(item); size = flow?.size ?? { width: b.width, height: b.height }; }
  const frame: Box = { x, y, w: size.width, h: size.height };
  if (hasBoxStyle(item)) out.push({ kind: "box", el: item, box: frame, xf: ctx.xf, clip: ctx.clip });

  const rotation = num(item.rotation) ?? 0;
  const inner: Ctx = {
    xf: rotation ? [...ctx.xf, { angle: rotation, cx: frame.x + frame.w / 2, cy: frame.y + frame.h / 2 }] : ctx.xf,
    clip: ctx.clip,
  };

  if (type === "group") {
    for (const c of arr(item.children)) visit(rec(c), frame.x, frame.y, null, inner, out);
    return;
  }

  if (type === "container") {
    const child = Object.keys(rec(item.child)).length ? rec(item.child) : null;
    if (!child) return;
    if (containerClips(item, child)) inner.clip = inner.clip ? intersect(inner.clip, frame) ?? frame : frame;
    if (Object.keys(rec(child.position)).length) {
      visit(child, frame.x, frame.y, null, inner, out);
      return;
    }
    const pad = rec(item.padding);
    const pl = num(pad.left) ?? 0, pr = num(pad.right) ?? 0, pt = num(pad.top) ?? 0, pb = num(pad.bottom) ?? 0;
    const cs = elementSize(child);
    const al = rec(item.alignment);
    const h = str(al.horizontal), v = str(al.vertical);
    const fx = h === "center" ? 0.5 : h === "right" ? 1 : 0;
    const fy = v === "middle" || v === "center" ? 0.5 : v === "bottom" ? 1 : 0;
    const availW = frame.w - pl - pr, availH = frame.h - pt - pb;
    visit(child, 0, 0, { x: frame.x + pl + (availW - cs.width) * fx, y: frame.y + pt + (availH - cs.height) * fy }, inner, out);
    return;
  }

  // flex / grid
  const kids = layoutChildren(item).map(rec);
  const laid = layoutFlowChildren(item, kids, { x: 0, y: 0, width: frame.w, height: frame.h }, deps);
  for (const { child, box, layoutManaged } of laid) {
    if (!box) { visit(child, frame.x, frame.y, null, inner, out); continue; }
    visit(child, 0, 0, {
      x: frame.x + box.x, y: frame.y + box.y,
      ...(layoutManaged ? { size: { width: box.width, height: box.height } } : {}),
    }, inner, out);
  }
}

// ---- transforms -------------------------------------------------------------------------------------------------

export type Placement = { x: number; y: number; w: number; h: number; rotate: number };

/** Final position of an unrotated absolute box with its own rotation and its ancestors' rotations applied. */
export function place(box: Box, ownRotation: number, xf: Rot[]): Placement {
  let cx = box.x + box.w / 2, cy = box.y + box.h / 2, angle = ownRotation;
  for (let i = xf.length - 1; i >= 0; i--) {
    const r = xf[i];
    const a = (r.angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const dx = cx - r.cx, dy = cy - r.cy;
    cx = r.cx + dx * cos - dy * sin;
    cy = r.cy + dx * sin + dy * cos;
    angle += r.angle;
  }
  angle = ((angle % 360) + 360) % 360;
  return { x: cx - box.w / 2, y: cy - box.h / 2, w: box.w, h: box.h, rotate: Math.round(angle * 100) / 100 };
}
