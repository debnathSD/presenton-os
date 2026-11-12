## Foundation (package, data, bridge, build, bridge tests)

- Content mode uses the prototype's own `chooseLayout` (to-presenton.mjs) via `udmToNewDeck`; no extra chooser was
  needed. Bridge-level choices: Presenton provenance is stripped first, empty untitled sections are dropped, and a
  document title (H1) gets its own title slide (`title_slide_added` loss). The capacity scorer does not prefer cover
  layouts for that slide (general picks `title_description_image`, not `title_intro`).
- None of the 24 curated layouts has a `text-list` element (only 35 lists exist in the whole corpus), so a bullet list
  in content mode reports `no_slot`; in provenance mode the cards come back as paragraphs/headings, not lists.
- `udmToDeck(udm, base, template?)` takes an optional template: sections with no linked slide (added or duplicated in
  the editor) get a layout from it, else from the layouts already in the deck. Linked sections are patched on top of
  the slide's current ui (per-slide catalog key `slide:<id>`), so repeated rounds stay byte-identical.
- `npm audit`: pptxgenjs 4.0.1 depends on image-size (2 high, DoS in JXL/HEIF/ICNS parsers). It is used by pptxgenjs
  only in Node to size images; the browser exporter does not reach it. Kept pinned; revisit when pptxgenjs updates.
- momentum fonts are the template's own TTFs (Lato Regular/Bold/Black, ~1.9 MB); no subsetting tool (fonttools/woff2)
  is installed here. Subsetting to Latin woff2 would cut ~1.7 MB. Anton is not used by the chosen layouts, so not copied.
- Template icons (`/static/icons/placeholder.svg`) and the replaceable image come from servers/fastapi/static.

## Render (src/render)

- Presenton's real renderer bundles: `templateV2UiToHtml` from servers/nextjs/lib/template-v2-json-to-html.ts via
  the `@` alias, no fallback renderer needed. Its transitive imports are plain TS (katex for math); only two needed
  shims, in `src/render/shims/`, wired by `src/render/aliases.mjs` (spread into the marked alias map in
  scripts/build.mjs; esbuild takes the longest matching key, so they beat `@`):
  - `@/utils/api`: the real `resolveBackendAssetUrl` reads `process.env`/`window.env` and rewrites same-origin URLs
    containing `/images/` to `/app_data/images/...`, which would break the copied images. The shim resolves against
    the playground assets root.
  - `@/lib/chart-browser`: re-exports the real module but overrides the two Chart.js script URLs (Presenton serves
    them from `/vendor/` at the site root) with live bindings set to `<assets root>/vendor/` before each render.
- `esbuild-shared.mjs` (`common`) does not include these aliases (not this module's file). Any other test bundle that
  imports src/render must spread `RENDER_ALIASES` into `alias` as test/render.test.mjs does; without them it still
  builds (the real api.ts bundles) but same-origin image URLs get rewritten.
- Fonts: the renderer only writes @font-face for font files (momentum's TTFs). Google Fonts css2 URLs (general,
  modern) are added as `<link rel="stylesheet">` in the slide document. Any @font-face pointing at Presenton's own
  `/vendor/fonts/` catalog is dropped (those files are not on the site); none occur in the curated decks.
- The sandboxed iframe has an opaque origin, so the momentum TTFs need CORS; GitHub Pages sends
  `Access-Control-Allow-Origin: *`. Not checked in a real browser here (no dev server per instructions).
- Size: src/render alone is ~391 KB min / ~115 KB gzip (includes katex, which the renderer imports for math runs, and
  the prototype's from-presenton.mjs, shared with the bridge). Consider importing src/render lazily if the initial
  budget gets tight.

## Editor (src/editor)

- `createEditor(mount, toolbarMount, initial?, opts?)` matches the spec contract; additions are backward-compatible:
  `setJSON` returns `false` (and keeps the current doc) when the new doc fails the schema check, `onChange` returns an
  unsubscribe function, and the handle has `onContentError(cb)` and `editor` (the Tiptap instance). Options:
  `placeholder`, `label`, `editable`, `onContentError`, `onChartError`, `loadChart` (tests pass a fake Chart.js).
  Content errors also fire a bubbling `udm-editor:content-error` DOM event on the mount.
- Schema = `bridge.tiptapExtensions()` exactly; view-only changes: `dataBlock`/`image` extended with `addNodeView`,
  a decoration-only placeholder plugin, and StarterKit configured with `trailingNode: false`. The trailing-node plugin
  would append an empty paragraph after a final chart/image/table, which the adapter reads back as a new block and the
  deck as a changed slide. The test checks the editor schema equals `getSchema(tiptapExtensions())`.
- `getJSON()` vs the converted doc: the adapter writes sparse attrs, Tiptap's `getJSON()` lists every attr with its
  default (e.g. `udmGroup: null`, `colspan: 1`). The test asserts equality with the schema-normalised input and with
  the input once default-valued attrs are dropped, plus identical UDM from `tiptapToUdm`. The app should not diff raw
  tiptap.json against the adapter output to detect edits; use the editor's `onChange`.
- `setJSON` builds a fresh EditorState (empty undo history, no `update` event), so loading a deck is not an edit.
- Chart previews: the vendored `vendor/chart-4.5.1.umd.min.js` is loaded with a `<script>` tag (resolved against the
  assets root) when the first chart scrolls near the viewport (IntersectionObserver). Colours come from `--site-*`;
  charts redraw when `<body data-md-color-scheme>` changes. The datalabels plugin is not loaded (not needed in the
  editor preview). Not checked in a real browser (no dev server per instructions); happy-dom has no canvas, so tests
  use a fake Chart class.
- Styles live in `src/editor/editor.css`; index.ts does not import it. The app stylesheet (src/styles.css) should
  `@import "./editor/editor.css";` (esbuild css loader bundles it).
- Size: src/editor/index.ts alone bundles to ~542 KB min / ~174 KB gzip, almost all of it Tiptap/ProseMirror plus
  the bridge's prototype adapters it imports for `tiptapExtensions()` (shared with src/udm and src/render).

## Generate (src/generate): prompt -> page

- Packages: `@anthropic-ai/sdk` 1.8.0 (latest stable, 2026-11-10) and `zod` 4.6.7 (SDK peer range `^3.25 || ^4`; its
  `helpers/zod` imports `zod/v4`, so `schema.ts` does too). Both load lazily: `createGenerator` imports `./llm` on the
  first call, so they are a separate chunk (~811 KB min / ~173 KB gzip, zod ~443 KB min of that). The `src/generate`
  entry itself adds ~14 KB min on top of the bridge it shares with the app. zod/mini cannot replace zod here because
  the SDK helper imports the full `zod/v4`.
- Verified in the installed SDK source (comments at the top of `llm.ts`): `dangerouslyAllowBrowser`, `messages.parse`
  + `output_config.format` + `zodOutputFormat`, `parsed_output`, `StopReason`, typed errors (incl. `OverloadedError`
  529, `APIConnectionTimeoutError`). SDK 1.8.0 sends the API key as `Authorization: Bearer <key>` (not `x-api-key`)
  and pins `anthropic-version: 2026-10-21`; `baseURL` is set explicitly to https://api.anthropic.com.
- `parseMessage()` throws on refusal / max_tokens (truncated JSON) before `stop_reason` can be read, so `llm.ts` wraps
  the zod format's `parse` to return null and keep the error; then `refusal` -> GenerateError (outline: run stops;
  section: outline-text fallback), `max_tokens` -> one retry at 21000 (the SDK refuses non-streaming above
  128000*10/60 = 21333), then fallback. No temperature/top_p/top_k/thinking params are sent.
- Not done: server-side refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) need the
  beta endpoint (`client.beta.messages.parse`); the spec asks for `client.messages.parse`, so a refusal shows a
  message instead of retrying on another model. Haiku 5.5 has no server-side fallback either. Worth adding for
  Opus/Sonnet if refusals show up in practice.
- No live call was made (no key here). The sample run (`sample-run.json`) is hand-authored in the exact schema shape
  and replayed through the same pipeline code; tests check it against the zod schemas, checkUdm and the Tiptap schema.
- zod v4 `toJSONSchema(..., { reused: "ref" })` emits `$defs`/`$ref` for the block union; the API supports them.
- App wiring expected (not this module's files): key dialog -> `setApiKey(key, { remember })`; Generate ->
  `runPagePipeline(input, { generator: createGenerator({ apiKey: getApiKey(), model, effort }), onOutline, ... })`.
  `onOutline` may return a Promise of the edited outline (Outline review) and gets `titleNodes` (H1 with artifact
  meta) to insert first; `onSection` gets ready-to-append `nodes` in outline order; `onDone` gets the full UDM and
  doc. Show `GenerateError.message` (kind: auth, rate_limit, overloaded, network, refusal, ...).

## App shell (src/app, src/main.ts, src/styles.css, content/playground/index.md)

- Modes (role=tablist, automatic activation): "Create a page from a prompt" (default), "Presenton deck to page",
  "Page to slides". One Tiptap editor is shared; each mode keeps its own workspace in the store (deck, last UDM,
  losses, issues, errors, saved editor doc, stage) and swaps it in on tab change. Store: `src/app/store.ts`.
- Prompt flow wiring: "Generate outline" calls `createGenerator(...).outline()` directly, the Outline review edits a
  local copy, and "Generate page" runs `runPagePipeline(input, { generator, outline: edited, ... })` (so the outline is
  reviewed between two user actions rather than inside `onOutline`). Sections are inserted as
  `[...titleNodes, ...nodes of every arrived section]` with `editor.setJSON` (schema-checked; editor read-only while
  streaming); pending sections are skeleton cards below the editor, outside the document. `onDone` swaps in the full
  doc. "Watch a sample run" calls `replaySampleRun(..., { speed: 2 })` (~20 s; `mountApp(el, { sampleSpeed })`
  overrides it) and pauses 1.5 s/speed on the recorded outline.
- The key dialog (`src/app/key-dialog.ts`) uses the key store in `src/generate/key.ts`, so there is one store.
- Deck mode: after "Apply edits", if slides were added or removed the page is reloaded from the new deck, so the
  next apply patches the right slide ids (the editor's section ids would otherwise point at the old deck).
- The slides pane imports `src/render` lazily (renderer + katex stay out of the first chunk). Initial JS after the
  final build: `app/main.js` ~597 KB min / ~197 KB gzip plus ~16 KB gzip of shared chunks, under the 450 KB budget.
- The page is not in `mkdocs.yml` nav (not this module's file): add `- Playground: playground/index.md` if it should
  appear in the navigation; MkDocs only logs an info line for pages outside nav. The wide layout uses
  `.md-grid:has(.udm-root)` (no `:has` support means the default 61rem column, still usable).
- Not checked in a real browser (no dev server per instructions): the happy-dom smoke test (test/app.test.mjs)
  covers mount, key dialog, sample run streaming, create slides, deck convert/edit/apply, page mode and downloads menu.
  Visual layout at 375 px and dark mode are CSS-only and untested. `test/pptx.test.mjs` had 4 failing tests at the
  time of writing (src/pptx, another module).

## PPTX exporter (src/pptx)

- `exportPptx(deck, t, fileName)` per the spec; also exported: `buildPptx(deck, t, {loadAsset?, assetsBase?, title?})`
  -> `{pptx, report}` (counts by kind, chart types per slide, warnings), `pptxBytes(pptx)`, `PPTX_MIME`,
  `EXPORT_FOOTER`. Lazy: only `src/app/pptx.ts` imports it dynamically; in a code-split build it is its own chunk
  (~397 KB min with pptxgenjs + jszip; katex is a shared chunk with src/render). Not in the initial bundle.
- Geometry reuses Presenton's own modules through the `@` alias: `layoutFlowChildren`/`intrinsicFlowSize`
  (components/slide-editor/layout/flowLayout, as the renderer and canvas editor use) for flex/grid,
  `normalizeRawTextMarkdownElement` for runs, `transformSvgMarkup` (lib/svg-color) to recolor SVG icons. The
  renderer's private helpers it needs (readBox, htmlElementSize, containerOverflowStyle, rounded-polygon and smooth
  curve sampling, chart data normalization and axis rules) are ported in src/pptx with comments naming them.
- pptxgenjs 4.0.1 writes an `<a:pPr>` before every run of a multi-run paragraph (schema allows one). `pptxBytes`
  reopens the package with JSZip and keeps only the first per paragraph (slides, layouts, masters, notes); the test
  asserts one leading pPr per paragraph in every part. `jszip` 3.10.2 (already installed as pptxgenjs's dependency)
  was added to dependencies, pinned.
- Downloads: browser = Blob + temporary `<a download>`; Node = `process.getBuiltinModule("node:fs")` (no static
  node import in the browser chunk). pptxgenjs `writeFile` is not used, so the fixed bytes are what users get.
- Simplifications (reported in `report.warnings`): rounded image corners are written square unless the radius makes
  a circle (`rounding`); raster PNG icons are recolored with a canvas in browsers only (in Node they keep their
  color; `icon_not_recolored`); math is written as LaTeX source; `polar_area` becomes a pie chart; infographics
  become a labelled text box (progress bar/gauge: two bars); rotated tables are written unrotated; text shadows on
  text boxes are kept, CSS `box-shadow` on images is not. Clip paths are reduced to their bounding box (a crop);
  the one rounded clip in momentum (`title_metrics_cards_8330`) loses its corner rounding. Fonts are referenced by
  name, not embedded (Poppins, Lato, Montserrat fall back if not installed).
- SVG images are embedded as SVG with a PNG preview; pptxgenjs generates that preview with a canvas, so in Node
  (tests) the preview is pptxgenjs's broken-image placeholder (PowerPoint uses the SVG; Quick Look shows the PNG).
- pptxgenjs numbers chart parts with a process-global counter (chart18.xml in a fresh deck is normal) and points
  slide rels at `/ppt/charts/chartN.xml` (absolute target); both valid.
- jszip's setImmediate polyfill contains `new Function(...)` (only reached when called with a string). It comes
  with pptxgenjs regardless; our code has no eval / new Function.
- Not checked in PowerPoint itself (no automation of the desktop app). Checked: well-formed XML in every part,
  native chart XML per type, and macOS Quick Look thumbnails of every sample slide (layout, crops of the rotated
  momentum ribbons, tables, cards look right; Quick Look does not draw charts).

## Integration

- Data + build run clean (`npm run data`, `npm run build`); no build errors across modules. Render aliases are in
  `scripts/build.mjs` and the bundle uses the shims (render test checks). Code split: pptx, llm (SDK + zod) and render
  are dynamic-import chunks; Chart.js loads from `vendor/` by script tag. Initial JS (main.js + its 4 static chunks):
  633 KB min / 208 KB gzip, under the 450 KB budget. No `eval` anywhere in the output; one `new Function` in the pptx
  chunk (jszip's setImmediate polyfill, noted above).
- `test/e2e.test.mjs` (new) imports the BUILT `content/assets/playground/app/main.js` in happy-dom with fetch serving
  the asset files and a mocked Anthropic Messages API (the real SDK runs): sample run -> validated page -> slides ->
  PPTX bytes (slide and chart counts); live flow with key dialog, outline, outline edits (rename, move, delete), five
  section calls, page in the edited order, slides + PPTX; deck mode convert -> paragraph edit via the editor API ->
  apply, checking the slide JSON changed only in that slot. It needs `npm run build` after source changes. pptxgenjs
  takes its browser path when `window` exists, so the test exposes happy-dom's `Image`/`FileReader` (real browsers have
  them). Zero console errors in the run.
- Found by e2e: the prototype's `runsFrom()` (to-presenton.mjs) writes bold/italic/underline explicitly on a rewritten
  run, so an edited run can gain `font.underline: false` where the template had no flag. Same rendering; left as is
  (prototype unchanged). The test allows only default-false flags on the edited run besides its text.
- Prototype `npm run all` passes (nothing in it changed; the run only rewrote timing numbers in REPORT.md, reverted).
- `mkdocs build --strict` passes (checked in a scratch venv with tutorial/requirements.txt). The playground page and the
  two vendor LICENSE .md files are outside nav (INFO only); the LICENSE files are rendered as pages, which is harmless.
- `node --test test/` (a directory argument) does not work on Node 22; use `npm test` (glob).

## Robustness and security review

Fixed (src/data.ts, src/render, src/pptx, src/generate, scripts):
- Assets root fallback was wrong: data.ts is bundled into a shared chunk (`app/chunks/…`), so `new URL("../",
  import.meta.url)` gave `…/playground/app/`. Now `rootFromBundleUrl()` cuts at the last `/app/`. `assetsRoot()` also
  reads `data-assets` (the attribute the page uses), not only `data-assets-root`. The page itself sets `data-assets`,
  so the published build was not affected; the fallback only matters without it.
- Slide srcdoc now carries a CSP `<meta>` (after `<meta charset>`): scripts, styles, images and fonts only from the
  assets folder (`https://debnathsd.github.io/presenton-os/assets/playground/`), plus fonts.googleapis.com /
  fonts.gstatic.com for the general and modern templates' Poppins/Montserrat (the site's theme already loads Google
  Fonts); `connect-src`, `frame-src`, `object-src`, `worker-src`, `media-src`, `base-uri`, `form-action` are `'none'`.
  Checked: every src/href/url() in all 24 sample slides is allowed; Chart.js 4.5.1 and datalabels need no eval.
  Sandbox stays `allow-scripts` only (opaque origin). Text is escaped by Presenton's renderer (escapeHtml per run);
  KaTeX runs with trust off (MathML output).
- Renderer: a container whose content was replaced elsewhere got a new iframe while the old ResizeObserver kept
  observing the detached wrapper. Now the old observer is disconnected, observers stop themselves when the slide is
  detached and re-observe on the next render, and `releaseSlide(container)` unloads a slide explicitly. Renderer
  error text on the fallback slide is cut to 300 characters.
- PPTX export: the default image loader only fetches from the assets root's origin (and blob:). A cross-origin image
  (for example pasted into the editor from another site) becomes a placeholder box with an `image_unavailable`
  warning instead of a third-party request.
- data.ts: readable errors for network failure, HTTP status and non-JSON responses; index and template files are
  shape-checked (template id, layouts list, layout ids; index thumbnails only from `images/<id>/…`).
- generate: the lazily imported SDK chunk is no longer cached when its fetch fails (the next call retries) and the
  failure maps to a `network` GenerateError. An exception while converting model output (blocks.ts or the
  UDM -> Tiptap step) now becomes that section's outline fallback (`invalid_output`) instead of failing the run.
  Model output is capped (`LIMITS` in blocks.ts: 40 blocks, 40 list items, 12 x 60 table, 40 categories x 8 series,
  200-character titles); cuts are listed in the section's notes.
- build-data.mjs: asset URLs that resolve outside the template folder or fastapi/static are skipped.

Reviewed, no change needed: API key is memory-only unless "Remember in this tab" (sessionStorage), never logged or
put in messages, sent only via the SDK with a fixed `baseURL` of https://api.anthropic.com (no cookies:
default `credentials`). stop_reason `refusal` / `max_tokens` / `model_context_window_exceeded` are checked before
`parsed_output` is used; output is validated three times (zod in the SDK, blocks.ts conversion + checkUdm, Tiptap
schema check) before it reaches the editor, and model output can only produce text, tables and static chart data
(no links, images or HTML). AbortSignal reaches the SDK call, the replay sleeps and the section workers.

Not changed (outside the modules this review could edit; src/app, src/editor):
- A page with many sections creates one thumbnail iframe per slide (lazy, but unbounded).
- An image pasted into the editor from another site is loaded by the editor's own image view in the page (the
  visitor's own action). Slides block it by CSP and the PPTX writes a placeholder.
- After "Apply edits" with no slides added or removed, the editor keeps its undo history; Undo then makes the page
  differ from the slides again (the hint shows unapplied edits), which is consistent but worth knowing.
- No hardening tests were added under test/ (not in the editable set); the fixes were checked with a scratch script
  (CSP on all sample slides, loader origin check, caps, conversion fallback, abort, observer cleanup) and the
  existing 81 tests.

## Accessibility and UX review (WCAG 2.2 AA)

Fixed (src/app, src/editor, styles):
- Prompt-to-page focus: focus no longer drops to <body> when the focused button is disabled or its card is hidden.
  Generate outline / Watch a sample run / Generate page move focus to "3. Writing the page" (Cancel is the next Tab
  stop); a ready outline focuses "2. Review the outline"; the finished or cancelled run focuses "Your page is ready";
  a failed run with nothing written goes back to the outline heading or the prompt. Focus is only moved when it was
  on <body> or inside the create panel (`moveFocus` in app/dom.ts), never taken from the editor or the inspector.
- ctx.run puts focus back on the control that started a run (picker cards, Convert, Apply, PPTX, Create slides)
  once it is enabled again. The PPTX button no longer jumps focus to the Download menu.
- The sample run hid its progress card (and Cancel) during the 1.5 s outline pause; it now stays.
- Key dialog opened by Generate outline / Generate page returns focus to that button, not "API key…".
- Empty prompt: inline error (#udm-prompt-error) tied by aria-describedby, cleared on input; label says "(required)".
- Mode tabs had no accessible name below 48rem (long label display:none, short label aria-hidden). Fixed.
- aria-busy moved from the app root to the workspace: on the root it also covered the status bar live region and
  could hold back the per-section announcements.
- Toasts: the container is a polite live region from the start (role=status nodes inserted later are often not
  announced); errors keep role=alert. Timers pause on hover/focus; focus returns where it came from on dismiss;
  close button is 24px+.
- Editor: setEditable() emits "update", not "transaction", so the toolbar stayed enabled (and could change the doc)
  while sections streamed in, and chart "Edit data" / image "Alt text" buttons drawn during the lock stayed disabled
  after it (the chart dialog was unreachable on a generated page). Toolbar and node views now follow "update".
  The editor gets aria-readonly while locked.
- Keyboard route out of the text: Esc or Alt+F10 moves to the toolbar, Esc goes back; visible hint under the editor
  (aria-describedby). Tab keeps its list/table meaning; arrow keys leave a table.
- Chart data / alt text dialogs: Save re-renders the card, so the opener was disconnected and focus was lost; focus
  now goes to the card's new button (fallback: the editor).
- Slide strip: focus stays on the selected thumbnail after the strip re-renders; thumbnail iframes are aria-hidden
  (the button has the name). Main slide iframe title "Slide N: title" was already set.
- Inspector: the scrollable <pre> is a named region; the Loss report badge reads "Loss report, 3 items".
- Toolbar heading buttons are named "Heading 1 (H1)" (visible label in the name, 2.5.3).
- Language options carry lang attributes.
- CSS: danger button border at full colour (was 2.5:1 in light); focus ring offset outside the selected ring on
  cards/thumbnails; scroll-padding so focused controls are not hidden under the header / sticky status bar (2.4.11);
  editor pane overflow: clip (overflow: hidden made the pane the scroll container, so the toolbar never stuck);
  Download menu opens rightwards at <= 48rem (it overflowed the left edge at 375px); dialog actions wrap; chart data
  tables scroll horizontally.

Checked, no change: --site-* text pairs are 5.5:1 or more (muted on surface-2 5.54 light, 6.31 dark), input
boundaries 3.3:1 (dark on surface-2 3.03:1), focus ring 6.3:1 / 8.8:1; reduced motion handled by the media query and
the scroll behaviour check; native <dialog>.showModal() gives the focus trap and Escape.

Not done / not verified:
- No browser was opened: layout at 375px, dark mode rendering, real screen reader output and the native dialog focus
  trap are reasoned from the code, not observed.
- The fixes were checked with a scratch happy-dom test (focus through the sample run, aria-readonly and toolbar lock,
  Edit data enabled after generation, chart dialog focus restore, Esc/Alt+F10, thumbnail focus, tab names, live
  regions). It is not in test/ (outside the editable set); it fails on the old node-view code and passes now.
  Suggested home: test/a11y.test.mjs.
- The skeleton scrollIntoView during generation can scroll the page while the visitor reads elsewhere; left as is.
- Error toasts and the status bar both announce a failure (once assertive, once polite).
