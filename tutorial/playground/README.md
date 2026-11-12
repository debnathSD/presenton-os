# UDM Playground

A browser demo for Part X of the tutorial, published at `/playground/` on the tutorial site
(`tutorial/content/playground/index.md`). Presenton turns a prompt into a deck: an outline first, then one slide at a
time. The playground runs the same pipeline with a **Tiptap page** as the target, so a prompt becomes a page whose
sections stream into a live editor. Pages and Presenton decks then convert into each other through the Unified
Document Model (UDM), using the prototype adapters in `tutorial/prototypes/udm`.

Static hosting only (GitHub Pages): there is no backend. Live generation calls the Anthropic API directly from the
visitor's browser with the visitor's own key.

## What it does

Three modes share one Tiptap 3.30.5 editor, a slide pane and a JSON inspector (Presenton JSON, UDM, tiptap.json,
Markdown, loss report).

1. **Create a page from a prompt** (default). Mirrors Presenton's Standard pipeline:
   - Prompt form: prompt, number of sections, tone, verbosity, language, instructions, model, effort.
   - Outline call: page title plus one Markdown outline per section (structured output), shown for review: rename,
     reorder, delete, add.
   - Section calls: one structured call per section, with a JSON schema built from the Tiptap target manifest
     (heading, paragraph, list, quote, callout, table, chart with static data, divider). Sections stream into the
     editor in outline order, with skeleton placeholders for the rest.
   - "Create slides from this page": UDM to a new Presenton deck in a chosen template, preview, PPTX download.
   - **Watch a sample run** replays a recorded generation through the same pipeline code, with no key.
2. **Presenton deck to page**: pick a sample deck, convert it to a Tiptap page, edit, apply the edits back into the same
   slide layouts. Changed slides are highlighted.
3. **Page to slides**: start from a sample page (or blank), generate a new deck in a chosen template; what did not fit
   is listed in the loss report.

Downloads: PPTX (demo exporter), Presenton JSON, UDM JSON, tiptap.json, Markdown.

## Rebuild

Node 22 or newer. All commands run in `tutorial/playground/`.

```sh
npm ci          # pinned dependencies (exact versions in package.json / package-lock.json)
npm run data    # curated decks + images -> ../content/assets/playground/{data,images}/ (uses macOS `sips` to resize)
npm run build   # esbuild -> ../content/assets/playground/app/ and vendored Chart.js -> vendor/
npm test        # node --test test/*.test.mjs (happy-dom; about 11 s)
```

The build output under `tutorial/content/assets/playground/` is committed, so the site deploy (`mkdocs build
--strict`) needs no Node step. Rebuild and commit it after changing anything in `src/`. `test/e2e.test.mjs` loads that
committed `app/main.js`, so run `npm run build` before `npm test` after a source change.

Sizes after the current build (gzip level 9):

| Output | Min | Gzip | Loaded |
| --- | --- | --- | --- |
| `app/main.js` + 4 shared chunks | 633 KB | 208 KB | on page load (budget 450 KB gzip) |
| `app/main.css` | 30 KB | 6 KB | on page load |
| `chunks/render-*.js` + shared `chunk-K2CYDFXY.js` (Presenton renderer, katex) | 392 KB | 116 KB | when slides are shown |
| `chunks/llm-*.js` (Anthropic SDK + zod) | 811 KB | 173 KB | on the first live generation |
| `chunks/pptx-*.js` (pptxgenjs + jszip) | 397 KB | 136 KB | on the first PPTX download |
| `vendor/chart-4.5.1.umd.min.js` (+ datalabels 13 KB) | 204 KB | 69 KB | when a chart is shown |
| `data/` + `images/` | 2.45 MB | | per deck, on demand |

## Architecture

```
src/main.ts           mounts the app into #udm-playground; assets root from data-assets on the mount element
src/app/              UI shell: modes, store, slide pane, inspector, key dialog, downloads, status/toasts
src/generate/         prompt -> page: prompts (adapted from Presenton's), zod schemas, outline and section calls
                      (lazy llm.ts: @anthropic-ai/sdk messages.parse + output_config.format), pipeline, sample run
src/udm/bridge.ts     thin wrapper over the prototype registry: deck <-> UDM <-> Tiptap / Markdown, new decks
src/editor/           Tiptap editor on exactly the adapter's extension list; chart/diagram/image node views, toolbar,
                      chart data dialog
src/render/           Presenton's real renderer (templateV2UiToHtml, via the "@" alias into servers/nextjs) in
                      sandboxed iframes; two browser shims (src/render/shims) for asset and Chart.js URLs
src/pptx/             demo PPTX exporter on pptxgenjs, from Presenton ui trees (lazy)
src/data.ts           loads data/index.json and data/<template>.json relative to the assets root
scripts/              build-data.mjs, build.mjs, esbuild-shared.mjs (one copy of every package; "@" alias)
test/                 node:test + happy-dom: bridge, editor, render, generate, pptx, app shell, and e2e on the build
```

Data flow:

```
prompt --outline call--> outline --review--> section calls --UDM blocks--> checkUdm --> udmToTiptap --> editor
editor JSON --tiptap adapter--> UDM --presenton.slides adapter--> deck (same layouts, or new layouts by slot capacity)
deck --presenton.slides adapter--> UDM --tiptap adapter--> editor
```

Nothing in `servers/` is modified; the renderer and some layout helpers are imported from it at build time. The
prototype in `tutorial/prototypes/udm` is used unchanged (`npm run all` there passes).

## Limitations

- **Live generation needs your own Anthropic API key.** It is kept in memory (sessionStorage only if you tick
  "remember in this tab") and sent only to `https://api.anthropic.com`. Requests are billed to your account. Without a
  key, "Watch a sample run" replays a hand-authored recording (`src/generate/sample-run.json`) through the same
  pipeline code; its figures are illustrative. The live path is tested against a mocked API, not a real call.
- A refusal stops the outline, or falls back to the outline text for one section; server-side refusal fallbacks
  (beta endpoint) are not used.
- **The PPTX exporter is a demo** built on pptxgenjs, not Presenton's export package. It writes native text, shapes,
  images, tables and charts, but simplifies some things: polar area charts become pie charts, infographics become
  labelled text boxes, math is written as LaTeX text, rounded image corners are square unless circular, clip paths are
  reduced to crops, fonts are referenced by name (not embedded).
- **Slide rendering** uses Presenton's own renderer, so slides look as they do in Presenton, with these differences:
  Chart.js loads from this site's `vendor/` folder instead of Presenton's `/vendor/`; Google Fonts for the general and
  modern templates are added as stylesheet links; `@font-face` rules pointing at Presenton's `/vendor/fonts/` catalog
  are dropped (none occur in the sample decks); momentum's Lato TTFs load from the site and need CORS inside the
  sandboxed iframe (GitHub Pages sends it).
- The editor's chart previews use Chart.js with the site's colours, not the template's chart styling.
- Content mode cannot place bullet lists: none of the 24 curated layouts has a list slot, so lists are reported as
  `no_slot`. A page's H1 gets its own title slide, which may use a non-cover layout.
- Applying an edit rewrites the runs of the edited slot; a style flag the template left out (for example
  `underline`) can come back as its default `false`. Rendering is unchanged.
- Not checked in a real browser in this build: the tests run in happy-dom (no canvas, no layout), so chart drawing,
  font loading, the 375 px layout and dark mode are untested there.
