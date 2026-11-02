# Research notes for the tutorial (work in progress, not published)

This file sits outside `tutorial/content/`, so MkDocs does not publish it.

## Status

- Done: `mkdocs.yml` (full nav), `content/index.md`, stylesheet, Pages workflow `.github/workflows/docs-pages.yml`.
- Not done: every chapter file under `content/presenton/` and `content/superset/`, the appendices, the first push, and enabling Pages.
- Note: `mkdocs build --strict` fails until every nav file exists. Do not push to `main` before that.
- Push plan: push `main` to `origin` (debnathSD/presenton-os). The workflow then builds the site and runs `mkdocs gh-deploy`. If Pages is not enabled after the first GITHUB_TOKEN push, set Settings > Pages > Branch to `gh-pages` once.
- Upstream CI also runs on push to `main` in the mirror: `test-all.yml`, `codeql.yml`, and `export-runtime-regressions.yml`. `docker-release` and `sync-releaes-to-r2` run only on releases.

## Presenton facts gathered

- Snapshot commit `571461f` (2026-11-01), tag line `electron-v0.9.12-beta`, 2952 commits.
- 16 templates with these layout counts: civic 29, dynamic 32, editorial 24, executive 32, general 12, horizon 28, landmark 27, modern 10, momentum 28, mosaic 34, nova 28, pulse 28, signal 24, standard 11, swift 9, verdant 27.
- The FastAPI code has about 58k lines of Python excluding tests. There are 24 alembic migrations.
- Docker processes: `node start.js` supervises nginx on :80, FastAPI `server.py` on :8000, `mcp_server.py` on :8001, Next.js standalone on :3000, and optionally Ollama.
- The standard flow, from docs/presenton-resource-usage.md, runs in five steps:
  1. `POST /api/v1/ppt/presentation/create`
  2. `GET /api/v1/ppt/outlines/stream/{id}` (SSE)
  3. `POST /api/v1/ppt/presentation/prepare`
  4. `GET /api/v1/ppt/presentation/stream/{id}` (SSE)
  5. export
- Smart mode exposes `POST /api/v2/ppt/presentation/generate/smart` and its `/async` variant.
- Template v2 uses a 1280x720 coordinate system. Each element has a `decorative` flag, and non-decorative elements become LLM schema fields. Text elements carry `max_length` and `min_length`.
- Images use `__image_prompt__` and icons use `__icon_query__`. `utils/process_slides.py` resolves both to URLs.
- Export runs through the closed npm package `@presenton/export-core` (v1.0.51). It is downloaded by `scripts/sync-presentation-export.cjs` and driven by headless Chromium.

## Superset 6.1 facts (web research, Nov 2026)

- The latest stable release is 6.1.0 (2026-05-13). A 7.0 branch has been cut.
- The extensions packages are `@apache-superset/core` (frontend, Module Federation), `apache-superset-core` (backend, 0.1.0), and the CLI `superset-extensions` (`init`, `dev`, `build`, `bundle` to `.supx`, `validate`).
- Extensions deploy through `EXTENSIONS_PATH`, with `LOCAL_EXTENSIONS` for development.
- Frontend APIs:
  - `views.registerView(..., 'sqllab.panels', ...)`
  - `commands.registerCommand`
  - `menus.registerMenuItem(..., 'sqllab.editor', 'primary'|'secondary'|'context')`
  - `editors.registerEditor`
  - `chat.registerChat` (SIP-214)
- Backend APIs:
  - `@api` on a `RestApi` subclass, served under `/extensions/{publisher}/{name}/`
  - `@tool` and `@prompt` from `superset_core.mcp.decorators`
  - `@task(name, scope=TaskScope.SHARED)` from `superset_core.tasks.decorators`, part of the Global Task Framework (`GLOBAL_TASK_FRAMEWORK` flag, `/api/v1/task/`)
  - `@semantic_layer`
- Built-in MCP:
  - Start it with `superset mcp run`. It listens on port 5008 at `/mcp`.
  - Auth uses JWT (`MCP_AUTH_ENABLED`, `MCP_JWKS_URI`) and RBAC (`MCP_RBAC_ENABLED`).
  - Data tools include `get_chart_data`, `get_dashboard_data`, `get_dashboard_layout`, `query_dataset`, `execute_sql`, `list_metrics`, `get_dataset_info`, and `generate_chart`.
- Chart data API: `POST /api/v1/chart/data` takes `datasource`, `queries[]`, `result_type`, and `result_format`.
  - `result_type` values: `full`, `results`, `query`, `samples`, `columns`, `timegrains`, `post_processed`, `drill_detail`.
  - `result_format` values: `json`, `csv`, `xlsx` (`arrow` is rejected).
  - A saved chart's stored query context can be fetched with `GET /api/v1/chart/{id}/data`.
  - Each response row includes `colnames`, `coltypes`, `data`, `applied_filters`, and `rejected_filters`.
- Dashboard API: `/api/v1/dashboard/{id}` returns `position_json` and `json_metadata`, including `native_filter_configuration`. `/api/v1/dashboard/{id}/charts` returns `form_data`, and `/datasets` returns columns and metrics. The grid has 12 columns with `GRID_BASE_UNIT` 8.
- Reports:
  - Celery beat and Playwright Chromium take screenshots; since 7.0 Playwright is the only option.
  - The webhook notification needs the `ALERT_REPORT_WEBHOOK` flag. It POSTs JSON with `name`, `header`, `text`, `description`, and `url`, or multipart when attachments are included.
- Design direction for Part VII:
  - Build a Superset extension, made of a frontend panel and command plus a backend `@api`, `@tool`, and `@task`.
  - Pair it with a "DeckForge" generation service.
  - Use a data-bound slide model whose chart elements reference chart and query context, never screenshots.
  - Render natively: PPTX native charts and tables are filled from `/api/v1/chart/data` at export or refresh time, under the requesting user's RLS.
