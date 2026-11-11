# Feasibility analysis

<div class="chapter-meta" markdown>
**Reads:** `servers/fastapi/models/sql/slide.py`, `servers/fastapi/models/sql/presentation.py`, `servers/fastapi/api/v1/ppt/endpoints/presentation.py`, `servers/fastapi/templates/v2/models/elements.py`, `servers/fastapi/templates/v2/schema.py`, `servers/nextjs/components/slide-editor/text/TiptapInlineTextEditor.tsx`, `servers/nextjs/components/slide-editor/importing/template-v2-import.ts`, `tutorial/prototypes/udm/core/negotiate.mjs`, `tutorial/prototypes/udm/adapters/presenton/to-presenton.mjs`, `tutorial/prototypes/udm/adapters/tiptap/index.mjs`, `tutorial/prototypes/udm/scripts/validate.mjs`  ·  **Builds on:** [Part X landing](index.md), [From template to schema to slide](../presenton/17-template-to-slide.md), [Artifact Spec and targets](../ai-component/62-artifact-spec-and-targets.md)  ·  **Time:** ~35 min
</div>

What you will learn: whether a Presenton deck and a Tiptap page can really share one Unified Document Model (UDM), and under which conditions. You will compare the four JSON forms a Presenton deck takes with Tiptap's JSON, see why "both are JSON" is necessary but not sufficient, walk through the element-by-element mapping and the losses in both directions, decide which Presenton form the adapter must read, look at the Smart-mode HTML path, and then check every claim against a prototype that ran on all 383 bundled layouts. The chapter closes with a verdict per scenario and a risk table. Throughout, Presenton PPT and Tiptap are the first two adapters of a generic contract; nothing in the analysis depends on Tiptap being the target.

!!! info "How to read the numbers"
    Every number in this chapter comes from `tutorial/prototypes/udm/REPORT.md`, which `npm run validate` generates from the 383 layouts in `templates/*/template.json`. Run `npm ci && npm run all` in `tutorial/prototypes/udm` to reproduce them. Statements about behavior the prototype did not exercise are marked **unverified**.

## Step 1: The four JSON forms of a Presenton deck

A Presenton deck lives in two SQL tables, `presentations` and `slides`, and almost every column that matters is JSON. For the current product (`version="v2-standard"`) a deck exists in four JSON forms at once. A fifth form, the Smart-mode HTML string, is not JSON and gets its own step (Step 7).

| # | Form | Where it lives | Shape | Written by | Read by |
| --- | --- | --- | --- | --- | --- |
| 1 | Outline | `presentations.outlines` (`servers/fastapi/models/sql/presentation.py:51`), plus `presentations.structure` (`:66`) | `{"slides":[{"content":"<markdown>"}]}` (`servers/fastapi/models/presentation_outline_model.py:8-28`) and a layout index per slide | outline and structure LLM calls | slide content generation |
| 2 | Content | `slides.content` (`servers/fastapi/models/sql/slide.py:26`) | a dict keyed by component id and element name, shaped by the layout's JSON schema (`servers/fastapi/templates/v2/schema.py:257`), plus `__speaker_note__` and asset keys | `get_slide_content_from_type_and_outline` (`servers/fastapi/utils/llm_calls/generate_slide_content.py:229`) | the hydrator, once |
| 3 | UI tree | `slides.ui` (`servers/fastapi/models/sql/slide.py:30`) | the Template v2 element tree: components, elements, runs, chart data, infographic data, positions | `_apply_template_content_to_ui` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:575`), the editor, chat tools | the HTML renderer, the editor, export |
| 4 | Editor deck | browser memory | the editor's `Deck` (`servers/nextjs/components/slide-editor/types.ts:675`) | `adaptGeneratedTemplateV2PresentationToDeck` (`servers/nextjs/components/slide-editor/importing/template-v2-import.ts:135`), the "presentation adapter" Presenton uses today | the Konva editor |

Two details shape the adapter design. The deck response that the frontend receives drops `layout` and `structure` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:343-344`), and `outlines` is not a field of that response, so a client never sees the template payload together with the deck. And legacy v1 decks are refused by the frontend (`servers/nextjs/app/(presentation-generator)/presentation/hooks/usePresentationData.ts:33-41`), so an adapter needs to support only the v2 `ui` tree.

Here is one card from the `dynamic` template's `center_title_cards_4771` layout in forms 2 and 3. The content form below is an illustration built from the schema that `get_template_schema` produces for this layout; the UI form is a real excerpt.

```json title="slides.content for the card (illustration; keys from get_template_schema)"
{
  "three_card_row": {
    "flx_card_elements": [
      { "card_heading_text": "Heading",
        "card_large_value": "$1 / Month",
        "card_feature_list": ["Lorem ipsum dolor sit amet, consectetur", "..."] }
    ]
  }
}
```

```json title="tutorial/prototypes/udm/examples/simple-cards-with-list/1-presenton-slide.json (excerpt)"
{
  "type": "text",
  "position": { "x": 50.77, "y": 44.41 },
  "size": { "width": 230.04, "height": 31.96 },
  "font": { "size": 23.53, "family": "Montserrat Semi-Bold", "color": "#FFFFFF", "bold": true },
  "runs": [ { "text": "Heading", "font": { "size": 23.53, "family": "Montserrat Semi-Bold", "bold": true } } ],
  "decorative": false,
  "name": "card_heading_text",
  "max_length": 17,
  "min_length": 4
}
```

The content form says *what* goes in each slot and nothing else. The UI form says what, where and how it looks, and it carries the slot limits.

## Step 2: Tiptap JSON in one page

Tiptap stores a document as ProseMirror JSON. The root is `{"type":"doc","content":[...]}`, every node has a `type` that must exist in the editor's schema, formatting is a list of **marks on text nodes** rather than wrapper elements, and attributes live in `attrs`. StarterKit 3.x provides `paragraph`, `heading` (levels 1 to 6), `bulletList`, `orderedList`, `listItem`, `blockquote`, `codeBlock`, `horizontalRule` and `hardBreak`, plus the marks `bold`, `italic`, `strike`, `code`, `underline` and `link`. Tables (`table > tableRow > tableHeader | tableCell > paragraph`) and images come from separate packages.

Presenton already ships Tiptap 3.30.5 (`servers/nextjs/package.json:40-44`) and already converts its text runs to and from Tiptap JSON: `textRunsToTiptapContent` (`servers/nextjs/components/slide-editor/text/TiptapInlineTextEditor.tsx:751`) and `tiptapContentToTextRuns` (`:798`), with a custom `runStyle` mark (`:50`) and a `latexRun` inline node (`:87`). That editor turns off headings, lists and blockquotes (`:267`), so it uses Tiptap as an **inline-run profile**: one paragraph of styled runs inside a slide element. A Tiptap page is a different **schema profile** of the same format, with headings, lists, tables, images and block nodes. This is why the Tiptap adapter takes its extension list as input and derives its capabilities from it (`tutorial/prototypes/udm/adapters/tiptap/index.mjs:13`), instead of hard-coding one schema.

## Step 3: Why "it is all JSON" is necessary but not sufficient

JSON on both sides removes the hard parts of an integration: no binary formats, no parsing of rendered output, and conversion as a pure function on the server. That part of the team's intuition holds. It is not sufficient, for five reasons.

1. **Both sides are schema-bound.** A Template v2 element is one member of a Pydantic union (`servers/fastapi/templates/v2/models/elements.py:624`) with type-specific fields. A Tiptap document must match the schema built from the editor's extensions. The prototype confirmed Tiptap's behavior on bad input with seven negative controls (`tutorial/prototypes/udm/scripts/validate.mjs`): an unknown node type is rejected, text directly inside `doc` is rejected, a list item that starts with a heading is rejected, an empty text node is rejected, a `code` mark combined with `bold` is rejected, a heading level of 9 passes the schema check and needs an explicit range check, and an attribute the schema does not know is **silently dropped**. JSON that "looks right" is not enough; the output must be checked against the real schema.
2. **Positioned layout versus flow.** A slide is a 1280 by 720 canvas (`servers/nextjs/lib/template-v2-json-to-html.ts:153-154`). Element positions are relative to their parent, and flex and grid children have no position at all. Reading order is not stored anywhere: it has to be computed. A Tiptap document is an ordered sequence, and order *is* the structure.
3. **Slot-keyed versus sequence.** The content form is keyed by component id and element name, and every slot has capacity limits (`max_length`, `min_length`, item and row limits). A document has no slots and no limits. Going from a document to a slide means choosing a layout and assigning blocks to slots.
4. **Styling versus marks.** Presenton text is a list of runs, each with a full font (family, size, color, bold, italic, underline, spacing). Tiptap has a few boolean marks. Size and color differences inside one element have no neutral home.
5. **Implicit versus explicit semantics.** Presenton has no heading level. "This is a title" must be inferred from element names (`main_heading`, `card_title`), font size rank and position. Charts carry their data inline in the slide; Tiptap has no chart node at all.

So the mapping is schema to schema, not JSON to JSON. Going through a canonical model with explicit semantics, plus one adapter per side that knows its own schema, is what makes the conversion predictable. That is the UDM.

## Step 4: Element-by-element mapping

The table lists every Template v2 content element and where it ends up in the UDM and in three targets. "Page" is the Tiptap page profile (StarterKit, TableKit, Image, one `dataBlock` atom and the `udmAttrs` global attributes, `tutorial/prototypes/udm/adapters/tiptap/extensions.mjs:52`). "Basic" is plain StarterKit (`:54`).

| Presenton element | UDM | Tiptap page | Tiptap basic | Markdown |
| --- | --- | --- | --- | --- |
| A slide | `Section` with `title`, `role`, `notes`, `summary`; template, layout and title slot in `ext["presenton.slides"]` | `heading` level 2 (or `horizontalRule` if untitled) with `udmKind: "section"`; section metadata in `udmMeta`, `ext` in `udmExt` | `heading` level 2; role and `ext` dropped | `## Title` |
| Largest heading-like `text` outside a group | `Section.title` | same as above | same | same |
| Other heading-like `text` | `heading` level 1 or 2 | `heading` 3 to 5 | `heading` 3 to 5 | `###` to `#####` |
| Body `text` | `paragraph`; `"\n"` is a line break | `paragraph` with `hardBreak` | same | paragraph |
| `text` named like a label, value or subtitle | `paragraph` with `role` (`label`, `kpi`, `subtitle`, `takeaway`) | `paragraph` with `udmRole` | role dropped | role dropped |
| Run bold, italic, underline | marks `bold`, `italic`, `underline`, recorded as differences from the element's own font | marks | marks | `**`, `*`; underline dropped |
| Run color or size different from the element | not carried | not carried | not carried | not carried |
| LaTeX run | mark `math` | negotiated to `code` mark | `code` mark | inline code |
| `text-list` | `list`, `ordered` from `marker == "number"`, flat | `bulletList` or `orderedList` | same | `-` or `1.` list |
| `table` | `table` block plus a `static` binding holding columns and rows | `table`, header row as `tableHeader` | degraded to a list | GFM table |
| `chart` | `chart` block (`chartType`, title, axes) plus a `static` binding holding categories and series | `dataBlock` with `kind: "chart"` and the binding definition | degraded via table to a list | degraded to a GFM table |
| Non-decorative `image` | `image` with `url`, `prompt`, `alt`, `kind` (`icon` when `is_icon`) | `image`; kind, prompt and caption in `udmMeta` | link paragraph | image; kind and prompt dropped |
| `infographic` | `diagram` with a neutral `diagramKind`, `items` or `range`; type-only fields in `ext` | `dataBlock` with `kind: "diagram"` | list, or paragraph for progress and gauge | same as basic |
| `group` of content (a card) | `Block.group` shared by the card's blocks | `udmGroup` | dropped | dropped |
| `speaker_note` | `Section.notes` | `blockquote` with `udmKind: "notes"` at the end of the section | dropped | dropped |
| Decorative images and text, vectors, containers, backgrounds, theme | not in the UDM (geometry and styling stay in the host) | none | none | none |

Two custom Tiptap pieces are enough for the whole catalog, and neither is Presenton-specific. `dataBlock` (`tutorial/prototypes/udm/adapters/tiptap/extensions.mjs:21`) is one atom for every data-bearing block: chart, diagram, metric, live table and embed. The UDM block type is an attribute, and the node holds the binding *definition* only. `udmAttrs` (`:41`) adds `udmId`, `udmGroup`, `udmRole`, `udmKind`, `udmMeta` and `udmExt` to every top-level node, so ids, groups, roles and other adapters' `ext` survive a trip through the editor.

## Step 5: Lossiness in both directions

### Presenton to UDM to Tiptap page

| Kept exactly | Kept, but only in `ext` | Lost (and reported) |
| --- | --- | --- |
| All text, list items, table cells, chart categories and series, chart type, title and axes, image URL and prompt, infographic items and ranges, speaker notes, outline summary | Slot path of every block, layout id, template id, title slot, infographic-only fields | Geometry and styling by design; per-run color and size differences inside one element; LaTeX becomes a `code` mark until `@tiptap/extension-mathematics` is added (the corpus has no LaTeX, so only the shared fixtures exercise this path) |

For the Tiptap page profile, negotiation reported no losses and the serializer reported none, on all 383 layouts.

### Tiptap page back to Presenton

| Kept exactly | Adjusted | Lost (and reported) |
| --- | --- | --- |
| Edited text, titles, list items, table cells and chart series land in their original slot; untouched slots stay byte-identical | Edited text takes the slot's first-run font (`tutorial/prototypes/udm/adapters/presenton/to-presenton.mjs:146`); slots with no block are blanked so template sample text never leaks | A second color or size inside an edited element (44 elements); a block with no free slot (`no_slot`); captions with no slot (`caption_dropped`); text over `max_length` is kept but flagged |

### Targets that cannot carry ids or `ext`

Markdown and a StarterKit-only editor cannot store slot provenance, so the way back to Presenton is positional. The losses are larger and are all reported by negotiation:

| Loss code (count over 383 layouts) | Tiptap basic | Markdown |
| --- | --- | --- |
| `ext_dropped` | 4,807 | 4,807 |
| `block_degraded` | 891 | 164 |
| `section_role_dropped` | 383 | 383 |
| `groups_dropped` | 310 | 310 |
| `roles_dropped` | 303 | 303 |
| `caption_to_paragraph` | 0 | 29 |
| `mark_dropped` | 0 | 1 |
| Serializer: `image_meta_dropped` | 0 | 607 |
| Serializer: `line_break_in_title` | 0 | 39 |

## Step 6: Which Presenton form the adapter must read

The `presenton.slides` adapter reads and writes **`slides.ui`**. The other forms are hints at most.

- **`ui` is what users see and change.** It is rendered, edited and exported. The Konva editor writes it back through `PATCH /slide_update` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:2585`), and chat tools edit it directly through `servers/fastapi/services/chat/slide_ui_helpers.py`.
- **`content` goes stale.** It is copied into `ui` once by the hydrator. After an edit on the canvas or through chat, `content` no longer matches the slide. Chat also has a second hydration implementation (`servers/fastapi/services/chat/memory_layer.py:3321`, `:3382`), so `content` is not even produced by one code path.
- **`ui` carries the semantics the UDM needs.** Element type, `name`, `decorative`, `is_icon`, text runs with fonts, the list marker, the table header row, chart data and infographic data are all in `ui`. The content form drops decorative elements and per-run fonts.
- **The prototype proves it.** Reading `ui` captured 100% of 3,582 text elements, 607 images, 113 charts, 51 infographics, 35 lists and 7 tables, and produced a valid UDM for 383/383 layouts.

The other forms still help. The outline becomes `Section.summary` and the speaker note becomes `Section.notes`. The layout's content schema (from `get_template_schema`) is the natural source of slot limits for fitting text. The editor `Deck` is a frontend view model derived from `ui` and is not a stable persisted form, so no adapter reads it.

!!! warning "Gotcha"
    This differs from Part IX, where the slides target writes per-layout `content` and has no reverse direction (see [Artifact Spec and targets](../ai-component/62-artifact-spec-and-targets.md), Step 7). Writing `content` is still a valid way to *generate* a new slide through Presenton's existing hydrator. For *round trips*, the adapter must patch `ui`, because that is the only form that survives edits.

## Step 7: The Smart-mode HTML path

Smart mode does not produce structured slides. `generate_smart_presentation` (`servers/fastapi/utils/llm_calls/generate_smart_presentation.py:733`) returns HTML, and each slide is stored with `layout_group="smart-html"`, `content={"title": ...}` and the full HTML in `html_content` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:2060-2067`). Edits go through `POST /slide/edit-html` (`servers/fastapi/api/v1/ppt/endpoints/slide.py:135`), which rewrites the HTML. `slides.ui` is null for these slides.

Options for an adapter:

| Option | What it means | Status |
| --- | --- | --- |
| Treat Smart decks as out of scope for the UDM | Offer "convert to a standard deck" by regenerating, or export only | No new code |
| One-way import by parsing the HTML | Parse `html_content` into UDM blocks (headings, paragraphs, lists, images); charts drawn in HTML would not come back as data | **Unverified**; the prototype does not cover Smart mode |
| Round trip | UDM back into free-form HTML slides | Not feasible without an LLM call; there is no slot structure to patch |

Verdict: Smart-mode slides stay outside the round-trip guarantee. If a one-way import is needed, it is a separate deserializer inside the `presenton.slides` adapter (or a separate adapter) and must report its losses like any other.

## Step 8: The prototype and its method

The prototype in `tutorial/prototypes/udm/` was built to answer one question with measurements rather than opinions: can one target-agnostic model carry Presenton slides and Tiptap pages both ways, and does a third and fourth target need only an adapter? It touches no Presenton server code. It runs in Node 22 with Tiptap 3.30.5 (the version Presenton ships), `marked` 17.0.5 and TypeScript 5.9.3 for a strict type check of the UDM types and the adapter contract.

| Part | Files | Lines of code |
| --- | --- | --- |
| Core: UDM types, contract, runtime helpers, negotiation, registry, conformance kit, fixtures | `core/` | 761 |
| `presenton.slides` adapter | `adapters/presenton/` | 590 |
| `tiptap` and `tiptap.basic` adapter (one factory, two extension lists) | `adapters/tiptap/` | 349 |
| `markdown` adapter | `adapters/markdown.mjs` | 181 |
| `plain-text` adapter (write-only) | `adapters/plaintext.mjs` | 33 |

The method had four parts.

1. **Corpus run** (`scripts/validate.mjs`). Every one of the 383 layouts in the 16 bundled templates becomes a one-slide deck with the layout's own sample content. Each deck goes Presenton to UDM, through `negotiate` and `serialize` for every target, through `validateNative`, back through `deserialize`, and back into the same Presenton layout. Tiptap documents are also loaded into a headless `Editor` with `enableContentCheck: true`, and the test requires no `contentError` and an unchanged `getJSON()`.
2. **Scripted edit.** For the Tiptap page profile, every text node, list item, table cell and chart series in `tiptap.json` is edited as an editor would (text gets ` [edited]` appended, 9 characters), mapped back, and checked slot by slot.
3. **Conformance kit** (`core/conformance.mjs`, run by `scripts/conformance.mjs`). Checks C0 to C11 on shared, target-neutral fixtures (`core/fixtures.mjs`) that cover every block type and mark, nested lists, groups, notes, static and live bindings and non-Latin text: valid manifest, valid input, negotiated output within the manifest, no silent text loss, deterministic negotiation and serialization with no input mutation, valid native output, well-formed loss report, neutral deserialized UDM, round trip equal to the negotiated input apart from declared losses, and `ext` pass-through and isolation.
4. **Genericity check.** File hashes of the core were recorded in `core.lock.json` after the Markdown adapter was finished. The plain-text adapter was written afterwards, and the corpus run verifies the hashes.

## Step 9: Prototype results

### Forward pass: Presenton to UDM

- Valid, neutral UDM for 383/383 layouts. Content elements captured: text 3,582/3,582, image 607/607, list 35/35, table 7/7, chart 113/113, infographic 51/51.
- 4,041 blocks: paragraph 2,445, heading 783, image 607, chart 113, diagram 51, list 35, table 7. Sections with a detected title: 354/383.
- Roles inferred from element names: label 750, kpi 600, subtitle 77, takeaway 5.
- Skipped as non-content: 1,644 decorative images, 718 non-content vectors, 39 decorative text elements, 15 decorative vectors, and 3 empty text elements.

### Output validity per target

| Target | Native output valid | Loads in a headless editor | Text atoms surviving UDM to native to UDM | Conformance |
| --- | --- | --- | --- | --- |
| `tiptap` (page) | 383/383 | 383/383 | 5,211/5,211 | 45/45 |
| `tiptap.basic` | 383/383 | 383/383 | 5,211/5,211 | 45/45 |
| `markdown` | 383/383 | n/a | 5,211/5,211 | 45/45 |
| `plain-text` | 383/383 | n/a | 5,211/5,211 (into the output) | 29/29 |
| `presenton.slides` | n/a | n/a | n/a | 45/45 |

The Tiptap validator rejected all 7 negative controls. Tiptap validity means `getSchema()` plus `nodeFromJSON().check()` plus a diff that catches attributes Tiptap would silently drop (`tutorial/prototypes/udm/adapters/tiptap/index.mjs:55`).

### Back into the same Presenton layout

| Element | `tiptap` | `tiptap.basic` | `markdown` |
| --- | --- | --- | --- |
| Whole `ui` byte-identical | 383/383 | 118/383 (30.81%) | 278/383 (72.58%) |
| Text slots | 3,582/3,582 | 2,429/3,582 (67.81%) | 3,378/3,582 (94.3%) |
| Lists | 35/35 | 35/35 | 34/35 |
| Tables | 7/7 | 0/7 | 7/7 |
| Charts | 113/113 | 0/113 | 113/113 |
| Images | 607/607 | 0/607 | 607/607 |
| Infographics | 51/51 | 0/51 | 0/51 |
| Layout found again from content alone | n/a (provenance kept) | 91/383 (23.76%) | 254/383 (66.32%) |

### Failure categories

| Category | Count | Cause |
| --- | --- | --- |
| `tiptap.basic:roundtrip_text_changed` | 1,153 | all in layouts where negotiation degraded at least one block (a chart, infographic, image or table became a list or a paragraph); the degraded block then competes for text and list slots in the positional pass |
| `tiptap.basic:roundtrip_image_unmapped` | 607 | basic has no image node |
| `markdown:roundtrip_text_changed` | 204 | 190 in layouts where negotiation degraded a block or turned a caption into a paragraph; 14 in layouts with no degradation (order or heading-versus-paragraph classification) |
| `tiptap.basic:roundtrip_chart_unmapped` | 113 | basic has no table or data node |
| `tiptap.basic` and `markdown` `roundtrip_infographic_unmapped` | 51 each | infographics become lists or paragraphs |
| `edited:per_run_highlight_flattened` | 44 | a second color or size inside one element is flattened on edit |
| `tiptap.basic:roundtrip_table_unmapped` | 7 | no table node |
| `markdown:roundtrip_list_changed` | 1 | one card list in `civic/dated_title_with_comparison_cards_7389` |

### Timing

Average milliseconds per layout on the development machine (p95 in brackets): Presenton to UDM 0.075 (0.127), negotiate for Tiptap 0.038 (0.071), UDM to Tiptap 0.019 (0.03), Tiptap validation 0.039 (0.078), headless editor load 0.6 (1.071), Tiptap to UDM 0.02 (0.035), UDM to Presenton 0.203 (0.411), and the full edit plus Tiptap to Presenton 0.274 (0.609). A whole deck converts in a few milliseconds; conversion speed is not a constraint.

### Genericity

No core file names a target in code. The Markdown adapter imports only `marked` and the shared runtime helpers. After `core.lock.json` was taken, adding the plain-text adapter changed no core file. The core was not untouched while the first three adapters were built: the tests forced five changes there, none specific to a target. They were a negotiation rule that drops section role and level, whitespace handling at bold and italic edges, keeping a chart's title and axes when it degrades to a table, the `structure.orderPreserved` flag (false for layout-driven targets, `tutorial/prototypes/udm/core/adapter.ts:28`), and an optional `trace` on serialize results (`:45`). Expect the same pattern in production: the first few adapters shake out the core, and later ones do not touch it.

## Step 10: Round-trip fidelity

The 383/383 identical round trip through Tiptap is partly by design. When a block comes back unchanged, the Presenton serializer leaves its slot untouched (`tutorial/prototypes/udm/adapters/presenton/to-presenton.mjs:30` computes the comparison key, and the write loop skips equal blocks). The **edit test** is the real proof that each block finds its way back. The serializer assigns blocks to slots in a fixed order: the slot recorded in `ext["presenton.slides"].slot`, then a table matched by exact shape (so a chart that a target turned into a table finds its chart slot again), then the next free slot of the same block type in reading order, then any compatible slot (`:99-120`). With provenance intact, 100% of edits landed: 3,228 text, 354 titles, 35 lists, 7 tables and 113 charts. All 3,582 edited slots kept the slot's base font.

Four findings limit the claim.

1. **Per-run highlights flatten.** 44 elements have a second color or size inside one text element; none kept it after an edit. A neutral `highlight` mark in the UDM would close this. That is a proposal, not something the prototype did.
2. **Slot length.** 2,477 edited slots exceed the slot's `max_length`, because the scripted edit adds 9 characters to each. `validateNative` reports them as warnings. Fitting text to a slot is the slides serializer's job and is not built.
3. **The patch base.** The serializer clones the layout from the template and compares incoming blocks with that layout's own content (`tutorial/prototypes/udm/adapters/presenton/to-presenton.mjs:37-40`, `:76-77`). In the corpus, the layout's sample content *is* the slide, so this is exact. For a real deck, the base must be the slide's stored `ui`, otherwise manual positions and per-run styling of untouched slots would be reset. **Unverified**: no real edited deck was in the corpus.
4. **Structural edits.** Adding a block for which the layout has no free slot produces a `no_slot` loss; adding a fourth card to a three-card row is not handled. Presenton's hydrator can clone repeated children (`_repeated_child_for_index`), but the prototype does not use it.

Without provenance, the reverse direction is positional and the numbers drop to 94.3% of text slots for Markdown and 67.81% for basic Tiptap. Almost every wrong slot sits in a layout where negotiation degraded a block (190 of 204 for Markdown, all 1,153 for basic Tiptap): a block the target could not show became a list or a paragraph (or a caption became a paragraph), and in the positional pass it competes with the original text for the same slots. The report classifies by layout, not by slot, so this mechanism is the likely cause rather than a measured one. The rule that follows: keep ids and `ext` in every target that can hold them, and treat documents that come back through a target that cannot as "generate new slides", not "update these slides".

The hand-written direction was checked with one example (`tutorial/prototypes/udm/examples/doc-to-slides/`): a Tiptap page with a heading, a paragraph, a three-item bullet list and a table, and no UDM attributes. The adapter chose `general/title_table_description` deterministically by slot capacity (`tutorial/prototypes/udm/adapters/presenton/to-presenton.mjs:43`). The list had no free list slot in that layout and was reported as `no_slot` with its text in `droppedText`, and the title came out at 34 characters for a 17-character slot.

## Step 11: Verdict per scenario

| Scenario | Verdict | Evidence | Conditions |
| --- | --- | --- | --- |
| Presenton deck to a Tiptap page | **Feasible, verified** | 383/383 valid against the real schema, 383/383 load with content checking, no losses reported for the page profile | The target editor registers the page extensions (`TableKit`, `Image`, `dataBlock`, `udmAttrs`). A `dataBlock` node view that draws charts and diagrams is needed for display; the prototype checked JSON validity and headless loading only (**rendering unverified**) |
| Edit round trip: Presenton to Tiptap, edit, back into the same deck | **Feasible, verified for content edits** | 100% of edited text, titles, lists, tables and charts landed in the right slot; base font kept for 3,582/3,582 | Patch against the stored slide `ui` (unverified); add text fitting for `max_length`; accept or close the 44 flattened highlights; structural edits (new cards, extra blocks) need repeated-child support |
| Hand-written Tiptap page to a new Presenton slide | **Feasible as "generate"** | One worked example; deterministic layout choice; every loss reported | Pagination of a long document across several slides is not built (one section becomes one slide). Layout choice and text fitting need product rules, or the existing structure LLM step |
| Through Markdown or a StarterKit-only editor back to slides | **Lossy; generate, do not patch** | 94.3% (Markdown) and 67.81% (basic) of text slots; layout found again 66.32% and 23.76% | Use these targets for export and import, not for round-trip editing |
| Live data (Superset bindings) | **Feasible by design, not prototyped** | The UDM carries binding definitions; `dataBlock` holds the definition only; the adapter's slot path is the same location as Part VIII's RFC 6901 `element_path` (see [Story 1: Dynamic data](../delivery/42-story1-dynamic-data.md)) | Tokens, the binding store and refresh are **unverified** here and must pass the conformance kit's live-data checks before release |
| Smart-mode HTML slides | **Out of scope for round trips** | No structured JSON exists | A one-way HTML import is possible but **unverified** |
| A third and fourth module | **Feasible, verified** | Markdown and plain text pass the kit; no core change after the freeze | Each new module ships an adapter and passes the kit |

## Step 12: Risks

| # | Risk | Evidence | Mitigation |
| --- | --- | --- | --- |
| R1 | The editor silently loses data | Tiptap drops unknown attributes, and an unknown node replaces the whole document with an empty paragraph | Every adapter validates its own output with `validateNative` before any host sees it; the dropped-attribute diff is mandatory |
| R2 | Round-trip edits reset untouched styling or manual positions | The prototype's patch base is the layout template | Pass the stored slide `ui` as the patch base; add real edited decks to the corpus |
| R3 | Edited text overflows slots | 2,477 warnings in the scripted edit | Add a fitting step (clip, or ask the model to shorten) in the slides serializer, driven by the layout's content schema |
| R4 | Per-run highlights are lost | 44/44 flattened | Add a neutral `highlight` mark to the UDM, mapped by each adapter |
| R5 | Heuristics do not generalize | Heading, role and reading-order detection were measured only on the bundled templates | Run the corpus on custom and imported templates before release; keep heuristics inside the Presenton adapter |
| R6 | Two hydration paths diverge | Endpoint hydrator and chat memory layer both build `ui` | Read only the persisted `ui`; never depend on which path produced it |
| R7 | Targets without ids corrupt decks | Positional fallback places degraded blocks in text slots | Offer "generate" instead of "update" for targets whose manifest has `features.ids: false` |
| R8 | Live data leaks numbers or goes stale | Not prototyped | Keep values out of the UDM and adapters; enforce the conformance kit's live-data checks |
| R9 | Conversion placed in the wrong runtime | Tiptap's server tools need Node, not the Edge runtime; FastAPI cannot use them | Run adapters in TypeScript on Node, or have Python emit plain JSON that a TypeScript validator checks |
| R10 | Version drift | Prototype pinned to Tiptap 3.30.5 | Pin the editor version per adapter release; rerun the corpus on upgrade |
| R11 | Model inconsistencies in Template v2 | `math` is hydrated but not in the Pydantic union or the renderer; `svg`, `list-view` and `grid-view` exist only in the renderer | The adapter validator accepts these types explicitly; the corpus contains no `math` elements, so that path is fixture-tested only |

## What you now know

- Presenton holds a deck in four JSON forms (outline, content, `ui`, editor `Deck`) plus Smart-mode HTML, and the adapter must read and patch `slides.ui`.
- Both sides being JSON makes conversion a pure function, but the two schemas differ in layout, keys, styling and semantics, so the conversion goes through the UDM.
- Every Template v2 content element has a mapping, and two generic Tiptap pieces (`dataBlock`, `udmAttrs`) cover the whole catalog.
- The prototype measured 383/383 valid outputs, exact round trips through Tiptap, 100% of scripted edits landing in the right slot, and a generic core that a fifth adapter did not change.
- Which scenarios are verified, which are feasible only as "generate", which are not prototyped, and the risks to plan for.

## Next

Read [Unified Document Model](72-unified-document-model.md) for the types, the `ext` rules, negotiation and the conformance kit.
