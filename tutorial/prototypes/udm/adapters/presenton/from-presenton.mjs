// Presenton deck (Template v2 `slides.ui` + speaker_note + outline) -> UDM.
// Reads `ui` (the source of truth after edits); `content` is not needed.

import { walkSlide } from "./walk.mjs";
import { hashId, normalizeRichText, plain, UDM_VERSION, UDM_PROFILE } from "../../core/udm-runtime.mjs";

export const NS = "presenton.slides";

const DIAGRAM_KIND = {
  progress_bar: "progress", gauge: "gauge",
  timeline: "timeline", roadmap: "timeline", milestone_timeline: "timeline", gantt: "timeline",
  staircase: "steps", stair_step_blocks: "steps", maturity_model: "steps",
  chevron_process: "process", supply_chain: "process", customer_journey: "process",
  conversion_funnel: "funnel", vertical_funnel: "funnel", pyramid: "pyramid",
  radial_cycle: "cycle", segmented_wheel: "cycle", diagonal_circles: "cycle",
  risk_matrix: "matrix", impact_effort_matrix: "matrix", comparison_matrix: "comparison", before_after: "comparison",
  org_chart: "hierarchy", decision_tree: "hierarchy", mind_map: "hierarchy", transformation_hub: "hierarchy",
  pillar_framework: "other",
};

const tokens = (name) => new Set(String(name ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean));
const any = (set, words) => words.some((w) => set.has(w));
const HEADING_WORDS = ["title", "heading", "headline", "header", "hero"];
const LABEL_WORDS = ["label", "caption", "tag", "badge", "marker", "footer", "page", "pagination", "metadata", "date", "index", "category", "unit", "eyebrow", "kicker"];
const KPI_WORDS = ["metric", "value", "number", "stat", "kpi", "price", "percent", "percentage", "amount", "figure", "delta"];
const SUBTITLE_WORDS = ["subtitle", "subheading", "tagline", "subheader"];

/** Template v2 runs -> RichText. Marks are deltas from the element font (base styling is the host's). */
export function runsToRichText(runs, elFont = {}) {
  return normalizeRichText((runs ?? []).map((r) => {
    if (r.type === "latex") return { text: r.latex ?? "", marks: ["math"] };
    const f = r.font ?? {};
    const marks = [];
    if (f.bold && !elFont.bold) marks.push("bold");
    if (f.italic && !elFont.italic) marks.push("italic");
    if (f.underline && !elFont.underline) marks.push("underline");
    return { text: r.text ?? "", ...(marks.length ? { marks } : {}) };
  }));
}

const fontSize = (el) => Math.max(el.font?.size ?? 0, ...(el.runs ?? []).map((r) => r.font?.size ?? 0));
const humanize = (name) => String(name ?? "").replace(/_?\d+$/, "").replace(/_/g, " ").trim();

/** Classify one text leaf: { kind: "title"|"heading"|"paragraph", role? } given slide-level stats. */
function classifyText(leaf, stats) {
  const t = tokens(leaf.el.name);
  const size = fontSize(leaf.el);
  if (any(t, LABEL_WORDS)) return { kind: "paragraph", role: "label" };
  if (any(t, KPI_WORDS) && !any(t, HEADING_WORDS)) return { kind: "paragraph", role: "kpi" };
  if (any(t, SUBTITLE_WORDS) || (any(t, HEADING_WORDS) && any(t, ["supporting", "sub", "secondary"]))) return { kind: "paragraph", role: "subtitle" };
  if (t.has("quote")) return { kind: "paragraph", role: "takeaway" };
  if (any(t, HEADING_WORDS) || (size >= 24 && size >= stats.body * 1.4)) return { kind: "heading" };
  return { kind: "paragraph" };
}

function sectionRole(layoutId) {
  const t = tokens(layoutId);
  if (any(t, ["agenda", "toc", "contents"])) return "agenda";
  if (any(t, ["closing", "thank", "thanks", "conclusion"])) return "closing";
  if (t.has("cover") || /^title_(slide|intro|page)?$|^title_slide_/.test(layoutId)) return "title";
  return "content";
}

/**
 * @param {{templateId?: string, title?: string, slides: {id?: string, layout_group?: string, layout: string,
 *          ui: object, speaker_note?: string, outline?: string}[]}} deck
 * @returns {{udm: import('../../core/udm.ts').Udm, loss: import('../../core/adapter.ts').LossEntry[], stats: object}}
 */
export function presentonToUdm(deck, { adapterVersion = "0.1.0" } = {}) {
  const loss = [];
  const bindings = {};
  const stats = { skipped: {}, emptyText: 0, leaves: 0 };
  const sections = deck.slides.map((slide, index) => {
    const slideKey = slide.id ?? `${index}:${slide.layout}`;
    const secId = `sec_${hashId("s", slideKey)}`;
    const { leaves, skipped } = walkSlide(slide.ui);
    for (const [k, v] of Object.entries(skipped)) stats.skipped[k] = (stats.skipped[k] ?? 0) + v;
    stats.leaves += leaves.length;

    const texts = leaves.filter((l) => l.el.type === "text" && plain(runsToRichText(l.el.runs)).trim());
    const sizes = texts.map((l) => fontSize(l.el)).sort((a, b) => a - b);
    const statsT = { body: sizes[Math.floor(sizes.length / 2)] ?? 16 };
    const cls = new Map(texts.map((l) => [l, classifyText(l, statsT)]));
    // Section title: the largest ungrouped heading (fallback: largest ungrouped text >= 28px that is not a label/kpi).
    const titleCand = texts.filter((l) => !l.group && cls.get(l).kind === "heading");
    const fallback = texts.filter((l) => !l.group && !cls.get(l).role && fontSize(l.el) >= 28);
    const pool = titleCand.length ? titleCand : fallback;
    const titleLeaf = pool.reduce((best, l) => (!best || fontSize(l.el) > fontSize(best.el) ? l : best), null);

    const section = { id: secId, role: sectionRole(slide.layout), blocks: [] };
    const sext = { templateId: slide.layout_group ?? deck.templateId, layoutId: slide.layout };
    if (slide.id) sext.slideId = slide.id;
    if (titleLeaf) {
      section.title = plain(runsToRichText(titleLeaf.el.runs)).trim();
      sext.titleSlot = titleLeaf.path;
    }
    if (slide.outline) section.summary = slide.outline;
    if (slide.speaker_note) section.notes = [{ text: slide.speaker_note }];
    section.ext = { [NS]: sext };

    const groupIds = new Map();
    for (const leaf of leaves) {
      if (leaf === titleLeaf) continue;
      const el = leaf.el;
      const id = `blk_${hashId("b", slideKey, leaf.path)}`;
      const ext = { [NS]: { slot: leaf.path, name: el.name ?? null, element: el.type } };
      const common = { id };
      if (leaf.group) {
        if (!groupIds.has(leaf.group)) groupIds.set(leaf.group, `grp_${hashId("g", slideKey, leaf.group)}`);
        common.group = groupIds.get(leaf.group);
      }
      let block;
      switch (el.type) {
        case "text": {
          const rt = runsToRichText(el.runs, el.font);
          if (!plain(rt).trim()) { stats.emptyText++; continue; }
          const c = cls.get(leaf);
          block = c.kind === "heading"
            ? { ...common, type: "heading", level: leaf.group ? 2 : 1, text: rt }
            : { ...common, ...(c.role ? { role: c.role } : {}), type: "paragraph", text: rt };
          break;
        }
        case "text-list":
          block = { ...common, type: "list", ordered: el.marker === "number",
            items: (el.items ?? []).map((runs) => runsToRichText(runs, el.font)) };
          break;
        case "table": {
          const key = `b_${hashId("t", slideKey, leaf.path)}`;
          const cell = (c) => plain(runsToRichText(c.runs));
          bindings[key] = { kind: "table", source: { type: "static", origin: "imported",
            data: { columns: (el.columns ?? []).map(cell), rows: (el.rows ?? []).map((r) => r.map(cell)) } } };
          block = { ...common, type: "table", bindingId: key };
          break;
        }
        case "chart": {
          const key = `b_${hashId("c", slideKey, leaf.path)}`;
          bindings[key] = { kind: "chart", source: { type: "static", origin: "imported",
            data: { categories: (el.categories ?? []).map(String),
              series: (el.series ?? []).map((s) => ({ name: String(s.name ?? ""), values: (s.values ?? []).map(Number) })) } } };
          block = { ...common, type: "chart", bindingId: key, chartType: el.chart_type ?? "bar" };
          if (el.title) block.title = el.title;
          if (el.x_axis_title || el.y_axis_title) block.axes = { ...(el.x_axis_title ? { x: el.x_axis_title } : {}), ...(el.y_axis_title ? { y: el.y_axis_title } : {}) };
          if (el.source) block.caption = [{ text: String(el.source) }];
          break;
        }
        case "image":
          block = { ...common, type: "image", alt: humanize(el.name), kind: el.is_icon ? "icon" : "photo" };
          if (el.data) block.url = el.data;
          if (el.prompt) block.prompt = el.prompt;
          break;
        case "infographic": {
          const d = el.data ?? {};
          block = { ...common, type: "diagram", diagramKind: DIAGRAM_KIND[d.type] ?? "other" };
          if ("value" in d) block.range = { min: Number(d.min_value ?? 0), max: Number(d.max_value ?? 100), value: Number(d.value) };
          if (Array.isArray(d.items)) {
            block.items = d.items.map((it) => {
              const o = {};
              for (const [from, to] of [["id", "id"], ["parent_id", "parentId"], ["heading", "heading"], ["description", "description"], ["label", "label"], ["focus", "focus"]]) {
                if (typeof it[from] === "string" && it[from]) o[to] = it[from];
                else if (typeof it[from] === "number") o[to] = String(it[from]);
              }
              if (typeof it.value === "number") o.value = it.value;
              return o;
            });
          }
          ext[NS].infographicType = d.type ?? null;
          const extra = Object.keys(d).filter((k) => !["type", "items", "value", "min_value", "max_value"].includes(k));
          if (extra.length) { ext[NS].data = Object.fromEntries(extra.map((k) => [k, d[k]])); loss.push({ code: "diagram_extra_to_ext", path: `${secId}/${id}`, detail: extra.join(",") }); }
          break;
        }
        case "math":
          block = { ...common, type: "math", latex: el.latex ?? "" };
          break;
        default:
          loss.push({ code: "unknown_element", path: `${secId}/${id}`, detail: el.type });
          continue;
      }
      block.ext = ext;
      section.blocks.push(block);
    }
    return section;
  });

  const udm = {
    version: UDM_VERSION, profile: UDM_PROFILE,
    id: `art_${hashId("a", deck.id ?? deck.templateId ?? "", ...deck.slides.map((s, i) => s.id ?? `${i}:${s.layout}`))}`,
    ...(deck.title ? { title: deck.title } : {}),
    provenance: { origin: "imported", importedFrom: { adapter: NS, adapterVersion, ...(deck.id ? { nativeRef: deck.id } : {}) } },
    sections, bindings,
    ...(deck.templateId ? { ext: { [NS]: { templateId: deck.templateId } } } : {}),
  };
  return { udm, loss, stats };
}
