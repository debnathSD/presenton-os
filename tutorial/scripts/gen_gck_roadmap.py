"""Generate the Generative Content Kit roadmap tables and CSV tracker.
Usage: python tutorial/scripts/gen_gck_roadmap.py <out_md_fragment> <out_csv>"""
import csv, sys
PHASES = [
    ("P0", "Foundations", "Monorepo, protocol, client, core state machine, mock engine", "Weeks 1-3"),
    ("P1", "Engine and first non-slide target", "GCK Engine run API and the text target in Superset", "Weeks 4-7"),
    ("P2", "Tiptap pages", "Tiptap target and extension, transform and edit intents", "Weeks 8-11"),
    ("P3", "Superset dashboards", "Dashboard target and Superset host", "Weeks 12-15"),
    ("P4", "Slides on the kit", "Presenton and AI Slides consume the kit, web component, hardening", "Weeks 16-19"),
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
    ("1.5", "P1", "@gck/data-superset: catalog, binding resolution through the Part VIII refresh API", "FE targets", 4, "0.5"),
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
