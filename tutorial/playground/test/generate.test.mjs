// Prompt-to-page tests (src/generate). No network: the SDK client is mocked (canned outputs go through the real
// zodOutputFormat parser), and the real SDK client is exercised against a fake fetch. Run with `npm test`.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { Window } from "happy-dom";
import { PLAYGROUND, ASSETS, common } from "../scripts/esbuild-shared.mjs";

const outfile = path.join(PLAYGROUND, "test/.build/generate.mjs");
await esbuild.build({ ...common, entryPoints: [path.join(PLAYGROUND, "test/generate-entry.ts")], outfile, platform: "node", minify: false });
const G = await import(pathToFileURL(outfile).href);

const schema = G.getSchema(G.tiptapExtensions());
const manifest = G.pageManifest();
const SAMPLE = G.SAMPLE_RUN;
const INPUT = SAMPLE.input;
const KEY = "sk-ant-api03-test-key-0000000000000000-abcd";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isOutlineCall = (params) => params.system.includes("Generate a page title");
const sectionIndexOf = (params) => Number(/# Section Number:\n(\d+) of/.exec(params.messages[0].content)[1]) - 1;
const docOf = (nodes) => ({ type: "doc", content: nodes });

/** Mock of client.messages.parse: canned text goes through the request's own format.parse (zodOutputFormat). */
function mockClient(handler) {
  const calls = [];
  let inFlight = 0;
  const client = {
    calls, maxInFlight: 0,
    messages: {
      async parse(params, options) {
        calls.push({ params, options });
        inFlight++; client.maxInFlight = Math.max(client.maxInFlight, inFlight);
        try {
          const r = await handler(params, calls.length - 1, options);
          const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : undefined);
          const parsed_output = text !== undefined ? params.output_config.format.parse(text) : null;
          return { id: "msg_test", type: "message", role: "assistant", model: params.model, stop_reason: r.stop_reason ?? "end_turn",
            stop_details: r.stop_details ?? null, content: text !== undefined ? [{ type: "text", text }] : [], parsed_output };
        } finally { inFlight--; }
      },
    },
  };
  return client;
}

/** Answers with the recorded sample outputs; `over` can replace any call's result. */
const sampleHandler = (over = {}) => async (params, n, options) => {
  if (isOutlineCall(params)) return over.outline ? over.outline(params, n) : { json: SAMPLE.outline };
  const i = sectionIndexOf(params);
  if (over.section) { const r = await over.section(i, params, n, options); if (r) return r; }
  return { json: SAMPLE.sections[i] };
};

function recorder() {
  const ev = { outline: null, starts: [], sections: [], done: null, error: null, order: [] };
  return {
    ev,
    cb: {
      onOutline: (o) => { ev.outline = o; ev.order.push("outline"); },
      onSectionStart: (i) => { ev.starts.push(i); ev.order.push(`start:${i}`); },
      onSection: (i, s, out) => { ev.sections.push({ i, s, out }); ev.order.push(`section:${i}`); },
      onDone: (r) => { ev.done = r; ev.order.push("done"); },
      onError: (e) => { ev.error = e; ev.order.push("error"); },
    },
  };
}

const fixedNow = () => new Date("2026-11-12T09:00:00Z");
const gen = (client, extra = {}) => G.createGenerator({ apiKey: KEY, client, runId: "test-run", now: fixedNow, ...extra });

function assertValidPage(result) {
  assert.deepEqual(G.checkUdm(result.udm), [], "assembled UDM passes checkUdm");
  assert.deepEqual(result.issues, []);
  schema.nodeFromJSON(result.doc).check();
  assert.deepEqual(G.validateTiptap(result.doc), []);
}

// ---------- schema building ----------

/** Inline local $refs (zodOutputFormat emits $defs for reused zod nodes; the API accepts $ref/$defs). */
function deref(root) {
  const walk = (n) => {
    if (Array.isArray(n)) return n.map(walk);
    if (!n || typeof n !== "object") return n;
    if (n.$ref) return walk(root.$defs[n.$ref.replace("#/$defs/", "")]);
    return Object.fromEntries(Object.entries(n).filter(([k]) => k !== "$defs").map(([k, v]) => [k, walk(v)]));
  };
  return walk(root);
}

test("section schema is built from the Tiptap manifest (allowed block types, chart kinds, heading levels)", () => {
  const types = G.generatedBlockTypes(manifest);
  assert.deepEqual([...types].sort(), ["callout", "chart", "divider", "heading", "list", "paragraph", "quote", "table"]);
  const js = deref(G.outputJsonSchema(G.sectionSchema(manifest)));
  assert.equal(js.type, "object");
  assert.equal(js.additionalProperties, false);
  const variants = js.properties.blocks.items.anyOf;
  assert.deepEqual(variants.map((v) => v.properties.type.const).sort(), [...types].sort());
  for (const v of variants) assert.equal(v.additionalProperties, false);
  const chart = variants.find((v) => v.properties.type.const === "chart");
  assert.ok(chart.properties.chartType.enum.every((k) => manifest.chartKinds.includes(k)));
  const text = JSON.stringify(js);
  for (const unsupported of ["minLength", "maxLength", "minimum", "maximum", "oneOf"]) assert.ok(!text.includes(`"${unsupported}"`), unsupported);

  // a smaller target: only what it can hold
  const basic = { id: "tiptap.basic", blocks: ["paragraph", "heading", "list", "quote", "code"], marks: ["bold"],
    structure: { maxHeadingLevel: 1, maxListDepth: 8 } };
  const small = deref(G.outputJsonSchema(G.sectionSchema(basic)));
  assert.deepEqual(small.properties.blocks.items.anyOf.map((v) => v.properties.type.const).sort(), ["heading", "list", "paragraph", "quote"]);
  const heading = small.properties.blocks.items.anyOf.find((v) => v.properties.type.const === "heading");
  assert.deepEqual(heading.properties.level.enum ?? [heading.properties.level.const], [1]);
  const prompt = G.sectionSystemPrompt(INPUT, basic);
  assert.ok(!prompt.includes("chart:") && !prompt.includes("# Data Rules"), "prompt lists only allowed blocks");
  assert.ok(prompt.includes("bolding (**text**)") && !prompt.includes("italicizing"), "emphasis follows the manifest marks");

  const outline = deref(G.outputJsonSchema(G.outlineSchema));
  assert.deepEqual(Object.keys(outline.properties).sort(), ["sections", "title"]);
});

test("prompts keep Presenton's rules: direct voice, authoritative settings, illustrative data labels", () => {
  const sys = G.outlineSystemPrompt("standard");
  for (const s of ['Never refer to "this page"', "Generation settings are authoritative", "clearly label estimates or illustrative",
    "Do not mention the chart instruction", "Make sure data is consistent across all sections", "around 40 words"]) assert.ok(sys.includes(s), s);
  assert.ok(G.outlineSystemPrompt("concise").includes("around 20 words"));
  const user = G.outlineUserPrompt({ prompt: "x", nSections: 4, tone: "sales_pitch", language: "Deutsch" }, fixedNow());
  for (const s of ["Number of Sections: 4", "Language: Deutsch", "Tone: sales pitch", "Today's Date: 2026-11-12"]) assert.ok(user.includes(s), s);
  assert.ok(G.outlineUserPrompt({ prompt: "x" }, fixedNow()).includes("Number of Sections: auto-detect, maximum 12"));
  const sec = G.sectionSystemPrompt({ ...INPUT, instructions: "Use British spelling" }, manifest);
  for (const s of ["# Data Rules", "illustrative estimates", "Use British spelling", "Make the section as professional as possible",
    "never emit those instructions or meta-commentary"]) assert.ok(sec.includes(s), s);
});

// ---------- pipeline with a mocked client ----------

test("request shape: model, effort, structured output format, no sampling or thinking params", async () => {
  const client = mockClient(sampleHandler());
  const { cb } = recorder();
  const r = await G.runPagePipeline(INPUT, { ...cb, generator: gen(client) });
  assert.ok(r);
  const [first, second] = client.calls;
  assert.equal(first.params.model, "claude-opus-5-5");
  assert.equal(first.params.max_tokens, G.MAX_TOKENS);
  assert.equal(first.params.output_config.effort, "medium");
  assert.equal(first.params.output_config.format.type, "json_schema");
  for (const k of ["temperature", "top_p", "top_k", "thinking"]) assert.ok(!(k in first.params), k);
  assert.ok(first.options.signal, "abort signal passed to the SDK");
  assert.ok(first.params.messages[0].content.includes("Number of Sections: 6"));
  assert.ok(second.params.messages[0].content.includes("# SECTION CONTENT: START"));
  assert.ok(second.params.system.includes("Allowed block types"));

  const client2 = mockClient(sampleHandler());
  await G.runPagePipeline(INPUT, { generator: gen(client2, { model: "claude-haiku-5-5", effort: "low" }) });
  assert.equal(client2.calls[0].params.model, "claude-haiku-5-5");
  assert.equal(client2.calls[0].params.output_config.effort, "low");
  assert.equal(G.resolveModel("gpt-whatever"), "claude-opus-5-5");
  assert.equal(G.resolveEffort("extreme"), "medium");
});

test("pipeline: outline, then sections two at a time, delivered in outline order as valid Tiptap nodes", async () => {
  const delays = [60, 5, 30, 5, 20, 5];
  const client = mockClient(sampleHandler({ section: async (i) => { await sleep(delays[i]); } }));
  const { ev, cb } = recorder();
  const r = await G.runPagePipeline(INPUT, { ...cb, generator: gen(client) });
  assert.equal(ev.error, null);
  assert.equal(ev.outline.title, "EMEA Quarterly Business Review: Q3 2026");
  assert.equal(ev.outline.sections.length, 6);
  assert.equal(client.maxInFlight, 2, "concurrency 2");
  assert.deepEqual(ev.starts, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(ev.sections.map((x) => x.i), [0, 1, 2, 3, 4, 5]);
  assert.equal(ev.order.at(-1), "done");
  assert.ok(ev.order.indexOf("outline") < ev.order.indexOf("start:0"));

  // appending the title and each section's nodes yields a valid doc that reads back as the same page
  const nodes = [...G.titleNodes(r.outline, { runId: r.runId, model: r.model, prompt: INPUT.prompt }), ...ev.sections.flatMap((x) => x.out.nodes)];
  schema.nodeFromJSON(docOf(nodes)).check();
  assert.deepEqual(G.validateTiptap(docOf(nodes)), []);
  for (const { out } of ev.sections) {
    assert.deepEqual(out.issues, []);
    assert.ok(!out.nodes[0].attrs.udmMeta?.artifact, "no artifact meta on appended section nodes");
  }
  const back = G.tiptapToUdm(docOf(nodes)).udm;
  assert.equal(back.title, r.outline.title);
  assert.equal(back.provenance.origin, "generated");
  assert.deepEqual(back.sections.map((s) => s.title), r.outline.sections.map((s) => s.title));
  assert.deepEqual(back.sections.map((s) => s.id), r.udm.sections.map((s) => s.id));

  assertValidPage(r);
  assert.ok(r.sections.every((s) => !s.fallback));
  const charts = r.udm.sections.flatMap((s) => s.blocks).filter((b) => b.type === "chart");
  assert.equal(charts.length, 2);
  for (const c of charts) {
    assert.deepEqual(c.ext[G.GEN_NS], { data: "illustrative" });
    assert.equal(r.udm.bindings[c.bindingId].source.type, "static");
    assert.match(c.caption.map((x) => x.text).join(""), /[Ii]llustrative/);
  }
});

test("Outline review: an edited outline (renamed, reordered, deleted) drives the section calls", async () => {
  const client = mockClient(sampleHandler({ section: async () => ({ json: SAMPLE.sections[0] }) }));
  const { ev, cb } = recorder();
  const r = await G.runPagePipeline(INPUT, {
    ...cb,
    onOutline: (o) => ({ title: "EMEA QBR", sections: [{ ...o.sections[2], title: "Regions at a glance" }, o.sections[0],
      { title: "Hiring plan", content: "- Two solution engineers for DACH" }] }),
    generator: gen(client),
  });
  assert.equal(r.outline.title, "EMEA QBR");
  assert.deepEqual(r.outline.sections.map((s) => s.title), ["Regions at a glance", "Executive summary", "Hiring plan"]);
  assert.ok(r.outline.sections[2].id.startsWith("out_"), "added section gets an id");
  const sectionCalls = client.calls.filter((c) => !isOutlineCall(c.params));
  assert.equal(sectionCalls.length, 3);
  assert.ok(sectionCalls.some((c) => c.params.messages[0].content.includes("# Section Title:\nRegions at a glance")));
  assert.deepEqual(ev.sections.map((x) => x.s.section.title), ["Regions at a glance", "Executive summary", "Hiring plan"]);
  assertValidPage(r);

  // starting from a given outline skips the outline call
  const c2 = mockClient(sampleHandler());
  const r2 = await G.runPagePipeline(INPUT, { generator: gen(c2), outline: r.outline });
  assert.ok(c2.calls.every((c) => !isOutlineCall(c.params)));
  assert.equal(r2.sections.length, 3);
});

test("validation fallback: unusable section output becomes the outline paragraph, the rest of the page is kept", async () => {
  const client = mockClient(sampleHandler({
    section: async (i) => i === 1 ? { text: "{not json" }
      : i === 2 ? { json: { blocks: [] } }
      : i === 4 ? { json: { blocks: [{ type: "paragraph", text: "   " }, { type: "divider" }] } }
      : null,
  }));
  const { ev, cb } = recorder();
  const r = await G.runPagePipeline(INPUT, { ...cb, generator: gen(client) });
  assert.equal(ev.error, null);
  for (const i of [1, 2, 4]) {
    const s = r.sections[i];
    assert.equal(s.fallback?.reason, "invalid_output", `section ${i}`);
    assert.equal(s.section.blocks.length, 1);
    assert.equal(s.section.blocks[0].type, "paragraph");
    assert.equal(s.section.title, r.outline.sections[i].title);
  }
  assert.match(r.sections[1].fallback.message, /did not match|parse/i);
  const text = r.sections[2].section.blocks[0].text.map((x) => x.text).join("");
  assert.ok(text.includes("UK and Ireland | 14.2") || text.includes("DACH and Middle East"), "outline text kept");
  for (const i of [0, 3, 5]) assert.ok(!r.sections[i].fallback);
  assertValidPage(r);
});

test("toUdmSection repairs and validates: disallowed types, ragged tables, mismatched chart data", () => {
  const outline = G.normalizeOutline(SAMPLE.outline, { runId: "t" });
  const ctx = { runId: "t", index: 0, outline, manifest };
  const s = G.toUdmSection({ blocks: [
    { type: "heading", level: 1, text: "Executive summary" },
    { type: "image", url: "x" },
    { type: "table", columns: ["A", "B"], rows: [["1"], ["2", "3", "4"]], caption: null },
    { type: "chart", chartType: "radar", title: "T", categories: ["a", "b", "c"], series: [{ name: "S", values: [1, "2", 3, 4] }], xAxisLabel: null, yAxisLabel: "%", caption: "Illustrative." },
    { type: "chart", chartType: "bar", title: "Empty", categories: [], series: [], xAxisLabel: null, yAxisLabel: null, caption: "No data" },
    { type: "list", ordered: false, items: ["**one**", "", "*two*"] },
  ] }, ctx);
  assert.ok(!s.fallback);
  assert.deepEqual(s.section.blocks.map((b) => b.type), ["table", "chart", "paragraph", "list"]);
  const table = s.bindings[s.section.blocks[0].bindingId].source.data;
  assert.deepEqual(table.rows, [["1", ""], ["2", "3"]]);
  const chart = s.section.blocks[1];
  assert.equal(chart.chartType, "bar", "unknown kind -> bar");
  assert.deepEqual(s.bindings[chart.bindingId].source.data.series[0].values, [1, 2, 3]);
  assert.deepEqual(s.section.blocks[3].items, [[{ text: "one", marks: ["bold"] }], [{ text: "two", marks: ["italic"] }]]);
  assert.ok(s.notes.some((n) => n.includes("repeated section title")));
  assert.ok(s.notes.some((n) => n.includes('"image"')));
  assert.deepEqual(G.checkSection(s), []);
  assert.deepEqual(G.udmToTiptap(G.sectionToUdm(s)).issues, []);
});

test("inline Markdown -> RichText keeps only the target's marks", () => {
  const marks = ["bold", "italic", "code"];
  assert.deepEqual(G.inlineMarkdown("**ARR** up *8.7%* in `Q3`", marks),
    [{ text: "ARR", marks: ["bold"] }, { text: " up " }, { text: "8.7%", marks: ["italic"] }, { text: " in " }, { text: "Q3", marks: ["code"] }]);
  assert.deepEqual(G.inlineMarkdown("**ARR** and 2 * 3 * 4", ["italic"]), [{ text: "ARR and 2 * 3 * 4" }]);
});

test("refusal: on the outline the run stops with a clear message; on a section that section falls back", async () => {
  const c1 = mockClient(sampleHandler({ outline: () => ({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }) }));
  const a = recorder();
  const r1 = await G.runPagePipeline(INPUT, { ...a.cb, generator: gen(c1) });
  assert.equal(r1, null);
  assert.equal(a.ev.error.kind, "refusal");
  assert.match(a.ev.error.message, /declined/);
  assert.equal(a.ev.error.detail, "category: cyber");
  assert.equal(a.ev.done, null);
  assert.equal(c1.calls.length, 1, "no retry on refusal");

  const c2 = mockClient(sampleHandler({ section: async (i) => i === 2 ? { stop_reason: "refusal", text: "I can't" } : null }));
  const b = recorder();
  const r2 = await G.runPagePipeline(INPUT, { ...b.cb, generator: gen(c2) });
  assert.equal(b.ev.error, null);
  assert.equal(r2.sections[2].fallback.reason, "refusal");
  assert.match(r2.sections[2].fallback.message, /declined/);
  assert.equal(r2.sections.filter((s) => s.fallback).length, 1);
  assertValidPage(r2);
});

test("max_tokens: retried once with a higher limit; a second cut-off falls back", async () => {
  const seen = new Map();
  const client = mockClient(sampleHandler({
    section: async (i, params) => {
      const n = (seen.get(i) ?? 0) + 1; seen.set(i, n);
      if (i === 0 && n === 1) return { stop_reason: "max_tokens", text: '{"blocks": [' };
      if (i === 3) return { stop_reason: "max_tokens", text: '{"blocks": [' };
      return null;
    },
  }));
  const r = await G.runPagePipeline(INPUT, { generator: gen(client) });
  const s0 = client.calls.filter((c) => !isOutlineCall(c.params) && sectionIndexOf(c.params) === 0);
  assert.deepEqual(s0.map((c) => c.params.max_tokens), [G.MAX_TOKENS, G.RETRY_MAX_TOKENS]);
  assert.ok(!r.sections[0].fallback);
  assert.equal(seen.get(3), 2);
  assert.equal(r.sections[3].fallback.reason, "max_tokens");
  assert.ok(G.RETRY_MAX_TOKENS <= (128000 * 10) / 60, "stays within the SDK's non-streaming limit");
});

test("API errors stop the run with a typed, key-free message; abort stops it too", async () => {
  const H = new Headers();
  const client = mockClient(sampleHandler({
    section: async (i) => { if (i === 3) throw new G.Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "429", H); },
  }));
  const { ev, cb } = recorder();
  const r = await G.runPagePipeline(INPUT, { ...cb, generator: gen(client) });
  assert.equal(r, null);
  assert.equal(ev.error.kind, "rate_limit");
  assert.equal(ev.error.sectionIndex, 3);
  assert.equal(ev.done, null);
  assert.ok(ev.sections.every((x) => x.i < 3), "nothing after the failed section is delivered");

  // without onError the error is thrown
  const c2 = mockClient(sampleHandler({ outline: () => { throw new G.Anthropic.AuthenticationError(401, {}, "401", H); } }));
  await assert.rejects(G.runPagePipeline(INPUT, { generator: gen(c2) }), (e) => e.kind === "auth" && !e.message.includes(KEY));

  // abort after the first section
  const ac = new AbortController();
  const c3 = mockClient(sampleHandler({ section: async (i, _p, _n, options) => {
    await sleep(15);
    if (options.signal.aborted) throw new G.Anthropic.APIUserAbortError();
  } }));
  const x = recorder();
  const r3 = await G.runPagePipeline(INPUT, { ...x.cb, onSection: (...args) => { x.cb.onSection(...args); ac.abort(); }, signal: ac.signal, generator: gen(c3) });
  assert.equal(r3, null);
  assert.equal(x.ev.error.kind, "aborted");
  assert.equal(x.ev.done, null);

  assert.throws(() => G.createGenerator({ model: "claude-opus-5-5" }), (e) => e.kind === "no_key");
  await assert.rejects(G.runPagePipeline({ prompt: "  " }, { generator: gen(mockClient(sampleHandler())) }), (e) => e.kind === "bad_request");
});

// ---------- the real SDK client, no network ----------

test("real SDK client: only api.anthropic.com, browser header, typed error mapping", async () => {
  const requests = [];
  let mode = "ok";
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_test" } });
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), headers: new Headers(init.headers), body });
    if (mode === "network") throw new TypeError("fetch failed");
    if (mode !== "ok") return json(Number(mode), { type: "error", error: { type: "x", message: `status ${mode}` } });
    const outline = body.system.includes("Generate a page title");
    const text = JSON.stringify(outline ? { title: "T", sections: [{ title: "A", content: "- one" }] }
      : { blocks: [{ type: "paragraph", text: "**One** fact." }] });
    return json(200, { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
  };
  const g = G.createGenerator({ apiKey: KEY, fetch: fakeFetch, maxRetries: 0, runId: "sdk" });
  const r = await G.runPagePipeline({ prompt: "Short page", nSections: 1 }, { generator: g });
  assertValidPage(r);
  assert.equal(requests.length, 2);
  for (const q of requests) {
    assert.equal(q.url, `${G.API_BASE_URL}/v1/messages`);
    assert.equal(new URL(q.url).host, "api.anthropic.com");
    // SDK 1.8.0 sends the API key as a bearer token (client.ts apiKeyAuth)
    assert.equal(q.headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(q.headers.get("anthropic-dangerous-direct-browser-access"), "true");
    assert.equal(q.body.model, "claude-opus-5-5");
    assert.equal(q.body.output_config.effort, "medium");
    assert.equal(q.body.output_config.format.type, "json_schema");
    assert.ok(q.body.output_config.format.schema.properties);
    for (const k of ["temperature", "top_p", "top_k", "thinking"]) assert.ok(!(k in q.body), k);
  }

  const kinds = { 401: "auth", 403: "permission", 404: "model", 429: "rate_limit", 529: "overloaded", 500: "server", 400: "bad_request", network: "network" };
  for (const [m, kind] of Object.entries(kinds)) {
    mode = m;
    await assert.rejects(g.outline({ prompt: "x" }), (e) => {
      assert.equal(e.name, "GenerateError");
      assert.equal(e.kind, kind, `mode ${m}`);
      assert.ok(!e.message.includes(KEY) && !String(e.detail ?? "").includes(KEY), "key never in messages");
      return true;
    });
  }
});

// ---------- recorded sample run ----------

test("sample run: hand-authored outputs pass the zod schemas, checkUdm and the Tiptap schema", () => {
  const outlineFmt = G.outputJsonSchema(G.outlineSchema);
  assert.ok(outlineFmt);
  assert.equal(G.outlineSchema.safeParse(SAMPLE.outline).success, true);
  const sectionZ = G.sectionSchema(manifest);
  const outline = G.normalizeOutline(SAMPLE.outline, { nSections: INPUT.nSections, runId: SAMPLE.runId });
  assert.equal(outline.sections.length, SAMPLE.sections.length);
  assert.equal(SAMPLE.timings.sectionMs.length, SAMPLE.sections.length);
  SAMPLE.sections.forEach((raw, index) => {
    const z = sectionZ.safeParse(raw);
    assert.equal(z.success, true, `section ${index}: ${z.error?.message}`);
    const s = G.toUdmSection(raw, { runId: SAMPLE.runId, index, outline, manifest });
    assert.equal(s.fallback, undefined, `section ${index}`);
    assert.deepEqual(s.notes, [], `section ${index}`);
    assert.deepEqual(G.checkSection(s), []);
    const { nodes, issues } = G.sectionNodes(s);
    assert.deepEqual(issues, []);
    schema.nodeFromJSON(docOf(nodes)).check();
  });
  const text = JSON.stringify(SAMPLE).toLowerCase();
  for (const meta of ["this page", "this section", "this report", "we will discuss"]) assert.ok(!text.includes(meta), `no meta-commentary: ${meta}`);
});

test("replaySampleRun streams the recorded run through the pipeline and builds a valid page", async () => {
  const { ev, cb } = recorder();
  const r = await G.replaySampleRun(cb, { speed: 1000 });
  assert.equal(ev.error, null);
  assert.equal(ev.outline.title, SAMPLE.outline.title);
  assert.deepEqual(ev.sections.map((x) => x.i), [0, 1, 2, 3, 4, 5]);
  assert.ok(r.sections.every((s) => !s.fallback));
  assert.equal(r.model, "claude-opus-5-5");
  assert.equal(r.udm.provenance.runId, "sample-qbr-emea");
  assertValidPage(r);
  const blocks = r.udm.sections.flatMap((s) => s.blocks.map((b) => b.type));
  for (const t of ["paragraph", "list", "callout", "chart", "table", "heading"]) assert.ok(blocks.includes(t), t);

  // deterministic: a second replay gives the same UDM (apart from the wall-clock createdAt)
  const r2 = await G.replaySampleRun({}, { speed: 1000 });
  const strip = (u) => ({ ...u, provenance: { ...u.provenance, createdAt: undefined } });
  assert.deepEqual(strip(r2.udm), strip(r.udm));

  // "Create slides from this page": the generated page converts into a deck
  const raw = JSON.parse(fs.readFileSync(path.join(ASSETS, "data/general.json"), "utf8"));
  const deck = G.udmToNewDeck(r.udm, G.hydrateTemplate(raw, "https://example.test/assets/playground/"));
  assert.equal(deck.deck.slides.length, 7, "title slide + 6 sections");
  assert.ok(!deck.issues.some((i) => i.level === "error"));

  // a section added in Outline review was never recorded: it gets its outline text
  const y = recorder();
  const r3 = await G.replaySampleRun({ ...y.cb, onOutline: (o) => ({ ...o, sections: [...o.sections.slice(0, 2), { title: "Hiring", content: "Two hires in DACH." }] }) }, { speed: 1000 });
  assert.equal(r3.sections.length, 3);
  assert.ok(!r3.sections[0].fallback && !r3.sections[1].fallback);
  assert.match(r3.sections[2].fallback.message, /recorded run/);
  assertValidPage(r3);

  // abort during the replay
  const ac = new AbortController();
  const z = recorder();
  const p = G.replaySampleRun({ ...z.cb, signal: ac.signal }, { speed: 10 });
  setTimeout(() => ac.abort(), 50);
  assert.equal(await p, null);
  assert.equal(z.ev.error.kind, "aborted");
});

// ---------- key handling ----------

test("API key: memory by default, sessionStorage only on opt-in, never logged", () => {
  G.clearApiKey();
  G.setApiKey(`  ${KEY}  `);
  assert.equal(G.getApiKey(), KEY);
  assert.equal(G.isKeyRemembered(), false, "no storage in plain node");

  const window = new Window({ url: "https://example.test/presenton-os/playground/" });
  const prev = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { value: window.sessionStorage, configurable: true });
  try {
    G.setApiKey(KEY);
    assert.equal(window.sessionStorage.length, 0, "not stored without opt-in");
    G.setApiKey(KEY, { remember: true });
    assert.equal(G.isKeyRemembered(), true);
    G.clearApiKey();
    assert.equal(window.sessionStorage.length, 0);
    assert.equal(G.getApiKey(), null);
    window.sessionStorage.setItem("udm-playground.anthropic-api-key", KEY);
    assert.equal(G.getApiKey(), KEY, "restored from this tab when remembered earlier");
    G.setApiKey(KEY, { remember: false });
    assert.equal(window.sessionStorage.length, 0, "unticking remember removes it");
  } finally {
    G.clearApiKey();
    if (prev) Object.defineProperty(globalThis, "sessionStorage", prev); else delete globalThis.sessionStorage;
    window.happyDOM.close();
  }
  assert.equal(G.maskKey(KEY), "sk-ant-…abcd");

  const dir = path.join(PLAYGROUND, "src/generate");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/console\.|localStorage|eval\(|new Function/.test(src), `${f}: no logging, localStorage or eval`);
  }
});

// ---------- bundling ----------

test("browser bundle: the SDK and zod load lazily in their own chunk", async (t) => {
  const outdir = path.join(PLAYGROUND, "test/.build/generate-browser");
  fs.rmSync(outdir, { recursive: true, force: true });
  const res = await esbuild.build({ ...common, entryPoints: { generate: path.join(PLAYGROUND, "src/generate/index.ts") }, outdir,
    splitting: true, minify: true, platform: "browser", chunkNames: "chunks/[name]-[hash]", metafile: true, write: true });
  const outs = Object.entries(res.metafile.outputs).filter(([f]) => f.endsWith(".js"));
  const entry = outs.find(([, o]) => o.entryPoint);
  const entryText = fs.readFileSync(entry[0], "utf8");
  assert.ok(!entryText.includes("anthropic-dangerous-direct-browser-access"), "SDK not in the entry chunk");
  const sdkChunk = outs.find(([f]) => fs.readFileSync(f, "utf8").includes("anthropic-dangerous-direct-browser-access"));
  assert.ok(sdkChunk, "SDK chunk exists");
  t.diagnostic(outs.map(([f, o]) => `${path.relative(outdir, f)} ${(o.bytes / 1024).toFixed(1)} KB`).join(", "));
});
