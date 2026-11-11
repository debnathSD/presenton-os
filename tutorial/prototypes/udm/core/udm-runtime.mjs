// Runtime helpers for the UDM (types live in udm.ts). Target-agnostic.

export const UDM_VERSION = "gck.artifact/1";
export const UDM_PROFILE = "udm/1.3";
export const BLOCK_TYPES = ["heading", "paragraph", "list", "callout", "quote", "divider", "code", "math",
  "chart", "metric", "table", "image", "diagram", "embed"];
export const MARKS = ["bold", "italic", "underline", "strike", "code", "link", "math"];
export const CHART_KINDS = ["bar", "horizontal_bar", "stacked_bar", "horizontal_stacked_bar", "line", "area",
  "pie", "donut", "polar_area", "scatter", "radar", "bubble"];
export const DIAGRAM_KINDS = ["progress", "gauge", "timeline", "process", "steps", "funnel", "pyramid", "cycle",
  "matrix", "hierarchy", "comparison", "other"];
export const NAMESPACE_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
export const BINDING_RE = /^b_[a-z0-9_]{1,48}$/;
const DATA_BLOCKS = new Set(["chart", "metric", "table", "embed"]);

// ---------- ids and determinism ----------

/** FNV-1a 32-bit -> base36. Deterministic short ids, no randomness, no clock. */
export function hashId(...parts) {
  let h = 0x811c9dc5;
  for (const ch of parts.join("\u0000")) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export const clone = (v) => (v === undefined ? v : structuredClone(v));

// ---------- rich text ----------

const MARK_ORDER = new Map(MARKS.map((m, i) => [m, i]));
const sameSeg = (a, b) => (a.marks ?? []).join() === (b.marks ?? []).join() && a.href === b.href
  && !a.token && !b.token && (a.cite ?? []).join() === (b.cite ?? []).join();

const INVISIBLE_ON_SPACE = new Set(["bold", "italic"]);

/** Canonical RichText: sorted marks, no empty segments, bold/italic never cover boundary whitespace,
 *  adjacent equal segments merged. */
export function normalizeRichText(rt) {
  const out = [];
  const split = [];
  for (const s of rt ?? []) {
    if (!s.token && s.text && s.marks?.length && s.marks.every((m) => INVISIBLE_ON_SPACE.has(m))) {
      const [, lead, core, trail] = s.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
      split.push({ text: lead }, { ...s, text: core }, { text: trail });
    } else split.push(s);
  }
  for (const s of split) {
    if (!s.token && !s.text) continue;
    const seg = { text: s.text };
    const marks = [...new Set(s.marks ?? [])].sort((a, b) => MARK_ORDER.get(a) - MARK_ORDER.get(b));
    if (marks.length) seg.marks = marks;
    if (s.href && marks.includes("link")) seg.href = s.href;
    if (s.token) seg.token = s.token;
    if (s.cite?.length) seg.cite = s.cite;
    const prev = out[out.length - 1];
    if (prev && sameSeg(prev, seg)) prev.text += seg.text;
    else out.push(seg);
  }
  return out;
}

export const plain = (rt) => (rt ?? []).map((s) => s.text).join("");
export const text = (str, marks) => (str ? [marks?.length ? { text: str, marks } : { text: str }] : []);
export const itemText = (it) => (Array.isArray(it) ? it : it.text);
export const itemChildren = (it) => (Array.isArray(it) ? [] : it.children ?? []);

export function flattenItems(items, depth = 0, out = []) {
  for (const it of items) {
    out.push({ text: itemText(it), depth });
    flattenItems(itemChildren(it), depth + 1, out);
  }
  return out;
}

// ---------- text atoms (used by negotiation reports and the conformance kit) ----------

/** Every human-readable string a block carries (data values are compared separately). */
export function blockAtoms(block, udm) {
  const a = [];
  const rt = (r) => r && a.push(plain(r));
  switch (block.type) {
    case "heading": case "paragraph": case "callout": rt(block.text); break;
    case "quote": rt(block.text); if (block.attribution) a.push(block.attribution); break;
    case "list": for (const it of flattenItems(block.items)) rt(it.text); break;
    case "code": a.push(block.code); break;
    case "math": a.push(block.latex); break;
    case "image": a.push(block.alt); rt(block.caption); break;
    case "diagram":
      for (const it of block.items ?? []) for (const k of ["heading", "description", "label", "focus"]) if (it[k]) a.push(it[k]);
      rt(block.caption); break;
    case "metric": a.push(block.label); break;
    case "chart": case "table": case "embed": {
      if (block.title) a.push(block.title);
      if (block.axes?.x) a.push(block.axes.x);
      if (block.axes?.y) a.push(block.axes.y);
      rt(block.caption);
      const d = staticData(udm, block.bindingId);
      if (d?.categories) a.push(...d.categories, ...d.series.map((s) => s.name));
      if (d?.columns) a.push(...d.columns, ...d.rows.flat());
      break;
    }
  }
  return a.map((s) => s.trim()).filter(Boolean);
}

export function sectionAtoms(section, udm) {
  const a = [];
  if (section.title) a.push(section.title.trim());
  if (section.summary) a.push(section.summary.trim());
  if (section.notes) a.push(plain(section.notes).trim());
  for (const b of section.blocks) a.push(...blockAtoms(b, udm));
  return a.filter(Boolean);
}

export const udmAtoms = (udm) => [...(udm.title ? [udm.title] : []), ...udm.sections.flatMap((s) => sectionAtoms(s, udm))];

export function staticData(udm, bindingId) {
  const b = bindingId && udm.bindings?.[bindingId];
  return b?.source?.type === "static" ? b.source.data : undefined;
}

// ---------- structural validation (strict on write) ----------

const ALLOWED = {
  udm: ["version", "profile", "id", "title", "language", "plannedFor", "meta", "provenance", "sections", "bindings", "assets", "sources", "ext"],
  section: ["id", "role", "level", "title", "summary", "notes", "blocks", "ext"],
  base: ["id", "type", "role", "group", "ext"],
  heading: ["level", "text"], paragraph: ["text"], list: ["ordered", "items"], callout: ["tone", "text"],
  quote: ["text", "attribution"], divider: [], code: ["language", "code"], math: ["latex"],
  chart: ["bindingId", "chartType", "title", "axes", "caption"], metric: ["bindingId", "label"],
  table: ["bindingId", "caption"], image: ["url", "prompt", "alt", "kind", "caption", "assetId"],
  diagram: ["diagramKind", "items", "range", "caption"], embed: ["bindingId", "title"],
};

/** Returns Issue[]; empty = valid, neutral UDM. */
export function checkUdm(udm) {
  const issues = [];
  const err = (path, code, message) => issues.push({ level: "error", code, path, message });
  const extOk = (ext, path) => {
    if (ext === undefined) return;
    for (const ns of Object.keys(ext)) if (!NAMESPACE_RE.test(ns)) err(path, "ext_namespace", `bad namespace "${ns}"`);
  };
  const keysOk = (obj, allowed, path) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(path, "unknown_field", `unknown field "${k}"`);
  };
  const rtOk = (rt, path) => {
    if (!Array.isArray(rt)) return err(path, "rich_text", "RichText must be an array");
    rt.forEach((s, i) => {
      if (typeof s.text !== "string") err(`${path}/${i}`, "rich_text", "segment.text must be a string");
      for (const m of s.marks ?? []) if (!MARKS.includes(m)) err(`${path}/${i}`, "mark", `unknown mark ${m}`);
    });
  };
  if (udm.version !== UDM_VERSION) err("", "version", `version must be ${UDM_VERSION}`);
  if (udm.profile !== UDM_PROFILE) err("", "profile", `profile must be ${UDM_PROFILE}`);
  if (!/^art_/.test(udm.id ?? "")) err("", "id", "artifact id must start with art_");
  if (!udm.provenance?.origin) err("", "provenance", "provenance.origin required");
  keysOk(udm, ALLOWED.udm, "");
  extOk(udm.ext, "");
  const ids = new Set();
  for (const k of Object.keys(udm.bindings ?? {})) if (!BINDING_RE.test(k)) err(`bindings/${k}`, "binding_key", "bad binding key");
  for (const s of udm.sections ?? []) {
    const sp = s.id;
    if (!/^sec_/.test(s.id ?? "")) err(sp, "id", "section id must start with sec_");
    if (ids.has(s.id)) err(sp, "dup_id", "duplicate id"); ids.add(s.id);
    keysOk(s, ALLOWED.section, sp);
    extOk(s.ext, sp);
    if (s.notes) rtOk(s.notes, `${sp}/notes`);
    for (const b of s.blocks ?? []) {
      const bp = `${sp}/${b.id}`;
      if (!/^blk_/.test(b.id ?? "")) err(bp, "id", "block id must start with blk_");
      if (ids.has(b.id)) err(bp, "dup_id", "duplicate id"); ids.add(b.id);
      if (!BLOCK_TYPES.includes(b.type)) { err(bp, "block_type", `unknown block type ${b.type}`); continue; }
      keysOk(b, [...ALLOWED.base, ...ALLOWED[b.type]], bp);
      extOk(b.ext, bp);
      if (["heading", "paragraph", "callout", "quote"].includes(b.type)) rtOk(b.text, `${bp}/text`);
      if (b.type === "heading" && ![1, 2, 3].includes(b.level)) err(bp, "heading_level", "level must be 1-3");
      if (b.type === "list") flattenItems(b.items ?? []).forEach((it, i) => rtOk(it.text, `${bp}/items/${i}`));
      if (b.type === "chart" && !CHART_KINDS.includes(b.chartType)) err(bp, "chart_kind", `unknown chart kind ${b.chartType}`);
      if (b.type === "diagram" && !DIAGRAM_KINDS.includes(b.diagramKind)) err(bp, "diagram_kind", `unknown diagram kind ${b.diagramKind}`);
      if (b.type === "image" && typeof b.alt !== "string") err(bp, "image_alt", "image.alt required");
      if (DATA_BLOCKS.has(b.type) && !udm.bindings?.[b.bindingId]) err(bp, "binding_missing", `binding ${b.bindingId} missing`);
    }
  }
  return issues;
}
