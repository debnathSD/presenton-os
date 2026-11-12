// Bridge tests: sample deck -> UDM -> tiptap.json -> UDM -> deck, edits landing in the right slot, content mode,
// Markdown. Run with `npm test` (node --test). The bridge is bundled with esbuild first (test/bundle.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadBundle } from "./bundle.mjs";
import { ASSETS } from "../scripts/esbuild-shared.mjs";

const B = await loadBundle();
const NS = B.PRESENTON_NS;
const BASE = "https://example.test/presenton-os/assets/playground/";
const index = JSON.parse(fs.readFileSync(path.join(ASSETS, "data/index.json"), "utf8"));
const template = (id) => B.hydrateTemplate(JSON.parse(fs.readFileSync(path.join(ASSETS, `data/${id}.json`), "utf8")), BASE);
const at = (ui, p) => p.split(".").reduce((o, k) => o?.[/^\d+$/.test(k) ? Number(k) : k], ui);
const runsText = (el) => (el.runs ?? []).map((r) => r.text ?? r.latex ?? "").join("");
const schema = B.getSchema(B.tiptapExtensions());

function checkDoc(doc) {
  schema.nodeFromJSON(doc).check();
  assert.deepEqual(B.validateTiptap(doc), []);
}

/** Top-level nodes of a converted doc with the slide each belongs to (from the section boundary's ext). */
function nodesWithSlide(doc) {
  let slideId = null;
  return doc.content.map((n) => {
    if (n.attrs?.udmKind === "section") slideId = n.attrs.udmExt?.[NS]?.slideId ?? null;
    return { node: n, slideId };
  });
}

test("index lists three curated decks with resolvable thumbnails", () => {
  assert.deepEqual(index.map((t) => t.id), ["general", "momentum", "modern"]);
  for (const t of index) {
    assert.ok(t.layoutCount >= 6 && t.layoutCount <= 10, `${t.id} layoutCount`);
    assert.ok(fs.existsSync(path.join(ASSETS, t.thumbnail)), `${t.id} thumbnail file`);
  }
});

for (const { id } of index) {
  test(`${id}: data assets are local, exist and resolve against the assets root`, () => {
    const raw = JSON.parse(fs.readFileSync(path.join(ASSETS, `data/${id}.json`), "utf8"));
    const s = JSON.stringify(raw);
    assert.ok(!/"\/?static\//.test(s), "no template-relative static/ URLs left");
    for (const m of s.matchAll(/"(images\/[^"]+)"/g)) assert.ok(fs.existsSync(path.join(ASSETS, m[1])), m[1]);
    const t = template(id);
    const urls = JSON.stringify(t).match(/https:\/\/example\.test[^"]+/g) ?? [];
    assert.ok(urls.length > 0 && urls.every((u) => u.startsWith(`${BASE}images/${id}/`)));
  });

  test(`${id}: deck -> UDM -> tiptap -> UDM -> deck is byte-identical`, () => {
    const t = template(id);
    const deck = B.sampleDeck(t);
    assert.equal(deck.slides.length, t.layouts.length);
    const { udm } = B.deckToUdm(deck);
    assert.equal(udm.sections.length, deck.slides.length);
    const { doc, issues } = B.udmToTiptap(udm);
    assert.deepEqual(issues, []);
    checkDoc(doc);
    const back = B.tiptapToUdm(doc).udm;
    const r = B.udmToDeck(back, deck, t);
    assert.deepEqual(r.changedSlideIds, []);
    assert.equal(r.deck.slides.length, deck.slides.length);
    r.deck.slides.forEach((s, i) => {
      assert.equal(s.id, deck.slides[i].id);
      assert.equal(s.layoutId, deck.slides[i].layoutId);
      assert.equal(JSON.stringify(s.ui), JSON.stringify(deck.slides[i].ui), `slide ${s.id} ui`);
    });
    assert.ok(!r.loss.some((l) => l.code === "slide_removed"));
    assert.ok(!r.issues.some((i) => i.level === "error"));
  });

  test(`${id}: an edited paragraph lands in its slot and only that slide changes`, () => {
    const t = template(id);
    const deck = B.sampleDeck(t);
    const { doc } = B.udmToTiptap(B.deckToUdm(deck).udm);
    const edited = structuredClone(doc);
    const target = nodesWithSlide(edited).find(({ node }) => node.type === "paragraph" && node.attrs?.udmExt?.[NS]?.slot && node.content?.length);
    assert.ok(target, "a paragraph with slot provenance");
    const slot = target.node.attrs.udmExt[NS].slot;
    const TEXT = "Edited in the playground";
    target.node.content = [{ type: "text", text: TEXT }];
    checkDoc(edited);
    const r = B.udmToDeck(B.tiptapToUdm(edited).udm, deck, t);
    assert.deepEqual(r.changedSlideIds, [target.slideId]);
    const slide = r.deck.slides.find((s) => s.id === target.slideId);
    assert.equal(runsText(at(slide.ui, slot)), TEXT);
    // the slot keeps its base font
    const before = at(deck.slides.find((s) => s.id === target.slideId).ui, slot);
    assert.equal(at(slide.ui, slot).runs[0].font?.family, (before.runs?.[0]?.font ?? before.font)?.family);
    for (const s of r.deck.slides) {
      if (s.id === target.slideId) continue;
      assert.equal(JSON.stringify(s.ui), JSON.stringify(deck.slides.find((d) => d.id === s.id).ui));
    }
    // a second round on the edited deck is a no-op (patching starts from the current ui)
    const again = B.udmToDeck(B.tiptapToUdm(B.udmToTiptap(B.deckToUdm(r.deck).udm).doc).udm, r.deck, t);
    assert.deepEqual(again.changedSlideIds, []);
  });

  test(`${id}: chart data edited in the data block reaches the chart slot`, (ctx) => {
    const t = template(id);
    const deck = B.sampleDeck(t);
    const { doc } = B.udmToTiptap(B.deckToUdm(deck).udm);
    const edited = structuredClone(doc);
    const target = nodesWithSlide(edited).find(({ node }) => node.type === "dataBlock" && node.attrs.kind === "chart"
      && node.attrs.binding?.source?.data?.series?.length);
    if (!target) return ctx.skip("no chart in this deck");
    const data = target.node.attrs.binding.source.data;
    data.series[0].values = data.series[0].values.map((v) => v * 2 + 1);
    checkDoc(edited);
    const r = B.udmToDeck(B.tiptapToUdm(edited).udm, deck, t);
    assert.deepEqual(r.changedSlideIds, [target.slideId]);
    const el = at(r.deck.slides.find((s) => s.id === target.slideId).ui, target.node.attrs.udmExt[NS].slot);
    assert.deepEqual(el.series[0].values, data.series[0].values);
  });

  test(`${id}: a section added in the editor becomes a new slide`, () => {
    const t = template(id);
    const deck = B.sampleDeck(t);
    const { doc } = B.udmToTiptap(B.deckToUdm(deck).udm);
    const edited = structuredClone(doc);
    edited.content.push({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Added section" }] },
      { type: "paragraph", content: [{ type: "text", text: "Written in the editor." }] });
    const r = B.udmToDeck(B.tiptapToUdm(edited).udm, deck, t);
    assert.equal(r.deck.slides.length, deck.slides.length + 1);
    const added = r.deck.slides.at(-1);
    assert.deepEqual(r.changedSlideIds, [added.id]);
    assert.ok(t.layouts.some((l) => l.id === added.layoutId));
    assert.ok(JSON.stringify(added.ui).includes("Added section"));
  });
}

const p = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const SAMPLE_PAGE = { type: "doc", content: [
  { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Quarterly review" }] },
  { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Why we are moving to usage pricing" }] },
  p("Seat pricing stopped tracking value once customers automated their workflows."),
  { type: "bulletList", content: ["Usage aligns cost with value", "Smaller teams can start cheaper", "Expansion revenue becomes automatic"]
    .map((x) => ({ type: "listItem", content: [p(x)] })) },
  { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Revenue by region" }] },
  p("North grew fastest after the launch."),
  { type: "dataBlock", attrs: { kind: "chart", bindingId: "b_rev", block: { chartType: "bar", title: "Revenue" },
    binding: { kind: "chart", source: { type: "static", origin: "user", data: { categories: ["North", "South", "West"],
      series: [{ name: "2025", values: [10, 20, 30] }, { name: "2026", values: [14, 22, 31] }] } } } } },
  { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Plans" }] },
  { type: "table", content: [["Plan", "Today", "Proposed"], ["Starter", "$20/seat", "$0.02/run"], ["Team", "$45/seat", "$0.015/run"]]
    .map((row, i) => ({ type: "tableRow", content: row.map((c) => ({ type: i ? "tableCell" : "tableHeader", content: [p(c)] })) })) },
] };

for (const { id } of index) {
  test(`${id}: content mode turns a sample page into slides with valid ui`, () => {
    const t = template(id);
    checkDoc(SAMPLE_PAGE);
    const { udm } = B.tiptapToUdm(SAMPLE_PAGE);
    const r = B.udmToNewDeck(udm, t);
    assert.equal(r.deck.templateId, id);
    assert.equal(r.deck.slides.length, 4); // title slide + 3 sections
    assert.ok(!r.issues.some((i) => i.level === "error"), JSON.stringify(r.issues.filter((i) => i.level === "error")));
    assert.equal(new Set(r.deck.slides.map((s) => s.id)).size, r.deck.slides.length);
    for (const s of r.deck.slides) {
      assert.ok(t.layouts.some((l) => l.id === s.layoutId));
      assert.ok(Array.isArray(s.ui.components));
      assert.ok(!JSON.stringify(s.ui).includes(`"${NS}"`));
    }
    const all = JSON.stringify(r.deck.slides.map((s) => s.ui));
    assert.ok(all.includes("Quarterly review"));
    assert.ok(all.includes("Revenue by region"));
    // every paragraph either reached a slide or is reported
    const placed = (txt) => all.includes(txt) || r.loss.some((l) => l.code === "no_slot" && JSON.stringify(l.detail).includes(txt));
    assert.ok(placed("Seat pricing stopped tracking value"));
    assert.ok(placed("North grew fastest"));
    // the generated deck converts back to a valid Tiptap page
    const { doc, issues } = B.udmToTiptap(B.deckToUdm(r.deck).udm);
    assert.deepEqual(issues, []);
    checkDoc(doc);
  });

  test(`${id}: Markdown export is non-empty`, () => {
    const deck = B.sampleDeck(template(id));
    const { markdown } = B.udmToMarkdown(B.deckToUdm(deck).udm);
    assert.ok(markdown.trim().length > 50);
    assert.match(markdown, /^## /m);
  });
}

test("data loaders fetch relative to the assets root", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const rel = String(url).slice(BASE.length);
    return new Response(fs.readFileSync(path.join(ASSETS, rel), "utf8"), { status: 200 });
  };
  try {
    const list = await B.loadIndex(BASE);
    assert.equal(list[0].thumbnail, `${BASE}images/general/thumbnail.jpg`);
    const t = await B.loadTemplate("modern", BASE);
    assert.equal(t.layouts.length, 8);
    assert.equal(t.layouts[0].ui.id, t.layouts[0].id);
    B.setAssetsRoot(BASE);
    assert.equal(B.assetsRoot(), BASE);
    assert.deepEqual(seen, [`${BASE}data/index.json`, `${BASE}data/modern.json`]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("auto-fit leaves the template's own sample text alone and shrinks overflowing generated text", () => {
  for (const t of index) {
    const tpl = template(t.id);
    for (const s of B.sampleDeck(tpl).slides) {
      const ui = structuredClone(s.ui);
      assert.deepEqual(B.autofitText(ui, s.id, s.ui), [], `${t.id}/${s.layoutId} sample text should fit`);
      assert.deepEqual(ui, s.ui);
    }
  }
  const el = { type: "text", size: { width: 661, height: 250.8 },
    font: { size: 151.11, family: "Lato Heavy", line_height: 0.78, letter_spacing: -10.73 },
    runs: [{ text: "EMEA quarterly business review for the third quarter", font: { size: 151.11 } }] };
  const ui = { components: [{ elements: [el] }] };
  const loss = B.autofitText(ui, "s1");
  assert.equal(loss.length, 1);
  assert.equal(loss[0].code, "text_autofit");
  assert.ok(el.font.size < 151.11 && el.font.size >= 151.11 * 0.45 - 0.01);
  assert.equal(el.runs[0].font.size, el.font.size);
});
