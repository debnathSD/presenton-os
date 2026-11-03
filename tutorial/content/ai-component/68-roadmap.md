# Roadmap and tracker

<div class="chapter-meta" markdown>
**Reads:** the earlier Part IX chapters  ·  **Builds on:** [Architecture](61-architecture.md), [Part VIII (AI Slides delivery plan)](../delivery/index.md)  ·  **Time:** ~15 min
</div>

This chapter turns Part IX into a plan you can track. It covers five phases, each ending in something a user can try, with 27 work packages, effort estimates, dependencies and exit criteria. Each phase adds one new host or target, so the kit proves its "plug into any host" promise step by step instead of all at the end.

[:material-file-delimited: Download tracker (.csv)](../assets/gck-roadmap-tracker.csv){ .md-button .md-button--primary }

## Step 1: Understand the planning assumptions

| Assumption | Value |
| --- | --- |
| Start | After the AI Slides pilot is stable, or in parallel with a separate small team (see Step 5) |
| Team | 2 frontend engineers, 1 backend engineer at about 50%, QA support in phases 2 and 3 |
| Effort unit | Ideal person-days (`d`), including tests and review |
| Capacity | 4 focus-days per person per week |
| Windows | Indicative week ranges relative to the start date; convert them to Friday release trains when a start date is fixed, the same way as the AI Slides release plan in [Part VIII](../delivery/index.md) |

Totals: about 104 d of frontend work, 33 d of backend work and 8 d of QA. Two frontend engineers at 4 d per week deliver the frontend share in about 13 weeks of pure work, so 19 weeks leaves room for review, integration and surprises.

## Step 2: Read the phase plan

Why this order:

1. **P0 first**, because the protocol and core are the contract every host and target depends on. Changing them later is the most expensive change in the project.
2. **Text before Tiptap before dashboards.** Text is the simplest target (no custom editor nodes, no layout), so it validates the engine and the kit with the least risk. Tiptap adds editor integration and undo. Dashboards add layout and real Superset objects.
3. **Slides last**, because AI Slides already works through Part VIII. Moving it onto the kit is a refactor, not new value, and it is safest once the kit is proven on three other targets.

| Phase | Name | Goal | Indicative window | Work packages | Effort |
| --- | --- | --- | --- | --- | --- |
| P0 | Foundations | Monorepo, protocol, client, core state machine, mock engine | Weeks 1-3 | 6 | 26 d |
| P1 | Engine and first non-slide target | GCK Engine run API and the text target in Superset | Weeks 4-7 | 7 | 40 d |
| P2 | Tiptap pages | Tiptap target and extension, transform and edit intents | Weeks 8-11 | 4 | 25 d |
| P3 | Superset dashboards | Dashboard target and Superset host | Weeks 12-15 | 5 | 25 d |
| P4 | Slides on the kit | Presenton and AI Slides consume the kit, web component, hardening | Weeks 16-19 | 5 | 29 d |
| | **Total** | | | **27** | **145 d** |

Effort by area:

| Area | Effort | Share |
| --- | --- | --- |
| BE | 33 d | 23% |
| FE hosts | 31 d | 21% |
| FE platform | 28 d | 19% |
| FE targets | 27 d | 19% |
| FE kit | 18 d | 12% |
| QA | 8 d | 6% |

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

GCK Engine run API and the text target in Superset. Weeks 4-7.

| ID | Work package | Area | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Engine: `/v1/runs` router (`RUNS_ROUTER`), run event log, input, cancel, resume | BE | 6 d | 0.3 | Not started |
| 1.2 | Engine: manifest-driven schema assembly (`build_response_schema`) and generalized plan and content steps | BE | 8 d | 1.1 | Not started |
| 1.3 | @gck/react and @gck/react/ui: `GckProvider`, hooks, PromptComposer, OutlineReview, StreamingPreview, RunStatusBar, ApplyBar | FE kit | 10 d | 0.5 | Not started |
| 1.4 | @gck/target-text (`textTarget`): Markdown, plain text, sanitized HTML | FE targets | 3 d | 0.5 | Not started |
| 1.5 | @gck/data-superset: chart catalog (`DataProvider`), binding resolution through the Part VIII refresh API | FE targets | 4 d | 0.5 | Not started |
| 1.6 | Superset text host in @gck/host-superset: Markdown component, SQL Lab narrative panel, headless alert and report narratives | FE hosts | 5 d | 1.3, 1.4 | Not started |
| 1.7 | `--gck-*` theming tokens from Superset, i18n, accessibility pass | FE kit | 4 d | 1.3 | Not started |

### P2: Tiptap pages

Tiptap target and extension, transform and edit intents. Weeks 8-11.

| ID | Work package | Area | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| 2.1 | @gck/target-tiptap: Artifact <-> ProseMirror JSON (`toProseMirror`, `fromProseMirror`), gckChart, gckMetric, gckDataTable, gckToken nodes | FE targets | 8 d | 0.5 | Not started |
| 2.2 | Tiptap extension `GckGenerate`: `/ai` slash command, transform bubble actions (`submit({ intent: "transform", selection })`), "Edit page" (`intent: "edit"`, `patch` apply through `gckBlockId`), streaming insert, single undo step, collaborative mode (Yjs) | FE hosts | 7 d | 2.1, 1.3 | Not started |
| 2.3 | Engine: `transform` and `edit` intents (selection import from `context.selection`, `artifact.patch` generation against `context.document` as version 0) | BE | 6 d | 1.2 | Not started |
| 2.4 | Tiptap demo app (`examples/react-vite-tiptap`) and Playwright end-to-end tests | QA | 4 d | 2.2 | Not started |

!!! note "Intents in P2"
    The kit side of `transform` and `edit` is part of the core and target packages, not extra P2 work: the run controller's `submit({ prompt, intent, selection, baseArtifact, apply })` (0.5) sends all three intents, and the Tiptap and text targets implement the `patch` apply mode through `applyPatch` (2.1, 1.4), see [React SDK and UI kit](64-react-sdk-and-ui-kit.md) and [Artifact Spec and targets](62-artifact-spec-and-targets.md). P2 wires them into the editor (2.2) and teaches the engine to answer them (2.3). Slides and dashboards keep `replace` for edits in v1.

### P3: Superset dashboards

Dashboard target and Superset host. Weeks 12-15.

| ID | Work package | Area | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| 3.1 | @gck/target-superset-dashboard: `position_json` (`toPositions`, `addAsTab`) and `json_metadata` builder | FE targets | 6 d | 0.5 | Not started |
| 3.2 | @gck/host-superset: extension commands, menus, chat panel, dashboard context provider | FE hosts | 6 d | 1.3 | Not started |
| 3.3 | Apply flow (`applyDashboard`): new dashboard or new tab through the Superset REST API, with revert (`ApplyResult.undo`) | FE hosts | 5 d | 3.1, 3.2 | Not started |
| 3.4 | Engine: dashboard layout planning with the 12-column grid | BE | 4 d | 1.2 | Not started |
| 3.5 | Superset dev instance end-to-end tests, RLS and permission cases | QA | 4 d | 3.3 | Not started |

### P4: Slides on the kit

Presenton and AI Slides consume the kit, web component, hardening. Weeks 16-19.

| ID | Work package | Area | Effort | Depends on | Status |
| --- | --- | --- | --- | --- | --- |
| 4.1 | @gck/target-slides (`createSlidesTarget`) on Template v2, lazy-loaded renderer | FE targets | 6 d | 0.5 | Not started |
| 4.2 | Presenton consumes the kit as the slides host: replace outline and streaming hooks (strangler) | FE hosts | 8 d | 4.1, 1.3 | Not started |
| 4.3 | Engine: slides target behind `/v1/runs` (mounted at `/api/gck` in Presenton), compatibility with existing Presenton endpoints | BE | 6 d | 1.2 | Not started |
| 4.4 | @gck/element: `<gck-generate>` web component and iframe fallback | FE kit | 4 d | 1.3 | Not started |
| 4.5 | Security review, bundle budgets, docs site and example apps, 1.0 release | FE platform | 5 d | 4.2, 4.4 | Not started |


## Step 3: Check each phase's exit criteria

| Phase | Exit criteria (a demo a user can run) |
| --- | --- |
| P0 | A Storybook story streams a recorded run from the mock engine through `@gck/core` into a preview, and can be cancelled and resumed |
| P1 | In Superset, a user writes "summarize this dashboard for leadership" and gets a Markdown component whose numbers come from data tokens resolved against bound charts (Markdown is static text, so they are frozen at `snapshotAt` and shown with an "as of" date, see [Host integrations](65-host-integrations.md)) |
| P2 | In a Tiptap page, `/ai` generates a page with a live chart node; selecting text and choosing "turn into chart" replaces the selection (`transform`); "Edit page" changes only the affected blocks (`edit` with `patch`); one undo reverts each of them |
| P3 | From a dashboard, "create an EMEA tab with revenue and churn" produces a new tab that uses existing charts, respects permissions and can be reverted |
| P4 | Presenton's own outline and streaming screens run on the kit with no user-visible regression; the `<gck-generate>` web component works in a plain HTML page; version 1.0 is published |

## Step 4: Watch the risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Protocol churn after hosts adopt it | Every host breaks | Freeze `gck.artifact/1` and the event set at the end of P0; additive changes only, with versioned manifests |
| Different Tiptap schemas per host | Generated nodes rejected | Targets read the host editor's schema and only emit node types it has; contract tests per host |
| Superset extension areas differ by version | Entry points missing on 6.1 | Use the 6.1 fallbacks documented in [Host integrations](65-host-integrations.md) and feature-detect at runtime; track Superset master (the master-only areas are expected in 7.0, not verified) |
| Model output quality per target | Unusable content | Per-target eval sets in CI (reuse the Story 7 eval approach in [Story 7](../delivery/48-story7-harness-planner.md)) |
| Two efforts in parallel with AI Slides | Duplicate work, divergent bindings model | Share the bindings model and refresh API from Part VIII; one owner for `@gck/protocol` across both teams |

## Step 5: Decide how to run it alongside AI Slides

Two workable options:

- **Sequential (recommended for a small team).** Finish the AI Slides pilot, then start P0 with the same people. The Part VIII code (bindings, refresh API, harness planner) becomes the engine's data layer, and nothing is built twice.
- **Parallel.** A separate pair of frontend engineers starts P0 and P1 while AI Slides continues. This works only if `@gck/protocol` adopts Part VIII's binding shape unchanged and one person owns the protocol across both teams.

## Step 6: Keep the tracker current

The tables above and the CSV download are generated by `tutorial/scripts/gen_gck_roadmap.py` from one work-package list. To re-plan, edit the list and regenerate:

```bash
python tutorial/scripts/gen_gck_roadmap.py /tmp/gck-tables.md tutorial/content/assets/gck-roadmap-tracker.csv
```

Paste the regenerated tables into this page. The script holds the short work-package names; the descriptions on this page add the package and API names from chapters 62 to 67 (for example `RUNS_ROUTER` or `toPositions`), so carry those over when you paste. IDs, areas, effort and dependencies must match the script exactly. The CSV has empty Owner, Start week and End week columns, ready to fill in the team sheet.

Feature flags introduced by the kit (see [Frontend engineering and quality](67-frontend-engineering.md)) each get a removal date: record it in the tracker against the work package that introduces the flag.

## What you now know

- The five phases, why they come in this order, and what each one demonstrates.
- The 27 work packages, their effort, area and dependencies, about 145 person-days in total.
- The team shape and capacity assumptions behind the indicative windows.
- The main risks and how to run this work alongside AI Slides.

## Next

Return to the [Part IX landing page](index.md), or see how the same ideas look in a Superset-native form in [Part VII](../superset/index.md).
