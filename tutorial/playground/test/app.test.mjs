// App shell smoke test (happy-dom): mount the playground with fetch reading the built data files from disk, run
// "Watch a sample run" to completion (sections land in the editor one by one), "Create slides from this page", then
// the deck mode: convert -> edit -> apply on one deck, and the page mode: sample page -> slides. Run with `npm test`.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { Window } from "happy-dom";
import { PLAYGROUND, ASSETS, REPO, common } from "../scripts/esbuild-shared.mjs";
import { RENDER_ALIASES } from "../src/render/aliases.mjs";

// ---------- DOM globals (before the bundle is imported) ----------
const window = new Window({ url: "https://example.test/presenton-os/playground/", width: 1400, height: 900 });
const g = globalThis;
const GLOBALS = [
  "window", "document", "Node", "Element", "HTMLElement", "HTMLDialogElement", "HTMLInputElement", "HTMLButtonElement",
  "HTMLCanvasElement", "HTMLSelectElement", "HTMLTextAreaElement", "Text", "Range", "Selection", "DocumentFragment",
  "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "Event", "KeyboardEvent",
  "MouseEvent", "InputEvent", "FocusEvent", "CustomEvent", "DOMParser", "ClipboardEvent", "DragEvent", "matchMedia", "sessionStorage",
];
for (const k of GLOBALS) {
  if (window[k] === undefined) continue;
  const v = typeof window[k] === "function" && !/^[A-Z]/.test(k) ? window[k].bind(window) : window[k];
  Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
}
Object.defineProperty(g, "navigator", { value: window.navigator, configurable: true, writable: true });

const BASE = "https://example.test/presenton-os/assets/playground/";
const fetched = [];
g.fetch = async (url) => {
  const u = String(url);
  fetched.push(u);
  if (!u.startsWith(BASE)) return new Response("not found", { status: 404 });
  const file = path.join(ASSETS, decodeURIComponent(u.slice(BASE.length)));
  if (!fs.existsSync(file)) return new Response("not found", { status: 404 });
  return new Response(fs.readFileSync(file), { status: 200, headers: { "content-type": "application/json" } });
};
const errors = [];
const realError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(" ")); };

const outfile = path.join(PLAYGROUND, "test/.build/app.mjs");
await esbuild.build({
  ...common, alias: { ...common.alias, ...RENDER_ALIASES },
  entryPoints: [path.join(PLAYGROUND, "test/app-entry.ts")], outfile, platform: "node", minify: false,
});
const A = await import(pathToFileURL(outfile).href);
A.setAssetsRoot(BASE);
const schema = A.getSchema(A.tiptapExtensions());

const { document } = window;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}
const click = (el) => { assert.ok(el, "element to click"); assert.ok(!el.disabled, `"${el.textContent.trim()}" is enabled`); el.click(); };
const idle = (app) => until(() => !app.ctx.store.get().busy, "the app to be idle");
const docText = (doc) => JSON.stringify(doc).match(/"text":"([^"]*)"/g)?.join(" ") ?? "";

document.body.innerHTML = '<div id="udm-playground" data-assets="../assets/playground/"></div>';
const mount = document.getElementById("udm-playground");
// Speed 25: the recorded 4.2 s outline + ~34 s of sections replay in about a second, slow enough to see them land.
const app = await A.mountApp(mount, { sampleSpeed: 25 });
const editor = app.ctx.editor;

test("shell: header, mode tabs (prompt mode first), step indicator, three panes, status bar", () => {
  assert.ok($(".udm-head h2").textContent.length > 10);
  const list = $('[role="tablist"].udm-modes');
  const tabs = $$('[role="tab"]', list);
  assert.deepEqual(tabs.map((t) => $(".udm-tab__long", t).textContent),
    ["Create a page from a prompt", "Presenton deck to page", "Page to slides"]);
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(tabs[1].tabIndex, -1);
  for (const t of tabs) assert.ok(document.getElementById(t.getAttribute("aria-controls")), "tab panel exists");
  assert.equal($("#udm-panel-create").hidden, false);
  assert.equal($("#udm-panel-deck").hidden, true);
  assert.ok($(".udm-pane--slides") && $(".udm-pane--editor") && $(".udm-pane--inspector"));
  assert.ok($('.udm-pane--editor [role="toolbar"]'), "editor toolbar");
  assert.equal($$(".udm-pane--inspector [role=tab]").length, 5);
  assert.equal($(".udm-status").getAttribute("aria-live"), "polite");
  assert.ok($(".udm-steps .udm-step--current"), "a current stage");
  // Prompt form like Presenton's upload page.
  for (const id of ["udm-prompt", "udm-nsections", "udm-tone", "udm-verbosity", "udm-language", "udm-instructions", "udm-model", "udm-effort"]) {
    assert.ok(document.getElementById(id), id);
    assert.ok($(`label[for="${id}"]`), `label for ${id}`);
  }
  assert.deepEqual($$("#udm-nsections option").map((o) => o.value), ["3", "4", "5", "6", "7", "8", "9", "10"]);
  assert.equal($("#udm-model").value, "claude-opus-5-5");
  assert.ok(fetched.some((u) => u.endsWith("data/index.json")));
});

test("Generate outline without a key opens the key dialog with a privacy note; Cancel closes it", async () => {
  $("#udm-prompt").value = "A page about usage pricing";
  click($('[data-action="generate-outline"]'));
  const dlg = await until(() => $("dialog.udm-dialog"), "the key dialog");
  assert.match($("#udm-key-privacy", dlg).textContent, /api\.anthropic\.com/);
  assert.equal($("#udm-key-input", dlg).type, "password");
  assert.equal($("#udm-key-remember", dlg).checked, false);
  [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click();
  await tick(10);
  assert.equal($("dialog.udm-dialog"), null);
  assert.equal(app.ctx.store.get().busy, null);
  $("#udm-prompt").value = "";
});

test("Watch a sample run: outline, then sections land in the editor one by one, then the page is done", async () => {
  const seen = { skeleton: false, partial: false, progress: "", maxHeadings: [] };
  click($('[data-action="sample-run"]'));
  const watch = setInterval(() => {
    if ($$(".udm-skeleton").length) seen.skeleton = true;
    const label = $(".udm-progress__label")?.textContent ?? "";
    if (/^Section \d+ of 6$/.test(label)) seen.progress = label;
    const n = editor.getJSON().content.filter((c) => c.type === "heading" && c.attrs?.level === 2).length;
    if (n > 0 && n < 6 && $$(".udm-skeleton").length) seen.partial = true;
    seen.maxHeadings.push(n);
  }, 2);
  await until(() => !$(".udm-done").hidden, "the sample run to finish", 30000);
  clearInterval(watch);
  await idle(app);

  assert.ok(seen.skeleton, "skeleton placeholders were shown");
  assert.ok(seen.partial, "the editor held part of the page while other sections were pending");
  assert.match(seen.progress, /^Section \d of 6$/);
  const doc = editor.getJSON();
  schema.nodeFromJSON(doc).check();
  assert.deepEqual(A.validateTiptap(doc).filter((i) => i.level === "error"), []);
  assert.equal(doc.content[0].type, "heading");
  assert.equal(doc.content[0].attrs.level, 1);
  assert.equal(doc.content.filter((c) => c.type === "heading" && c.attrs?.level === 2).length, 6);
  assert.ok(doc.content.some((c) => c.type === "table"), "a table");
  assert.ok(doc.content.some((c) => c.type === "dataBlock"), "a chart");
  assert.equal($$(".udm-skeleton").length, 0, "skeletons removed");
  assert.equal(editor.editor.isEditable, true, "editable again");
  const m = app.ctx.mode("create");
  assert.deepEqual(m.errors, []);
  assert.ok(m.udm?.sections?.length === 6, "the UDM of the page is kept");
  assert.match($(".udm-done__note").textContent, /Sample run finished: 6 sections/);
  assert.equal($("#udm-prompt").value.startsWith("Quarterly business review"), true, "form shows the recorded prompt");
  // Outline review shows the recorded outline, read-only for the sample.
  assert.equal($$(".udm-outline-item").length, 6);
  assert.equal($(".udm-journey li.is-current strong").textContent, "Page");
  // Inspector views have content.
  for (const tab of ["udm", "tiptap", "markdown", "loss"]) {
    click($(`#udm-itab-${tab}`));
    await tick(5);
    assert.ok(!$(".udm-pre").classList.contains("is-empty"), `${tab} view has content`);
  }
  assert.match($(".udm-pre").textContent, /Last operation: Sample run: 6 sections/);
});

test("Create slides from this page: a deck in the chosen template, previews with numbered thumbnails", async () => {
  click($('#udm-panel-create .udm-card[data-template="modern"]'));
  click($('[data-action="create-slides"]'));
  await idle(app);
  const m = app.ctx.mode("create");
  assert.deepEqual(m.errors, []);
  assert.ok(m.deck && m.deck.slides.length >= 6, "slides generated");
  assert.equal(m.deck.templateId, "modern");
  assert.equal(m.stage, 4);
  const thumbs = await until(() => ($$(".udm-thumb").length === m.deck.slides.length ? $$(".udm-thumb") : null), "thumbnails");
  assert.deepEqual(thumbs.map((t) => $(".udm-thumb__num", t).textContent), m.deck.slides.map((_, i) => String(i + 1)));
  assert.equal(thumbs[0].getAttribute("aria-current"), "true");
  const big = await until(() => $(".udm-slides__main iframe"), "the selected slide");
  assert.equal(big.getAttribute("sandbox"), "allow-scripts");
  assert.ok($('[data-action="pptx"]').disabled === false, "PPTX download enabled");
  click(thumbs[2]);
  await until(() => app.ctx.mode("create").selected === 2, "selection");
  assert.match($(".udm-slides__caption").textContent, /^Slide 3 of/);
  // Presenton JSON in the inspector.
  click($("#udm-itab-presenton"));
  await tick(5);
  const pj = JSON.parse($(".udm-pre").textContent);
  assert.equal(pj.slides.length, m.deck.slides.length);
});

test("deck mode: pick -> convert -> edit -> apply highlights the changed slide; no errors", async () => {
  const createDoc = editor.getJSON();
  click($("#udm-mode-deck"));
  assert.equal($("#udm-panel-deck").hidden, false);
  await until(() => app.ctx.mode("deck").deck, "the first sample deck");
  await idle(app);
  const deck = app.ctx.mode("deck").deck;
  assert.equal(deck.templateId, "general");
  click($('[data-action="convert"]'));
  await idle(app);
  let m = app.ctx.mode("deck");
  assert.deepEqual(m.errors, []);
  assert.equal(m.stage, 2);
  const doc = editor.getJSON();
  schema.nodeFromJSON(doc).check();
  assert.ok(doc.content.length > deck.slides.length, "page has the slides' content");
  assert.ok($(".udm-step--current").textContent.includes("Tiptap page"));

  // Edit the first non-empty paragraph through a transaction (as typing would).
  let pos = -1;
  editor.editor.state.doc.descendants((n, p) => {
    if (pos < 0 && n.type.name === "paragraph" && n.textContent.length > 3) pos = p + 1;
    return pos < 0;
  });
  assert.ok(pos > 0);
  editor.editor.view.dispatch(editor.editor.state.tr.insertText("Edited in the playground. ", pos));
  await tick(5);
  assert.equal(app.ctx.mode("deck").dirty, true);

  click($('[data-action="apply"]'));
  await idle(app);
  m = app.ctx.mode("deck");
  assert.deepEqual(m.errors, []);
  assert.equal(m.stage, 4);
  assert.equal(m.changed.length, 1, "exactly one slide changed");
  assert.equal(m.deck.slides.length, deck.slides.length);
  assert.ok(JSON.stringify(m.deck.slides.find((s) => s.id === m.changed[0]).ui).includes("Edited in the playground."));
  await until(() => $$(".udm-thumb.is-changed").length === 1, "changed thumbnail");
  await until(() => /1 slide changed/.test($(".udm-status__text").textContent), "the apply status message");

  // Mode switch keeps each mode's page.
  click($("#udm-mode-create"));
  assert.deepEqual(editor.getJSON(), createDoc);
  click($("#udm-mode-deck"));
  assert.ok(docText(editor.getJSON()).includes("Edited in the playground."));
});

test("page mode: sample page -> Generate slides from page", async () => {
  click($("#udm-mode-page"));
  await tick(5);
  assert.ok(docText(editor.getJSON()).includes("Quarterly product review"), "sample page loaded");
  click($('[data-action="generate-slides"]'));
  await idle(app);
  const m = app.ctx.mode("page");
  assert.deepEqual(m.errors, []);
  assert.ok(m.deck.slides.length >= 4);
  assert.ok(m.loss.length >= 1, "losses reported (title slide, no_slot list)");
});

test("download menu lists the five formats", async () => {
  const btn = $("#udm-download");
  click(btn);
  const items = $$("#udm-download-menu [role=menuitem]").map((b) => $("span", b).textContent);
  assert.deepEqual(items, ["PPTX", "Presenton JSON", "UDM JSON", "tiptap.json", "Markdown"]);
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  $("#udm-download-menu").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(btn.getAttribute("aria-expanded"), "false");
});

test("no errors were logged", () => {
  assert.deepEqual(errors.filter((e) => !/Chart|canvas/i.test(e)), []);
});

test("published page mounts the bundle with the build output names", () => {
  const md = fs.readFileSync(path.join(REPO, "tutorial/content/playground/index.md"), "utf8");
  assert.match(md, /hide:\n\s+- navigation\n\s+- toc/);
  assert.match(md, /<div id="udm-playground"[^>]*data-assets="\.\.\/assets\/playground\/"/);
  assert.match(md, /<script type="module" src="\.\.\/assets\/playground\/app\/main\.js"><\/script>/);
  assert.match(md, /<link rel="stylesheet" href="\.\.\/assets\/playground\/app\/main\.css">/);
  assert.match(md, /<noscript>/);
  for (const link of ["../final/index.md", "../final/73-ppt-adapter.md", "../final/74-tiptap-adapter.md"]) assert.ok(md.includes(`(${link})`), link);
});

test.after(async () => {
  console.error = realError;
  app.destroy();
  await window.happyDOM.abort();
  window.happyDOM.close();
});
