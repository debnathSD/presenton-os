// Template v2 tree walker: absolute geometry, reading order, groups, element paths.
// Shared by both directions of the Presenton adapter. Pure; never mutates the ui.

export const CONTENT_TYPES = new Set(["text", "text-list", "table", "chart", "image", "infographic", "math"]);
const CANVAS = { w: 1280, h: 720 };

/** "components.2.elements.0.children.1.child" -> the element (or undefined). */
export function resolvePath(ui, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[/^\d+$/.test(k) ? Number(k) : k]), ui);
}

/** Is this leaf content (not decoration)? */
export function isContent(el) {
  if (!CONTENT_TYPES.has(el.type)) return false;
  if (el.decorative === true) return false;
  return true;
}

/**
 * Walk a slide ui and return content leaves in reading order.
 * Each leaf: { el, path, box: {x, y, w, h}, group: string|null, componentId, depth }.
 * Also returns `skipped`: counts of non-content leaves by reason (for reports).
 */
export function walkSlide(ui) {
  const skipped = {};
  const skip = (reason) => (skipped[reason] = (skipped[reason] ?? 0) + 1);

  // Build a unit tree: { box, leaf?, children?, ordered? }
  function node(el, path, ox, oy, group, componentId, flowPos) {
    const pos = flowPos ?? el.position ?? { x: 0, y: 0 };
    const x = ox + (pos.x ?? 0);
    const y = oy + (pos.y ?? 0);
    const w = el.size?.width ?? 0;
    const h = el.size?.height ?? 0;
    switch (el.type) {
      case "group": {
        const g = path; // innermost group = one visual region (a card)
        const kids = (el.children ?? []).map((c, i) => node(c, `${path}.children.${i}`, x, y, g, componentId));
        return unit(kids, false);
      }
      case "container": {
        const pad = typeof el.padding === "number" ? el.padding : 0;
        return unit(el.child ? [node(el.child, `${path}.child`, x + pad, y + pad, group, componentId)] : [], false);
      }
      case "flex": case "list-view": case "grid": case "grid-view": {
        const flows = flowPositions(el);
        // Flow order is visual order for row/column flow: keep index order.
        return unit((el.children ?? []).map((c, i) => node(c, `${path}.children.${i}`, x, y, group, componentId, flows[i])), true);
      }
      default: {
        if (!isContent(el)) { skip(el.decorative ? `decorative_${el.type}` : `non_content_${el.type}`); return null; }
        return { box: { x, y, w, h }, leaf: { el, path, box: { x, y, w, h }, group, componentId } };
      }
    }
  }

  const roots = [];
  (ui.components ?? []).forEach((comp, ci) => {
    const ox = comp.position?.x ?? 0;
    const oy = comp.position?.y ?? 0;
    const kids = (comp.elements ?? []).map((el, i) => node(el, `components.${ci}.elements.${i}`, ox, oy, null, comp.id));
    const u = unit(kids, false);
    if (u) roots.push(u);
  });
  (ui.elements ?? []).forEach((el, i) => {
    const n = node(el, `elements.${i}`, 0, 0, null, null);
    if (n) roots.push(n);
  });

  const leaves = [];
  (function emit(units) {
    for (const u of units) {
      if (u.leaf) leaves.push(u.leaf);
      else emit(u.ordered ? u.children : xyCut(u.children));
    }
  })(xyCut(roots));
  return { leaves, skipped };
}

function unit(children, ordered) {
  const kids = children.filter(Boolean);
  if (!kids.length) return null;
  const x0 = Math.min(...kids.map((k) => k.box.x));
  const y0 = Math.min(...kids.map((k) => k.box.y));
  const x1 = Math.max(...kids.map((k) => k.box.x + k.box.w));
  const y1 = Math.max(...kids.map((k) => k.box.y + k.box.h));
  return { box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, children: kids, ordered };
}

/** Approximate flex/grid flow (the renderer lays these children out by flow, not by position). */
function flowPositions(el) {
  const kids = el.children ?? [];
  const W = el.size?.width ?? CANVAS.w;
  const H = el.size?.height ?? CANVAS.h;
  if (el.type === "grid" || el.type === "grid-view") {
    const cols = Math.max(1, Number(el.columns) || 1);
    const rows = Math.max(1, Number(el.rows) || Math.ceil(kids.length / cols));
    const cg = el.column_gap ?? el.gap ?? 0;
    const rg = el.row_gap ?? el.gap ?? 0;
    const cw = (W - (cols - 1) * cg) / cols;
    const rh = (H - (rows - 1) * rg) / rows;
    return kids.map((_, i) => ({ x: (i % cols) * (cw + cg), y: Math.floor(i / cols) * (rh + rg) }));
  }
  const row = el.direction === "row";
  const gap = (row ? el.column_gap : el.row_gap) ?? el.gap ?? 0;
  const cross = (row ? el.row_gap : el.column_gap) ?? el.gap ?? 0;
  let main = 0;
  let line = 0;
  let lineSize = 0;
  return kids.map((c) => {
    const cw = c.size?.width ?? 0;
    const ch = c.size?.height ?? 0;
    const along = row ? cw : ch;
    const limit = row ? W : H;
    if (el.wrap && main > 0 && main + along > limit + 0.5) { line += lineSize + cross; main = 0; lineSize = 0; }
    const p = row ? { x: main, y: line } : { x: line, y: main };
    main += along + gap;
    lineSize = Math.max(lineSize, row ? ch : cw);
    return p;
  });
}

/** Recursive XY-cut: split by horizontal whitespace bands, then by vertical gutters; fall back to (top, left). */
export function xyCut(units) {
  const list = units.filter(Boolean);
  if (list.length <= 1) return list;
  for (const axis of ["y", "x"]) {
    const size = axis === "y" ? "h" : "w";
    const sorted = [...list].sort((a, b) => a.box[axis] - b.box[axis] || a.box[axis === "y" ? "x" : "y"] - b.box[axis === "y" ? "x" : "y"]);
    const parts = [];
    let cur = [];
    let end = -Infinity;
    for (const u of sorted) {
      if (cur.length && u.box[axis] >= end - 1) { parts.push(cur); cur = []; }
      cur.push(u);
      end = Math.max(end, u.box[axis] + u.box[size]);
    }
    parts.push(cur);
    if (parts.length > 1) return parts.flatMap(xyCut);
  }
  return [...list].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}
