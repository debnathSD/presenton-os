// End-to-end check of the BUILT bundle (content/assets/playground/app/main.js, as published), in happy-dom.
// fetch serves the files under content/assets/playground/ and a mocked Anthropic Messages API, so the real SDK in the
// lazily loaded llm chunk runs end to end without a key or a network. Run `npm run build` first; `npm test` runs it.
//   1. Sample run: sections stream into the editor, the page validates, "Create slides", PPTX download (bytes checked).
//   2. Live flow with the mocked API: key dialog, outline, outline edits (rename, reorder, delete), sections, slides.
//   3. Deck mode: convert, edit one paragraph through the editor API, apply; only that slot of that slide changes.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import JSZip from "jszip";
import { ASSETS, PLAYGROUND } from "../scripts/esbuild-shared.mjs";

const MAIN = path.join(ASSETS, "app/main.js");
const SAMPLE = JSON.parse(fs.readFileSync(path.join(PLAYGROUND, "src/generate/sample-run.json"), "utf8"));

// ---------- DOM globals ----------
const window = new Window({ url: "https://example.test/presenton-os/playground/", width: 1400, height: 900 });
const g = globalThis;
const GLOBALS = [
  "window", "document", "Node", "Element", "HTMLElement", "HTMLDialogElement", "HTMLInputElement", "HTMLButtonElement",
  "HTMLCanvasElement", "HTMLSelectElement", "HTMLTextAreaElement", "Text", "Range", "Selection", "DocumentFragment",
  "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "Event", "KeyboardEvent",
  "MouseEvent", "InputEvent", "FocusEvent", "CustomEvent", "DOMParser", "ClipboardEvent", "DragEvent", "matchMedia", "sessionStorage", "Image", "FileReader",
];
for (const k of GLOBALS) {
  if (window[k] === undefined) continue;
  const v = typeof window[k] === "function" && !/^[A-Z]/.test(k) ? window[k].bind(window) : window[k];
  Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
}
Object.defineProperty(g, "navigator", { value: window.navigator, configurable: true, writable: true });

// Sample-run replay uses timers; scale long delays down while it runs so the test stays short.
let timeScale = 1;
const realSetTimeout = g.setTimeout;
g.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms > 20 ? ms * timeScale : ms, ...a);

// Downloads: capture the Blob behind every <a download>.
const blobs = [];
const realCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = (blob) => { blobs.push(blob); return realCreateObjectURL.call(URL, blob); };

// ---------- fetch: site assets + mocked Anthropic API ----------
const BASE = "https://example.test/presenton-os/assets/playground/";
const API = "https://api.anthropic.com/";
const TEST_KEY = `sk-ant-test-${"0".repeat(32)}`; // fake test value; only ever reaches this mock
const fetched = [];
const apiCalls = [];
let titleToSample = new Map(); // section title (as the model sees it) -> index into SAMPLE.sections

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_test" } });
function message(obj) {
  return json({
    id: `msg_test_${apiCalls.length}`, type: "message", role: "assistant", model: "claude-opus-5-5",
    content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 200 },
  });
}
g.fetch = async (input, init = {}) => {
  const u = String(input?.url ?? input);
  fetched.push(u);
  if (u.startsWith(BASE)) {
    const file = path.join(ASSETS, decodeURIComponent(u.slice(BASE.length)));
    if (!fs.existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(fs.readFileSync(file), { status: 200 });
  }
  if (u.startsWith(`${API}v1/messages`)) {
    const body = JSON.parse(init.body);
    const headers = new Headers(init.headers);
    apiCalls.push({ url: u, body, headers });
    const props = Object.keys(body.output_config?.format?.schema?.properties ?? {});
    if (props.includes("sections")) return message(SAMPLE.outline); // outline call
    const title = /# Section Title:\n(.*)\n/.exec(body.messages[0].content)?.[1];
    const idx = titleToSample.get(title);
    if (idx == null) return json({ type: "error", error: { type: "invalid_request_error", message: `unknown section ${title}` } }, 400);
    return message(SAMPLE.sections[idx]);
  }
  return new Response("not found", { status: 404 });
};

const errors = [];
const realError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(" ")); };

// ---------- mount the published bundle ----------
const { document } = window;
document.body.innerHTML = '<div id="udm-playground" class="udm-root" data-assets="../assets/playground/"></div>';
const mount = document.getElementById("udm-playground");
await import(pathToFileURL(MAIN).href);
if (!mount.dataset.mounted) document.dispatchEvent(new window.Event("DOMContentLoaded"));

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const tick = (ms = 0) => new Promise((r) => realSetTimeout(r, ms));
async function until(fn, what, timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what} (status: ${$(".udm-status__text")?.textContent})`);
    await tick(5);
  }
}
const click = (el, what = "element") => { assert.ok(el, `${what} exists`); assert.ok(!el.disabled, `${what} is enabled`); el.click(); };
const idle = async () => { await tick(5); await until(() => mount.getAttribute("aria-busy") !== "true", "the app to be idle", 60000); };
const statusOk = () => assert.notEqual($(".udm-status").dataset.kind, "error", $(".udm-status__text").textContent);
const editor = () => $(".ProseMirror").editor; // Tiptap sets view.dom.editor
const docJSON = () => editor().getJSON();
const h2s = (doc) => doc.content.filter((n) => n.type === "heading" && n.attrs?.level === 2).map((n) => n.content?.map((c) => c.text).join("") ?? "");
const inspect = async (tab) => { click($(`#udm-itab-${tab}`), `inspector tab ${tab}`); await tick(5); return $(".udm-pre").textContent; };
const schemaCheck = () => { editor().schema.nodeFromJSON(docJSON()).check(); };

async function downloadPptx() {
  const before = blobs.length;
  click($('#udm-panel-create [data-action="pptx"]'), "Download PPTX");
  await until(() => blobs.length > before, "the PPTX blob", 60000);
  await idle();
  const blob = blobs[blobs.length - 1];
  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  return { blob, zip, slides: Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)),
    charts: Object.keys(zip.files).filter((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f)) };
}

await until(() => $(".ProseMirror") && $$('[role="tab"]').length >= 3, "the app to mount");

test("built bundle mounts from the published files only", () => {
  assert.equal(mount.dataset.mounted, "true");
  assert.ok($("#udm-mode-create") && $("#udm-mode-deck") && $("#udm-mode-page"));
  assert.ok(fetched.some((u) => u === `${BASE}data/index.json`), "index.json from the assets root");
});

test("sample run: sections stream into the editor, the page validates, slides and a PPTX follow", async () => {
  timeScale = 0.05;
  const seen = { skeleton: false, partial: false };
  click($('[data-action="sample-run"]'), "Watch a sample run");
  const watch = setInterval(() => {
    const n = h2s(docJSON()).length;
    if ($$(".udm-skeleton").length) seen.skeleton = true;
    if (n > 0 && n < 6) seen.partial = true;
  }, 1);
  await until(() => !$(".udm-done").hidden, "the sample run to finish", 60000);
  clearInterval(watch);
  timeScale = 1;
  await idle();
  statusOk();
  assert.ok(seen.skeleton && seen.partial, "skeletons and a part-written page were seen");
  const doc = docJSON();
  schemaCheck();
  assert.equal(doc.content[0].attrs.level, 1);
  assert.deepEqual(h2s(doc), SAMPLE.outline.sections.map((s) => s.title));
  assert.ok(doc.content.some((n) => n.type === "dataBlock") && doc.content.some((n) => n.type === "table"));
  assert.match(await inspect("loss"), /Sample run: 6 sections/);

  click($('#udm-panel-create .udm-card[data-template="general"]'), "general template");
  click($('[data-action="create-slides"]'), "Create slides");
  await idle();
  statusOk();
  const deck = JSON.parse(await inspect("presenton"));
  assert.equal(deck.template, "general");
  assert.ok(deck.slides.length >= 6);
  await until(() => $$(".udm-thumb").length === deck.slides.length, "thumbnails");
  assert.equal($(".udm-slides__main iframe").getAttribute("sandbox"), "allow-scripts");

  const { blob, zip, slides, charts } = await downloadPptx();
  assert.equal(blob.type, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert.equal(slides.length, deck.slides.length, "one PowerPoint slide per deck slide");
  const chartSlots = deck.slides.reduce((n, s) => n + (JSON.stringify(s.ui).match(/"type":"chart"/g)?.length ?? 0), 0);
  assert.equal(charts.length, chartSlots, "a native chart per chart slot");
  assert.ok(await zip.file("ppt/presentation.xml").async("string"));
});

test("live flow with a mocked Anthropic API: key, outline, outline edits, sections", async () => {
  click($('[data-action="new-page"]') ?? [...$$("#udm-panel-create button")].find((b) => b.textContent === "Start a new page"), "Start a new page");
  await idle();
  $("#udm-prompt").value = "Quarterly business review for a SaaS company in EMEA";
  $("#udm-nsections").value = "6";
  click($('[data-action="generate-outline"]'), "Generate outline");
  const dlg = await until(() => $("dialog.udm-dialog"), "the key dialog");
  $("#udm-key-input", dlg).value = TEST_KEY;
  $("form", dlg).dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  await until(() => !$("dialog.udm-dialog"), "the key dialog to close");
  await until(() => $$(".udm-outline-item").length === 6, "the outline review", 60000);
  await idle();
  statusOk();

  // Outline call: model, effort, structured output, browser header, key only to api.anthropic.com.
  const oc = apiCalls[0];
  assert.equal(new URL(oc.url).origin, "https://api.anthropic.com");
  assert.equal(oc.body.model, "claude-opus-5-5");
  assert.equal(oc.body.output_config.effort, "medium");
  assert.equal(oc.body.output_config.format.type, "json_schema");
  assert.equal(oc.headers.get("anthropic-dangerous-direct-browser-access"), "true");
  assert.ok([oc.headers.get("authorization"), oc.headers.get("x-api-key")].some((v) => v?.includes(TEST_KEY)));
  for (const k of ["temperature", "top_p", "top_k", "thinking"]) assert.equal(oc.body[k], undefined, k);
  assert.equal(sessionStorage.length, 0, "key not remembered without opt-in");

  // Edit the outline: rename section 2, move section 3 up, delete the last section.
  const titles = () => $$(".udm-outline-item input").map((i) => i.value);
  const t2 = $$(".udm-outline-item input")[1];
  t2.value = "Revenue in detail";
  t2.dispatchEvent(new window.Event("input", { bubbles: true }));
  click($('[aria-label="Move section 3 up"]'), "move up");
  click($('[aria-label="Delete section 6"]'), "delete");
  const edited = titles();
  const orig = SAMPLE.outline.sections.map((s) => s.title);
  assert.deepEqual(edited, [orig[0], orig[2], "Revenue in detail", orig[3], orig[4]]);
  titleToSample = new Map([[orig[0], 0], [orig[2], 2], ["Revenue in detail", 1], [orig[3], 3], [orig[4], 4]]);

  const before = apiCalls.length;
  click($('[data-action="generate-page"]'), "Generate page");
  await until(() => !$(".udm-done").hidden, "the live page to finish", 60000);
  await idle();
  statusOk();
  assert.equal(apiCalls.length - before, 5, "one section call per edited outline section");
  assert.ok(apiCalls.slice(before).every((c) => c.body.output_config.format.type === "json_schema"));
  schemaCheck();
  const doc = docJSON();
  assert.equal(doc.content[0].attrs.level, 1);
  assert.deepEqual(h2s(doc), edited, "sections in the edited order with the edited titles");
  assert.ok(doc.content.some((n) => n.type === "dataBlock"), "a chart from the section output");

  click($('#udm-panel-create .udm-card[data-template="modern"]'), "modern template");
  click($('[data-action="create-slides"]'), "Create slides");
  await idle();
  statusOk();
  const deck = JSON.parse(await inspect("presenton"));
  assert.equal(deck.template, "modern");
  const { slides } = await downloadPptx();
  assert.equal(slides.length, deck.slides.length);
  assert.ok(fetched.every((u) => u.startsWith(BASE) || u.startsWith(API)), "no other host was contacted");
});

/** Leaf paths whose values differ between a and b. */
function diff(a, b, p = "") {
  if (a === b) return [];
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return [{ path: p, a, b }];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diff(a[k], b[k], `${p}/${k}`));
}

test("deck mode: convert, edit a paragraph through the editor API, apply: only that slot changes", async () => {
  click($("#udm-mode-deck"), "deck mode tab");
  await until(() => $$(".udm-thumb").length > 0, "the sample deck");
  await idle();
  const before = JSON.parse(await inspect("presenton"));
  click($('[data-action="convert"]'), "Convert to Tiptap");
  await idle();
  statusOk();
  schemaCheck();

  // First paragraph with real text: insert at its start through a transaction (as typing would).
  const ed = editor();
  let pos = -1, original = "";
  ed.state.doc.descendants((n, p) => {
    if (pos < 0 && n.type.name === "paragraph" && n.textContent.length > 12) { pos = p + 1; original = n.textContent; }
    return pos < 0;
  });
  assert.ok(pos > 0, "a paragraph to edit");
  const INSERT = "E2E edit: ";
  ed.view.dispatch(ed.state.tr.insertText(INSERT, pos));
  click($('[data-action="apply"]'), "Apply to slides");
  await idle();
  statusOk();
  const after = JSON.parse(await inspect("presenton"));
  assert.equal(after.slides.length, before.slides.length);

  const changes = before.slides.flatMap((s, i) => diff(s, after.slides[i]).map((d) => ({ ...d, slide: s.id })));
  assert.ok(changes.length >= 1, "something changed");
  assert.equal(new Set(changes.map((c) => c.slide)).size, 1, "exactly one slide changed");
  const words = original.slice(0, 12);
  const slot = changes.find((c) => typeof c.b === "string" && c.b.includes(INSERT.trim()));
  assert.ok(slot, `a text slot now holds the edit (changed: ${changes.map((c) => c.path).join(", ")})`);
  assert.ok(String(slot.a).includes(words), `the same slot held the original text ("${words}…") before`);
  // Everything that changed is inside that run. The prototype's runsFrom() writes bold/italic/underline explicitly on a
  // rewritten run, so a flag the template left out can appear as its default (false); nothing else may change.
  const run = slot.path.replace(/\/text$/, "");
  for (const c of changes) {
    if (c.path === slot.path) continue;
    assert.ok(c.path.startsWith(`${run}/font/`) && c.a === undefined && c.b === false,
      `only that slot changed (or a default style flag on its run): ${c.path} ${JSON.stringify(c.a)} -> ${JSON.stringify(c.b)}`);
  }
  await until(() => $$(".udm-thumb.is-changed").length === 1, "the changed slide highlight");
});

test("no errors were logged", () => {
  assert.deepEqual(errors.filter((e) => !/Chart|canvas/i.test(e)), []);
});

test.after(async () => {
  console.error = realError;
  g.setTimeout = realSetTimeout;
  URL.createObjectURL = realCreateObjectURL;
  await window.happyDOM.abort();
  window.happyDOM.close();
});
