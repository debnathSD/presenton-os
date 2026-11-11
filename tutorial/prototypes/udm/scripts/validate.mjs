// Corpus validation: every layout of every bundled Presenton template, through every registered target adapter.
//   forward:   Presenton ui -> UDM -> negotiate -> native  (native validated by the adapter; Tiptap = real PM schema check)
//   roundtrip: ... -> native -> UDM -> Presenton ui, compared slot by slot with the original
//   edited:    Tiptap only: edit every text/list/table/chart/diagram in tiptap.json, map back, check each edit landed
// Writes out/report.json and REPORT.md. Numbers are measured, never typed in.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { setupRegistry, HERE } from "./setup.mjs";
import { negotiate } from "../core/negotiate.mjs";
import { checkUdm, udmAtoms, plain, clone } from "../core/udm-runtime.mjs";
import { walkSlide, resolvePath } from "../adapters/presenton/walk.mjs";
import { runConformance } from "../core/conformance.mjs";
import { fixtures } from "../core/fixtures.mjs";
import { Editor } from "@tiptap/core";

const { registry, layouts } = setupRegistry();
const P = registry.get("presenton.slides");
const TARGETS = registry.list().map((m) => m.id).filter((id) => id !== P.manifest.id);
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const EDIT = " [edited]";

// ---------- slot content extraction (what "survives" means, per element type) ----------
const runsText = (runs) => (runs ?? []).map((r) => (r.type === "latex" ? r.latex : r.text ?? "")).join("");
function slotContent(el) {
  switch (el?.type) {
    case "text": return runsText(el.runs);
    case "text-list": return (el.items ?? []).map(runsText);
    case "table": return { columns: (el.columns ?? []).map((c) => runsText(c.runs)), rows: (el.rows ?? []).map((r) => r.map((c) => runsText(c.runs))) };
    case "chart": return { chart_type: el.chart_type, categories: (el.categories ?? []).map(String), series: (el.series ?? []).map((s) => ({ name: String(s.name ?? ""), values: (s.values ?? []).map(Number) })) };
    case "image": return el.data ?? null;
    case "infographic": return el.data ?? null;
    case "math": return el.latex ?? "";
    default: return null;
  }
}
const KIND = { text: "text", "text-list": "list", table: "table", chart: "chart", image: "image", infographic: "infographic", math: "math" };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const textSame = (a, b) => (typeof a === "string" ? norm(a) === norm(b) : same(a, b));

/** Expected content of an original slot after the scripted Tiptap edit. */
function edited(el, isTitle) {
  const c = slotContent(el);
  switch (el.type) {
    case "text": return (isTitle ? c.trim() : c) + EDIT;
    case "text-list": return c.map((t) => t + EDIT);
    case "table": return { columns: c.columns.map((t) => t + EDIT), rows: c.rows.map((r) => r.map((t) => t + EDIT)) };
    case "chart": return { ...c, categories: c.categories.map((x) => `${x}*`), series: c.series.map((s) => ({ ...s, values: s.values.map((v) => v + 1) })) };
    default: return c;
  }
}

/** The scripted user edit, applied to tiptap.json as an editor would. */
function editTiptap(doc) {
  const d = clone(doc);
  const appendTo = (n) => { n.content = [...(n.content ?? []), { type: "text", text: EDIT }]; };
  for (const n of d.content) {
    if (n.type === "heading" && n.attrs?.udmKind === "doc-title") continue;
    if (n.type === "heading" || n.type === "paragraph") appendTo(n);
    if (n.type === "bulletList" || n.type === "orderedList") for (const li of n.content) appendTo(li.content[0]);
    if (n.type === "table") for (const row of n.content) for (const cell of row.content) appendTo(cell.content[0]);
    if (n.type === "dataBlock" && n.attrs.kind === "chart" && n.attrs.binding?.source?.type === "static") {
      const data = n.attrs.binding.source.data;
      data.categories = data.categories.map((x) => `${x}*`);
      data.series = data.series.map((s) => ({ ...s, values: s.values.map((v) => v + 1) }));
    }
  }
  return d;
}

// ---------- run ----------
const counters = () => ({ total: 0, ok: 0 });
const pct = (c) => (c.total ? Math.round((c.ok / c.total) * 10000) / 100 : null);
const failures = {};
const fail = (cat, example) => { (failures[cat] ??= { count: 0, examples: [] }).count++; if (failures[cat].examples.length < 5) failures[cat].examples.push(example); };
const time = {};
const timed = (k, fn) => { const t0 = performance.now(); const r = fn(); (time[k] ??= []).push(performance.now() - t0); return r; };

const forward = { layouts: 0, udmValid: 0, leaves: 0, blocks: 0, sectionsWithTitle: 0, blockTypes: {}, skipped: {}, roles: {}, emptyText: 0, coverage: {} };
const perTarget = Object.fromEntries(TARGETS.map((t) => [t, {
  nativeValid: counters(), udmRoundTripValid: counters(), textAtomsSurvive: counters(), negotiationLoss: {}, serializeLoss: {},
  roundTrip: { byteIdenticalUi: counters(), ...Object.fromEntries(Object.values(KIND).map((k) => [k, counters()])) },
  layoutReidentified: counters(), slotStatus: {}, editorLoads: counters(), wrongTextSlotCause: {},
}]));
const editedStats = { text: counters(), title: counters(), list: counters(), table: counters(), chart: counters(), styleKept: counters(),
  perRunHighlightKept: counters(), maxLengthWarnings: 0 };
const perTemplate = {};

for (const [templateId, list] of Object.entries(layouts)) {
  const tstat = perTemplate[templateId] = { layouts: list.length, tiptapValid: 0, markdownValid: 0, tiptapTextRoundTrip: counters(), editedTextLanded: counters() };
  for (const layout of list) {
    const where = `${templateId}/${layout.id}`;
    forward.layouts++;
    const deck = { templateId, slides: [{ layout_group: templateId, layout: layout.id, ui: layout }] };
    const { udm, loss: fLoss } = timed("presenton->udm", () => P.deserialize(deck));
    const issues = checkUdm(udm);
    if (issues.length) fail("udm_invalid", { where, issue: issues[0] }); else forward.udmValid++;
    for (const l of fLoss) fail(`forward:${l.code}`, { where, detail: l.detail });
    const sec = udm.sections[0];
    if (sec.title) forward.sectionsWithTitle++;
    for (const b of sec.blocks) {
      forward.blocks++;
      forward.blockTypes[b.type] = (forward.blockTypes[b.type] ?? 0) + 1;
      if (b.role) forward.roles[b.role] = (forward.roles[b.role] ?? 0) + 1;
    }
    // forward coverage: every non-empty content leaf is represented (by slot) in the UDM
    const { leaves, skipped } = walkSlide(layout);
    for (const [k, v] of Object.entries(skipped)) forward.skipped[k] = (forward.skipped[k] ?? 0) + v;
    forward.leaves += leaves.length;
    const slots = new Set(sec.blocks.map((b) => b.ext["presenton.slides"].slot));
    if (sec.ext["presenton.slides"].titleSlot) slots.add(sec.ext["presenton.slides"].titleSlot);
    for (const leaf of leaves) {
      const k = KIND[leaf.el.type];
      const c = (forward.coverage[k] ??= counters());
      const empty = leaf.el.type === "text" && !runsText(leaf.el.runs).trim();
      if (empty) { forward.emptyText++; continue; }
      c.total++;
      if (slots.has(leaf.path)) c.ok++; else fail("forward_leaf_missing", { where, path: leaf.path, type: leaf.el.type });
    }

    for (const target of TARGETS) {
      const A = registry.get(target);
      const st = perTarget[target];
      const n = timed(`negotiate(${target})`, () => negotiate(udm, A.manifest));
      for (const l of n.loss) st.negotiationLoss[l.code] = (st.negotiationLoss[l.code] ?? 0) + 1;
      let s;
      try { s = timed(`udm->${target}`, () => A.serialize(n.udm)); } catch (e) { fail(`${target}:serialize_threw`, { where, error: e.message }); continue; }
      for (const l of s.loss) st.serializeLoss[l.code] = (st.serializeLoss[l.code] ?? 0) + 1;
      const v = timed(`validate(${target})`, () => A.validateNative(s.native)).filter((i) => i.level === "error");
      st.nativeValid.total++;
      if (v.length) fail(`${target}:native_invalid`, { where, issue: v[0] }); else st.nativeValid.ok++;
      if (!v.length && target === "tiptap") tstat.tiptapValid++;
      if (!v.length && target === "markdown") tstat.markdownValid++;

      if (!A.deserialize) { // write-only target: every text atom must appear verbatim in the output
        const out = norm(s.native);
        for (const a of udmAtoms(udm)) {
          st.textAtomsSurvive.total++;
          if (out.includes(norm(a))) st.textAtomsSurvive.ok++; else fail(`${target}:text_atom_missing_in_output`, { where, atom: a.slice(0, 80) });
        }
        continue;
      }
      if (A.extensions) { // load into a real headless Tiptap Editor with content checking on
        st.editorLoads.total++;
        let contentError = null;
        const ed = timed(`editor-load(${target})`, () => new Editor({ element: null, extensions: A.extensions, content: s.native, enableContentCheck: true,
          onContentError: ({ error }) => { contentError = error.message; } }));
        const same = JSON.stringify(ed.getJSON()) === JSON.stringify(A.schema.nodeFromJSON(s.native).toJSON());
        ed.destroy();
        if (!contentError && same) st.editorLoads.ok++; else fail(`${target}:editor_load`, { where, issue: contentError ?? "getJSON() differs" });
      }
      const r = timed(`${target}->udm`, () => A.deserialize(s.native));
      st.udmRoundTripValid.total++;
      const rIssues = checkUdm(r.udm);
      if (rIssues.length) fail(`${target}:roundtrip_udm_invalid`, { where, issue: rIssues[0] }); else st.udmRoundTripValid.ok++;
      const rText = norm(udmAtoms(r.udm).join(" \u0001 "));
      for (const a of udmAtoms(udm)) {
        st.textAtomsSurvive.total++;
        if (rText.includes(norm(a))) st.textAtomsSurvive.ok++; else fail(`${target}:text_atom_lost`, { where, atom: a.slice(0, 80) });
      }

      // back into Presenton. With provenance (tiptap) the layout comes from ext; without it, the user applies it to
      // the same layout (catalog = [layout]) and slots are filled by type in reading order.
      const hasProv = Boolean(r.udm.sections[0]?.ext?.["presenton.slides"]);
      const opts = hasProv ? {} : { layouts: { [templateId]: [layout] }, defaultTemplateId: templateId };
      const back = timed(`udm->presenton(${target})`, () => {
        const np = negotiate(r.udm, P.manifest);
        return P.serialize(np.udm, opts);
      });
      const ui = back.native.slides[0]?.ui;
      const tr = back.trace.slides[0];
      const carried = new Set([...tr.written, ...tr.unchanged]);
      st.roundTrip.byteIdenticalUi.total++;
      if (same(ui, layout)) st.roundTrip.byteIdenticalUi.ok++;
      for (const leaf of leaves) {
        const k = KIND[leaf.el.type];
        if (leaf.el.type === "text" && !runsText(leaf.el.runs).trim()) continue;
        const c = st.roundTrip[k];
        c.total++;
        // OK = same content AND the slot was refilled from a block that came back from the target
        // (a slot nobody mapped keeps the template's content; that is "untouched", not "survived").
        const status = carried.has(leaf.path) ? "carried" : tr.unmapped.includes(leaf.path) ? "unmapped" : "untouched";
        st.slotStatus[status] = (st.slotStatus[status] ?? 0) + 1;
        const ok = status === "carried" && textSame(slotContent(leaf.el), slotContent(resolvePath(ui, leaf.path)));
        if (ok) c.ok++; else fail(`${target}:roundtrip_${k}_${status === "carried" ? "changed" : status}`, { where, path: leaf.path, name: leaf.el.name });
        if (!ok && k === "text") {
          // positional targets: did negotiation turn a non-text block into a paragraph that then took a text slot?
          const cause = n.loss.some((l) => l.code === "block_degraded" || l.code === "caption_to_paragraph") ? "layout had degraded blocks" : "no degradation (order or heading/paragraph classification)";
          st.wrongTextSlotCause[cause] = (st.wrongTextSlotCause[cause] ?? 0) + 1;
        }
        if (k === "text" && target === "tiptap") { tstat.tiptapTextRoundTrip.total++; if (ok) tstat.tiptapTextRoundTrip.ok++; }
      }
      // can the deterministic chooser find the original layout again from content alone?
      if (!hasProv) {
        const stripped = clone(r.udm);
        const np = negotiate(stripped, P.manifest);
        const chosen = P.serialize(np.udm, { layouts: { [templateId]: list }, defaultTemplateId: templateId }).native.slides[0]?.layout;
        st.layoutReidentified.total++;
        if (chosen === layout.id) st.layoutReidentified.ok++;
      }

      // scripted edit (Tiptap page profile only)
      if (target === "tiptap") {
        const ed = timed("edit+tiptap->presenton", () => {
          const r2 = A.deserialize(editTiptap(s.native));
          return P.serialize(negotiate(r2.udm, P.manifest).udm);
        });
        editedStats.maxLengthWarnings += P.validateNative(ed.native).filter((i) => i.code === "max_length").length;
        const eui = ed.native.slides[0].ui;
        const titleSlot = sec.ext["presenton.slides"].titleSlot;
        for (const leaf of leaves) {
          const k = { text: "text", "text-list": "list", table: "table", chart: "chart" }[leaf.el.type];
          if (!k || (leaf.el.type === "text" && !runsText(leaf.el.runs).trim())) continue;
          const isTitle = leaf.path === titleSlot;
          const bucket = isTitle ? editedStats.title : editedStats[k];
          bucket.total++;
          const got = resolvePath(eui, leaf.path);
          const ok = textSame(edited(leaf.el, isTitle), slotContent(got));
          if (ok) bucket.ok++; else fail(`edited:${k}_not_landed`, { where, path: leaf.path, want: JSON.stringify(edited(leaf.el, isTitle)).slice(0, 120), got: JSON.stringify(slotContent(got)).slice(0, 120) });
          if (k === "text") { tstat.editedTextLanded.total++; if (ok) tstat.editedTextLanded.ok++; }
          if (k === "text" && ok) {
            // base style = the slot's first run (or element) font; per-run highlights = runs that differ from it
            const sig = (f) => JSON.stringify(["family", "size", "color"].map((x) => f?.[x]));
            const eff = (r, e) => sig(r.font ?? e.font);
            editedStats.styleKept.total++;
            if (eff(leaf.el.runs[0] ?? {}, leaf.el) === eff(got.runs[0] ?? {}, got)) editedStats.styleKept.ok++;
            if (new Set(leaf.el.runs.map((r) => eff(r, leaf.el))).size > 1) {
              editedStats.perRunHighlightKept.total++;
              if (new Set(got.runs.map((r) => eff(r, got))).size > 1) editedStats.perRunHighlightKept.ok++;
              else fail("edited:per_run_highlight_flattened", { where, path: leaf.path, name: leaf.el.name });
            }
          }
        }
      }
    }
  }
}

// ---------- negative controls: the Tiptap validator must reject known-bad documents ----------
const T0 = registry.get("tiptap");
const txt = (t, marks) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const negativeControls = Object.entries({
  "unknown node type": { type: "doc", content: [{ type: "chart", attrs: {} }] },
  "text directly in doc": { type: "doc", content: [txt("loose")] },
  "listItem starting with a heading": { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "heading", attrs: { level: 1 }, content: [txt("x")] }] }] }] },
  "attr not in schema (silently dropped by Tiptap)": { type: "doc", content: [{ type: "paragraph", attrs: { bogus: 1 }, content: [txt("x")] }] },
  "code mark combined with bold": { type: "doc", content: [{ type: "paragraph", content: [txt("x", [{ type: "code" }, { type: "bold" }])] }] },
  "empty text node": { type: "doc", content: [{ type: "paragraph", content: [txt("")] }] },
  "heading level 9": { type: "doc", content: [{ type: "heading", attrs: { level: 9 }, content: [txt("x")] }] },
}).map(([name, doc]) => ({ name, rejected: T0.validateNative(doc).some((i) => i.level === "error") }));

// ---------- conformance + core freeze ----------
const conformance = registry.list().map((m) => {
  const { results } = runConformance(registry.get(m.id), fixtures);
  return { adapter: m.id, passed: results.filter((r) => r.pass).length, total: results.length, failures: results.filter((r) => !r.pass) };
});
const coreFiles = fs.readdirSync(path.join(HERE, "core")).filter((f) => /\.(ts|mjs)$/.test(f)).sort();
const coreHash = Object.fromEntries(coreFiles.map((f) => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "core", f))).digest("hex").slice(0, 16)]));
const lockPath = path.join(HERE, "core.lock.json");
const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : null;
const coreChangedSinceFreeze = lock ? coreFiles.filter((f) => lock.files[f] !== coreHash[f]) : null;
const loc = (f) => fs.readFileSync(path.join(HERE, f), "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length;
const adapterFiles = {
  "presenton.slides": ["adapters/presenton/walk.mjs", "adapters/presenton/from-presenton.mjs", "adapters/presenton/to-presenton.mjs", "adapters/presenton/index.mjs"],
  tiptap: ["adapters/tiptap/extensions.mjs", "adapters/tiptap/to-tiptap.mjs", "adapters/tiptap/from-tiptap.mjs", "adapters/tiptap/index.mjs"],
  markdown: ["adapters/markdown.mjs"],
  ...(fs.existsSync(path.join(HERE, "adapters/plaintext.mjs")) ? { "plain-text": ["adapters/plaintext.mjs"] } : {}),
};
const linesOfCode = Object.fromEntries(Object.entries(adapterFiles).map(([k, fsx]) => [k, fsx.reduce((a, f) => a + loc(f), 0)]));
linesOfCode.core = coreFiles.reduce((a, f) => a + loc(`core/${f}`), 0);
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const coreMentions = coreFiles.filter((f) => /presenton|tiptap|markdown|prosemirror|plaintext/i.test(stripComments(fs.readFileSync(path.join(HERE, "core", f), "utf8"))));

const timing = Object.fromEntries(Object.entries(time).map(([k, arr]) => {
  const s = [...arr].sort((a, b) => a - b);
  return [k, { calls: arr.length, totalMs: +s.reduce((a, b) => a + b, 0).toFixed(1), avgMs: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3), p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(3), maxMs: +s.at(-1).toFixed(3) }];
}));

const pctTree = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v && typeof v === "object" && "total" in v && "ok" in v && Object.keys(v).length === 2 ? { ...v, pct: pct(v) } : v)));
const report = pctTree({
  environment: { node: process.version, tiptap: "3.30.5", marked: "17.0.5", templates: Object.keys(layouts).length, layouts: forward.layouts },
  forward, targets: perTarget, edited: editedStats, negativeControls, perTemplate, failureCategories: failures, conformance, timing,
  genericity: { linesOfCode, coreFiles: coreHash, coreChangedSinceFreeze, frozenAt: lock?.frozenAt ?? null, coreFilesNamingATarget: coreMentions,
    markdownImports: [...fs.readFileSync(path.join(HERE, "adapters/markdown.mjs"), "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]) },
});
fs.mkdirSync(path.join(HERE, "out"), { recursive: true });
fs.writeFileSync(path.join(HERE, "out/report.json"), JSON.stringify(report, null, 2));
if (process.argv.includes("--freeze")) fs.writeFileSync(lockPath, JSON.stringify({ frozenAt: "after markdown adapter, before plain-text adapter", files: coreHash }, null, 2) + "\n");

// ---------- console summary ----------
const line = (k, c) => c.total && console.log(`${k.padEnd(44)} ${c.ok}/${c.total}  (${pct(c)}%)`);
console.log(`layouts: ${forward.layouts}, UDM valid: ${forward.udmValid}, blocks: ${forward.blocks}`);
for (const [k, c] of Object.entries(forward.coverage)) line(`forward coverage ${k}`, c);
for (const t of TARGETS) {
  const st = perTarget[t];
  line(`[${t}] native valid`, st.nativeValid);
  line(`[${t}] round-trip UDM valid`, st.udmRoundTripValid);
  line(`[${t}] text atoms survive`, st.textAtomsSurvive);
  for (const [k, c] of Object.entries(st.roundTrip)) if (c.total) line(`[${t}] presenton round trip ${k}`, c);
  if (st.layoutReidentified.total) line(`[${t}] layout re-identified`, st.layoutReidentified);
}
for (const [k, c] of Object.entries(editedStats)) if (typeof c === "object") line(`[edited] ${k}`, c);
console.log("failure categories:", Object.fromEntries(Object.entries(failures).map(([k, v]) => [k, v.count])));
console.log("conformance:", conformance.map((c) => `${c.adapter} ${c.passed}/${c.total}`).join(", "));
console.log("lines:", linesOfCode, "core changed since freeze:", coreChangedSinceFreeze, "core naming a target:", coreMentions);

// ---------- REPORT.md (committed; every number comes from `report` above) ----------
{
  const R = report;
  const p = (c) => (c?.total ? `${c.ok}/${c.total} (${c.pct}%)` : "n/a");
  const top = (o, n = 6) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  const md = [];
  md.push("# UDM prototype: corpus report", "",
    "Generated by `npm run validate` (`scripts/validate.mjs`). Do not edit by hand. Raw data: `out/report.json` (not committed).", "",
    `Environment: Node ${R.environment.node}, Tiptap ${R.environment.tiptap}, marked ${R.environment.marked}. Corpus: ${R.environment.layouts} layouts from ${R.environment.templates} bundled templates (\`templates/*/template.json\`), one slide per layout, each layout's own sample content.`, "");
  md.push("## Headline numbers", "", "| Check | Result |", "| --- | --- |",
    `| Presenton -> UDM: valid, neutral UDM | ${R.forward.udmValid}/${R.forward.layouts} |`,
    `| Content elements represented in the UDM | ${Object.entries(R.forward.coverage).map(([k, c]) => `${k} ${p(c)}`).join("; ")} |`,
    ...TARGETS.map((t) => `| UDM -> ${t}: native output valid (${{ tiptap: "real Tiptap schema: \`getSchema()\`, \`nodeFromJSON().check()\`, dropped-attr diff", "tiptap.basic": "same, StarterKit-only schema", markdown: "re-lexes with marked; the round-trip rows below are the real test", "plain-text": "is a string" }[t] ?? "adapter validateNative"}) | ${p(R.targets[t].nativeValid)} |`),
    ...TARGETS.filter((t) => R.targets[t].editorLoads.total).map((t) => `| ${t}: loads in a headless Tiptap \`Editor\` (\`enableContentCheck: true\`, no contentError, \`getJSON()\` unchanged) | ${p(R.targets[t].editorLoads)} |`),
    ...TARGETS.map((t) => `| ${t}: text atoms surviving ${registry.get(t).deserialize ? "UDM -> native -> UDM" : "into the output"} | ${p(R.targets[t].textAtomsSurvive)} |`),
    `| Tiptap round trip Presenton -> UDM -> tiptap.json -> UDM -> Presenton: ui byte-identical | ${p(R.targets.tiptap.roundTrip.byteIdenticalUi)} |`,
    `| Tiptap edited round trip: edited text / titles / lists / tables / charts landing in the right slot | ${p(R.edited.text)} / ${p(R.edited.title)} / ${p(R.edited.list)} / ${p(R.edited.table)} / ${p(R.edited.chart)} |`,
    `| Edited slots now over the slot's \`max_length\` (warnings from \`validateNative\`; the edit adds 9 characters) | ${R.edited.maxLengthWarnings} |`,
    `| Edited slots keeping the slot's base font (family, size, color) | ${p(R.edited.styleKept)} |`,
    `| Edited text elements keeping per-run highlights (a second color/size inside one element) | ${p(R.edited.perRunHighlightKept)} |`,
    `| Tiptap validator negative controls rejected | ${R.negativeControls.filter((c) => c.rejected).length}/${R.negativeControls.length} (${R.negativeControls.map((c) => `${c.name}${c.rejected ? "" : " NOT rejected"}`).join("; ")}) |`,
    `| Conformance kit | ${R.conformance.map((c) => `${c.adapter} ${c.passed}/${c.total}`).join(", ")} |`,
    `| Core files changed after the freeze (\`core.lock.json\`) | ${R.genericity.coreChangedSinceFreeze === null ? "no freeze recorded" : R.genericity.coreChangedSinceFreeze.length ? R.genericity.coreChangedSinceFreeze.join(", ") : "none"} |`,
    `| Core files naming a target in code | ${R.genericity.coreFilesNamingATarget.length ? R.genericity.coreFilesNamingATarget.join(", ") : "none"} |`, "");

  md.push("## Forward pass: Presenton ui -> UDM", "",
    `Blocks produced: ${R.forward.blocks} (${top(R.forward.blockTypes, 10)}). Sections with a detected title: ${R.forward.sectionsWithTitle}/${R.forward.layouts}.`, "",
    `Block roles inferred from element names: ${top(R.forward.roles)}.`, "",
    `Skipped as non-content: ${top(R.forward.skipped)}. Empty text elements skipped: ${R.forward.emptyText}.`, "");

  md.push("## Round trip back into the same Presenton layout, per target", "",
    "A slot counts as surviving only if a block that came back from the target was mapped to it (by provenance or by position) and its content equals the original. Slots no block mapped to are reported as unmapped, even when the template's own content is still there.", "",
    `| Element | ${TARGETS.filter((t) => registry.get(t).deserialize).join(" | ")} |`, `| --- |${TARGETS.filter((t) => registry.get(t).deserialize).map(() => " --- |").join("")}`);
  for (const k of ["byteIdenticalUi", ...Object.values(KIND)]) {
    if (!R.targets.tiptap.roundTrip[k]?.total) continue;
    md.push(`| ${k === "byteIdenticalUi" ? "whole ui byte-identical" : k} | ${TARGETS.filter((t) => registry.get(t).deserialize).map((t) => p(R.targets[t].roundTrip[k])).join(" | ")} |`);
  }
  md.push(`| wrong text slots, by cause | ${TARGETS.filter((t) => registry.get(t).deserialize).map((t) => top(R.targets[t].wrongTextSlotCause) ).join(" | ")} |`);
  md.push(`| slot status | ${TARGETS.filter((t) => registry.get(t).deserialize).map((t) => top(R.targets[t].slotStatus)).join(" | ")} |`,
    `| layout re-identified from content alone (no provenance) | ${TARGETS.filter((t) => registry.get(t).deserialize).map((t) => (R.targets[t].layoutReidentified.total ? p(R.targets[t].layoutReidentified) : "n/a (provenance kept)")).join(" | ")} |`, "",
    "Provenance (`ext[\"presenton.slides\"]`) survives only through targets with `features.extPassThrough` (the Tiptap page profile). The others are written back positionally into the layout the user picks.", "");
  md.push("### Losses reported by negotiation and serializers (counts over the corpus)", "");
  for (const t of TARGETS) md.push(`- **${t}**: negotiation: ${top(R.targets[t].negotiationLoss, 8)}; serializer: ${top(R.targets[t].serializeLoss, 8)}.`);
  md.push("");

  md.push("## Per template", "", "| Template | Layouts | Tiptap valid | Markdown valid | Tiptap text round trip | Edited text landed |", "| --- | --- | --- | --- | --- | --- |");
  for (const [t, s] of Object.entries(R.perTemplate)) md.push(`| ${t} | ${s.layouts} | ${s.tiptapValid} | ${s.markdownValid} | ${p(s.tiptapTextRoundTrip)} | ${p(s.editedTextLanded)} |`);
  md.push("");

  md.push("## Failure categories", "");
  const cats = Object.entries(R.failureCategories).sort((a, b) => b[1].count - a[1].count);
  if (!cats.length) md.push("None.", "");
  for (const [k, v] of cats) md.push(`- **${k}**: ${v.count}. Examples: ${v.examples.slice(0, 3).map((e) => `\`${e.where}${e.name ? ` ${e.name}` : ""}${e.atom ? ` "${e.atom}"` : ""}\``).join(", ")}`);
  md.push("");

  md.push("## Conformance kit (shared fixtures in `core/fixtures.mjs`)", "");
  for (const c of R.conformance) md.push(`- ${c.adapter}: ${c.passed}/${c.total} checks passed${c.failures.length ? `; failures: ${c.failures.map((f) => `${f.fixture}: ${f.check}`).join("; ")}` : ""}.`);
  md.push("");

  md.push("## Genericity", "", "Non-blank, non-comment lines of code:", "", "| Part | Lines |", "| --- | --- |",
    ...Object.entries(R.genericity.linesOfCode).map(([k, v]) => `| ${k === "core" ? "core (UDM types, contract, registry, negotiation, conformance kit, fixtures)" : `adapter ${k}`} | ${v} |`), "",
    `The Markdown adapter imports only ${R.genericity.markdownImports.map((x) => `\`${x}\``).join(" and ")}. The core was frozen (${R.genericity.frozenAt}); files changed in core since then: ${R.genericity.coreChangedSinceFreeze?.length ? R.genericity.coreChangedSinceFreeze.join(", ") : "none"}.`, "");

  md.push("## Timing (milliseconds per layout, this machine)", "", "| Stage | Calls | Avg | p95 | Max | Total |", "| --- | --- | --- | --- | --- | --- |",
    ...Object.entries(R.timing).map(([k, v]) => `| ${k} | ${v.calls} | ${v.avgMs} | ${v.p95Ms} | ${v.maxMs} | ${v.totalMs} |`), "");
  fs.writeFileSync(path.join(HERE, "REPORT.md"), md.join("\n"));
}
