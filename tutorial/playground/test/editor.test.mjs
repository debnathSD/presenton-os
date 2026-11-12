// Editor tests (happy-dom): every sample deck's converted tiptap.json loads into the playground editor with
// enableContentCheck and no content error, getJSON() deep-equals the input, chart data edits write node attrs
// (by transaction and through the "Edit data" dialog), invalid content is reported instead of wiping the doc.
// Run with `npm test`.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { Window } from "happy-dom";
import { PLAYGROUND, ASSETS, common } from "../scripts/esbuild-shared.mjs";

// ---------- DOM globals (before the bundle is imported) ----------

const window = new Window({ url: "https://example.test/presenton-os/playground/", width: 1200, height: 900 });
const g = globalThis;
const GLOBALS = [
  "window", "document", "Node", "Element", "HTMLElement", "HTMLDialogElement", "HTMLInputElement", "HTMLButtonElement",
  "HTMLCanvasElement", "Text", "Range", "Selection", "DocumentFragment", "MutationObserver", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "Event", "KeyboardEvent", "MouseEvent", "InputEvent", "FocusEvent",
  "CustomEvent", "DOMParser", "ClipboardEvent", "DragEvent", "matchMedia",
];
for (const k of GLOBALS) {
  if (window[k] === undefined) continue;
  const v = typeof window[k] === "function" && !/^[A-Z]/.test(k) ? window[k].bind(window) : window[k];
  Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
}
Object.defineProperty(g, "navigator", { value: window.navigator, configurable: true, writable: true });
// No IntersectionObserver global: the chart view then draws on a microtask (happy-dom's observer never intersects).

const outfile = path.join(PLAYGROUND, "test/.build/editor.mjs");
await esbuild.build({ ...common, entryPoints: [path.join(PLAYGROUND, "test/editor-entry.ts")], outfile, platform: "node", minify: false });
const E = await import(pathToFileURL(outfile).href);
const bundleText = fs.readFileSync(outfile, "utf8");

const BASE = "https://example.test/presenton-os/assets/playground/";
E.setAssetsRoot(BASE);
const index = JSON.parse(fs.readFileSync(path.join(ASSETS, "data/index.json"), "utf8"));
const template = (id) => E.hydrateTemplate(JSON.parse(fs.readFileSync(path.join(ASSETS, `data/${id}.json`), "utf8")), BASE);
const convert = (id) => E.udmToTiptap(E.deckToUdm(E.sampleDeck(template(id))).udm).doc;
const clone = (v) => JSON.parse(JSON.stringify(v));
/** The adapter writes sparse attrs; Tiptap's getJSON() lists every attr. Drop attrs equal to the schema default. */
const sparse = (schema, v) => {
  if (Array.isArray(v)) return v.map((x) => sparse(schema, x));
  if (!v || typeof v !== "object") return v;
  const spec = (v.type && (schema.nodes[v.type] ?? schema.marks[v.type])?.spec.attrs) || {};
  return Object.fromEntries(Object.entries(v).flatMap(([k, x]) => {
    if (k !== "attrs" || !x || typeof x !== "object") return [[k, sparse(schema, x)]];
    const kept = Object.entries(x).filter(([n, y]) => JSON.stringify(y) !== JSON.stringify(spec[n]?.default ?? null));
    return kept.length ? [[k, Object.fromEntries(kept.map(([n, y]) => [n, sparse(schema, y)]))]] : [];
  }));
};
/** getJSON() equals `input`: exactly the schema-normalised input, and the same doc once default-valued attrs are dropped. */
function assertSameDoc(editor, actual, input, msg) {
  assert.deepEqual(clone(actual), clone(editor.schema.nodeFromJSON(input).toJSON()), `${msg} (normalised)`);
  assert.deepEqual(sparse(editor.schema, clone(actual)), sparse(editor.schema, clone(input)), `${msg} (sparse)`);
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A Chart.js stand-in: records every chart created. */
function fakeChart() {
  const made = [];
  class Chart {
    constructor(canvas, config) { this.canvas = canvas; this.config = config; this.destroyed = false; made.push(this); }
    destroy() { this.destroyed = true; }
  }
  return { made, load: () => Promise.resolve(Chart) };
}

function mount(initial, opts = {}) {
  const root = document.createElement("div");
  const bar = document.createElement("div");
  const host = document.createElement("div");
  root.append(bar, host);
  document.body.append(root);
  const errors = [];
  const chart = fakeChart();
  const handle = E.createEditor(host, bar, initial, { loadChart: chart.load, onContentError: (e) => errors.push(e), ...opts });
  return { handle, errors, bar, host, chart, cleanup: () => { handle.destroy(); root.remove(); } };
}

const findNodes = (doc, pred) => {
  const out = [];
  doc.descendants((n, pos) => { if (pred(n)) out.push({ node: n, pos }); });
  return out;
};

test("bundle holds one Tiptap core and never eval", () => {
  assert.equal(bundleText.split("var Editor = class").length - 1, 1, "one @tiptap/core Editor class");
  assert.ok(!/\beval\(|new Function\(/.test(bundleText.replace(/\/\/.*$/gm, "")), "no eval / new Function");
});

test("editor schema is the adapter schema (node views and placeholder do not change it)", () => {
  const { handle, cleanup } = mount();
  const shape = (s) => ({
    nodes: Object.fromEntries(Object.entries(s.nodes).map(([k, t]) => [k, {
      attrs: Object.fromEntries(Object.entries(t.spec.attrs ?? {}).map(([a, v]) => [a, v.default ?? null])),
      content: t.spec.content ?? "", group: t.spec.group ?? "", atom: Boolean(t.spec.atom), inline: Boolean(t.spec.inline) }])),
    marks: Object.keys(s.marks),
  });
  assert.deepEqual(shape(handle.editor.schema), shape(E.getSchema(E.tiptapExtensions())));
  cleanup();
});

for (const { id } of index) {
  test(`${id}: converted doc loads with no content error and getJSON() equals the input`, async () => {
    const doc = convert(id);
    const input = clone(doc);
    const { handle, errors, host, chart, cleanup } = mount(doc);
    await tick();
    assert.deepEqual(errors, [], "no content error");
    assertSameDoc(handle.editor, handle.getJSON(), input, "getJSON() deep-equals the converted doc");
    assert.deepEqual(E.tiptapToUdm(handle.getJSON()).udm, E.tiptapToUdm(input).udm, "same UDM as the converted doc");
    assert.deepEqual(doc, input, "input not mutated");

    // Node views rendered for every atom; charts drawn with the (fake) Chart.js.
    const blocks = input.content.filter((n) => n.type === "dataBlock");
    assert.equal(host.querySelectorAll("figure.udm-datablock").length, blocks.length);
    const charts = blocks.filter((n) => n.attrs.kind === "chart" && (!n.attrs.binding?.source || n.attrs.binding.source.type === "static"));
    await tick();
    assert.equal(chart.made.length, charts.length, "one Chart.js instance per chart");
    for (const c of chart.made) assert.ok(c.config.data.labels.length > 0 && c.config.data.datasets.length > 0);
    const images = input.content.filter((n) => n.type === "image");
    assert.equal(host.querySelectorAll("figure.udm-image").length, images.length);
    for (const img of host.querySelectorAll("figure.udm-image img")) assert.ok(img.hasAttribute("alt"));

    // setJSON of the same doc is a load, not an edit: no change callback, still equal.
    let changed = 0;
    handle.onChange(() => changed++);
    assert.equal(handle.setJSON(input), true);
    assert.equal(changed, 0);
    assertSameDoc(handle.editor, handle.getJSON(), input, "after setJSON");
    cleanup();
  });
}

test("chart data edit by transaction updates the dataBlock attrs (and the round trip keeps it)", async () => {
  const id = index.map((t) => t.id).find((tid) => convert(tid).content.some((n) => n.type === "dataBlock" && n.attrs.kind === "chart"));
  assert.ok(id, "a sample deck with a chart");
  const { handle, errors, chart, cleanup } = mount(convert(id));
  await tick();
  const ed = handle.editor;
  const [{ node, pos }] = findNodes(ed.state.doc, (n) => n.type.name === "dataBlock" && n.attrs.kind === "chart");
  const before = E.readChartData(node.attrs);
  const data = { categories: ["North", "South", "East"], series: [{ name: "Units", values: [3, 1.5, 4] }] };
  let changed = 0;
  handle.onChange(() => changed++);
  assert.ok(E.setNodeAttrs(ed, pos, E.withChartData(node.attrs, data, { chartType: "line", title: "Units by region" })));
  await tick();
  const after = ed.state.doc.nodeAt(pos);
  assert.notDeepEqual(before, data);
  assert.deepEqual(E.readChartData(after.attrs), data);
  assert.deepEqual(after.attrs.binding.source.data, data);
  assert.equal(after.attrs.block.chartType, "line");
  assert.equal(after.attrs.block.title, "Units by region");
  assert.equal(after.attrs.bindingId, node.attrs.bindingId, "binding id kept");
  assert.equal(changed, 1);
  assert.deepEqual(errors, []);
  // The node view redrew with the new data.
  const last = chart.made.at(-1);
  assert.deepEqual(last.config.data.labels, data.categories);
  assert.equal(last.config.type, "line");
  // UDM sees the new data.
  const { udm } = E.tiptapToUdm(handle.getJSON());
  assert.deepEqual(udm.bindings[node.attrs.bindingId].source.data, data);
  // Undo restores the old data.
  ed.commands.undo();
  assert.deepEqual(E.readChartData(ed.state.doc.nodeAt(pos).attrs), before);
  cleanup();
});

test("Edit data dialog edits a cell and writes back through a transaction", async () => {
  const { handle, host, cleanup } = mount();
  const ed = handle.editor;
  ed.commands.insertContent({ type: "dataBlock", attrs: E.newChartAttrs(ed) });
  await tick();
  const [{ pos }] = findNodes(ed.state.doc, (n) => n.type.name === "dataBlock");
  const btn = host.querySelector('[data-action="edit-chart"]');
  assert.ok(btn && !btn.disabled);
  btn.click();
  const dialog = document.querySelector("dialog.udm-dialog");
  assert.ok(dialog, "dialog opened");
  assert.ok(dialog.getAttribute("aria-labelledby"));
  const cell = dialog.querySelector('[data-cell="1:0"]');
  cell.value = "99";
  cell.dispatchEvent(new window.Event("input", { bubbles: true }));
  const cat = dialog.querySelector('[data-category="0"]');
  cat.value = "Q1 2026";
  cat.dispatchEvent(new window.Event("input", { bubbles: true }));
  dialog.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  assert.ok(!dialog.isConnected, "dialog closed after save");
  const d = E.readChartData(ed.state.doc.nodeAt(pos).attrs);
  assert.equal(d.series[0].values[1], 99);
  assert.equal(d.categories[0], "Q1 2026");

  // A non-number is refused with a message and nothing is written.
  host.querySelector('[data-action="edit-chart"]').click();
  const dlg2 = document.querySelector("dialog.udm-dialog");
  const c2 = dlg2.querySelector('[data-cell="0:0"]');
  c2.value = "abc";
  c2.dispatchEvent(new window.Event("input", { bubbles: true }));
  dlg2.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  assert.ok(dlg2.isConnected, "dialog stays open");
  assert.match(dlg2.querySelector(".udm-dialog__error").textContent, /not a number/);
  assert.equal(c2.getAttribute("aria-invalid"), "true");
  dlg2.querySelector('[data-action="cancel"]').click();
  assert.ok(!dlg2.isConnected);
  assert.equal(E.readChartData(ed.state.doc.nodeAt(pos).attrs).series[0].values[0], 12);
  cleanup();
});

test("invalid content is reported, never silently replaces the document", async () => {
  const good = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep me" }] }] };
  const bad = { type: "doc", content: [{ type: "noSuchNode" }] };
  const { handle, errors, cleanup } = mount(good);
  assert.equal(handle.setJSON(bad), false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].source, "setJSON");
  assertSameDoc(handle.editor, handle.getJSON(), good, "document kept");
  cleanup();

  const m2 = mount(bad);
  await tick();
  assert.equal(m2.errors.length, 1);
  assert.equal(m2.errors[0].source, "initial");
  assert.deepEqual(m2.errors[0].rejected, bad);
  m2.cleanup();
});

test("toolbar: role, labels, aria-pressed, roving tabindex, commands", async () => {
  const { handle, bar, host, cleanup } = mount({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }] });
  const ed = handle.editor;
  const tb = bar.querySelector('[role="toolbar"]');
  assert.ok(tb && tb.getAttribute("aria-label"));
  const btns = [...tb.querySelectorAll("button")];
  const ids = btns.map((b) => b.dataset.cmd);
  for (const want of ["undo", "redo", "paragraph", "h1", "h2", "h3", "bold", "italic", "underline", "strike", "code", "link",
    "bulletList", "orderedList", "blockquote", "insertTable", "addRow", "deleteRow", "addColumn", "deleteColumn", "insertChart", "horizontalRule"]) {
    assert.ok(ids.includes(want), `toolbar has ${want}`);
  }
  for (const b of btns) assert.ok(b.getAttribute("aria-label"), `${b.dataset.cmd} labelled`);
  assert.equal(btns.filter((b) => b.tabIndex === 0).length, 1, "one tab stop");
  const btn = (id) => tb.querySelector(`[data-cmd="${id}"]`);

  ed.commands.setTextSelection({ from: 1, to: 6 });
  btn("bold").click();
  assert.equal(btn("bold").getAttribute("aria-pressed"), "true");
  assert.ok(ed.getJSON().content[0].content[0].marks.some((m) => m.type === "bold"));
  btn("h2").click();
  assert.equal(ed.getJSON().content[0].type, "heading");
  assert.equal(btn("h2").getAttribute("aria-pressed"), "true");
  assert.equal(btn("paragraph").getAttribute("aria-pressed"), "false");

  assert.ok(btn("addRow").disabled, "row commands disabled outside a table");
  btn("insertTable").click();
  const table = ed.getJSON().content.find((n) => n.type === "table");
  assert.equal(table.content.length, 3);
  assert.equal(table.content[0].content.length, 3);
  assert.ok(!btn("addRow").disabled);
  btn("addRow").click();
  btn("addColumn").click();
  const t2 = ed.getJSON().content.find((n) => n.type === "table");
  assert.equal(t2.content.length, 4);
  assert.equal(t2.content[0].content.length, 4);
  btn("deleteColumn").click();
  assert.equal(ed.getJSON().content.find((n) => n.type === "table").content[0].content.length, 3);

  ed.commands.setTextSelection(1);
  btn("insertChart").click();
  await tick();
  assert.ok(ed.getJSON().content.some((n) => n.type === "dataBlock" && n.attrs.kind === "chart"));
  assert.ok(host.querySelector("figure.udm-datablock canvas"));

  btn("undo").click();
  assert.ok(!ed.getJSON().content.some((n) => n.type === "dataBlock"));

  // Roving tabindex: ArrowRight moves the tab stop.
  const first = btns.find((b) => b.tabIndex === 0);
  first.focus();
  tb.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.notEqual(document.activeElement, first);
  assert.equal(document.activeElement.tabIndex, 0);
  assert.equal(first.tabIndex, -1);

  // Every resulting doc is still valid for the adapter.
  ed.schema.nodeFromJSON(ed.getJSON()).check();
  cleanup();
});

test("charts redraw when the site theme changes, and are destroyed with the editor", async () => {
  const m = mount();
  m.handle.editor.commands.insertContent({ type: "dataBlock", attrs: E.newChartAttrs(m.handle.editor) });
  await tick();
  assert.equal(m.chart.made.length, 1);
  document.body.setAttribute("data-md-color-scheme", "slate");
  await tick();
  await tick();
  assert.equal(m.chart.made.length, 2, "redrawn after the scheme switch");
  assert.ok(m.chart.made[0].destroyed, "old chart destroyed");
  m.cleanup();
  assert.ok(m.chart.made[1].destroyed, "chart destroyed with the editor");
  document.body.removeAttribute("data-md-color-scheme");
});

test("links refuse unsafe schemes", () => {
  assert.equal(E.safeHref("javascript:alert(1)"), null);
  assert.equal(E.safeHref("data:text/html,x"), null);
  assert.equal(E.safeHref("https://a.example"), "https://a.example");
  assert.equal(E.safeHref("example.com/x"), "https://example.com/x");
  assert.equal(E.safeHref("#part-x"), "#part-x");
});
