# Roadmap and tracker

<div class="chapter-meta" markdown>
**Reads:** the earlier Part IX chapters  ·  **Builds on:** [Architecture](61-architecture.md), [Part VIII (AI Slides delivery plan)](../delivery/index.md)  ·  **Time:** ~15 min
</div>

This chapter turns Part IX into a plan you can track. It covers five phases, each ending in something a user can try, with 44 work packages, effort estimates, dependencies and exit criteria. Each phase adds one new host or target, so the kit proves its "plug into any host" promise step by step instead of all at the end. Each phase also makes its target show live Superset data, fetched as the viewing user and refreshed after generation, so no phase ships a target that freezes numbers ([Live Superset data](69-live-superset-data.md)).

[:material-file-delimited: Download tracker (.csv)](../assets/gck-roadmap-tracker.csv){ .md-button .md-button--primary }

## Step 1: Understand the planning assumptions

| Assumption | Value |
| --- | --- |
| Start | After the AI Slides pilot is stable, or in parallel with a separate small team (see Step 5) |
| Team | 2 frontend engineers, 1 backend engineer full time (the live-data work doubles the backend share), QA support in phases 2 and 3 |
| Effort unit | Ideal person-days (`d`), including tests and review |
| Capacity | 4 focus-days per person per week |
| Windows | Indicative week ranges relative to the start date; convert them to Friday release trains when a start date is fixed, the same way as the AI Slides release plan in [Part VIII](../delivery/index.md) |

Totals: about 130 d of frontend work, 69 d of backend work and 11 d of QA, 210 d in all. The 17 live-data work packages (1.8 to 1.13, 2.5 to 2.7, 3.6 to 3.8, 4.6 to 4.10) account for 65 d of it, 36 d of them backend. Two frontend engineers at 4 d per week deliver the frontend share in about 16 weeks of pure work, and one backend engineer at 4 d per week delivers the backend share in about 17 weeks, so 24 weeks leaves room for review, integration and surprises. P1 is the backend-heavy phase (30 d of backend work), which is why it is the longest; 1.8 depends only on the schema contract test (0.3), so the backend engineer can start it during P0.

## Step 2: Read the phase plan

Why this order:

1. **P0 first**, because the protocol and core are the contract every host and target depends on. Changing them later is the most expensive change in the project.
2. **Text before Tiptap before dashboards.** Text is the simplest target (no custom editor nodes, no layout), so it validates the engine and the kit with the least risk. Tiptap adds editor integration and undo. Dashboards add layout and real Superset objects.
3. **Slides last**, because AI Slides already works through Part VIII. Moving it onto the kit is a refactor, not new value, and it is safest once the kit is proven on three other targets.

| Phase | Name | Goal | Indicative window | Work packages | Effort |
| --- | --- | --- | --- | --- | --- |
| P0 | Foundations | Monorepo, protocol, client, core state machine, mock engine | Weeks 1-3 | 6 | 26 d |
| P1 | Engine and first non-slide target | GCK Engine run API, live data resolution and the text target in Superset | Weeks 4-11 | 13 | 66 d |
| P2 | Tiptap pages | Tiptap target and extension, transform and edit intents, live data nodes and parameters | Weeks 12-15 | 7 | 36 d |
| P3 | Superset dashboards | Dashboard target and Superset host, live text charts | Weeks 16-19 | 8 | 37 d |
| P4 | Slides on the kit | Presenton and AI Slides consume the kit, slide binding rows, web components, hardening | Weeks 20-24 | 10 | 45 d |
| | **Total** | | | **44** | **210 d** |

Effort by area:

| Area | Effort | Share |
| --- | --- | --- |
| BE | 69 d | 33% |
| FE hosts | 37 d | 18% |
| FE platform | 33 d | 16% |
| FE targets | 33 d | 16% |
| FE kit | 27 d | 13% |
| QA | 11 d | 5% |

!!! note "Where live data sits in the plan"
    Live data is not a phase of its own: each phase makes its own target live. The new IDs were appended after each phase's existing ones, so earlier IDs and tracker rows did not change. P1 builds the shared pieces every later target uses: Story 8's source-typed refresh and token exchange, the shared `gck_data` mappers, the engine's `/v1/data/*` API, and the binding store and refresh controller in `@gck/core` (1.8 to 1.13). P2 adds data sources beyond saved charts (datasets and saved metrics), artifact parameters and the Tiptap live nodes with the embedded-chart fallback (2.5 to 2.7). P3 turns numbers in dashboard narrative into live Handlebars and Big Number charts and adds headless re-rendering for scheduled sends (3.6 to 3.8). P4 gives GCK decks real `slide_data_bindings` rows and live numbers in slide text (4.6 to 4.10). Protocol 1.2 data work (semantic-view metrics on Superset master, the flagged `superset_sql` source, splitting `mixed_timeseries` into two dataset bindings and propagating cross filters, about 8 d of backend work) comes after P4 and is not in the 44 work packages or the totals above.

### P0: Foundations

Monorepo, protocol, client, core state machine, mock engine. Weeks 1-3.

| ID | Work package | Area | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| 0.1 | Monorepo with pnpm workspaces, Turborepo, tsup builds, size-limit, changesets | FE platform | 4 d | - | Not started |
| 0.2 | @gck/protocol: Artifact Spec (`gck.artifact/1`), run events, target manifests as TS types and JSON Schemas; AG-UI mapping (`toAgUi`) | FE platform | 5 d | - | Not started |
| 0.3 | Schema contract test shared with the engine (Pydantic <-> JSON Schema) | BE | 3 d | 0.2 | Not started |
| 0.4 | @gck/client: `GckClient` with fetch-based SSE, reconnect with Last-Event-ID, retries, cancel | FE platform | 5 d | 0.2 | Not started |
| 0.5 | @gck/core: run state machine, artifact store with JSON Patch, plugin registry, run controller (`createRunController`), `resolveToken`, `validateArtifact` | FE platform | 6 d | 0.2 | Not started |
| 0.6 | Mock engine (MSW) replaying recorded event logs (`@gck/testing`, private); Storybook setup (`apps/storybook`) | FE platform | 3 d | 0.4 | Not started |

### P1: Engine and first non-slide target

GCK Engine run API, live data resolution and the text target in Superset. Weeks 4-11.

| ID | Work package | Area | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Engine: `/v1/runs` router (`RUNS_ROUTER`), run event log, input, cancel, resume | BE | 6 d | 0.3 | Not started |
| 1.2 | Engine: manifest-driven schema assembly (`build_response_schema`) and generalized plan and content steps | BE | 8 d | 1.1 | Not started |
| 1.3 | @gck/react and @gck/react/ui: `GckProvider`, hooks, PromptComposer, OutlineReview, StreamingPreview, RunStatusBar, ApplyBar | FE kit | 10 d | 0.5 | Not started |
| 1.4 | @gck/target-text (`textTarget`): Markdown, plain text, sanitized HTML | FE targets | 3 d | 0.5 | Not started |
| 1.5 | @gck/data-superset: chart catalog (`DataProvider`), binding resolution through the engine (`/v1/data/resolve`) and the Part VIII refresh API | FE targets | 4 d | 0.5 | Not started |
| 1.6 | Superset text host in @gck/host-superset: Markdown component, SQL Lab narrative panel, headless alert and report narratives | FE hosts | 5 d | 1.3, 1.4 | Not started |
| 1.7 | `--gck-*` theming tokens from Superset, i18n, accessibility pass | FE kit | 4 d | 1.3 | Not started |
| 1.8 | Story 8 source-typed refresh items (`superset_chart` with `filter_context`, legacy flat item kept), `POST /api/v1/ai_slides/token-exchange`, shared `gck_data` mappers and the common snapshot shape (Story 1 alignment, contract test against `write_value`) | BE | 6 d | 0.3 | Not started |
| 1.9 | Engine data API: `GET /v1/data/catalog`, `POST /v1/data/resolve` (SSE and JSON), 60 s per-viewer cache, limits and rate limits; catalog-time `mapping` and `format` derivation per viz type, constrained `chartType` | BE | 7 d | 1.2, 1.8 | Not started |
| 1.10 | Live bindings in `@gck/core`: `createBindingStore`, `createRefreshController` with refresh policies (`on_open`, `manual`, `interval` of at least 60 s, `on_filter_change`, `onVisible`), `resolveArtifact`, `stripRuntime`, `dataAsOf`; `@gck/data-superset` over `/v1/data/resolve`; run-to-host handoff at `gck.applied` | FE platform | 5 d | 1.5, 1.9 | Not started |
| 1.11 | Dashboard filter capture: native filter `dataMask` and a dashboard permalink into `HostDataScope` (`RunRequest.data.scope`), `filter_context: captured` on bindings | FE hosts | 3 d | 1.6 | Not started |
| 1.12 | Story 8 dashboard filter scope: `get_dashboard_filter_context` on Superset master, a local `native_filter_configuration` resolver on 6.1, `applied_filters` and `rejected_filters` in results | BE | 3 d | 1.8 | Not started |
| 1.13 | @gck/target-text: "Data as of" footer (`dataAsOf` option), binding status rendering (`stale`, `error`, `forbidden`) | FE targets | 2 d | 1.4 | Not started |

### P2: Tiptap pages

Tiptap target and extension, transform and edit intents, live data nodes and parameters. Weeks 12-15.

| ID | Work package | Area | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| 2.1 | @gck/target-tiptap: Artifact <-> ProseMirror JSON (`toProseMirror`, `fromProseMirror`), gckChart, gckMetric, gckDataTable, gckToken nodes | FE targets | 8 d | 0.5 | Not started |
| 2.2 | Tiptap extension `GckGenerate`: `/ai` slash command, transform bubble actions (`submit({ intent: "transform", selection })`), "Edit page" (`intent: "edit"`, `patch` apply through `gckBlockId`), streaming insert, single undo step, collaborative mode (Yjs) | FE hosts | 7 d | 2.1, 1.3 | Not started |
| 2.3 | Engine: `transform` and `edit` intents (selection import from `context.selection`, `artifact.patch` generation against `context.document` as version 0) | BE | 6 d | 1.2 | Not started |
| 2.4 | Tiptap demo app (`examples/react-vite-tiptap`) and Playwright end-to-end tests | QA | 4 d | 2.2 | Not started |
| 2.5 | Tiptap live data: `binding` attribute (definition only) on `gckChart`, `gckMetric`, `gckDataTable` and `gckToken`, empty token text in saved HTML and JSON, `GckBindingsProvider` with `live`, `GckRefreshButton`, `GckParameterBar`, `GckEmbedView` (`gckEmbed` node, same-site live chart frame or link card), redact policy for shared pages | FE kit | 5 d | 2.1, 1.10 | Not started |
| 2.6 | Dataset and metric sources (`superset_dataset`, `superset_metric` on tables) in Story 8 and the engine, validated against dataset metadata; artifact parameters (`ArtifactParameter`, `ParamBinding`) and the four-layer scope merge end to end | BE | 5 d | 1.9 | Not started |
| 2.7 | Dataset and metric entries in the kit catalog (`DataCatalog.allowedDatasetIds`, `CatalogEntryView`) and source pickers | FE kit | 1 d | 2.6, 1.3 | Not started |

!!! note "Intents in P2"
    The kit side of `transform` and `edit` is part of the core and target packages, not extra P2 work: the run controller's `submit({ prompt, intent, selection, baseArtifact, apply })` (0.5) sends all three intents, and the Tiptap and text targets implement the `patch` apply mode through `applyPatch` (2.1, 1.4), see [React SDK and UI kit](64-react-sdk-and-ui-kit.md) and [Artifact Spec and targets](62-artifact-spec-and-targets.md). P2 wires them into the editor (2.2) and teaches the engine to answer them (2.3). Slides and dashboards keep `replace` for edits in v1.

### P3: Superset dashboards

Dashboard target and Superset host, live text charts. Weeks 16-19.

| ID | Work package | Area | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| 3.1 | @gck/target-superset-dashboard: `position_json` (`toPositions`, `addAsTab`) and `json_metadata` builder | FE targets | 6 d | 0.5 | Not started |
| 3.2 | @gck/host-superset: extension commands, menus, chat panel, dashboard context provider | FE hosts | 6 d | 1.3 | Not started |
| 3.3 | Apply flow (`applyDashboard`): new dashboard or new tab through the Superset REST API, with revert (`ApplyResult.undo`) | FE hosts | 5 d | 3.1, 3.2 | Not started |
| 3.4 | Engine: dashboard layout planning with the 12-column grid | BE | 4 d | 1.2 | Not started |
| 3.5 | Superset dev instance end-to-end tests, RLS and permission cases | QA | 4 d | 3.3 | Not started |
| 3.6 | Dashboard live text in `toPositions`: numbers in narrative become Handlebars charts (one dataset) or Big Number charts (`big_number_total`, `big_number`, `pop_kpi`), derived charts for pinned scope, new chart ids added to native filter scope, parameters as native filters, `json_metadata.refresh_frequency` from the refresh policy (at least 60 s) | FE targets | 4 d | 3.1, 3.3 | Not started |
| 3.7 | Engine `POST /v1/render`: Python port of the text target (parity fixtures with `@gck/target-text`), headless refresh as the schedule executor for scheduled reports and alert narratives, stamped "Data as of" | BE | 5 d | 1.9, 1.13 | Not started |
| 3.8 | Live-data test tier: two RLS users per target, filter capture and `follow_host`, parameters, limits and rate limits, `mapping_changed` drift | QA | 3 d | 3.6, 2.5 | Not started |

### P4: Slides on the kit

Presenton and AI Slides consume the kit, slide binding rows, web components, hardening. Weeks 20-24.

| ID | Work package | Area | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| 4.1 | @gck/target-slides (`createSlidesTarget`) on Template v2, lazy-loaded renderer | FE targets | 6 d | 0.5 | Not started |
| 4.2 | Presenton consumes the kit as the slides host: replace outline and streaming hooks (strangler) | FE hosts | 8 d | 4.1, 1.3 | Not started |
| 4.3 | Engine: slides target behind `/v1/runs` (mounted at `/api/gck` in Presenton), compatibility with existing Presenton endpoints | BE | 6 d | 1.2 | Not started |
| 4.4 | @gck/element: `<gck-generate>` web component and iframe fallback | FE kit | 4 d | 1.3 | Not started |
| 4.5 | Security review, bundle budgets, docs site and example apps, 1.0 release | FE platform | 5 d | 4.2, 4.4 | Not started |
| 4.6 | Slides binding rows: `SlideOut.bindings` persisted as `slide_data_bindings` rows by `POST .../slides/from-content` and the engine deck materializer in the same commit, status handling at fill time (never template sample data), refresh-on-open parity with Part VIII | BE | 4 d | 4.3, 1.8 | Not started |
| 4.7 | Presenton transport for `@gck/data-superset` over the deck-scoped refresh routes; Story 4 `useDeckRefresh` as a thin wrapper over `createRefreshController` (gains `intervalMs`, `onVisible`) | FE hosts | 3 d | 4.2, 1.10 | Not started |
| 4.8 | `text_template` binding kind in Part VIII: live numbers in slide text, re-rendered through `gck_data.tokens.resolve_token` | BE | 3 d | 4.6 | Not started |
| 4.9 | `<gck-data>` and `<gck-artifact>` live web components (`refresh()` method, `refresh-interval` attribute of at least 60) | FE kit | 3 d | 4.4, 1.10 | Not started |
| 4.10 | PPTX native-chart acceptance test (one `ppt/charts/chart*.xml` per bound chart), python-pptx post-processor from the binding snapshot if needed | BE | 3 d | 4.6 | Not started |

## Step 3: Check each phase's exit criteria

| Phase | Exit criteria (a demo a user can run) |
| --- | --- |
| P0 | A Storybook story streams a recorded run from the mock engine through `@gck/core` into a preview, and can be cancelled and resumed |
| P1 | In Superset, a user writes "summarize this dashboard for leadership" and every data token in the generated text comes from a binding resolved as the viewer, with the dashboard's native filters captured at submit; text the kit renders refreshes on open and on "Refresh data" with the same scope, and static outputs (a Markdown component, exported Markdown or email) carry "Data as of" ([Live Superset data](69-live-superset-data.md)) |
| P2 | In a Tiptap page, `/ai` generates a page with a live chart node; selecting text and choosing "turn into chart" replaces the selection (`transform`); "Edit page" changes only the affected blocks (`edit` with `patch`); one undo reverts each of them. Reopening the page refreshes every data node as the viewer, "Refresh data" forces it, a viewer without access sees no numbers, copy-paste keeps nodes refreshable, and changing a parameter re-resolves only the nodes that depend on it |
| P3 | From a dashboard, "create an EMEA tab with revenue and churn" produces a new tab that uses existing charts, respects permissions and can be reverted; its charts are filtered to the prompt's scope and react to native filter changes, and numbers in its narrative are live charts (Handlebars or Big Number) or stamped |
| P4 | Presenton's own outline and streaming screens run on the kit with no user-visible regression; a GCK deck has `slide_data_bindings` rows, refreshes on open (Story 4 AC1 to AC6), bakes fresh data into export (Story 1 AC6) and its PPTX charts carry native data; the `<gck-generate>` web component works in a plain HTML page; version 1.0 is published |

## Step 4: Watch the risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Protocol churn after hosts adopt it | Every host breaks | Freeze `gck.artifact/1` and the event set at the end of P0; additive changes only, with versioned manifests |
| Different Tiptap schemas per host | Generated nodes rejected | Targets read the host editor's schema and only emit node types it has; contract tests per host |
| Superset extension areas differ by version | Entry points missing on 6.1 | Use the 6.1 fallbacks documented in [Host integrations](65-host-integrations.md) and feature-detect at runtime; track Superset master (the master-only areas are expected in 7.0, not verified) |
| Model output quality per target | Unusable content | Per-target eval sets in CI (reuse the Story 7 eval approach in [Story 7](../delivery/48-story7-harness-planner.md)) |
| Two efforts in parallel with AI Slides | Duplicate work, divergent bindings model | Share the bindings model and refresh API from Part VIII; one owner for `@gck/protocol` across both teams |
| Data identity outside Superset (no shared session or identity provider) | Tiptap pages and web components on another origin show no live data | Token-exchange contract test; `no_data_identity` fallback in every view; documented identity bridges ([Live Superset data](69-live-superset-data.md)) |
| Author and viewer row level security differ | A shared page leaks the author's numbers | Per-viewer resolution, redact policy for snapshots resolved by someone else, two-user tests in 3.8 |
| Superset 6.1 lacks `get_dashboard_filter_context`, `apply_dashboard_filter_context`, the form-data rebuild and `number_format.py` | Filters and formats differ between 6.1 and master | Story 8's local 6.1 scope resolver with per-viz tests (1.12); vendored formatter; `no_query_context` fallback |
| Superset dashboard auto refresh defaults to force mode (`DASHBOARD_AUTO_REFRESH_MODE = "force"`) | Every interval bypasses the cache and loads the database | The dashboard target writes no interval below 60 s, recommends 300 s or more, or `fetch` mode per deployment |
| Handlebars number formatting differs from d3 | Live dashboard text formats numbers differently from charts | `format_approximated` warning; Big Number charts for single KPIs |
| export-core may rasterize charts in PPTX | Exported decks lose native chart data | PPTX acceptance test plus python-pptx post-processor (4.10) |
| Static hosts show old numbers | Readers trust stale figures | Mandatory "Data as of" stamps; scheduled sends re-render per send (3.7) |

## Step 5: Decide how to run it alongside AI Slides

Two workable options:

- **Sequential (recommended for a small team).** Finish the AI Slides pilot, then start P0 with the same people. The Part VIII code (bindings, refresh API, harness planner) becomes the engine's data layer, and nothing is built twice.
- **Parallel.** A separate pair of frontend engineers starts P0 and P1 while AI Slides continues. This works only if `@gck/protocol` and Part VIII share one binding shape and one person owns the protocol across both teams. The shapes are aligned field by field (a GCK `DataBinding` maps onto a `slide_data_bindings` row, see [Extracting the engine from Presenton](66-extracting-from-presenton.md)), both stores use the snapshot JSON produced by the shared `gck_data` mappers (1.8), and a contract test pipes one recorded Story 8 response through `gck_data.map_result` into Part VIII's `write_value` and GCK's `resolveToken` and asserts identical displays.

## Step 6: Keep the tracker current

The tables above and the CSV download are generated by `tutorial/scripts/gen_gck_roadmap.py` from one work-package list. To re-plan, edit the list and regenerate:

```bash
python tutorial/scripts/gen_gck_roadmap.py /tmp/gck-tables.md tutorial/content/assets/gck-roadmap-tracker.csv
```

Paste the regenerated tables into this page. The script holds the short work-package names; the descriptions on this page add the package and API names from chapters 62 to 69 (for example `RUNS_ROUTER` or `toPositions`), so carry those over when you paste. IDs, areas, effort and dependencies must match the script exactly. The CSV has empty Owner, Start week and End week columns, ready to fill in the team sheet.

Feature flags introduced by the kit (see [Frontend engineering and quality](67-frontend-engineering.md)) each get a removal date: record it in the tracker against the work package that introduces the flag.

## What you now know

- The five phases, why they come in this order, and what each one demonstrates, including how each phase makes its own target show live Superset data.
- The 44 work packages, their effort, area and dependencies, about 210 person-days in total, 65 of them for live Superset data.
- The team shape and capacity assumptions behind the indicative windows.
- The main risks and how to run this work alongside AI Slides.

## Next

Return to the [Part IX landing page](index.md), or see how the same ideas look in a Superset-native form in [Part VII](../superset/index.md).
