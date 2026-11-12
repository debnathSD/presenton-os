// Render tests: every slide of every sample deck goes through Presenton's real renderer (templateV2UiToHtml,
// bundled with the playground's browser shims) and into a sandboxed, scaled iframe. DOM: happy-dom.
// Run with `npm test`.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { Window } from "happy-dom";
import { PLAYGROUND, ASSETS, common } from "../scripts/esbuild-shared.mjs";
import { RENDER_ALIASES } from "../src/render/aliases.mjs";

const outfile = path.join(PLAYGROUND, "test/.build/render.mjs");
await esbuild.build({
  ...common, alias: { ...common.alias, ...RENDER_ALIASES },
  entryPoints: [path.join(PLAYGROUND, "test/render-entry.ts")], outfile, platform: "node", minify: false,
});
const R = await import(pathToFileURL(outfile).href);
const bundleText = fs.readFileSync(outfile, "utf8");

const BASE = "https://example.test/presenton-os/assets/playground/";
R.setAssetsRoot(BASE);
const index = JSON.parse(fs.readFileSync(path.join(ASSETS, "data/index.json"), "utf8"));
const template = (id) => R.hydrateTemplate(JSON.parse(fs.readFileSync(path.join(ASSETS, `data/${id}.json`), "utf8")), BASE);
const local = (url) => path.join(ASSETS, decodeURIComponent(url.slice(BASE.length)));

const window = new Window({ url: "https://example.test/presenton-os/playground/" });
const { document } = window;
const parse = (html) => new window.DOMParser().parseFromString(html, "text/html");

const countCharts = (v) => Array.isArray(v) ? v.reduce((n, x) => n + countCharts(x), 0)
  : v && typeof v === "object" ? (v.type === "chart" ? 1 : 0) + Object.values(v).reduce((n, x) => n + countCharts(x), 0) : 0;

test("bundle uses the shims, not Presenton's server api or root-relative vendor URLs", () => {
  assert.ok(!bundleText.includes("NEXT_PUBLIC_FAST_API"), "real @/utils/api bundled");
  assert.ok(!bundleText.includes("BackendConnectionError"), "real @/utils/api bundled");
  assert.ok(bundleText.includes("templateV2UiToHtml"), "real renderer bundled");
  assert.ok(bundleText.includes("setChartVendorBase"), "chart-browser shim bundled");
  assert.ok(!bundleText.includes('"/vendor/chart-4.5.1'), "root-relative Chart.js URL left in the bundle");
});

for (const { id } of index) {
  const t = template(id);
  const deck = R.sampleDeck(t);
  const { files, stylesheets } = R.splitFonts(t.fonts);

  test(`${id}: every slide renders to a full document with local assets`, () => {
    assert.ok(deck.slides.length >= 6);
    for (const slide of deck.slides) {
      const html = R.slideHtml(slide, t);
      const where = `${id}/${slide.layoutId}`;
      assert.match(html, /^<!doctype html>/i, where);
      assert.ok(html.includes('data-template-v2-html-slide="true"'), `${where}: Presenton slide root`);
      assert.ok(!html.includes("Could not render"), `${where}: renderer threw`);
      assert.ok(!/\/app_data\/|url\("\/vendor\/fonts\/|src="\/(?:vendor|static)\//.test(html), `${where}: server path left`);

      const d = parse(html);
      const root = d.querySelector("[data-template-v2-html-slide]");
      assert.ok(root && root.children.length > 0, `${where}: slide has content`);
      assert.equal(root.getAttribute("style").includes("width:1280px;height:720px"), true, `${where}: 1280x720`);

      for (const img of d.querySelectorAll("img")) {
        const src = img.getAttribute("src");
        assert.ok(src.startsWith(`${BASE}images/${id}/`), `${where}: image ${src}`);
        assert.ok(fs.existsSync(local(src)), `${where}: image file ${src}`);
      }
      for (const m of html.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        if (m[1].startsWith("data:")) continue;
        assert.ok(m[1].startsWith(`${BASE}images/${id}/`), `${where}: css url ${m[1]}`);
        assert.ok(fs.existsSync(local(m[1])), `${where}: css url file ${m[1]}`);
      }

      const charts = countCharts(slide.ui);
      assert.equal(d.querySelectorAll("canvas[data-presenton-chart]").length, charts, `${where}: chart canvases`);
      const scripts = [...d.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"));
      if (charts) {
        assert.deepEqual(scripts, [`${BASE}vendor/chart-4.5.1.umd.min.js`, `${BASE}vendor/chartjs-plugin-datalabels-2.2.0.min.js`]);
        for (const s of scripts) assert.ok(fs.existsSync(local(s)), s);
        for (const c of d.querySelectorAll("canvas[data-presenton-chart]")) JSON.parse(c.getAttribute("data-chart-config"));
      } else {
        assert.equal(scripts.length, 0, `${where}: no scripts without charts`);
      }

      const links = [...d.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href"));
      assert.deepEqual(links, stylesheets, `${where}: font stylesheets`);
      for (const src of Object.values(files)) assert.ok(html.includes(`url("${src}")`), `${where}: @font-face ${src}`);

      const text = root.textContent.replace(/\s+/g, " ");
      assert.ok(text.trim().length > 0, `${where}: slide has text`);
    }
  });

  test(`${id}: renderSlide puts each slide in a sandboxed, scaled iframe; renderThumb is small and inert`, async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    for (const [i, slide] of deck.slides.entries()) {
      const box = document.createElement("div");
      host.appendChild(box);
      await R.renderSlide(box, slide, t, { highlight: i === 1, fallbackWidth: 640, timeoutMs: 5 });
      const iframe = box.querySelector("iframe");
      assert.ok(iframe, `${slide.id}: iframe`);
      assert.equal(iframe.getAttribute("sandbox"), "allow-scripts");
      assert.equal(iframe.srcdoc, R.slideHtml(slide, t));
      assert.match(iframe.style.transform, /scale\(0\.5\)/);
      assert.equal(iframe.style.maxWidth, "none", "host page max-width rules must not crop the 1280px slide");
      assert.ok(iframe.title.length > 0);
      assert.equal(box.firstElementChild.classList.contains("udm-slide--changed"), i === 1);

      // Re-render: same iframe, highlight toggles, srcdoc only swapped when the HTML changes.
      const before = iframe;
      await R.renderSlide(box, slide, t, { highlight: false, fallbackWidth: 640, timeoutMs: 5 });
      assert.equal(box.querySelector("iframe"), before);
      assert.equal(box.firstElementChild.classList.contains("udm-slide--changed"), false);

      const tb = document.createElement("div");
      host.appendChild(tb);
      await R.renderThumb(tb, slide, t, { timeoutMs: 5 });
      const ti = tb.querySelector("iframe");
      assert.equal(ti.getAttribute("sandbox"), "allow-scripts");
      assert.equal(ti.getAttribute("tabindex"), "-1");
      assert.equal(ti.getAttribute("loading"), "lazy");
      assert.match(ti.style.transform, /scale\(0\.1875\)/);
    }
    host.remove();
  });
}

test("edited text reaches the rendered HTML (escaped)", () => {
  const t = template(index[0].id);
  const slide = structuredClone(R.sampleDeck(t).slides[0]);
  const walk = (v) => {
    if (!v || typeof v !== "object") return null;
    if (v.type === "text" && Array.isArray(v.runs) && v.runs.length) return v;
    for (const x of Object.values(v)) { const r = walk(x); if (r) return r; }
    return null;
  };
  const el = walk(slide.ui);
  assert.ok(el, "a text element");
  el.runs = [{ ...el.runs[0], text: "Edited <b>in</b> Tiptap & back" }];
  const html = R.slideHtml(slide, t);
  assert.ok(html.includes("Edited &lt;b&gt;in&lt;/b&gt; Tiptap &amp; back"));
});

test("a ui without elements renders a blank slide instead of throwing", async () => {
  const t = template(index[0].id);
  const html = R.slideHtml({ ui: { background: "#123456" } }, t);
  assert.match(html, /background:#123456/);
  const box = document.createElement("div");
  await R.renderSlide(box, { id: "x", templateId: t.id, layoutId: "none", title: "", ui: {} }, t, { timeoutMs: 5 });
  assert.equal(box.querySelector("iframe").getAttribute("sandbox"), "allow-scripts");
});

test.after(() => window.happyDOM.close());
