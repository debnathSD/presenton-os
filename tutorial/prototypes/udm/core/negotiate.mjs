// Capability negotiation: degrade a UDM deterministically to what one manifest supports and report every loss.
// Fixed rule order (each rule documented in README "Negotiation rules"). Knows nothing about any target.

import { clone, plain, text, itemText, itemChildren, normalizeRichText, staticData, blockAtoms } from "./udm-runtime.mjs";

/** Fixed fallback chain per chart kind; `null` = no chart kind left, degrade the block. */
const CHART_FALLBACK = {
  horizontal_stacked_bar: "stacked_bar", stacked_bar: "bar", horizontal_bar: "bar", donut: "pie",
  polar_area: "pie", radar: "bar", scatter: "line", bubble: "scatter", area: "line", pie: "bar", line: "bar", bar: null,
};
const MARK_FALLBACK = { math: "code", code: null, link: null, strike: null, underline: null, bold: null, italic: null };
const TONE_LABEL = { info: "Note:", warning: "Warning:", success: "Success:" };

/** Block fallback chains: block -> replacement blocks (one step). The loop repeats until supported. */
const DEGRADE = {
  chart(b, ctx) {
    const d = staticData(ctx.udm, b.bindingId);
    const key = `${b.bindingId}_tbl`.slice(0, 50);
    if (d) {
      ctx.udm.bindings[key] = { kind: "table", source: { type: "static", origin: ctx.udm.bindings[b.bindingId].source.origin,
        data: { columns: ["", ...d.series.map((s) => s.name)],
          rows: d.categories.map((c, i) => [c, ...d.series.map((s) => fmt(s.values[i]))]) } } };
    } else ctx.udm.bindings[key] = { ...clone(ctx.udm.bindings[b.bindingId]), kind: "table" };
    const head = [b.title, b.axes?.x && `x: ${b.axes.x}`, b.axes?.y && `y: ${b.axes.y}`].filter(Boolean).join(", ");
    const caption = [...text(head), ...(head && b.caption ? text(" - ") : []), ...(b.caption ?? [])];
    return [{ ...base(b), type: "table", bindingId: key, ...(caption.length ? { caption } : {}) }];
  },
  table(b, ctx) {
    const d = staticData(ctx.udm, b.bindingId);
    const items = d ? d.rows.map((r) => text(r.map((c, i) => (d.columns[i] ? `${d.columns[i]}: ${c}` : c)).join("; "))) : [];
    return [...(b.caption ? [{ ...base(b, "_cap"), type: "paragraph", text: b.caption }] : []),
      { ...base(b), type: "list", ordered: false, items: d ? [text(d.columns.filter(Boolean).join(" | ")), ...items] : [] }];
  },
  metric(b, ctx) {
    const d = staticData(ctx.udm, b.bindingId);
    return [{ ...base(b), type: "paragraph", text: text(d ? `${b.label}: ${fmt(d.value)}` : b.label) }];
  },
  diagram(b) {
    if (b.range) return [{ ...base(b), type: "paragraph", text: text(`${b.items?.[0]?.label ?? b.diagramKind}: ${fmt(b.range.value)} (${fmt(b.range.min)} to ${fmt(b.range.max)})`) }];
    const items = (b.items ?? []).map((it) => text([it.focus, it.heading ?? it.label, it.description, it.value !== undefined ? fmt(it.value) : undefined]
      .filter((x) => x !== undefined && x !== "").join(" - ")));
    return [{ ...base(b), type: "list", ordered: ["timeline", "process", "steps", "funnel"].includes(b.diagramKind), items },
      ...(b.caption ? [{ ...base(b, "_cap"), type: "paragraph", text: b.caption }] : [])];
  },
  list(b) {
    const out = [];
    const walk = (items, depth) => items.forEach((it) => {
      out.push({ ...base(b, out.length ? `_${out.length}` : ""), type: "paragraph",
        text: [...text(b.ordered ? `${out.length + 1}. ` : `${"  ".repeat(depth)}- `), ...itemText(it)] });
      walk(itemChildren(it), depth + 1);
    });
    walk(b.items, 0);
    return out;
  },
  callout: (b, ctx) => (ctx.has("quote") ? [{ ...base(b), type: "quote", text: [{ text: `${TONE_LABEL[b.tone]} `, marks: ["bold"] }, ...b.text] }]
    : [{ ...base(b), type: "paragraph", text: [{ text: `${TONE_LABEL[b.tone]} `, marks: ["bold"] }, ...b.text] }]),
  quote: (b) => [{ ...base(b), type: "paragraph", text: [...b.text, ...text(b.attribution ? ` - ${b.attribution}` : "")] }],
  code: (b) => [{ ...base(b), type: "paragraph", text: text(b.code, ["code"]) }],
  math: (b) => [{ ...base(b), type: "paragraph", text: text(b.latex, ["math"]) }],
  heading: (b) => [{ ...base(b), type: "paragraph", text: b.text.map((s) => ({ ...s, marks: [...(s.marks ?? []), "bold"] })) }],
  image: (b) => (b.url ? [{ ...base(b), type: "paragraph", text: [{ text: b.alt || b.url, marks: ["link"], href: b.url }, ...(b.caption ?? [])] }] : []),
  embed: (b) => (b.title ? [{ ...base(b), type: "paragraph", text: text(b.title) }] : []),
  divider: () => [],
  paragraph: () => [],
};

const fmt = (n) => (typeof n === "number" ? String(Math.round(n * 1000) / 1000) : String(n ?? ""));
const base = (b, suffix = "") => {
  const o = { id: b.id + suffix };
  if (b.role) o.role = b.role;
  if (b.group) o.group = b.group;
  if (b.ext && !suffix) o.ext = b.ext;
  return o;
};

/**
 * @param {import('./udm.ts').Udm} input
 * @param {import('./adapter.ts').AdapterManifest} manifest
 * @returns {import('./adapter.ts').NegotiationResult}
 */
export function negotiate(input, manifest) {
  const udm = clone(input);
  const loss = [];
  const add = (code, path, detail, droppedText) => loss.push({ code, path, ...(detail ? { detail } : {}), ...(droppedText ? { droppedText } : {}) });
  const has = (t) => manifest.blocks.includes(t);
  const ctx = { udm, has };

  // Rule 1: ext bags. Keep own namespace; foreign namespaces only if the target can carry them.
  const extRule = (obj, path) => {
    if (!obj.ext || manifest.features.extPassThrough) return;
    const foreign = Object.keys(obj.ext).filter((ns) => ns !== manifest.id);
    if (!foreign.length) return;
    add("ext_dropped", path, foreign.join(","));
    for (const ns of foreign) delete obj.ext[ns];
    if (!Object.keys(obj.ext).length) delete obj.ext;
  };
  extRule(udm, "");

  const sections = [];
  for (const s of udm.sections) {
    extRule(s, s.id);
    // Rule 2: non-body annotations (notes, summary).
    if (!manifest.features.notes) {
      if (s.notes) { add("notes_dropped", s.id, undefined, plain(s.notes)); delete s.notes; }
      if (s.summary) { add("summary_dropped", s.id, undefined, s.summary); delete s.summary; }
    }
    // Rule 3: section titles become a leading heading/paragraph when the target has no section titles.
    if (!manifest.features.sectionTitles && s.title) {
      s.blocks.unshift({ id: `blk_${s.id.slice(4)}_title`, type: "heading", level: 1, text: text(s.title) });
      add("section_title_to_block", s.id);
      delete s.title;
    }
    // Rule 4: blocks the target lacks, by fixed fallback chains (repeat until supported or gone).
    let queue = s.blocks;
    for (let guard = 0; guard < 8 && queue.some((b) => !has(b.type)); guard++) {
      const next = [];
      for (const b of queue) {
        if (has(b.type)) { next.push(b); continue; }
        const repl = DEGRADE[b.type](b, ctx);
        const before = blockAtoms(b, udm).join(" ");
        const after = repl.map((r) => blockAtoms(r, udm).join(" ")).join(" ");
        add(repl.length ? "block_degraded" : "block_dropped", `${s.id}/${b.id}`,
          `${b.type} -> ${repl.map((r) => r.type).join("+") || "nothing"}`, repl.length ? undefined : before || undefined);
        if (repl.length && after.length < before.length * 0.5) add("text_reduced", `${s.id}/${b.id}`);
        next.push(...repl);
      }
      queue = next;
    }
    s.blocks = queue.filter((b) => has(b.type));
    // Rule 5: chart kinds.
    for (const b of s.blocks) {
      if (b.type !== "chart" || !manifest.chartKinds || manifest.chartKinds.includes(b.chartType)) continue;
      let k = b.chartType;
      while (k && !manifest.chartKinds.includes(k)) k = CHART_FALLBACK[k];
      add("chart_kind_fallback", `${s.id}/${b.id}`, `${b.chartType} -> ${k ?? "table"}`);
      if (k) b.chartType = k;
    }
    // Rule 6: marks. Rule 7: heading levels and list depth. Rule 8: groups, roles, captions.
    const marksRule = (rt, path) => normalizeRichText(rt.map((seg) => {
      if (!seg.marks) return seg;
      const marks = [];
      for (let m of seg.marks) {
        const orig = m;
        while (m && !manifest.marks.includes(m)) m = MARK_FALLBACK[m];
        if (m !== orig) add("mark_dropped", path, `${orig} -> ${m ?? "none"}${orig === "link" ? ` (${seg.href})` : ""}`);
        if (m) marks.push(m);
      }
      const out = { ...seg, marks };
      if (!marks.includes("link")) delete out.href;
      if (!marks.length) delete out.marks;
      return out;
    }));
    if (s.notes) s.notes = marksRule(s.notes, `${s.id}/notes`);
    const groups = new Set();
    const roles = new Set();
    const out = [];
    for (const b of s.blocks) {
      const p = `${s.id}/${b.id}`;
      extRule(b, p);
      if (b.text) b.text = marksRule(b.text, p);
      if (b.caption) b.caption = marksRule(b.caption, p);
      if (b.type === "list") b.items = limitDepth(b.items.map(function m(it) {
        return Array.isArray(it) ? marksRule(it, p) : { text: marksRule(it.text, p), children: it.children.map(m) };
      }), manifest.structure.maxListDepth, () => add("list_flattened", p));
      if (b.type === "heading" && b.level > manifest.structure.maxHeadingLevel) {
        add("heading_clamped", p, `${b.level} -> ${manifest.structure.maxHeadingLevel}`);
        b.level = manifest.structure.maxHeadingLevel;
      }
      if (b.group && !manifest.structure.groups) { groups.add(b.group); delete b.group; }
      if (b.role && !manifest.structure.roles) { roles.add(b.role); delete b.role; }
      out.push(b);
      if (b.caption && !manifest.features.captions) {
        if (has("paragraph")) {
          out.push({ id: `${b.id}_cap`, type: "paragraph", text: b.caption });
          add("caption_to_paragraph", p);
        } else add("caption_dropped", p, undefined, plain(b.caption));
        delete b.caption;
      }
    }
    if (!manifest.structure.roles && (s.role || s.level)) { add("section_role_dropped", s.id, [s.role, s.level].filter(Boolean).join(",")); delete s.role; delete s.level; }
    if (groups.size) add("groups_dropped", s.id, `${groups.size} group(s)`);
    if (roles.size) add("roles_dropped", s.id, [...roles].sort().join(","));
    s.blocks = out;
    // Rule 9: limits (clip characters, split sections, never pad).
    const lim = manifest.limits ?? {};
    if (lim.maxCharsPerBlock) for (const b of s.blocks) {
      if (!b.text || plain(b.text).length <= lim.maxCharsPerBlock) continue;
      const full = plain(b.text);
      b.text = clipRichText(b.text, lim.maxCharsPerBlock);
      add("text_clipped", `${s.id}/${b.id}`, `${full.length} -> ${lim.maxCharsPerBlock}`, full.slice(lim.maxCharsPerBlock));
    }
    if (lim.maxBlocksPerSection && s.blocks.length > lim.maxBlocksPerSection) {
      const chunks = [];
      for (let i = 0; i < s.blocks.length; i += lim.maxBlocksPerSection) chunks.push(s.blocks.slice(i, i + lim.maxBlocksPerSection));
      add("section_split", s.id, `${chunks.length} parts`);
      chunks.forEach((blocks, i) => sections.push(i === 0 ? { ...s, blocks } : { id: `${s.id}_${i + 1}`, title: s.title, blocks }));
    } else sections.push(s);
  }
  udm.sections = sections;
  // Drop bindings no longer referenced (definitions only; nothing user-visible is lost).
  const used = new Set(udm.sections.flatMap((s) => s.blocks.map((b) => b.bindingId).filter(Boolean)));
  for (const k of Object.keys(udm.bindings)) if (!used.has(k)) delete udm.bindings[k];
  return { udm, loss };
}

function limitDepth(items, maxDepth, onFlatten, depth = 0) {
  const out = [];
  for (const it of items) {
    if (Array.isArray(it)) { out.push(it); continue; }
    if (depth + 1 >= maxDepth) {
      onFlatten();
      out.push(it.text, ...limitDepth(it.children, maxDepth, onFlatten, depth));
    } else out.push(it.children.length ? { text: it.text, children: limitDepth(it.children, maxDepth, onFlatten, depth + 1) } : it.text);
  }
  return out;
}

function clipRichText(rt, max) {
  const out = [];
  let left = max;
  for (const s of rt) {
    if (left <= 0) break;
    out.push({ ...s, text: s.text.slice(0, left) });
    left -= s.text.length;
  }
  return out;
}
