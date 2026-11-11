// UDM -> Presenton deck: fill an existing Template v2 layout's editable slots.
// Slot lookup order: (1) provenance in ext["presenton.slides"].slot, (2) next free slot of the same block type in
// reading order, (3) any compatible slot. Unchanged slots are left byte-identical (patch semantics).

import { walkSlide, resolvePath } from "./walk.mjs";
import { presentonToUdm, NS } from "./from-presenton.mjs";
import { clone, plain, flattenItems, staticData, stableStringify, blockAtoms } from "../../core/udm-runtime.mjs";

const SLOT_TYPES = {
  heading: ["text"], paragraph: ["text"], quote: ["text"], callout: ["text"], code: ["text"], math: ["math", "text"],
  list: ["text-list"], table: ["table", "chart"], chart: ["chart"], image: ["image"], diagram: ["infographic"],
};
const isNum = (c) => String(c).trim() !== "" && Number.isFinite(Number(c));
/** A table whose first column is labels and every other cell a number can refill a chart slot. */
const chartShaped = (d) => d && d.columns.length >= 2 && d.rows.length > 0 && d.rows.every((r) => r.slice(1).every(isNum));
function fits(b, el, udm) {
  if (!el || !SLOT_TYPES[b.type]?.includes(el.type)) return false;
  return !(b.type === "table" && el.type === "chart" && !chartShaped(staticData(udm, b.bindingId)));
}
/** Exact shape match between a table block and a table/chart slot (used before positional matching). */
function sameShape(b, el, udm) {
  const d = staticData(udm, b.bindingId);
  if (!d) return false;
  if (el.type === "table") return (el.columns ?? []).length === d.columns.length && (el.rows ?? []).length === d.rows.length;
  if (el.type === "chart") return chartShaped(d) && (el.categories ?? []).length === d.rows.length && (el.series ?? []).length === d.columns.length - 1;
  return false;
}

/** Content of a block, without ids/ext/group/role, with its data resolved: equal key = nothing to write. */
function contentKey(block, udm) {
  const { id, ext, group, role, bindingId, ...rest } = block;
  return stableStringify({ ...rest, data: staticData(udm, bindingId) ?? null });
}

/** Base model of a layout (its own content read as UDM), cached per layout object. */
const baseCache = new WeakMap();
function baseOf(layout, templateId) {
  if (!baseCache.has(layout)) baseCache.set(layout, presentonToUdm({ slides: [{ layout: layout.id, layout_group: templateId, ui: layout }] }));
  return baseCache.get(layout);
}

/** Deterministic layout choice when a section carries no layout provenance (e.g. it came from a document). */
export function chooseLayout(section, layouts, templateId) {
  const want = countTypes(section.blocks);
  let best = null;
  layouts.forEach((layout, i) => {
    const base = baseOf(layout, templateId).udm.sections[0];
    const have = countTypes(base.blocks);
    let score = 0;
    for (const t of new Set([...Object.keys(want), ...Object.keys(have)])) {
      const d = (have[t] ?? 0) - (want[t] ?? 0);
      const hard = ["chart", "table", "diagram"].includes(t);
      score -= d < 0 ? -d * (hard ? 10 : 3) : d * (hard ? 10 : 1); // missing slots cost more than spare ones
    }
    if (Boolean(section.title) !== Boolean(base.title)) score -= 2;
    if (!best || score > best.score) best = { score, layout, i };
  });
  return best.layout;
}
const countTypes = (blocks) => blocks.reduce((m, b) => ((m[b.type === "heading" ? "paragraph" : b.type] = (m[b.type === "heading" ? "paragraph" : b.type] ?? 0) + 1), m), {});

/**
 * @param {import('../../core/udm.ts').Udm} udm  (already negotiated)
 * @param {{layouts: Record<string, object[]>, defaultTemplateId?: string}} opts
 */
export function udmToPresenton(udm, opts) {
  const loss = [];
  const slides = [];
  const trace = { slides: [] };
  const deckTemplate = udm.ext?.[NS]?.templateId ?? opts.defaultTemplateId;
  for (const [index, section] of udm.sections.entries()) {
    const pe = section.ext?.[NS] ?? {};
    const templateId = pe.templateId ?? deckTemplate;
    const layouts = opts.layouts[templateId] ?? [];
    const layout = (pe.layoutId && layouts.find((l) => l.id === pe.layoutId)) || chooseLayout(section, layouts, templateId);
    const ui = clone(layout);
    const base = baseOf(layout, templateId);
    const baseSec = base.udm.sections[0];
    const baseBySlot = new Map(baseSec.blocks.map((b) => [b.ext[NS].slot, b]));
    const { leaves } = walkSlide(ui);
    const free = leaves.map((l) => l.path);
    const used = new Set();
    const tr = { written: [], unchanged: [], unmapped: [] };
    trace.slides.push(tr);
    const take = (slot) => { used.add(slot); };
    const path = (b) => `${section.id}/${b.id}`;

    // Title.
    const blocks = [...section.blocks];
    const titleSlot = (pe.titleSlot && resolvePath(ui, pe.titleSlot)?.type === "text") ? pe.titleSlot : baseSec.ext[NS].titleSlot;
    if (section.title !== undefined) {
      if (titleSlot) {
        take(titleSlot);
        if (section.title !== baseSec.title) { writeText(resolvePath(ui, titleSlot), [{ text: section.title }]); tr.written.push(titleSlot); }
        else tr.unchanged.push(titleSlot);
      } else blocks.unshift({ id: `blk_${section.id.slice(4)}_title`, type: "heading", level: 1, text: [{ text: section.title }] });
    } else if (titleSlot) { take(titleSlot); blankSlot(resolvePath(ui, titleSlot)); tr.unmapped.push(titleSlot); loss.push({ code: "slot_unmapped", path: section.id, detail: titleSlot }); }

    // Pass 1: provenance.
    const plan = new Map();
    for (const b of blocks) {
      const slot = b.ext?.[NS]?.slot;
      const el = slot && !used.has(slot) ? resolvePath(ui, slot) : undefined;
      if (fits(b, el, udm)) { plan.set(b, slot); take(slot); }
    }
    // Pass 1b: tables by exact shape (a chart that a target degraded to a table finds its chart slot again).
    for (const b of blocks) {
      if (plan.has(b) || b.type !== "table") continue;
      const slot = free.find((p) => !used.has(p) && fits(b, resolvePath(ui, p), udm) && sameShape(b, resolvePath(ui, p), udm));
      if (slot) { plan.set(b, slot); take(slot); }
    }
    // Pass 2: same block type, reading order. Pass 3: any compatible slot.
    for (const strict of [true, false]) {
      for (const b of blocks) {
        if (plan.has(b)) continue;
        const slot = free.find((p) => !used.has(p) && fits(b, resolvePath(ui, p), udm)
          && (!strict || baseBySlot.get(p)?.type === b.type)); // empty template slots only in the loose pass
        if (slot) { plan.set(b, slot); take(slot); }
      }
    }
    // Write.
    for (const b of blocks) {
      const slot = plan.get(b);
      if (!slot) { loss.push({ code: "no_slot", path: path(b), detail: `${b.type} has no free ${SLOT_TYPES[b.type]?.join("/") ?? "?"} slot in ${layout.id}`, droppedText: blockAtoms(b, udm).join(" ") || undefined }); continue; }
      const baseBlock = baseBySlot.get(slot);
      if (baseBlock && baseBlock.type !== b.type) loss.push({ code: "block_retyped", path: path(b), detail: `${b.type} placed in a ${baseBlock.type} slot` });
      if (baseBlock && contentKey(b, udm) === contentKey(baseBlock, base.udm)) { tr.unchanged.push(slot); continue; } // keep original runs/styling
      tr.written.push(slot);
      const el = resolvePath(ui, slot);
      writeBlock(el, b, udm, loss, path(b));
    }
    for (const p of free) {
      if (used.has(p) || !baseBySlot.has(p)) continue; // never touch slots that were empty in the layout
      // no block for this slot: blank text/list/chart/table so template sample data never leaks; images and
      // infographics keep the template's asset/data
      blankSlot(resolvePath(ui, p));
      tr.unmapped.push(p);
      loss.push({ code: "slot_unmapped", path: section.id, detail: p });
    }
    slides.push({ index, layout_group: templateId, layout: layout.id, ui, speaker_note: section.notes ? plain(section.notes) : "",
      ...(section.summary ? { outline: section.summary } : {}), ...(pe.slideId ? { id: pe.slideId } : {}) });
  }
  return { native: { templateId: deckTemplate, ...(udm.title ? { title: udm.title } : {}), slides }, loss, trace };
}

function fontOf(el) { return clone(el.runs?.[0]?.font ?? el.font ?? {}); }

function runsFrom(rt, tpl, elFont = {}) {
  const runs = rt.map((s) => {
    const m = new Set(s.marks ?? []);
    if (m.has("math")) return { type: "latex", latex: s.text, display_mode: false, font: clone(tpl) };
    const font = clone(tpl);
    font.bold = Boolean(elFont.bold) || m.has("bold");
    font.italic = Boolean(elFont.italic) || m.has("italic");
    font.underline = Boolean(elFont.underline) || m.has("underline");
    return { text: s.text, font };
  });
  return runs.length ? runs : [{ text: " ", font: clone(tpl) }];
}

function writeText(el, rt, loss, p) {
  const absorbed = ["bold", "italic", "underline"].filter((m) => el.font?.[m] && rt.some((s) => s.marks?.includes(m)));
  if (absorbed.length && loss) loss.push({ code: "mark_absorbed_by_slot_style", path: p, detail: absorbed.join(",") });
  el.runs = runsFrom(rt, fontOf(el), el.font);
}

function writeBlock(el, b, udm, loss, p) {
  switch (b.type) {
    case "heading": case "paragraph": case "callout": case "quote": {
      if (el.type === "math") { el.latex = plain(b.text); break; }
      writeText(el, b.text, loss, p);
      break;
    }
    case "code": writeText(el, [{ text: b.code }]); break;
    case "math": if (el.type === "math") el.latex = b.latex; else writeText(el, [{ text: b.latex, marks: ["math"] }]); break;
    case "list": {
      const tpl = clone(el.items?.[0]?.[0]?.font ?? el.font ?? {});
      el.items = flattenItems(b.items).map((it) => runsFrom(it.text, tpl, el.font));
      break;
    }
    case "table": {
      const d = staticData(udm, b.bindingId);
      if (!d) { loss.push({ code: "live_table_unbound", path: p }); break; }
      if (el.type === "chart") {
        el.categories = d.rows.map((r) => r[0]);
        el.series = d.columns.slice(1).map((name, j) => ({ name, values: d.rows.map((r) => Number(r[j + 1])) }));
        loss.push({ code: "table_as_chart", path: p, detail: `kept chart_type ${el.chart_type}`, ...(d.columns[0] ? { droppedText: d.columns[0] } : {}) });
        if (b.caption) loss.push({ code: "caption_dropped", path: p, droppedText: plain(b.caption) });
        break;
      }
      const cell = (tplCell, text) => ({ ...clone(tplCell ?? {}), runs: [{ text, font: clone(tplCell?.runs?.[0]?.font ?? tplCell?.font ?? {}) }] });
      const cols = el.columns ?? [];
      const rows = el.rows ?? [];
      el.columns = d.columns.map((c, i) => cell(cols[i] ?? cols.at(-1), c));
      el.rows = d.rows.map((r, ri) => r.map((c, ci) => cell(rows[ri]?.[ci] ?? rows[0]?.[ci] ?? rows.at(-1)?.at(-1), c)));
      if (b.caption) loss.push({ code: "caption_dropped", path: p, droppedText: plain(b.caption) });
      break;
    }
    case "chart": {
      const d = staticData(udm, b.bindingId);
      el.chart_type = b.chartType;
      if (d) { el.categories = [...d.categories]; el.series = d.series.map((s) => ({ name: s.name, values: [...s.values] })); }
      else loss.push({ code: "live_chart_unbound", path: p });
      if (b.title !== undefined) el.title = b.title; else delete el.title;
      if (b.axes?.x) el.x_axis_title = b.axes.x;
      if (b.axes?.y) el.y_axis_title = b.axes.y;
      if (b.caption) el.source = plain(b.caption);
      break;
    }
    case "image":
      if (b.url) el.data = b.url;
      if (b.prompt) el.prompt = b.prompt;
      if (b.caption) loss.push({ code: "caption_dropped", path: p, droppedText: plain(b.caption) });
      break;
    case "diagram": {
      const extData = b.ext?.[NS]?.data ?? {};
      const orig = el.data ?? {};
      const data = { ...orig, ...extData };
      if (b.range) Object.assign(data, { min_value: b.range.min, max_value: b.range.max, value: b.range.value });
      if (b.items) {
        data.items = b.items.map((it, i) => {
          const o = { ...(orig.items?.[i] ?? orig.items?.at?.(-1) ?? {}) };
          for (const k of ["heading", "description", "label", "focus", "id"]) { if (it[k] !== undefined) o[k] = it[k]; else delete o[k]; }
          if (it.parentId !== undefined) o.parent_id = it.parentId;
          if (it.value !== undefined) o.value = it.value; else delete o.value;
          return o;
        });
      }
      el.data = data;
      break;
    }
    default:
      loss.push({ code: "unsupported_block", path: p, detail: b.type, droppedText: blockAtoms(b, udm).join(" ") });
  }
}

function blankSlot(el) {
  if (!el) return;
  if (el.type === "text") el.runs = [{ text: " ", font: fontOf(el) }];
  else if (el.type === "text-list") el.items = [];
  else if (el.type === "chart") { el.categories = []; el.series = []; }
  else if (el.type === "table") el.rows = [];
}

/** Template v2 shape checks (a subset of the Pydantic SlideElement rules) plus slot limits as warnings. */
export function validatePresenton(native) {
  const issues = [];
  const e = (path, code, message, level = "error") => issues.push({ level, code, path, message });
  const KNOWN = new Set(["text", "text-list", "table", "chart", "image", "infographic", "vector", "container", "flex", "grid", "group", "svg", "math", "list-view", "grid-view"]);
  if (!Array.isArray(native?.slides)) return [{ level: "error", code: "shape", path: "", message: "slides[] required" }];
  native.slides.forEach((s, si) => {
    if (!s.ui || !Array.isArray(s.ui.components)) return e(`slides.${si}`, "shape", "ui.components[] required");
    const visit = (el, p) => {
      if (!KNOWN.has(el?.type)) return e(p, "element_type", `unknown element type ${el?.type}`);
      if (el.type === "text") {
        if (!Array.isArray(el.runs)) return e(p, "runs", "text.runs[] required");
        el.runs.forEach((r, i) => { if (r.type !== "latex" && typeof r.text !== "string") e(`${p}.runs.${i}`, "run", "run.text must be a string"); });
        const len = el.runs.map((r) => r.text ?? r.latex ?? "").join("").length;
        if (el.max_length && len > el.max_length) e(p, "max_length", `${len} > ${el.max_length}`, "warning");
      }
      if (el.type === "text-list") {
        if (!Array.isArray(el.items) || el.items.some((i) => !Array.isArray(i))) e(p, "items", "items must be run arrays");
        else if (el.max_items && el.items.length > el.max_items) e(p, "max_items", `${el.items.length} > ${el.max_items}`, "warning");
      }
      if (el.type === "table") {
        if (!Array.isArray(el.columns) || !Array.isArray(el.rows)) e(p, "table", "columns[] and rows[] required");
        else el.rows.forEach((r, i) => { if (r.length !== el.columns.length) e(`${p}.rows.${i}`, "table_width", `${r.length} cells for ${el.columns.length} columns`); });
      }
      if (el.type === "chart") {
        if (!Array.isArray(el.categories) || !Array.isArray(el.series)) e(p, "chart", "categories[] and series[] required");
        else el.series.forEach((sr, i) => {
          if (!Array.isArray(sr.values) || sr.values.some((v) => typeof v !== "number" || Number.isNaN(v))) e(`${p}.series.${i}`, "chart_values", "values must be numbers");
          else if (sr.values.length !== el.categories.length) e(`${p}.series.${i}`, "chart_length", `${sr.values.length} values for ${el.categories.length} categories`, "warning");
        });
      }
      if (el.child) visit(el.child, `${p}.child`);
      (el.children ?? []).forEach((c, i) => visit(c, `${p}.children.${i}`));
    };
    s.ui.components.forEach((c, ci) => (c.elements ?? []).forEach((el, i) => visit(el, `slides.${si}.components.${ci}.elements.${i}`)));
    (s.ui.elements ?? []).forEach((el, i) => visit(el, `slides.${si}.elements.${i}`));
  });
  return issues;
}
