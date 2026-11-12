# UDM Playground: build spec

A browser demo, published on the tutorial site at `/playground/`, that runs the Part X design for real:
Presenton slide JSON and a live Tiptap 3.30.5 editor meet in the Unified Document Model (UDM) through the
prototype's adapters in `tutorial/prototypes/udm`. Static hosting only (GitHub Pages): no backend, no LLM.

## Primary flow: create a page from a prompt (Presenton's pipeline, for pages)

The user's goal: "Presenton creates a PPT from a prompt; the same way, we need to create Pages."
This is the playground's main feature. It mirrors Presenton's Standard pipeline step by step
(see content/presenton/08-standard-pipeline.md and 09-prompts-and-schemas.md), with the Tiptap page as the target:

| Presenton (slides) | Playground (pages) |
| --- | --- |
| `POST /presentation/create` (prompt, n_slides, tone, verbosity, language, instructions) | Page form: prompt, number of sections, tone, verbosity, language, instructions |
| Outline stream: `generate_ppt_outline` -> one Markdown outline per slide | Outline call -> page title + one outline per section (structured output), shown in an editable Outline review (rename, reorder, delete, add) |
| Structure: layout per slide from the template | Not needed for a flowing page; the target manifest (allowed block types from the editor schema) replaces layouts |
| Per-slide content call with the layout's JSON schema | Per-section content call whose JSON schema is built from the Tiptap target manifest (UDM blocks: heading, paragraph, list, quote, callout, table, chart with static data, divider) |
| Slides stream into the editor one by one | Sections stream into the Tiptap editor one by one (skeleton placeholder per section, replaced when it arrives) |
| Export PPTX/PDF | Download tiptap.json / Markdown / UDM, and "Create slides from this page" (UDM -> Presenton deck in a chosen template -> preview -> PPTX) |

LLM access on a static site: bring your own Anthropic API key, entered by the user in a key dialog, kept in memory
(optional "remember in this tab" uses sessionStorage), sent only to api.anthropic.com via the official
`@anthropic-ai/sdk` with `dangerouslyAllowBrowser: true`. Model `claude-opus-5-5` by default (selector also offers
`claude-sonnet-5-5` and `claude-haiku-5-5`); effort `medium` default. Structured outputs through
`client.messages.parse` with `output_config.format` (zod schemas via `zodOutputFormat` from
`@anthropic-ai/sdk/helpers/zod`), checking `stop_reason` (`refusal`, `max_tokens`) before using the output.
Verify every SDK call against the installed package source; never guess. Typed SDK error classes drive the
user-facing messages (invalid key, rate limit, overloaded, network). Numbers: content prompts follow Presenton's rule
(charts get a compact data table; estimates are labeled as illustrative) and tokens are not used (no live data in
the demo; static bindings only, marked as sample data).

Without a key, a "Watch a sample run" button replays a recorded generation (a committed JSON event log produced
by the same pipeline code path, hand-authored if no key is available at build time) so every visitor can see
the flow.

## Secondary flows (conversion)

1. **Presenton deck -> Tiptap page -> back to the deck**
   1. Pick a sample deck (a built-in Presenton template with ~8 curated layouts and their own sample content).
   2. Slides render with Presenton's real renderer (`templateV2UiToHtml`) in sandboxed iframes.
   3. "Convert to Tiptap": `presenton.slides` deserialize -> UDM -> negotiate -> `tiptap` serialize -> load into the editor.
   4. The user edits in Tiptap (text, lists, tables, chart data via the chart node).
   5. "Apply to slides": editor JSON -> `tiptap` deserialize -> UDM -> `presenton.slides` serialize back into the
      same layouts (provenance in `ext["presenton.slides"]`) -> slides re-render; changed slides are highlighted.
   6. Download: PPTX (demo exporter), Presenton slides JSON, UDM JSON, tiptap.json, Markdown.
2. **Tiptap page -> new Presenton deck**
   1. Start from a sample page (or blank) in the editor; insert headings, paragraphs, lists, tables and charts.
   2. "Generate slides": editor JSON -> UDM -> `presenton.slides` serialize in content mode (no provenance): choose a
      layout per section from the selected template by capacity, fill slots, report what did not fit.
   3. Preview and download as above.

Every stage is inspectable: a JSON inspector with tabs (Presenton ui, UDM, tiptap.json, Markdown, Loss report).

## Layout of the code

```
tutorial/playground/
  package.json          pinned deps; scripts: data, build, test
  SPEC.md               this file
  README.md             how to run and rebuild
  scripts/build-data.mjs   curated decks: copies selected layouts from ../../templates/*/template.json,
                           rewrites image URLs to local resized copies (macOS `sips`), writes
                           ../content/assets/playground/data/{index.json,<template>.json} and images/
  scripts/build.mjs        esbuild: src/main.ts -> ../content/assets/playground/app/ (ESM, code-split, minified,
                           sourcemaps off); aliases "@/..." to ../../servers/nextjs/... for the renderer;
                           copies vendored Chart.js + datalabels from ../../servers/nextjs/public/vendor
  src/main.ts              mounts the app into #udm-playground
  src/generate/          prompt-to-page pipeline: Anthropic client wrapper, prompts, zod schemas, outline and
                         section calls, progressive insertion, recorded sample run
  src/udm/bridge.ts        thin wrapper over the prototype registry (imports ../../prototypes/udm/...)
  src/render/              Presenton renderer wrapper (+ fallback renderer if the real one cannot bundle)
  src/editor/              Tiptap editor: extensions (same list as the prototype's tiptap adapter), node views,
                           toolbar, chart data dialog
  src/pptx/                demo PPTX exporter (pptxgenjs) from Presenton ui trees; lazy-loaded
  src/app/                 UI shell, state, inspector, downloads, toasts
  src/styles.css           bundled CSS (uses the site's --site-* tokens)
  test/                    node tests (happy-dom) for bridge, editor load/round-trip, pptx generation
tutorial/content/playground/index.md   the published page (hide navigation and toc)
tutorial/content/assets/playground/    build output committed to the repo (app/, data/, images/, vendor/)
```

## Module contracts (TypeScript, all ES modules)

```ts
// src/udm/bridge.ts
export type DeckSlide = { id: string; templateId: string; layoutId: string; title: string; ui: unknown };
export type Deck = { templateId: string; templateName: string; slides: DeckSlide[] };
export type Loss = { code: string; message: string; blockId?: string; detail?: unknown };
export function deckToUdm(deck: Deck): { udm: any; loss: Loss[] };
export function udmToTiptap(udm: any): { doc: any; loss: Loss[] };          // negotiated for the 'tiptap' adapter
export function tiptapToUdm(doc: any): { udm: any; loss: Loss[] };
export function udmToDeck(udm: any, base: Deck): { deck: Deck; loss: Loss[]; changedSlideIds: string[] }; // provenance mode
export function udmToNewDeck(udm: any, template: TemplateData): { deck: Deck; loss: Loss[] };             // content mode
export function udmToMarkdown(udm: any): { markdown: string; loss: Loss[] };
export function tiptapExtensions(): any[];   // the exact extension list the adapter's schema uses (editor must use it too)

// src/data.ts
export type TemplateSummary = { id: string; name: string; description: string; thumbnail: string; layoutCount: number };
export type TemplateData = { id: string; name: string; fonts: unknown; theme: unknown; layouts: Array<{ id: string; description: string; ui: unknown }> };
export function loadIndex(): Promise<TemplateSummary[]>;
export function loadTemplate(id: string): Promise<TemplateData>;
export function sampleDeck(t: TemplateData): Deck;     // curated order of layouts

// src/render/index.ts
export function renderSlide(container: HTMLElement, slide: DeckSlide, t: TemplateData, opts?: { highlight?: boolean }): Promise<void>;
// renders a 1280x720 slide scaled to the container width inside a sandboxed iframe (srcdoc, allow-scripts only)

// src/editor/index.ts
export type EditorHandle = { getJSON(): any; setJSON(doc: any): void; onChange(cb: () => void): void; destroy(): void; focus(): void };
export function createEditor(mount: HTMLElement, toolbarMount: HTMLElement, initial?: any): EditorHandle;

// src/pptx/index.ts (lazy)
export function exportPptx(deck: Deck, t: TemplateData, fileName: string): Promise<void>; // native text, shapes, images, tables, charts
```

## Requirements

- Use the prototype's adapters and core unchanged where possible; if a change is needed, make it in
  `tutorial/prototypes/udm` and keep `npm run all` there passing (re-run it).
- Editor extension list must equal the `tiptap` adapter's schema so every converted doc loads with
  `enableContentCheck: true` and no content error.
- Accessibility: keyboard reachable toolbar (role="toolbar", aria-pressed), labelled buttons, focus outlines,
  aria-live status for conversions, reduced motion respected, works at 375px wide (stacked layout).
- Light and dark mode via the site's `--site-*` CSS tokens and `[data-md-color-scheme]`.
- Bundle budget: initial JS <= 450 kB min+gzip excluding the lazily loaded PPTX exporter and Chart.js.
- Never use `eval`; sandbox rendered slides (`sandbox="allow-scripts"`, no same-origin).
- Clear labels that this is a demo: no LLM; the PPTX exporter is a demo built on pptxgenjs, not Presenton's
  closed export package.
