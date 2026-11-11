// Writes the committed example conversions quoted by the tutorial chapters.
//   examples/<name>/1-presenton-slide.json   before: Template v2 slide (ui) as stored in slides.ui
//   examples/<name>/2-udm.json               canonical IR
//   examples/<name>/3-tiptap.json            after: tiptap.json (validated against the real Tiptap schema)
//   examples/<name>/4-markdown.md            same UDM through the Markdown adapter
//   examples/<name>/5-loss.json              loss reports per target (negotiation + serializer)
//   examples/<name>/6-roundtrip-check.json   Tiptap -> UDM -> Presenton: is the ui byte-identical?
//   examples/<name>/7-edited-tiptap.json     the same tiptap.json after a user edit (first paragraph, chart values)
//   examples/<name>/8-edit-result.json       which Presenton slots were rewritten, with before/after content
//   examples/doc-to-slides/                  a hand-written Tiptap page (no UDM attrs) -> UDM -> Presenton layout

import fs from "node:fs";
import path from "node:path";
import { setupRegistry, HERE } from "./setup.mjs";
import { negotiate } from "../core/negotiate.mjs";
import { resolvePath } from "../adapters/presenton/walk.mjs";

const { registry, layouts } = setupRegistry();
const P = registry.get("presenton.slides");
const EXAMPLES = [
  { name: "simple-cards-with-list", templateId: "dynamic", layoutId: "center_title_cards_4771" },
  { name: "chart-and-table", templateId: "modern", layoutId: "title_description_chart_table" },
];

for (const ex of EXAMPLES) {
  const dir = path.join(HERE, "examples", ex.name);
  fs.mkdirSync(dir, { recursive: true });
  const ui = layouts[ex.templateId].find((l) => l.id === ex.layoutId);
  const deck = { templateId: ex.templateId, slides: [{ layout_group: ex.templateId, layout: ex.layoutId, ui }] };
  const { udm } = P.deserialize(deck);
  const write = (f, v) => fs.writeFileSync(path.join(dir, f), typeof v === "string" ? v : `${JSON.stringify(v, null, 2)}\n`);
  write("1-presenton-slide.json", deck);
  write("2-udm.json", udm);
  const losses = {};
  for (const id of ["tiptap", "markdown"]) {
    const { native, loss } = registry.convert(udm, id);
    const issues = registry.get(id).validateNative(native);
    if (issues.some((i) => i.level === "error")) throw new Error(`${ex.name} ${id}: ${JSON.stringify(issues)}`);
    write(id === "tiptap" ? "3-tiptap.json" : "4-markdown.md", native);
    losses[id] = loss;
  }
  write("5-loss.json", losses);
  const T = registry.get("tiptap");
  const back = T.deserialize(registry.convert(udm, "tiptap").native).udm;
  const out = P.serialize(negotiate(back, P.manifest).udm);
  write("6-roundtrip-check.json", {
    path: "Presenton ui -> UDM -> tiptap.json -> UDM -> Presenton ui",
    uiByteIdentical: JSON.stringify(out.native.slides[0].ui) === JSON.stringify(ui),
    slotsWritten: out.trace.slides[0].written.length, slotsUnchanged: out.trace.slides[0].unchanged.length, slotsUnmapped: out.trace.slides[0].unmapped.length,
  });
  // a user edit in the document editor
  const edited = structuredClone(registry.convert(udm, "tiptap").native);
  const para = edited.content.find((n) => n.type === "paragraph");
  para.content = [{ type: "text", text: "Edited in the document: " }, { type: "text", text: "traction doubled", marks: [{ type: "bold" }] }, { type: "text", text: " this year." }];
  const chart = edited.content.find((n) => n.type === "dataBlock" && n.attrs.kind === "chart");
  if (chart) chart.attrs.binding.source.data.series[0].values = chart.attrs.binding.source.data.series[0].values.map((v) => v * 2);
  write("7-edited-tiptap.json", edited);
  const after = P.serialize(negotiate(T.deserialize(edited).udm, P.manifest).udm);
  const eui = after.native.slides[0].ui;
  const show = (el) => (el.type === "text" ? el.runs.map((r) => ({ text: r.text, bold: r.font?.bold ?? false })) : el.type === "chart" ? { categories: el.categories, series: el.series } : el.type);
  write("8-edit-result.json", {
    slotsWritten: after.trace.slides[0].written.map((p) => ({ slot: p, name: resolvePath(ui, p).name, before: show(resolvePath(ui, p)), after: show(resolvePath(eui, p)) })),
    slotsUnchanged: after.trace.slides[0].unchanged.length,
    loss: after.loss,
    validation: P.validateNative(after.native),
  });
  console.log(`${ex.name}: ${udm.sections[0].blocks.length} blocks, tiptap nodes ${registry.convert(udm, "tiptap").native.content.length}`);
}

// A Tiptap page written by a person (no UDM attrs at all) becoming a Presenton slide.
{
  const dir = path.join(HERE, "examples", "doc-to-slides");
  fs.mkdirSync(dir, { recursive: true });
  const p = (text, marks) => ({ type: "paragraph", content: [{ type: "text", text, ...(marks ? { marks } : {}) }] });
  const doc = { type: "doc", content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Why we are moving to usage pricing" }] },
    p("Seat pricing stopped tracking value once customers automated their workflows."),
    { type: "bulletList", content: ["Usage aligns cost with value", "Smaller teams can start cheaper", "Expansion revenue becomes automatic"].map((t) => ({ type: "listItem", content: [p(t)] })) },
    { type: "table", content: [["Plan", "Today", "Proposed"], ["Starter", "$20/seat", "$0.02/run"], ["Team", "$45/seat", "$0.015/run"]].map((row, i) => ({
      type: "tableRow", content: row.map((c) => ({ type: i ? "tableCell" : "tableHeader", content: [p(c)] })) })) },
  ] };
  const T = registry.get("tiptap");
  const issues = T.validateNative(doc);
  const { udm, loss: dLoss } = T.deserialize(doc);
  const out = registry.convert(udm, "presenton.slides", { layouts: { general: layouts.general }, defaultTemplateId: "general" });
  const write = (f, v) => fs.writeFileSync(path.join(dir, f), `${JSON.stringify(v, null, 2)}\n`);
  write("1-tiptap-page.json", doc);
  write("2-udm.json", udm);
  write("3-presenton-slide.json", out.native);
  write("4-report.json", { tiptapSchemaIssues: issues, deserializeLoss: dLoss, chosenLayout: out.native.slides[0].layout,
    serializeLoss: out.loss, presentonValidation: registry.get("presenton.slides").validateNative(out.native) });
  console.log(`doc-to-slides: layout ${out.native.slides[0].layout}, loss ${out.loss.map((l) => l.code).join(",")}`);
}
