"""Generate the Generative Content Kit roadmap tables and CSV tracker.
Usage: python tutorial/scripts/gen_gck_roadmap.py <out_md_fragment> <out_csv>"""
import csv, sys
PHASES = [
    ("P0", "Foundations", "Monorepo, protocol, client, core state machine, mock engine", "Weeks 1-3"),
    ("P1", "Engine and first non-slide target", "GCK Engine run API, live data resolution and the text target in Superset", "Weeks 4-11"),
    ("P2", "Tiptap pages", "Tiptap target and extension, transform and edit intents, live data nodes and parameters", "Weeks 12-15"),
    ("P3", "Superset dashboards", "Dashboard target and Superset host, live text charts", "Weeks 16-19"),
    ("P4", "Slides on the kit", "Presenton and AI Slides consume the kit, slide binding rows, web components, hardening", "Weeks 20-24"),
]
WP = [  # id, phase, title, area, effort person-days, depends
    ("0.1", "P0", "Monorepo with pnpm workspaces, Turborepo, tsup builds, size-limit, changesets", "FE platform", 4, ""),
    ("0.2", "P0", "@gck/protocol: Artifact Spec, events, manifests as TS types and JSON Schemas", "FE platform", 5, ""),
    ("0.3", "P0", "Schema contract test shared with the engine (Pydantic <-> JSON Schema)", "BE", 3, "0.2"),
    ("0.4", "P0", "@gck/client: fetch-based streaming, reconnect with Last-Event-ID, cancel", "FE platform", 5, "0.2"),
    ("0.5", "P0", "@gck/core: run state machine, artifact store with JSON Patch, plugin registry", "FE platform", 6, "0.2"),
    ("0.6", "P0", "Mock engine (MSW) replaying recorded event logs; Storybook setup", "FE platform", 3, "0.4"),
    ("1.1", "P1", "Engine: /v1/runs router, run event log, cancel, resume", "BE", 6, "0.3"),
    ("1.2", "P1", "Engine: manifest-driven schema assembly and generalized plan and content steps", "BE", 8, "1.1"),
    ("1.3", "P1", "@gck/react: provider, hooks, PromptComposer, OutlineReview, StreamingPreview, ApplyBar", "FE kit", 10, "0.5"),
    ("1.4", "P1", "@gck/target-text: Markdown, plain text, sanitized HTML", "FE targets", 3, "0.5"),
    ("1.5", "P1", "@gck/data-superset: catalog, binding resolution through the engine and the Part VIII refresh API", "FE targets", 4, "0.5"),
    ("1.6", "P1", "Superset text host: Markdown component and SQL Lab narrative panel", "FE hosts", 5, "1.3, 1.4"),
    ("1.7", "P1", "Theming tokens from Superset, i18n, accessibility pass", "FE kit", 4, "1.3"),
    ("2.1", "P2", "@gck/target-tiptap: Artifact <-> ProseMirror JSON, gckChart, gckMetric, gckDataTable, gckToken nodes", "FE targets", 8, "0.5"),
    ("2.2", "P2", "Tiptap extension: /ai slash command, bubble actions, streaming insert, single undo step", "FE hosts", 7, "2.1, 1.3"),
    ("2.3", "P2", "Engine: transform and edit intents (selection import, patch generation)", "BE", 6, "1.2"),
    ("2.4", "P2", "Tiptap demo app and Playwright end-to-end tests", "QA", 4, "2.2"),
    ("3.1", "P3", "@gck/target-superset-dashboard: position_json and json_metadata builder", "FE targets", 6, "0.5"),
    ("3.2", "P3", "@gck/host-superset: extension commands, menus, dashboard context provider", "FE hosts", 6, "1.3"),
    ("3.3", "P3", "Apply flow: new dashboard or new tab through the Superset REST API, with revert", "FE hosts", 5, "3.1, 3.2"),
    ("3.4", "P3", "Engine: dashboard layout planning with the 12-column grid", "BE", 4, "1.2"),
    ("3.5", "P3", "Superset dev instance end-to-end tests, RLS and permission cases", "QA", 4, "3.3"),
    ("4.1", "P4", "@gck/target-slides on Template v2, lazy-loaded renderer", "FE targets", 6, "0.5"),
    ("4.2", "P4", "Presenton consumes the kit: replace outline and streaming hooks (strangler)", "FE hosts", 8, "4.1, 1.3"),
    ("4.3", "P4", "Engine: slides target behind /v1/runs, compatibility with existing Presenton endpoints", "BE", 6, "1.2"),
    ("4.4", "P4", "@gck/element web component and iframe fallback", "FE kit", 4, "1.3"),
    ("4.5", "P4", "Security review, bundle budgets, docs site, 1.0 release", "FE platform", 5, "4.2, 4.4"),
    # Live Superset data (ai-component/69-live-superset-data.md). Appended so existing IDs and CSV rows keep their order.
    ("1.8", "P1", "Story 8 source-typed refresh items, token exchange, shared gck_data mappers and snapshot shape", "BE", 6, "0.3"),
    ("1.9", "P1", "Engine data API: /v1/data/catalog and /v1/data/resolve, cache, limits, catalog-time mapping and format", "BE", 7, "1.2, 1.8"),
    ("1.10", "P1", "Live bindings in @gck/core: binding store, refresh controller, refresh policies; @gck/data-superset over the engine", "FE platform", 5, "1.5, 1.9"),
    ("1.11", "P1", "Dashboard filter capture: dataMask and permalink into HostDataScope, filter_context on bindings", "FE hosts", 3, "1.6"),
    ("1.12", "P1", "Story 8 dashboard filter scope: master filter context, 6.1 local resolver", "BE", 3, "1.8"),
    ("1.13", "P1", "Text target: Data as of footer and binding status rendering", "FE targets", 2, "1.4"),
    ("2.5", "P2", "Tiptap live data: binding node attrs, live provider, Refresh button, parameter bar, embed view, redact policy", "FE kit", 5, "2.1, 1.10"),
    ("2.6", "P2", "Dataset and metric sources (superset_dataset, superset_metric) and artifact parameters end to end", "BE", 5, "1.9"),
    ("2.7", "P2", "Dataset and metric entries in the kit catalog and source pickers", "FE kit", 1, "2.6, 1.3"),
    ("3.6", "P3", "Dashboard live text: Handlebars and Big Number charts, derived charts, filter scope, refresh_frequency", "FE targets", 4, "3.1, 3.3"),
    ("3.7", "P3", "Engine /v1/render: Python text target port, headless refresh as the schedule executor", "BE", 5, "1.9, 1.13"),
    ("3.8", "P3", "Live-data test tier: two RLS users per target, filter capture and follow, limits, drift", "QA", 3, "3.6, 2.5"),
    ("4.6", "P4", "Slides binding rows in from-content and the materializer, status handling, refresh-on-open parity", "BE", 4, "4.3, 1.8"),
    ("4.7", "P4", "Presenton transport for @gck/data-superset; useDeckRefresh over the refresh controller", "FE hosts", 3, "4.2, 1.10"),
    ("4.8", "P4", "text_template binding kind in Part VIII: live numbers in slide text", "BE", 3, "4.6"),
    ("4.9", "P4", "<gck-data> and <gck-artifact> live web components", "FE kit", 3, "4.4, 1.10"),
    ("4.10", "P4", "PPTX native-chart acceptance test, python-pptx post-processor if needed", "BE", 3, "4.6"),
]
by_phase = {}
for w in WP: by_phase.setdefault(w[1], []).append(w)
out = []
A = out.append
A("| Phase | Name | Goal | Indicative window | Work packages | Effort |")
A("| --- | --- | --- | --- | --- | --- |")
for pid, name, goal, window in PHASES:
    ws = by_phase[pid]
    A(f"| {pid} | {name} | {goal} | {window} | {len(ws)} | {sum(w[4] for w in ws)} d |")
A(f"| | **Total** | | | **{len(WP)}** | **{sum(w[4] for w in WP)} d** |")
A("")
areas = {}
for w in WP: areas[w[3]] = areas.get(w[3], 0) + w[4]
A("Effort by area:\n")
A("| Area | Effort | Share |")
A("| --- | --- | --- |")
tot = sum(areas.values())
for a, e in sorted(areas.items(), key=lambda x: -x[1]):
    A(f"| {a} | {e} d | {round(100*e/tot)}% |")
A("")
for pid, name, goal, window in PHASES:
    A(f"### {pid}: {name}\n")
    A(f"{goal}. {window}.\n")
    A("| ID | Work package | Area | Effort | Depends on | Status |")
    A("| --- | --- | --- | --- | --- | --- |")
    for w in by_phase[pid]:
        A(f"| {w[0]} | {w[2]} | {w[3]} | {w[4]} d | {w[5] or '-'} | Not started |")
    A("")
open(sys.argv[1], "w").write("\n".join(out) + "\n")
with open(sys.argv[2], "w", newline="") as f:
    wr = csv.writer(f)
    wr.writerow(["ID", "Phase", "Phase name", "Work package", "Area", "Effort (person-days)", "Depends on", "Owner", "Start week", "End week", "Status"])
    names = {p[0]: p[1] for p in PHASES}
    for w in WP:
        wr.writerow([w[0], w[1], names[w[1]], w[2], w[3], w[4], w[5], "", "", "", "Not started"])
print(len(WP), sum(w[4] for w in WP), areas)
