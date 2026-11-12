// PPTX exporter tests: every sample deck (and a synthetic slide with every element and chart type) is exported with
// pptxgenjs in Node, then the .pptx is opened with a minimal zip reader and its parts are checked: one slide part per
// slide, one native chart part per chart element with the right chart XML, tables, pictures, crops, rotations,
// speaker notes with the demo footer, and well-formed XML. Run with `npm test`.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { PLAYGROUND, ASSETS, common } from "../scripts/esbuild-shared.mjs";

const outdir = path.join(PLAYGROUND, "test/.build");
const outfile = path.join(outdir, "pptx.mjs");
await esbuild.build({ ...common, entryPoints: [path.join(PLAYGROUND, "test/pptx-entry.ts")], outfile, platform: "node", minify: false });
const X = await import(pathToFileURL(outfile).href);

const BASE = "https://example.test/presenton-os/assets/playground/";
X.setAssetsRoot(BASE);
const index = JSON.parse(fs.readFileSync(path.join(ASSETS, "data/index.json"), "utf8"));
const template = (id) => X.hydrateTemplate(JSON.parse(fs.readFileSync(path.join(ASSETS, `data/${id}.json`), "utf8")), BASE);
const localFile = (url) => {
  assert.ok(url.startsWith(BASE), `asset outside the playground: ${url}`);
  return path.join(ASSETS, decodeURIComponent(url.slice(BASE.length).split(/[?#]/)[0]));
};
const loadAsset = async (url) => ({ bytes: new Uint8Array(fs.readFileSync(localFile(url))), type: "" });

// ---- minimal zip reader (central directory + stored/deflated entries) ---------------------------------------------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  assert.ok(eocd >= 0, "zip end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central directory entry");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    assert.equal(buf.readUInt32LE(local), 0x04034b50, `local header of ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    files.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
const text = (files, name) => files.get(name)?.toString("utf8");

/** Tag balance check: every opened element is closed in order (catches truncated or mis-nested XML). */
function assertWellFormed(xml, name) {
  const body = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const stack = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    if (m[1]) assert.equal(stack.pop(), m[2], `${name}: </${m[2]}> closes the wrong element`);
    else if (!m[4]) stack.push(m[2]);
  }
  assert.deepEqual(stack, [], `${name}: unclosed elements`);
  assert.ok(!/<[^>]*\bundefined="|="undefined"|NaN/.test(xml), `${name}: undefined/NaN values in XML`);
  for (const [, body] of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
    const n = (body.match(/<a:pPr\b/g) ?? []).length;
    assert.ok(n === 0 || (n === 1 && body.trimStart().startsWith("<a:pPr")), `${name}: one leading a:pPr per paragraph`);
  }
}

const CHART_XML = { bar: "c:barChart", line: "c:lineChart", area: "c:areaChart", pie: "c:pieChart", doughnut: "c:doughnutChart",
  scatter: "c:scatterChart", radar: "c:radarChart", bubble: "c:bubbleChart" };
const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function collect(v, pred, out = []) {
  if (Array.isArray(v)) v.forEach((x) => collect(x, pred, out));
  else if (v && typeof v === "object") { if (pred(v)) out.push(v); Object.values(v).forEach((x) => collect(x, pred, out)); }
  return out;
}

async function exportToZip(deck, t) {
  const { pptx, report } = await X.buildPptx(deck, t, { loadAsset, assetsBase: BASE });
  // the raw pptxgenjs output is a valid zip too; the exporter's bytes add the one-pPr-per-paragraph fix
  const raw = await pptx.write({ outputType: "nodebuffer" });
  assert.ok(Buffer.isBuffer(raw) && raw.length > 1000);
  assert.ok([...unzip(raw).keys()].includes("ppt/presentation.xml"));
  const buf = Buffer.from(await X.pptxBytes(pptx));
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "starts with a zip local file header");
  return { files: unzip(buf), report };
}

function checkPackage(files, slideCount) {
  for (const part of ["[Content_Types].xml", "ppt/presentation.xml", "_rels/.rels"]) assert.ok(files.has(part), part);
  assert.match(text(files, "ppt/presentation.xml"), /<p:sldSz cx="12192000" cy="6858000"/, "LAYOUT_WIDE 13.333 x 7.5 in");
  const slides = [...files.keys()].filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  assert.equal(slides.length, slideCount);
  for (let i = 1; i <= slideCount; i++) {
    assert.ok(files.has(`ppt/slides/slide${i}.xml`), `slide${i}.xml`);
    assert.ok(text(files, `ppt/notesSlides/notesSlide${i}.xml`)?.includes(X.EXPORT_FOOTER), `notes ${i} carry the demo footer`);
  }
  for (const [name, data] of files) if (/\.(xml|rels)$/.test(name)) assertWellFormed(data.toString("utf8"), name);
}

for (const { id } of index) {
  test(`${id}: sample deck exports a valid pptx with native charts, tables, pictures and notes`, async () => {
    const t = template(id);
    const deck = X.sampleDeck(t);
    const { files, report } = await exportToZip(deck, t);
    checkPackage(files, deck.slides.length);
    assert.equal(report.slides, deck.slides.length);
    assert.deepEqual(report.warnings.filter((w) => ["element_failed", "image_unavailable", "element_skipped"].includes(w.code)), [],
      JSON.stringify(report.warnings));

    // one native chart part per chart element, referenced from its slide, with the matching chart XML
    const chartParts = [...files.keys()].filter((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f));
    const chartEls = collect(deck.slides.map((s) => s.ui), (o) => o.type === "chart");
    assert.equal(chartParts.length, chartEls.length, "chart parts");
    deck.slides.forEach((s, i) => {
      const xml = text(files, `ppt/slides/slide${i + 1}.xml`);
      const rels = text(files, `ppt/slides/_rels/slide${i + 1}.xml.rels`) ?? "";
      const chartTargets = rels.match(/(?:\.\.|\/ppt)\/charts\/chart\d+\.xml/g) ?? [];
      const charts = collect(s.ui, (o) => o.type === "chart");
      assert.equal(chartTargets.length, charts.length, `${s.id} chart rels`);
      assert.equal((xml.match(/<c:chart /g) ?? []).length, charts.length, `${s.id} chart frames`);
      for (const [k, target] of chartTargets.entries()) {
        const chartXml = text(files, target.replace(/^(\.\.|\/ppt)\//, "ppt/"));
        const type = report.charts[s.id][k];
        assert.ok(chartXml.includes(`<${CHART_XML[type]}>`), `${s.id}: ${target} is a native ${type} chart`);
        assert.ok(chartXml.includes("<c:ser>"), `${s.id}: ${target} has series`);
      }
      const expected = { bar: "bar", horizontal_bar: "bar", stacked_bar: "bar", horizontal_stacked_bar: "bar", line: "line", area: "area",
        pie: "pie", donut: "doughnut", scatter: "scatter", radar: "radar", polar_area: "pie" };
      assert.deepEqual(report.charts[s.id] ?? [], charts.map((c) => expected[c.chart_type]), `${s.id} chart types`);
      // tables are native tables
      assert.equal((xml.match(/<a:tbl>/g) ?? []).length, collect(s.ui, (o) => o.type === "table").length, `${s.id} tables`);
      // the slide's text is real text: some run of the ui is in the slide XML
      const runs = collect(s.ui, (o) => o.type === "text").flatMap((t) => (t.runs ?? []).map((r) => (r.text ?? "").split("\n")[0].trim()))
        .filter((r) => r.length >= 4 && !/[*_`]/.test(r));
      if (runs.length) assert.ok(runs.some((r) => xml.includes(xmlEscape(r))), `${s.id}: text runs written as text`);
    });

    const images = collect(deck.slides.map((s) => s.ui), (o) => o.type === "image" && o.data);
    assert.ok((report.counts.image ?? 0) > 0 && (report.counts.image ?? 0) <= images.length, "pictures written");
    assert.ok([...files.keys()].some((f) => f.startsWith("ppt/media/")), "media embedded");
    assert.ok((report.counts.text ?? 0) > 0 && (report.counts.shape ?? 0) > 0);
  });
}

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const CHART_TYPES = ["bar", "horizontal_bar", "stacked_bar", "horizontal_stacked_bar", "line", "area", "pie", "donut", "scatter", "radar", "polar_area", "bubble"];
const chartEl = (chart_type, i) => ({
  type: "chart", chart_type, name: `chart_${i}`, decorative: false, title: `${chart_type} chart`,
  categories: ["Q1", "Q2", "Q3", "Q4"], series: [{ name: "2025", values: [3, 5, 2, 6] }, { name: "2026", values: [4, 6, 3, 7] }],
  colors: ["#3B82F6", "#EF4444"], data_labels: i % 2 ? "top" : undefined, legend_position: "right",
});
const SYNTHETIC = {
  id: "synthetic", background: "#FAFAFA", components: [
    { id: "shapes", position: { x: 0, y: 0 }, elements: [
      { type: "vector", shape: "polygon", fill: { color: "#F8FAFC" }, points: rect(0, 0, 1280, 720), closed: true },
      { type: "vector", shape: "ellipse", fill: { color: "#3B82F6", opacity: 0.5 }, stroke: { color: "#111827", width: 2 }, points: rect(20, 20, 80, 60) },
      { type: "vector", shape: "polygon", fill: { color: "#10B981" }, points: [{ x: 120, y: 20 }, { x: 200, y: 20 }, { x: 160, y: 90 }], corner_radii: [6, 6, 6] },
      { type: "vector", points: [{ x: 220, y: 40 }, { x: 320, y: 40 }], closed: false, stroke: { color: "#EF4444", width: 3, dash: [6, 4] }, end_marker: "arrow" },
      { type: "vector", shape: "polygon", fill: { color: "#111827" }, points: rect(340, 20, 120, 60), corner_radii: [10, 10, 10, 10], opacity: 0.8,
        shadow: { color: "#000000", blur: 4, opacity: 0.2, offset_x: 0, offset_y: 2 } },
    ] },
    { id: "text", position: { x: 40, y: 120 }, elements: [
      { type: "text", position: { x: 0, y: 0 }, size: { width: 500, height: 60 }, name: "title", decorative: false,
        font: { family: "Poppins", size: 40, color: "#111827", bold: true, line_height: 1.1 }, alignment: { horizontal: "center", vertical: "middle" },
        runs: [{ text: "Synthetic " }, { text: "title", font: { italic: true, color: "#EF4444" } }, { text: "\nsecond line" }] },
      { type: "text-list", position: { x: 0, y: 80 }, size: { width: 500, height: 120 }, font: { size: 18, color: "#334155" }, marker: "bullet", gap: 6,
        items: [[{ text: "First point" }], [{ text: "Second point" }]], name: "bullets", decorative: false },
      { type: "text-list", position: { x: 0, y: 210 }, size: { width: 500, height: 100 }, font: { size: 18 }, marker: "number",
        items: [[{ text: "One" }], [{ text: "Two" }]], name: "numbers", decorative: false },
    ] },
    { id: "cropped", position: { x: 640, y: 100 }, elements: [
      { type: "container", position: { x: 0, y: 0 }, size: { width: 200, height: 300 }, rotation: 30, fill: { color: "#FFFFFF" },
        border_radius: { tl: 12, tr: 12, bl: 12, br: 12 }, stroke: { color: "#E5E7EB", width: 1 },
        child: { type: "image", position: { x: -100, y: -50 }, size: { width: 400, height: 400 }, fit: "fill", decorative: true, is_icon: false, name: "img",
          data: `${BASE}images/general/image2-ec1c92dee7a3.png`, clip_path: "path('M 100 50 L 300 50 L 300 350 L 100 350 Z')" } },
      { type: "image", position: { x: 300, y: 0 }, size: { width: 200, height: 120 }, fit: "cover", focus_x: 20, focus_y: 50, decorative: false,
        is_icon: false, name: "cover", data: `${BASE}images/general/image3-82be19a88965.png` },
      { type: "image", position: { x: 300, y: 140 }, size: { width: 48, height: 48 }, fit: "fill", decorative: false, is_icon: true, color: "#9333EA",
        name: "icon", data: `${BASE}images/general/placeholder.svg` },
    ] },
    { id: "table", position: { x: 40, y: 460 }, elements: [
      { type: "table", position: { x: 0, y: 0 }, size: { width: 500, height: 200 }, font: { size: 14 }, name: "t", decorative: false,
        columns: [{ runs: [{ text: "Plan" }], color: { color: "#111827" }, font: { color: "#FFFFFF" } }, { runs: [{ text: "Price" }] }],
        rows: [[{ runs: [{ text: "Starter" }] }, { runs: [{ text: "$20 & up" }], color: { color: "#111827" } }]] },
      { type: "infographic", position: { x: 560, y: 0 }, size: { width: 300, height: 40 }, name: "p", decorative: false,
        data: { type: "progress_bar", min_value: 0, max_value: 100, value: 40 }, colors: ["#3B82F6"] },
      { type: "infographic", position: { x: 560, y: 60 }, size: { width: 300, height: 140 }, name: "tl", decorative: false,
        data: { type: "timeline", items: [{ title: "Plan", description: "Q1" }, { title: "Ship", description: "Q3" }] } },
    ] },
  ],
};
const CHARTS = { id: "charts", components: [{ id: "grid", position: { x: 40, y: 40 }, elements: [
  { type: "grid", position: { x: 0, y: 0 }, size: { width: 1200, height: 640 }, columns: 4, rows: 3, gap: 16, name: "g",
    children: CHART_TYPES.map(chartEl) },
] }] };

test("synthetic slides: every element kind and every Presenton chart type become native PowerPoint objects", async () => {
  const t = template("general");
  const deck = { templateId: "general", templateName: "General", slides: [
    { id: "s1", templateId: "general", layoutId: "synthetic", title: "Synthetic", ui: SYNTHETIC, speaker_note: "Say hello." },
    { id: "s2", templateId: "general", layoutId: "charts", title: "Charts", ui: CHARTS },
  ] };
  const { files, report } = await exportToZip(deck, t);
  checkPackage(files, 2);
  const s1 = text(files, "ppt/slides/slide1.xml");
  for (const needle of ['prst="ellipse"', "<a:custGeom>", 'prst="roundRect"', 'prst="rect"', "<a:tbl>", "<a:srcRect", 'rot="', "<a:buAutoNum",
    "<a:buChar", "Synthetic ", "second line", "First point", "$20 &amp; up", 'typeface="Poppins"', "<a:outerShdw", 'prstDash val="dash"',
    '<a:tailEnd type="arrow"', "Plan: Q1"]) {
    assert.ok(s1.includes(needle), `slide 1 has ${needle}`);
  }
  assert.match(s1, /<p:bgPr><a:solidFill><a:srgbClr val="FAFAFA"/, "slide background");
  // the cropped image sits where the container is (rotation 30deg around its center), cropped to the clip rect
  assert.ok(/<a:xfrm rot="1800000">/.test(s1), "container rotation reaches its child picture");
  assert.ok(text(files, "ppt/notesSlides/notesSlide1.xml").includes("Say hello."), "own speaker note kept");
  // the recolored SVG icon is embedded as SVG
  assert.ok([...files.keys()].some((f) => /^ppt\/media\/.*\.svg$/.test(f)), "svg icon embedded");
  const svg = [...files.entries()].find(([f]) => /^ppt\/media\/.*\.svg$/.test(f))[1].toString("utf8");
  assert.match(svg, /9333EA/i, "icon color applied to the SVG");

  assert.deepEqual(report.charts.s2, ["bar", "bar", "bar", "bar", "line", "area", "pie", "doughnut", "scatter", "radar", "pie", "bubble"]);
  const charts = [...files.keys()].filter((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  assert.equal(charts.length, 12);
  const xml = charts.map((f) => text(files, f));
  const bar = xml.filter((x) => x.includes("<c:barChart>"));
  assert.equal(bar.length, 4);
  assert.ok(bar.some((x) => x.includes('<c:barDir val="col"/>') && x.includes('<c:grouping val="clustered"/>')));
  assert.ok(bar.some((x) => x.includes('<c:barDir val="bar"/>') && x.includes('<c:grouping val="clustered"/>')));
  assert.ok(bar.some((x) => x.includes('<c:barDir val="col"/>') && x.includes('<c:grouping val="stacked"/>')));
  assert.ok(bar.some((x) => x.includes('<c:barDir val="bar"/>') && x.includes('<c:grouping val="stacked"/>')));
  for (const tag of ["c:lineChart", "c:areaChart", "c:pieChart", "c:doughnutChart", "c:scatterChart", "c:radarChart", "c:bubbleChart"]) {
    assert.ok(xml.some((x) => x.includes(`<${tag}>`)), tag);
  }
  assert.ok(xml.every((x) => x.includes("<c:legendPos val=\"r\"/>")), "legend position");
  assert.ok(xml.some((x) => x.includes("3B82F6")) && xml.some((x) => x.includes("EF4444")), "template colors");
  assert.ok(xml.some((x) => x.includes("<c:showVal val=\"1\"/>")), "data labels");
  assert.ok(xml.every((x) => x.includes("chart</a:t>") || x.includes("chart<")), "chart titles");
  assert.ok(report.warnings.some((w) => w.code === "chart_type_mapped"), "polar area reported");
  assert.ok(report.warnings.some((w) => w.code === "infographic_simplified"), "infographic reported");
});

test("a deck generated from a page (content mode) exports", async () => {
  const p = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const page = { type: "doc", content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Quarterly review" }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Revenue by region" }] },
    p("North grew fastest after the launch."),
    { type: "dataBlock", attrs: { kind: "chart", bindingId: "b_rev", block: { chartType: "bar", title: "Revenue" },
      binding: { kind: "chart", source: { type: "static", origin: "user", data: { categories: ["North", "South"], series: [{ name: "2026", values: [14, 22] }] } } } } },
  ] };
  for (const { id } of index) {
    const t = template(id);
    const { deck } = X.udmToNewDeck(X.tiptapToUdm(page).udm, t);
    const { files, report } = await exportToZip(deck, t);
    checkPackage(files, deck.slides.length);
    assert.ok(report.slides >= 2);
    const all = [...files.keys()].filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).map((f) => text(files, f)).join("");
    assert.ok(all.includes("Quarterly review"), `${id}: generated title written`);
  }
});

test("exportPptx in Node writes a .pptx file, fetching images from the assets root", async () => {
  fs.mkdirSync(outdir, { recursive: true });
  const prevCwd = process.cwd();
  const prevFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    const body = fs.readFileSync(localFile(String(url)));
    return new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
  };
  process.chdir(outdir);
  try {
    const t = template("modern");
    await X.exportPptx(X.sampleDeck(t), t, "modern-export");
    const file = path.join(outdir, "modern-export.pptx");
    assert.ok(fs.existsSync(file));
    const files = unzip(fs.readFileSync(file));
    checkPackage(files, t.layouts.length);
    assert.ok(fetched.length > 0 && fetched.every((u) => u.startsWith(`${BASE}images/modern/`)), "images fetched from the assets root");
    fs.rmSync(file);
  } finally {
    process.chdir(prevCwd);
    globalThis.fetch = prevFetch;
  }
});

test("exportPptx in a browser DOM (happy-dom) downloads a .pptx Blob through an <a download> link", async () => {
  const { Window } = await import("happy-dom");
  const window = new Window({ url: "https://example.test/presenton-os/playground/" });
  const prev = { document: globalThis.document, fetch: globalThis.fetch, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let blob = null, clicked = null;
  globalThis.document = window.document;
  URL.createObjectURL = (b) => { blob = b; return "blob:test-pptx"; };
  URL.revokeObjectURL = () => {};
  globalThis.fetch = async (url) => new Response(fs.readFileSync(localFile(String(url))), { status: 200 });
  window.document.addEventListener("click", (e) => { clicked = { download: e.target.download, href: e.target.href }; e.preventDefault(); }, true);
  try {
    const t = template("general");
    await X.exportPptx(X.sampleDeck(t), t, "General: demo/deck");
    assert.deepEqual(clicked, { download: "General- demo-deck.pptx", href: "blob:test-pptx" });
    assert.equal(blob.type, X.PPTX_MIME);
    const files = unzip(Buffer.from(await blob.arrayBuffer()));
    checkPackage(files, t.layouts.length);
    assert.equal(window.document.querySelectorAll("a[download]").length, 0, "temporary link removed");
  } finally {
    globalThis.document = prev.document;
    globalThis.fetch = prev.fetch;
    URL.createObjectURL = prev.create;
    URL.revokeObjectURL = prev.revoke;
    await window.happyDOM.close();
  }
});

test("image headers: natural sizes of the playground's PNG, JPEG and SVG files", () => {
  const png = new Uint8Array(fs.readFileSync(path.join(ASSETS, "images/general/image2-ec1c92dee7a3.png")));
  const jpg = new Uint8Array(fs.readFileSync(path.join(ASSETS, "images/general/thumbnail.jpg")));
  const svg = new Uint8Array(fs.readFileSync(path.join(ASSETS, "images/general/placeholder.svg")));
  assert.equal(X.sniffType(png, "x"), "image/png");
  assert.equal(X.sniffType(jpg, "x"), "image/jpeg");
  assert.equal(X.sniffType(svg, "x"), "image/svg+xml");
  const ps = X.imageSize(png, "image/png"), js = X.imageSize(jpg, "image/jpeg");
  assert.ok(ps.width > 0 && ps.height > 0 && js.width > 0 && js.height > 0);
  assert.deepEqual(X.imageSize(svg, "image/svg+xml"), { width: 256, height: 256 });
});
