"""Generate the AI Slides release plan: schedule subtasks onto weekly releases
respecting dependencies and per-person capacity, then emit Markdown, CSV and XLSX."""
import csv, json, sys
from collections import defaultdict
from datetime import date

OUT_MD = sys.argv[1]       # tutorial/content/delivery/51-release-plan.md
OUT_ASSETS = sys.argv[2]   # tutorial/content/assets
OUT_SNIPPETS = sys.argv[3] # scratchpad dir for per-story snippets

RELEASES = [  # weekly release train, Fridays; holiday break 21 Dec 2026 to 1 Jan 2027
    ("R1", date(2026, 11, 13), 6.0),  # 8 working days from Wed 4 Nov
    ("R2", date(2026, 11, 20), 4.0),
    ("R3", date(2026, 11, 27), 4.0),
    ("R4", date(2026, 12, 4), 4.0),
    ("R5", date(2026, 12, 11), 4.0),
    ("R6", date(2026, 12, 18), 4.0),
    ("R7", date(2027, 1, 8), 4.0),
    ("R8", date(2027, 1, 15), 4.0),
    ("R9", date(2027, 1, 22), 4.0),
    ("R10", date(2027, 1, 29), 4.0),
    ("R11", date(2027, 2, 5), 4.0),
    ("R12", date(2027, 2, 12), 4.0),
    ("R13", date(2027, 2, 19), 4.0),
    ("R14", date(2027, 2, 26), 4.0),
    ("R15", date(2027, 3, 5), 4.0),
]
PEOPLE = ["Srini", "Sourav", "Nitesh", "Radhika"]

STORIES = {
    1: ("[Presenton BE] Dynamic data: refresh spike, binding storage and refresh service", "Srini, Sourav, Nitesh", "42-story1-dynamic-data.md",
        "Stores a Superset data binding for each chart or metric and refreshes values on open, after a spike picks the refresh approach."),
    2: ("[Presenton BE] Platform Integration: Postgres, access control, pod-ready API", "Nitesh", "43-story2-platform-integration.md",
        "Moves metadata to the analytics Postgres, enforces owner, org and collaborator access with platform identity, and makes the API fit the analytics pod."),
    3: ("[Presenton BE] Prompt library and custom templates backend", "Srini", "44-story3-prompt-library-backend.md",
        "Provides APIs for curated prompts and bundled templates and async generation, with custom template upload on hold pending a decision."),
    4: ("[Presenton FE] Native charts and async refresh UX", "Srini, Sourav, Nitesh", "45-story4-native-charts-ux.md",
        "Renders charts with a charting library from stored bindings and fills them in progressively with loading, error and stale states."),
    5: ("[Presenton FE] Analytics menu and iframe hardening", "Sourav", "46-story5-menu-and-iframe.md",
        "Adds the \"AI Slides\" menu item and makes the embedded Presenton iframe reliable (sizing, deep links, session handoff, base path)."),
    6: ("[Presenton FE] Prompt library and template UI", "Radhika", "47-story6-prompt-library-ui.md",
        "Lets users browse and use curated prompts and select templates, with template upload on hold."),
    7: ("[Harness] presentation-planner skill and refreshable-only data selection", "Srini, Nitesh", "48-story7-harness-planner.md",
        "Plans decks and picks only charts and metrics that Superset can refresh and the user can access, with validation, limits and an eval set."),
    8: ("[Analytics BE/MCP] Refresh APIs, MCP catalog, user-context enforcement, CSP and cookies", "Nitesh", "49-story8-analytics-mcp.md",
        "Lets Presenton and the harness discover and refresh Superset data per user, with RBAC enforcement and the iframe CSP and cookie settings."),
    9: ("[Infra] Deploy Presenton BE and FE alongside the analytics platform", "Nitesh, Sourav", "50-story9-infra.md",
        "Deploys both Presenton services with routing, secrets, storage, harness connectivity, CI/CD and monitoring."),
}

# id, title, effort (person-days), owners (effort split equally), deps
T = [
    ("1.1", "Refresh spike: prototype options A, B and C, measure, write and approve the decision record", 3, ["Srini", "Nitesh"], []),
    ("1.2", "slide_data_bindings SQLModel model and Alembic migration", 2, ["Srini"], ["1.1", "2.1"]),
    ("1.3", "Create bindings during generation from the DeckPlan", 3, ["Srini"], ["1.2", "7.1"]),
    ("1.4", "BindingRefreshService: batching, mapping, caching, snapshot write-back", 4, ["Srini"], ["1.2", "8.3"]),
    ("1.5", "Bindings API: GET and PUT bindings, refresh SSE stream, batch refresh", 3, ["Sourav"], ["1.4"]),
    ("1.6", "Export pre-refresh with 'data as of' fallback footnote", 2, ["Sourav"], ["1.4"]),
    ("1.7", "Tests (mappers, contract test against fake refresh API, migration) and metrics", 2, ["Srini"], ["1.5"]),

    ("2.1", "Postgres schema presenton, pool settings, migration Kubernetes Job", 2, ["Nitesh"], []),
    ("2.2", "POST /api/v1/platform/session: JWKS verification, jti replay guard, user and org upsert, cookie path", 3, ["Nitesh"], ["2.1", "8.2"]),
    ("2.3", "Encrypted data-token storage and refresh-data-token endpoint", 2, ["Nitesh"], ["2.2"]),
    ("2.4", "organizations and presentation_collaborators tables, require_presentation_access on every endpoint", 4, ["Nitesh"], ["2.2"]),
    ("2.5", "Sharing endpoints, owned plus shared listing, app_data asset authorization", 2, ["Nitesh"], ["2.4"]),
    ("2.6", "Pod readiness: /healthz, /readyz, JSON logs, graceful shutdown, root_path, local login off", 2, ["Nitesh"], ["2.1"]),

    ("3.1", "prompt_library_items model, migration and curated seed import", 2, ["Srini"], ["2.1"]),
    ("3.2", "List, detail and render endpoints with JSON Schema validation", 2, ["Srini"], ["3.1"]),
    ("3.3", "GET /api/v1/ppt/templates/bundled", 1, ["Srini"], []),
    ("3.4", "POST generate-from-prompt/async with planner stage and task polling", 3, ["Srini"], ["3.2", "7.5"]),
    ("3.5", "Gate custom template upload behind AI_SLIDES_CUSTOM_TEMPLATES_ENABLED and record open questions", 1, ["Srini"], []),
    ("3.6", "Backend tests for prompt library and async generation", 1, ["Srini"], ["3.4"]),

    ("4.1", "Chart rendering decision and element-patch reducer on the existing Chart.js path", 2, ["Sourav"], ["1.2"]),
    ("4.2", "useDeckRefresh SSE hook and bindingsSlice", 3, ["Sourav"], ["1.5", "4.1"]),
    ("4.3", "Overlay states (loading, error, stale, forbidden), status badge, retry, Refresh data button", 3, ["Radhika"], ["4.2"]),
    ("4.4", "Autosave interaction, visible-slide-first ordering, cancellation", 2, ["Srini"], ["4.2"]),
    ("4.5", "Presentation mode and export render checks", 1, ["Nitesh"], ["4.3"]),
    ("4.6", "Reducer unit tests and Cypress component tests for every state", 2, ["Radhika"], ["4.3"]),

    ("5.1", "AI Slides menu item and role permission in Superset", 1, ["Sourav"], []),
    ("5.2", "Superset host page /ai-slides/launch with iframe and postMessage bridge", 2, ["Sourav"], ["8.2"]),
    ("5.3", "Next.js basePath /ai-slides and prefix fixes (proxy, asset URLs, export route)", 3, ["Sourav"], []),
    ("5.4", "PlatformSessionBridge component with re-handoff on expiry", 2, ["Sourav"], ["2.2", "5.2"]),
    ("5.5", "Iframe sizing, fullscreen, deep links, downloads", 2, ["Sourav"], ["5.3"]),
    ("5.6", "End-to-end tests and browser QA matrix", 2, ["Sourav"], ["5.4", "5.5"]),

    ("6.1", "Prompt library API client and state", 1, ["Radhika"], ["3.1"]),
    ("6.2", "PromptLibraryPanel and PromptCard with search and category filters", 3, ["Radhika"], ["6.1"]),
    ("6.3", "PromptVariablesForm from JSON Schema, with dashboard picker", 3, ["Radhika"], ["6.2", "8.4"]),
    ("6.4", "TemplatePicker with bundled templates and recommended badge", 2, ["Radhika"], ["3.3"]),
    ("6.5", "GenerateFromPromptButton with async progress, navigation and ?prompt= deep link", 2, ["Radhika"], ["3.4", "6.3"]),
    ("6.6", "Hide template upload entry points via runtime flag", 0.5, ["Radhika"], []),
    ("6.7", "Unit and Cypress component tests", 1.5, ["Radhika"], ["6.5"]),

    ("7.1", "Skill scaffold: SKILL.md, DeckPlan JSON Schema and Pydantic models, layout catalog input", 2, ["Srini"], []),
    ("7.2", "Catalog and MCP tool integration (list, info, row-limited samples) with the data token", 3, ["Nitesh"], ["8.4", "8.5"]),
    ("7.3", "Refreshable-only selection, viz_type compatibility table, ranking", 3, ["Srini"], ["7.1", "7.2"]),
    ("7.4", "Deterministic validators, bounded repair loop, limits and budgets", 3, ["Srini"], ["7.3"]),
    ("7.5", "Presenton BE harness client: DeckPlan to structure and bindings", 2, ["Srini"], ["7.4", "1.3"]),
    ("7.6", "Eval set (40+ cases), runner and CI gate", 4, ["Srini"], ["7.4"]),

    ("8.1", "ai_slides blueprint scaffold, signing keys and JWKS endpoint", 2, ["Nitesh"], []),
    ("8.2", "Handoff endpoint and data-token verification with user context", 2, ["Nitesh"], ["8.1"]),
    ("8.3", "Refresh API: saved query context, overrides merge, ChartDataCommand, normalization, errors", 4, ["Nitesh"], ["8.2", "1.1"]),
    ("8.4", "Catalog endpoint with refreshable rules", 2, ["Nitesh"], ["8.3"]),
    ("8.5", "MCP: JWT auth as the user, tool allowlist, custom catalog tool", 2, ["Nitesh"], ["8.2"]),
    ("8.6", "CSP, cookie settings and CSRF exemptions for Bearer endpoints", 1, ["Nitesh"], []),
    ("8.7", "Integration tests: RLS, forbidden charts, overrides", 2, ["Nitesh"], ["8.4"]),

    ("9.1", "Split the Dockerfile into presenton-be and presenton-fe images", 2, ["Sourav"], []),
    ("9.2", "Dev namespace: Helm chart, prefix ingress, migrate Job", 3, ["Nitesh"], ["9.1"]),
    ("9.3", "Secrets through External Secrets", 1, ["Sourav"], ["9.2"]),
    ("9.4", "Storage: RWX PVC for v1, object-storage plan", 1, ["Sourav"], ["9.2"]),
    ("9.5", "CI/CD: build, scan, push, deploy dev, staging and prod", 3, ["Sourav"], ["9.1"]),
    ("9.6", "Monitoring: metrics, tracing, dashboards, alerts", 3, ["Sourav"], ["9.2"]),
    ("9.7", "Production rollout: canary and pilot role", 2, ["Nitesh", "Sourav"],
     ["5.6", "4.6", "6.7", "7.6", "3.6", "2.5", "8.7", "9.6", "1.7", "1.6", "4.4", "4.5", "2.6", "2.3", "9.3", "9.4", "9.5", "8.6", "3.5", "6.6", "6.4"]),
]
ARCHITECT_OWNERS = {k: set(v[1].split(", ")) for k, v in STORIES.items()}

tasks = {t[0]: dict(id=t[0], story=int(t[0].split(".")[0]), title=t[1], effort=t[2], owners=t[3], deps=t[4]) for t in T}
for t in tasks.values():
    for d in t["deps"]:
        assert d in tasks, (t["id"], d)
    t["reassigned"] = not set(t["owners"]) <= ARCHITECT_OWNERS[t["story"]]

# ---- day-level list scheduling by critical-path priority ----
from datetime import timedelta
FOCUS = 0.8  # focus-days per working day
HOLIDAYS = {date(2026, 12, 21) + timedelta(days=i) for i in range(12)}
DAYS = []
d0 = date(2026, 11, 4)
while len(DAYS) < 400:
    if d0.weekday() < 5 and d0 not in HOLIDAYS:
        DAYS.append(d0)
    d0 += timedelta(days=1)
dependents = defaultdict(list)
for t in tasks.values():
    for d in t["deps"]:
        dependents[d].append(t["id"])
memo = {}
def cp(i):
    if i not in memo:
        memo[i] = tasks[i]["effort"] + max([cp(j) for j in dependents[i]], default=0)
    return memo[i]
BOOST = {"9.1": 30, "9.2": 30, "2.1": 20, "8.1": 20, "1.1": 20, "8.2": 15, "2.2": 10, "5.3": 10}
free = {p: 0.0 for p in PEOPLE}  # next free working-day index (fractional)
done = set()
while len(done) < len(tasks):
    ready = [t for t in tasks.values() if t["id"] not in done and all(d in done for d in t["deps"])]
    ready.sort(key=lambda t: (-(cp(t["id"]) + BOOST.get(t["id"], 0)), [int(x) for x in t["id"].split(".")]))
    # pick the ready task that can start earliest; ties by priority
    def est(t):
        return max([free[p] for p in t["owners"]] + [tasks[d]["end"] for d in t["deps"]])
    t = min(ready, key=lambda t: (est(t), ready.index(t)))
    s0 = est(t)
    dur = t["effort"] / len(t["owners"]) / FOCUS
    t["start"], t["end"] = s0, s0 + dur
    for p in t["owners"]:
        free[p] = t["end"]
    done.add(t["id"])

def release_for(end_idx):
    day = DAYS[max(0, int(end_idx - 1e-9 + 0.999999) - 1)] if end_idx > 0 else DAYS[0]
    for w, (r, rd, c) in enumerate(RELEASES):
        if day <= rd:
            return w
    raise SystemExit("extend RELEASES")
load = defaultdict(float)
for t in tasks.values():
    t["week"] = release_for(t["end"])
    t["release"], t["date"] = RELEASES[t["week"]][0], RELEASES[t["week"]][1]
    for p in t["owners"]:
        load[(p, t["week"])] += t["effort"] / len(t["owners"])
    t["start_day"], t["end_day"] = DAYS[int(t["start"])], DAYS[max(0, int(t["end"] - 1e-9))]

def esc(x): return x.replace("[", "\\[").replace("]", "\\]")
def fmt_date(d): return d.strftime("%a %d %b %Y").replace(" 0", " ")
def fmt_eff(e): return (f"{e:g}") + " d"

story_rows = []
for s, (title, owners, page, what) in STORIES.items():
    sub = [t for t in tasks.values() if t["story"] == s]
    eff = sum(t["effort"] for t in sub)
    last = max(sub, key=lambda t: t["week"])
    first = min(sub, key=lambda t: t["week"])
    story_rows.append(dict(story=s, title=title, owners=owners, page=page, what=what, subtasks=sub,
                           effort=eff, release=last["release"], date=last["date"], start=first["release"]))

total = sum(t["effort"] for t in tasks.values())
last_week = max(t["week"] for t in tasks.values())

# ---------- Markdown ----------
L = []
A = L.append
A("# Release plan and tracker\n")
A('<div class="chapter-meta" markdown>')
A("**Reads:** the architect's story sheet  ·  **Builds on:** [Part VIII landing](index.md), [Architecture and contracts](41-architecture-and-contracts.md)  ·  **Time:** ~15 min")
A("</div>\n")
A("This page breaks the nine stories into trackable subtasks. Each subtask has an owner, an effort estimate, a weekly release date and a status, matching the columns of the team's story sheet (SubTasks, Effort, Release Date, Status). The schedule respects task dependencies and each person's weekly capacity. A spreadsheet version is available for the team tracker.\n")
A("[:material-microsoft-excel: Download tracker (.xlsx)](../assets/ai-slides-tracker.xlsx){ .md-button .md-button--primary } [:material-file-delimited: Download tracker (.csv)](../assets/ai-slides-tracker.csv){ .md-button }\n")
A("## Step 1: Understand the planning rules\n")
A("| Rule | Value |")
A("| --- | --- |")
A("| Release cadence | Weekly release train, every Friday. Code freeze Thursday 17:00, deploy to staging Friday morning, production promotion after sign-off |")
A("| Plan start | Wednesday 4 November 2026 (the first train, R1, has 8 working days) |")
A("| Holiday break | No release trains from 21 December 2026 to 1 January 2027 (assumed; adjust to the team calendar) |")
A("| Effort unit | Ideal person-days (`d`) of focused work, including tests and code review, excluding meetings |")
A("| Capacity | 0.8 focus-days per working day per person (4 per 5-day week); one subtask at a time per person, critical-path work first |")
A("| Release date of a subtask | The Friday of the train it ships in, to dev or staging behind a feature flag |")
A("| Release date of a story | The release date of its last subtask |")
A("| Dependencies | A subtask is never scheduled before the train of anything it depends on |")
A("")
A("!!! note \"Estimates are starting points\"")
A("    The efforts below were derived from the implementation steps in each story chapter. Re-estimate in the first planning meeting, update the spreadsheet, and keep this page in sync (the generator script is described at the end of this page).\n")
A("## Step 2: Read the release calendar\n")
A("| Train | Release date | Capacity per person |")
A("| --- | --- | --- |")
for i, (r, d, c) in enumerate(RELEASES[: last_week + 1]):
    A(f"| {r} | {fmt_date(d)} | {c:g} d |")
A("")
A("## Step 3: Read the story summary\n")
A("| # | Story | Owner | SubTasks | Effort | Starts | Release date | Status |")
A("| --- | --- | --- | --- | --- | --- | --- | --- |")
for r in story_rows:
    A(f"| {r['story']} | [{esc(r['title'])}]({r['page']}) | {r['owners']} | {len(r['subtasks'])} | {fmt_eff(r['effort'])} | {r['start']} | {r['release']} · {fmt_date(r['date'])} | Not started |")
A(f"| | **Total** | | **{len(tasks)}** | **{fmt_eff(total)}** | | **{RELEASES[last_week][0]} · {fmt_date(RELEASES[last_week][1])}** | |")
A("")
A("## Step 4: Track the subtasks\n")
A("Status values: `Not started`, `In progress`, `In review`, `Blocked`, `Done`. Update the Status column in the spreadsheet; the trains and dates only change when the plan is re-baselined.\n")
for r in story_rows:
    A(f"### Story {r['story']}: {esc(r['title'])}\n")
    A(f"Owner: {r['owners']} · Effort: {fmt_eff(r['effort'])} · Release: {r['release']} ({fmt_date(r['date'])}) · [Implementation guide]({r['page']})\n")
    A("| ID | SubTask | Owner | Effort | Depends on | Release date | Status |")
    A("| --- | --- | --- | --- | --- | --- | --- |")
    for t in sorted(r["subtasks"], key=lambda t: [int(p) for p in t["id"].split(".")]):
        own = ", ".join(t["owners"]) + (" (proposed)" if t["reassigned"] else "")
        deps = ", ".join(t["deps"]) if len(t["deps"]) <= 4 else "all other subtasks"
        A(f"| {t['id']} | {t['title']} | {own} | {fmt_eff(t['effort'])} | {deps or '-'} | {t['release']} · {fmt_date(t['date'])} | Not started |")
    A("")
A("## Step 5: Check the weekly load per person\n")
A("Person-days of subtasks that ship in each train. A subtask counts in the train it finishes in, so a long subtask can make one train look heavier than 4 d while the previous train looks light.\n")
A("| Train | " + " | ".join(PEOPLE) + " |")
A("| --- | " + " | ".join("---" for _ in PEOPLE) + " |")
for w in range(last_week + 1):
    A(f"| {RELEASES[w][0]} ({RELEASES[w][1].strftime('%d %b')}) | " + " | ".join(f"{load[(p, w)]:g}" for p in PEOPLE) + " |")
tot_p = {p: sum(load[(p, w)] for w in range(last_week + 1)) for p in PEOPLE}
A("| **Total** | " + " | ".join(f"**{tot_p[p]:g}**" for p in PEOPLE) + " |")
A("")
A("## Step 6: Read the schedule as a Gantt chart\n")
A("```mermaid")
A("gantt")
A("    title AI Slides weekly release plan")
A("    dateFormat YYYY-MM-DD")
A("    axisFormat %d %b")
A("    excludes weekends")
from datetime import timedelta
for r in story_rows:
    A(f"    section Story {r['story']}")
    for t in sorted(r["subtasks"], key=lambda t: t["week"]):
        A(f"    {t['id']} :s{t['id'].replace('.', '_')}, {t['start_day'].isoformat()}, {(t['end_day'] + timedelta(days=1)).isoformat()}")
A("```\n")
A("## Step 7: Watch the scheduling risks\n")
nit = tot_p["Nitesh"]
A("!!! warning \"Gotcha: Srini and Nitesh set the end date\"")
A(f"    Srini carries {tot_p['Srini']:g} d and Nitesh {tot_p['Nitesh']:g} d, against {tot_p['Sourav']:g} d for Sourav and {tot_p['Radhika']:g} d for Radhika. Nitesh owns all of Stories 2 and 8 (identity handoff, refresh API, catalog), which most other work waits on, and Srini owns the binding service, the planner and the prompt backend. The plan finishes in {RELEASES[last_week][0]} only if both stay focused. Protect their time, pair on 8.3 (refresh API) if it slips, and treat any new request for either of them as a date change.\n")
A("!!! info \"Proposed reassignments\"")
A("    Subtasks marked `(proposed)` are assigned to someone who is not listed as an owner of that story on the architect's sheet. They balance the load and should be confirmed by the architect. Radhika has spare capacity after Story 6, so the Story 4 overlay states and component tests (4.3, 4.6) are proposed for her; she is already building the same UI patterns in Story 6.\n")
A("Other risks that move dates:\n")
A("- The Story 1 spike (1.1) can change the refresh approach. If it selects option A (browser calls Superset directly), subtasks 1.4, 1.5 and 8.3 change shape; re-plan at the end of R1.")
A("- Story 8 depends on how the analytics platform packages Superset changes (blueprint or extension). Settle that in R1.")
A("- The harness team's availability for Story 7 integration (7.2) is an external dependency.")
A("- Custom template upload stays out of the plan until the pending decision is made.\n")
A("## Step 8: Keep the tracker in sync\n")
A("This page, the tracking table in each story chapter, and both spreadsheet downloads are generated from one subtask list (IDs, efforts, owners, dependencies) by `tutorial/scripts/gen_release_plan.py`. The script schedules subtasks day by day: critical-path work first, one subtask at a time per person, never before its dependencies. Each subtask then ships in the first Friday train on or after its finish day. To re-plan, edit the `T` list or the `RELEASES` calendar in the script and regenerate (it needs `openpyxl`):\n")
A("```bash")
A("python tutorial/scripts/gen_release_plan.py tutorial/content/delivery/51-release-plan.md tutorial/content/assets /tmp/ai-slides-snippets")
A("```\n")
A("Then paste the regenerated per-story tables from the snippets folder into the Tracking section of each story chapter, and commit. Statuses live in the team spreadsheet; copy them back here at each release review if you want the site to show progress.\n")
A("## What you now know\n")
A(f"- The {len(tasks)} subtasks behind the nine stories, with owners, effort and dependencies.")
A(f"- The weekly release train, from R1 on {fmt_date(RELEASES[0][1])} to {RELEASES[last_week][0]} on {fmt_date(RELEASES[last_week][1])}, and which train each subtask ships in.")
A(f"- The total estimated effort ({fmt_eff(total)}) and the weekly load per person.")
A("- The scheduling risks, starting with the critical path through Stories 8 and 2.\n")
A("## Next\n")
A("Start building with [Story 1: Dynamic data, binding storage and refresh service](42-story1-dynamic-data.md).")
open(OUT_MD, "w").write("\n".join(L) + "\n")

# ---------- per-story snippets ----------
for r in story_rows:
    S = []
    S.append("## Tracking: subtasks, effort and release dates\n")
    S.append(f"This story is planned as {len(r['subtasks'])} subtasks, {fmt_eff(r['effort'])} in total, finishing in train {r['release']} on {fmt_date(r['date'])}. The full plan, the weekly load per person and the spreadsheet download are in the [release plan and tracker](51-release-plan.md).\n")
    S.append("| ID | SubTask | Owner | Effort | Depends on | Release date | Status |")
    S.append("| --- | --- | --- | --- | --- | --- | --- |")
    for t in sorted(r["subtasks"], key=lambda t: [int(p) for p in t["id"].split(".")]):
        own = ", ".join(t["owners"]) + (" (proposed)" if t["reassigned"] else "")
        deps = ", ".join(t["deps"]) if len(t["deps"]) <= 4 else "all other subtasks"
        S.append(f"| {t['id']} | {t['title']} | {own} | {fmt_eff(t['effort'])} | {deps or '-'} | {t['release']} · {fmt_date(t['date'])} | Not started |")
    S.append("")
    open(f"{OUT_SNIPPETS}/story{r['story']}.md", "w").write("\n".join(S) + "\n")

# ---------- CSV and XLSX (team sheet columns + subtask rows) ----------
header = ["Num", "Story title", "What it does", "Owner", "SubTask ID", "SubTasks", "SubTask owner", "Effort (person-days)", "Depends on", "Release train", "Release Date", "Status"]
rows = []
for r in story_rows:
    rows.append([r["story"], r["title"], r["what"], r["owners"], "", f"{len(r['subtasks'])} subtasks", "", r["effort"], "", r["release"], r["date"].isoformat(), "Not started"])
    for t in sorted(r["subtasks"], key=lambda t: [int(p) for p in t["id"].split(".")]):
        rows.append(["", "", "", "", t["id"], t["title"], ", ".join(t["owners"]) + (" (proposed)" if t["reassigned"] else ""),
                     t["effort"], ", ".join(t["deps"]), t["release"], t["date"].isoformat(), "Not started"])
with open(f"{OUT_ASSETS}/ai-slides-tracker.csv", "w", newline="") as f:
    w = csv.writer(f); w.writerow(header); w.writerows(rows)

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from datetime import datetime
wb = Workbook(); ws = wb.active; ws.title = "AI slides"
ws.append(header)
hdr_fill = PatternFill("solid", fgColor="F4B183")
story_fill = PatternFill("solid", fgColor="FBE5D6")
thin = Side(style="thin", color="999999")
for c in ws[1]:
    c.font = Font(bold=True); c.fill = hdr_fill; c.alignment = Alignment(wrap_text=True, vertical="center")
for row in rows:
    row = list(row)
    row[10] = datetime.fromisoformat(row[10])
    ws.append(row)
    cur = ws.max_row
    for c in ws[cur]:
        c.alignment = Alignment(wrap_text=True, vertical="top")
        c.border = Border(top=thin, bottom=thin, left=thin, right=thin)
        if row[0] != "":
            c.fill = story_fill; c.font = Font(bold=True)
    ws.cell(cur, 11).number_format = "ddd dd mmm yyyy"
    if row[0] == "":  # story effort rows sum their subtasks
        pass
widths = [6, 42, 48, 18, 10, 60, 18, 12, 18, 9, 16, 14]
for i, wdt in enumerate(widths, 1):
    ws.column_dimensions[chr(64 + i)].width = wdt
dv = DataValidation(type="list", formula1='"Not started,In progress,In review,Blocked,Done"', allow_blank=False)
ws.add_data_validation(dv); dv.add(f"L2:L{ws.max_row}")
ws.freeze_panes = "A2"
ws.auto_filter.ref = f"A1:L{ws.max_row}"
cal = wb.create_sheet("Release calendar")
cal.append(["Train", "Release date", "Capacity per person (d)"])
for c in cal[1]: c.font = Font(bold=True); c.fill = hdr_fill
for r_, d_, c_ in RELEASES[: last_week + 1]:
    cal.append([r_, datetime.combine(d_, datetime.min.time()), c_]); cal.cell(cal.max_row, 2).number_format = "ddd dd mmm yyyy"
lw = wb.create_sheet("Load per person")
lw.append(["Train"] + PEOPLE)
for c in lw[1]: c.font = Font(bold=True); c.fill = hdr_fill
for w_ in range(last_week + 1):
    lw.append([RELEASES[w_][0]] + [load[(p, w_)] for p in PEOPLE])
for s in (cal, lw):
    for col in "ABCDE": s.column_dimensions[col].width = 18
wb.save(f"{OUT_ASSETS}/ai-slides-tracker.xlsx")

print(json.dumps({"tasks": len(tasks), "total": total, "last": RELEASES[last_week][0], "date": str(RELEASES[last_week][1]),
                  "per_person": tot_p,
                  "stories": {r["story"]: [r["effort"], r["release"], str(r["date"])] for r in story_rows},
                  "max_week_load": max(load.values())}, indent=1))
