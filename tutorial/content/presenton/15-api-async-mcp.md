# REST API, async tasks, webhooks, MCP

<div class="chapter-meta" markdown>
**Reads:** `servers/fastapi/api/v1/ppt/endpoints/presentation.py`, `servers/fastapi/api/v2/ppt/endpoints/presentation.py`, `servers/fastapi/api/v1/async_tasks/router.py`, `servers/fastapi/services/async_tasks.py`, `servers/fastapi/api/v1/webhook/router.py`, `servers/fastapi/services/webhook_service.py`, `servers/fastapi/mcp_server.py`, `servers/fastapi/utils/mcp_public_urls.py`  ·  **Builds on:** [Standard generation pipeline](08-standard-pipeline.md), [Auth and multi-user](25-auth-and-multiuser.md)  ·  **Time:** ~50 min
</div>

Presenton is not only a web app: the same FastAPI process is a headless presentation API that other programs and AI agents can drive. This chapter walks through that product surface in execution order: how a program authenticates, the full `GeneratePresentationRequest` contract, what the synchronous `/generate` endpoint does and returns, how the async variant persists progress in an `async_tasks` row that you poll, what happens to those rows when the server restarts, how Smart generation is exposed under `/api/v2`, how webhooks are stored and delivered (and what they do not do), and how `mcp_server.py` turns a static OpenAPI document into a Model Context Protocol server with mode-gated tools and a key-for-session exchange.

## Step 1: The API surface at a glance

Three processes are involved in a Docker deployment: nginx on port 80, FastAPI on 8000, and the MCP server on 8001 (spawned by `start.js:608`). nginx forwards `/api/v1/` and `/api/v2/` to FastAPI with 30 minute timeouts, and `/mcp` to the MCP server (`nginx.conf:45`, `nginx.conf:59`, `nginx.conf:94`). The topology itself is covered in [Runtime topology](03-runtime-topology.md).

```mermaid
flowchart LR
    C["HTTP client (curl, SDK)"] --> N["nginx :80"]
    M["MCP client (VS Code, Open WebUI)"] --> N
    N -->|/api/v1 and /api/v2| F["FastAPI :8000"]
    N -->|/mcp| P["mcp_server.py :8001 (FastMCP)"]
    P -->|httpx with session cookie| F
    F --> DB[("async_tasks, webhook_subscriptions, presentations")]
    F -->|POST JSON| W["Webhook subscriber URLs"]
```

| Method and path | Purpose | Defined at |
| --- | --- | --- |
| `POST /api/v1/ppt/presentation/generate` | Standard deck, blocking | `servers/fastapi/api/v1/ppt/endpoints/presentation.py:3169` |
| `POST /api/v1/ppt/presentation/generate/async` | Standard deck, returns a task | `servers/fastapi/api/v1/ppt/endpoints/presentation.py:3240` |
| `GET /api/v1/ppt/presentation/status/{id}` | Poll a task (legacy path) | `servers/fastapi/api/v1/ppt/endpoints/presentation.py:3282` |
| `POST /api/v1/ppt/presentation/{id}/export` | Re-export an existing deck | `servers/fastapi/api/v1/ppt/endpoints/presentation.py:1642` |
| `POST /api/v1/ppt/presentation/edit` | Patch slide content and export | `servers/fastapi/api/v1/ppt/endpoints/presentation.py:3301` |
| `POST /api/v1/ppt/presentation/derive` | Copy a deck with patched content and export | `servers/fastapi/api/v1/ppt/endpoints/presentation.py:3352` |
| `POST /api/v2/ppt/presentation/generate/smart` | Smart deck, blocking | `servers/fastapi/api/v2/ppt/endpoints/presentation.py:229` |
| `POST /api/v2/ppt/presentation/generate/smart/async` | Smart deck, returns a task | `servers/fastapi/api/v2/ppt/endpoints/presentation.py:264` |
| `GET /api/v1/async-tasks` | List tasks with filters | `servers/fastapi/api/v1/async_tasks/router.py:20` |
| `GET /api/v1/async-tasks/status/{id}` | Poll any task | `servers/fastapi/api/v1/async_tasks/router.py:69` |
| `POST /api/v1/webhook/subscribe` | Register a webhook | `servers/fastapi/api/v1/webhook/router.py:23` |
| `DELETE /api/v1/webhook/unsubscribe` | Remove a webhook | `servers/fastapi/api/v1/webhook/router.py:40` |
| `GET /api/v1/mock/presentation-generation-completed` | Sample success payload | `servers/fastapi/api/v1/mock/router.py:12` |
| `GET /api/v1/mock/presentation-generation-failed` | Sample failure payload | `servers/fastapi/api/v1/mock/router.py:26` |
| `POST /api/v1/ppt/files/upload` | Multipart upload of source files | `servers/fastapi/api/v1/ppt/endpoints/files.py:79` |
| `POST /api/v1/ppt/files/mcp-upload` | Base64 upload of source files | `servers/fastapi/api/v1/ppt/endpoints/files.py:103` |

Every endpoint is also listed in the [Endpoint index](../appendix-endpoints.md).

!!! warning "Gotcha"
    `POST /api/v1/ppt/presentation/{id}/export` exists because a long blocking `/generate` call can be cut by a proxy or a client timeout after the deck was already saved; its docstring says so (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:1649`). With the `presentation_id` in hand you can export again (body `{"export_as": "pdf"}`) without regenerating. The catch is getting that id: a failed sync response does not contain it, while an async task carries it in `data` from the start.

## Step 2: Authenticate as a program

With account login enabled, `SessionAuthMiddleware` requires authentication for every `/api/` path except five public auth routes (`servers/fastapi/api/middlewares.py:30`). It resolves a principal in `resolve_request_principal` (`servers/fastapi/api/v1/auth/principal.py:22`): a `presenton_session` JWT cookie first, otherwise an `Authorization: Bearer <token>` header verified as an API key.

### 2.1 Key format

```python title="servers/fastapi/services/api_keys.py (excerpt)"
API_KEY_PREFIX = "sk-presenton-"
DEFAULT_EXPIRY_DAYS = 90
MAX_EXPIRY_DAYS = 365
API_KEY_ID_PATTERN = re.compile(r"^[0-9a-f]{16}$")
# ...
def build_api_key(api_key_id: str, secret: str) -> str:
    return f"{API_KEY_PREFIX}{api_key_id}.{secret}"
```

A key looks like `sk-presenton-0123456789abcdef.<secret>`: a 16-hex-character id (`secrets.token_hex(8)`, also the `api_keys.id` primary key) and a secret from `secrets.token_urlsafe(40)`. `parse_api_key` rejects anything without the prefix, a dot, a valid id, or a secret of at least 32 characters (`servers/fastapi/services/api_keys.py:50`). Only a password hash of the secret is used for verification; an encrypted copy of the whole token (Fernet, keyed by a SHA-256 of the auth secret) lets an admin reveal it again.

### 2.2 Verification

`verify_api_key` (`servers/fastapi/services/api_keys.py:107`) loads the row by id, rejects it if revoked or expired, checks the secret against `secret_hash` (upgrading the hash if the helper asks), requires the owning user to be active, and stamps `last_used_at`. The middleware then:

1. Sets `request.state.auth_principal` with `method="api_key"`.
2. Mints an internal session JWT for that user (`servers/fastapi/api/middlewares.py:123`). The export step needs it: the headless browser that renders the deck must load the editor page as that user, and `build_export_cookie_header` turns it into a `presenton_session=` cookie (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:1486`).
3. Sets the owner context variables, so every row created during the request is stamped with the key owner's id and every ORM `SELECT` is filtered to it.

Keys are issued, listed, revealed and revoked under `/api/v1/admin/api-keys` from an admin browser session (`servers/fastapi/api/v1/admin/router.py:44`). An API key can never call those admin routes, nor the handful of admin-only paths listed at `servers/fastapi/api/middlewares.py:100`. The full model, including hashing and tenancy, is in [Auth and multi-user](25-auth-and-multiuser.md).

!!! note
    When `DISABLE_AUTH` is enabled (Electron's single-user mode), the middleware returns before any of this and requests run without an owner (`servers/fastapi/api/middlewares.py:59`). The README states that external REST and MCP access are not available in the Electron app.

## Step 3: The request contract

### 3.1 Every field of `GeneratePresentationRequest`

Defined at `servers/fastapi/models/generate_presentation_request.py:8`:

| Field | Type | Default | Behavior |
| --- | --- | --- | --- |
| `content` | `str` | required | The prompt. May be `""` when `slides_markdown` or `files` carries the content. |
| `slides_markdown` | `list[str]` or `null` | `null` | One Markdown string per slide. Skips outline generation; `n_slides` becomes its length. |
| `instructions` | `str` or `null` | `null` | Extra guidance, passed to outline, structure and slide-content prompts. |
| `tone` | `Tone` | `"default"` | `default`, `casual`, `professional`, `funny`, `educational`, `sales_pitch` (`servers/fastapi/enums/tone.py:4`). |
| `verbosity` | `Verbosity` | `"standard"` | `concise`, `standard`, `text-heavy` (`servers/fastapi/enums/verbosity.py:4`). |
| `web_search` | `bool` | `false` | Grounds the outline step; see [Images, icons, web search](12-images-icons-search.md). |
| `n_slides` | `int` or `null` | `null` | 1 to 50. `null` lets the model choose. |
| `language` | `str` or `null` | `null` | Blank or `null` means auto-detect. |
| `template` | `str` | `"general"` | A bundled template name, a `TemplateV2` id, or `custom-<id>`. |
| `include_table_of_contents` | `bool` | `false` | Needs `n_slides >= 3` when `n_slides` is given. Ignored with `slides_markdown`. |
| `include_title_slide` | `bool` | `true` | Affects the outline prompt and TOC math. |
| `files` | `list[str]` or `null` | `null` | Paths returned by `/api/v1/ppt/files/upload` or `/files/mcp-upload`. |
| `export_as` | `"pptx"` or `"pdf"` | `"pptx"` | Output format of the exported file. |
| `trigger_webhook` | `bool` | `false` | Declared, documented in the OpenAPI schema, and never read (see Step 8). |

!!! warning "Gotcha"
    The README's API table says `language` defaults to `"English"`. The code default is `None`, which the outline prompt renders as `auto-detect` (`servers/fastapi/utils/llm_calls/generate_presentation_outlines.py:170`). Send `"language": "English"` explicitly if you need it.

### 3.2 Validation before any work

`check_if_api_request_is_valid` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:2620`) allocates the `presentation_id` (a fresh `uuid4`) and rejects bad input with HTTP 400:

| Condition | `detail` |
| --- | --- |
| `content`, `slides_markdown` and `files` all empty | `Either content or slides markdown or files is required to generate presentation` |
| `n_slides <= 0` | `Number of slides must be greater than 0` |
| `n_slides > 50` or more than 50 `slides_markdown` items | `Number of slides cannot be greater than 50` |
| `include_table_of_contents` with `n_slides < 3` | `Number of slides cannot be less than 3 if table of contents is included` |
| template not in DB and not a bundled name | `Template not found. Please use a valid template.` |

The limit 50 is `MAX_NUMBER_OF_SLIDES` (`servers/fastapi/constants/presentation.py:4`). Template lookup strips a `custom-` prefix, tries `TemplateV2` by id, then `resolve_default_template_id` for bundled names such as `general`, `modern` or `swift` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:212`). If found in the DB, `request.template` is rewritten to the row id. Type errors (for example `"export_as": "docx"`) are rejected earlier by Pydantic with HTTP 422.

### 3.3 `slides_markdown` and `files`

With `slides_markdown`, each string becomes a `SlideOutlineModel(content=...)` directly (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:2838`). Each item is still passed through the outline word limit (`MAX_OUTLINE_WORDS`, default 100) by the model's validator, and the LLM still chooses layouts and fills the template schema, so text can be rephrased. `http(s)` image URLs ending in `.jpg`, `.jpeg`, `.png` or `.webp` inside an item are used for that slide's image slots instead of generating images.

`files` are resolved by `DocumentsLoader`, which only accepts paths inside the server's temp upload area (`servers/fastapi/services/documents_loader.py:171`). Upload first:

```bash
curl -s -X POST http://localhost:5001/api/v1/ppt/files/upload \
  -H "Authorization: Bearer $PRESENTON_KEY" \
  -F "files=@quarterly-report.pdf"
# ["/tmp/presenton/<owner>/<uuid>/quarterly-report.pdf"]
```

The returned array (path shape shown schematically) goes into `files` unchanged. Document parsing is covered in [Document ingestion](11-document-ingestion.md).

## Step 4: Synchronous generation

### 4.1 Execution order

`generate_presentation_sync` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:3170`) validates, then awaits `generate_presentation_handler` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:2684`) with `async_status=None`. The handler is the same code the async path runs. Its stages, which [Standard generation pipeline](08-standard-pipeline.md) explains in depth:

```mermaid
sequenceDiagram
    participant C as Client
    participant API as generate_presentation_sync
    participant H as generate_presentation_handler
    participant L as LLM
    participant A as Image and icon providers
    participant X as Export runtime
    participant W as WebhookService
    C->>API: POST /api/v1/ppt/presentation/generate
    API->>API: check_if_api_request_is_valid
    API->>H: request, presentation_id, async_status None
    H->>L: outline (skipped for slides_markdown)
    H->>H: resolve template layout
    H->>L: structure (skipped for ordered layouts)
    loop batches of 10 slides
        H->>L: slide content, concurrently
        H->>A: asset tasks start in background
    end
    H->>A: gather all asset tasks
    H->>H: commit presentation, slides, image assets
    H->>X: export_presentation as pptx or pdf
    H-->>W: fire and forget, presentation.generation.completed
    H-->>API: PresentationPathAndEditPath
    API-->>C: 200 JSON with path and edit_path
```

1. **Outline.** Unless `slides_markdown` is set: load `files` into `additional_context`, compute the outline count (adjusted for a TOC), store generation context in Mem0, stream `generate_ppt_outline` into a string, parse it with `dirtyjson`, and normalize it. Fewer outlines than requested is a 400 (`Failed to generate presentation outlines with requested number of slides. Please try again.`); extra outlines are silently truncated (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:2830`).
2. **Layout.** `_resolve_generation_layout` loads the `TemplateV2` row and returns the layout payload, a `PresentationLayoutModel`, fonts and theme. A bundled template whose row was never imported yields 503 `Bundled template '<name>' is not available. Restart the service to import bundled templates.` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:279`).
3. **Structure.** Ordered layouts map one to one; otherwise an LLM picks a layout index per outline. Out-of-range indices are replaced with random valid ones.
4. **Table of contents** layouts are inserted when requested.
5. **Slides** are generated in batches of 10 with `asyncio.gather`, and each slide's asset task starts immediately so images overlap the next batch's LLM calls (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:2985`).
6. **Persist.** After all asset tasks finish, the presentation, slides and generated `ImageAsset` rows are committed in one transaction (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:3088`).
7. **Export** via `export_presentation(presentation_id, title, export_as, cookie_header=...)` (`servers/fastapi/utils/export_utils.py:43`), described in [PPTX and PDF export](24-export-pipeline.md).
8. **Respond** and fire the completion webhook.

### 4.2 The response model

```python title="servers/fastapi/models/presentation_and_path.py"
from pydantic import BaseModel
import uuid


class PresentationAndPath(BaseModel):
    presentation_id: uuid.UUID
    path: str


class PresentationPathAndEditPath(PresentationAndPath):
    edit_path: str
```

`path` is the exported file's location on the server. `ExportTaskService._move_export_to_owner` places it in `$APP_DATA_DIRECTORY/exports/users/<owner_id>/` when there is an owner (`servers/fastapi/services/export_task_service.py:773`). The Docker image sets `APP_DATA_DIRECTORY=/app_data` (`Dockerfile:82`), so the filesystem path doubles as the URL path that nginx serves from `/app_data/exports/` behind an auth subrequest (`nginx.conf:167`). `edit_path` is always `/presentation?id=<presentation_id>`, a Next.js route.

Just before returning, the sync handler passes both fields through `absolute_mcp_result_links` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:3185`), which only changes them for MCP-originated requests (Step 10.6). A plain REST caller gets host-relative values and must prefix its own base URL.

### 4.3 Worked example: curl, synchronous

```bash
export PRESENTON_KEY="sk-presenton-0123456789abcdef.REPLACE_WITH_SECRET"

curl -s -X POST http://localhost:5001/api/v1/ppt/presentation/generate \
  -H "Authorization: Bearer $PRESENTON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Introduction to machine learning for product managers",
    "n_slides": 6,
    "language": "English",
    "tone": "educational",
    "verbosity": "concise",
    "template": "general",
    "include_table_of_contents": false,
    "export_as": "pdf"
  }'
```

A successful response has this shape (the file name is chosen by the export runtime from the deck title):

```json
{
  "presentation_id": "d3000f96-096c-4768-b67b-e99aed029b57",
  "path": "/app_data/exports/users/<owner-uuid>/<Deck_Title>.pdf",
  "edit_path": "/presentation?id=d3000f96-096c-4768-b67b-e99aed029b57"
}
```

Download it with the same key; nginx's `/_auth_check` subrequest forwards the `Authorization` header to `/api/v1/auth/verify` (`nginx.conf:133`):

```bash
curl -s -H "Authorization: Bearer $PRESENTON_KEY" \
  -o deck.pdf "http://localhost:5001/app_data/exports/users/<owner-uuid>/<Deck_Title>.pdf"
```

### 4.4 Failure semantics

Any non-`HTTPException` inside the handler is printed and replaced by `HTTPException(500, "Presentation generation failed")`; then the failure webhook fires; then, for a sync call, the exception propagates as the HTTP response (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:3142`). The body is FastAPI's standard `{"detail": "..."}`.

!!! warning "Gotcha"
    A sync request that the client abandons is cancelled cooperatively: `raise_if_client_disconnected` checks `request.is_disconnected()` before each batch and raises `asyncio.CancelledError` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:2697`). `CancelledError` is a `BaseException`, not an `Exception`, so it skips the handler's `except Exception` block: no failure webhook is sent and no error is recorded. Use the async endpoint for anything long-running.

## Step 5: Asynchronous generation and the task row

### 5.1 Queuing

`generate_presentation_async` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:3241`) runs the same validation, then:

```python title="servers/fastapi/api/v1/ppt/endpoints/presentation.py (excerpt)"
        async_status = AsyncTaskModel(
            type=ASYNC_TASK_TYPE_PRESENTATION_GENERATE,
            status=AsyncTaskStatus.PENDING,
            message="Queued for generation",
            data=presentation_task_progress_data(
                created_slides=0,
                remaining_slides=_requested_slide_count(request),
                presentation_id=presentation_id,
            ),
        )
        sql_session.add(async_status)
        await sql_session.commit()
        await sql_session.refresh(async_status)

        background_tasks.add_task(
            _run_generate_presentation_task,
            request,
            presentation_id,
            async_status.id,
            build_export_cookie_header(request_http),
            get_current_owner_id(),
        )
        return async_status
```

The task row is returned immediately; FastAPI runs the background function in the same process after the response is sent. `_run_generate_presentation_task` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:3198`) re-establishes the owner context (the request's context variables are gone by then), opens a fresh DB session, sets the message to `Starting presentation generation`, and calls the shared handler with the row so the handler can update it as it goes.

### 5.2 The `async_tasks` table

```python title="servers/fastapi/models/sql/async_task.py (excerpt)"
class AsyncTaskModel(SQLModel, table=True):
    __tablename__ = "async_tasks"

    id: str = Field(
        default_factory=lambda: f"task-{secrets.token_hex(32)}",
        primary_key=True,
    )
    # ...
    type: str = Field(index=True)
    status: AsyncTaskStatus = Field(
        sa_column=Column(String, index=True, nullable=False),
    )
    message: Optional[str] = None
    error: Optional[dict[str, Any]] = Field(sa_column=Column(JSON), default=None)
    data: Optional[dict[str, Any]] = Field(sa_column=Column(JSON), default=None)
    payload: Optional[dict[str, Any]] = Field(
        default=None,
        exclude=True,
        sa_column=Column(JSON, nullable=True),
    )
```

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `str` | `task-` plus 64 hex characters |
| `owner_id` | UUID, nullable | FK `user.id`, cascade delete; excluded from JSON |
| `type` | `str`, indexed | `presentation.generate`, `presentation.smart.generate`, or `template.create` |
| `status` | `str`, indexed | an `AsyncTaskStatus` value |
| `message` | `str` | human-readable progress line |
| `error` | JSON | `{"status_code": int, "detail": str}` on failure |
| `data` | JSON | progress counters and, on success, result links |
| `payload` | JSON | internal input copy (used by template jobs); excluded from JSON |
| `created_at`, `updated_at` | timestamptz | UTC defaults; `updated_at` also has an `onupdate` |

The task types come from `servers/fastapi/api/v1/ppt/endpoints/presentation.py:137`, `servers/fastapi/api/v2/ppt/endpoints/presentation.py:39` and `servers/fastapi/api/v1/ppt/endpoints/template.py:100`. Template jobs are covered in [Custom templates from PPTX](18-custom-templates.md).

`AsyncTaskStatus` (`servers/fastapi/enums/async_task_status.py:4`) has exactly three values:

| Value | Meaning |
| --- | --- |
| `pending` | queued or running; there is no separate "running" state |
| `completed` | terminal success |
| `error` | terminal failure, `error` populated |

### 5.3 Progress messages and data

`presentation_task_progress_data` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:172`) builds `{"created_slides", "remaining_slides", "presentation_id"}`, clamping counts at zero. The handler moves the row through these states:

| `message` | `status` | Set at | Visible to pollers |
| --- | --- | --- | --- |
| `Queued for generation` | `pending` | request handler | yes |
| `Starting presentation generation` | `pending` | background task start | yes |
| `Generating presentation outlines` | `pending` | before the outline LLM call (skipped with `slides_markdown`) | yes |
| `Selecting layout for each slide` | `pending` | after outlines | yes |
| `Generating slides` | `pending` | before the first batch; `remaining_slides` reset to the final count | yes |
| (data only) | `pending` | after each batch of 10, `created_slides` grows | yes |
| `Fetching assets for slides` | `pending` | after all batches are scheduled | yes |
| `Exporting presentation` | `pending` | before export | **no** |
| `Presentation generation completed` | `completed` | after export; `data` gains `path` and `edit_path` | yes |
| `Presentation generation failed` | `error` | on any exception | yes |

!!! warning "Gotcha"
    The "Exporting presentation" update is `sql_session.add(async_status)` without a `commit()` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:3093`), and the next write overwrites the message before committing. Pollers therefore see "Fetching assets for slides" for the whole export, which can take a while for PDF or large decks. Do not treat a long stall on that message as a hang.

!!! warning "Gotcha"
    `data.presentation_id` is present from the first poll, but in the v1 pipeline the `presentations` row is only committed after every slide and asset is done (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:3088`). Until then `GET /api/v1/ppt/presentation/{id}` returns 404. The id becomes useful after completion, or after an export failure, when `POST /api/v1/ppt/presentation/{id}/export` can retry without regenerating.

## Step 6: Polling

### 6.1 Endpoints

- `GET /api/v1/async-tasks/status/{id}` (`servers/fastapi/api/v1/async_tasks/router.py:73`): generic, used by the MCP `get_job_status` tool. 404 `No async task found`.
- `GET /api/v1/ppt/presentation/status/{id}` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:3283`): older presentation-specific path; same body. 404 `No presentation generation task found`. It does not check the task type.
- `GET /api/v1/async-tasks` (`servers/fastapi/api/v1/async_tasks/router.py:24`): list with filters `type`, `status`, `created_at` (alias of `created_at_from`), `created_at_from`, `created_at_to`, `order_by` (`created_at` or `updated_at`, default `created_at`), `order` (`asc` or `desc`, default `desc`), `limit` (1 to 200, default 50), `offset` (default 0).

All three only see the caller's own tasks, via the owner filter in `servers/fastapi/services/database.py:67`. Both status endpoints pass `data` through `absolute_mcp_result_links`; the list endpoint does not.

### 6.2 What the bodies look like

=== "pending"

    ```json
    {
      "id": "task-6c1f...e09a",
      "type": "presentation.generate",
      "status": "pending",
      "message": "Generating slides",
      "error": null,
      "data": {
        "created_slides": 0,
        "remaining_slides": 6,
        "presentation_id": "d3000f96-096c-4768-b67b-e99aed029b57"
      },
      "created_at": "2026-11-02T10:15:03.412Z",
      "updated_at": "2026-11-02T10:15:41.870Z"
    }
    ```

=== "completed"

    ```json
    {
      "id": "task-6c1f...e09a",
      "type": "presentation.generate",
      "status": "completed",
      "message": "Presentation generation completed",
      "error": null,
      "data": {
        "created_slides": 6,
        "remaining_slides": 0,
        "presentation_id": "d3000f96-096c-4768-b67b-e99aed029b57",
        "path": "/app_data/exports/users/<owner-uuid>/<Deck_Title>.pdf",
        "edit_path": "/presentation?id=d3000f96-096c-4768-b67b-e99aed029b57"
      },
      "created_at": "2026-11-02T10:15:03.412Z",
      "updated_at": "2026-11-02T10:17:20.004Z"
    }
    ```

=== "error"

    ```json
    {
      "id": "task-6c1f...e09a",
      "type": "presentation.generate",
      "status": "error",
      "message": "Presentation generation failed",
      "error": {
        "status_code": 400,
        "detail": "Failed to generate presentation outlines. Please try again."
      },
      "data": {
        "created_slides": 0,
        "remaining_slides": 6,
        "presentation_id": "d3000f96-096c-4768-b67b-e99aed029b57"
      },
      "created_at": "2026-11-02T10:15:03.412Z",
      "updated_at": "2026-11-02T10:15:30.118Z"
    }
    ```

Ids, timestamps and paths above are illustrative; the field set and messages are the ones the code writes. The completed `data` gained `path` and `edit_path` deliberately: the inline comment at `servers/fastapi/api/v1/ppt/endpoints/presentation.py:3120` notes that previously a poller could learn the result only by receiving the webhook.

### 6.3 Worked example: async generate plus polling loop

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="http://localhost:5001"
AUTH="Authorization: Bearer $PRESENTON_KEY"

TASK_ID=$(curl -s -X POST "$BASE/api/v1/ppt/presentation/generate/async" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"content": "Quarterly sales review for a SaaS company", "n_slides": 8, "export_as": "pptx"}' \
  | jq -r '.id')
echo "queued $TASK_ID"

while true; do
  BODY=$(curl -s "$BASE/api/v1/async-tasks/status/$TASK_ID" -H "$AUTH")
  STATUS=$(echo "$BODY" | jq -r '.status')
  echo "$STATUS | $(echo "$BODY" | jq -r '.message') | $(echo "$BODY" | jq -c '.data')"
  case "$STATUS" in
    completed)
      FILE_PATH=$(echo "$BODY" | jq -r '.data.path')
      curl -s -H "$AUTH" -o deck.pptx "$BASE$FILE_PATH"
      break ;;
    error)
      echo "$BODY" | jq '.error'
      exit 1 ;;
  esac
  sleep 10
done
```

The MCP instructions recommend the same cadence, 10 to 15 seconds between polls (`servers/fastapi/mcp_server.py:264`).

## Step 7: What happens to in-flight tasks on restart

Background tasks are plain coroutines inside the FastAPI process. If the process dies (a crash that `start.js` restarts, a container restart, a deploy), the coroutine is gone but its row still says `pending`. The lifespan hook fixes that before the server accepts requests (`servers/fastapi/api/lifespan.py:59`):

```python title="servers/fastapi/services/async_tasks.py (excerpt)"
INTERRUPTED_TASK_ERROR = {
    "status_code": 503,
    "detail": (
        "The server restarted before this background task completed. "
        "Please start a new job."
    ),
}


async def fail_interrupted_async_tasks(session: AsyncSession) -> int:
    # ...
    result = await session.execute(
        select(AsyncTaskModel).where(
            AsyncTaskModel.status == AsyncTaskStatus.PENDING
        )
    )
    interrupted_tasks = list(result.scalars().all())
    if not interrupted_tasks:
        return 0

    interrupted_at = get_current_utc_datetime()
    for task in interrupted_tasks:
        task.status = AsyncTaskStatus.ERROR
        task.message = "Background task interrupted by server restart"
        task.error = dict(INTERRUPTED_TASK_ERROR)
        task.updated_at = interrupted_at
        session.add(task)
```

The query runs at startup with no owner context, so it covers every user's tasks. There is no resume and no re-queue: the client must submit a new job.

Uploaded source files do not survive a restart either. `TEMP_FILE_SERVICE` is a module-level singleton whose constructor calls `cleanup_base_dir()`, which deletes everything under `TEMP_DIRECTORY` (default `/tmp/presenton`) when the process starts (`servers/fastapi/services/temp_file_service.py:13` and `servers/fastapi/services/temp_file_service.py:187`). A resubmitted job that reuses `files` paths from before the restart therefore fails with `404 File not found` when `DocumentsLoader` resolves them; upload the files again first.

!!! warning "Gotcha"
    No webhook is sent for tasks failed this way; `fail_interrupted_async_tasks` only updates rows. A webhook-only integration never hears about a job lost to a restart, so it should also poll, or at least reconcile with `GET /api/v1/async-tasks?status=error`. And because every `pending` row is failed at startup, running two FastAPI processes against one database would let one process's restart fail the other's live jobs.

## Step 8: Smart generation over the API (v2)

Smart mode (adaptive HTML slides, see [Smart mode](13-smart-mode.md)) has its own request model, `GenerateSmartPresentationRequest` (`servers/fastapi/models/generate_presentation_request.py:49`):

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `content` | `str` | `""` | prompt |
| `n_slides` | `int` or `null`, `>= 1` | `null` | `null` resolves to 8 (`DEFAULT_SMART_SLIDE_COUNT`); values above 50 are rejected with 400 by `create_presentation` |
| `language` | `str` or `null` | `null` | |
| `instructions` | `str` or `null` | `null` | |
| `tone` | `Tone` | `default` | |
| `verbosity` | `Verbosity` | `standard` | |
| `web_search` | `bool` | `false` | external providers only in Smart mode |
| `include_table_of_contents` | `bool` | `false` | |
| `include_title_slide` | `bool` | `true` | |
| `files` | `list[str]` or `null` | `null` | uploaded paths |
| `community_design_ids` | `list[int]` or `null` | `null` | Smart-only design references; 422 if community features are disabled |
| `export_as` | `"pptx"` or `"pdf"` | `"pptx"` | |

There is no `template` field. Both v2 endpoints first call the v1 `create_presentation` function (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:1682`) with `generation_mode="smart"`, which validates (a prompt, a document, or a community reference is required) and **commits** the `presentations` row up front. Then `_generate_and_export_smart_presentation` (`servers/fastapi/api/v2/ppt/endpoints/presentation.py:87`) consumes the Smart SSE stream in-process:

```python title="servers/fastapi/api/v2/ppt/endpoints/presentation.py (excerpt)"
    async for chunk in stream_response.body_iterator:
        text = chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk)
        for line in text.splitlines():
            if not line.startswith("data: "):
                continue
            try:
                event = json.loads(line[6:])
            except json.JSONDecodeError:
                continue
            event_type = event.get("type")
            if event_type == "slide_html":
                created_slides = max(
                    created_slides,
                    int(event.get("index", 0)) + 1,
                )
                if task_id:
                    await _update_smart_task_progress(
                        # ...
                        message="Generating Smart presentation slides",
                    )
            elif event_type == "complete":
                completed = True
            elif event_type == "error":
                stream_error = str(event.get("detail") or "Smart generation failed")
```

If no `complete` event arrived it raises 500 with the stream's error detail; otherwise it rolls back the read transaction, reloads the row, exports, and returns a `PresentationPathAndEditPath`.

The async variant creates an `AsyncTaskModel` of type `presentation.smart.generate` with message `Queued for Smart presentation generation`, and `run_generate_smart_presentation_task` (`servers/fastapi/api/v2/ppt/endpoints/presentation.py:152`) updates it through `Starting Smart presentation generation`, `Generating Smart presentation slides` (one commit per `slide_html` event, in its own short session), then `Smart presentation generation completed` with `data` containing `path`, `edit_path` and `export_as`, or `Smart presentation generation failed` with `error`.

!!! warning "Gotcha"
    Neither v2 endpoint calls `WebhookService`. Webhook subscribers hear about Standard decks only; Smart jobs must be polled.

## Step 9: Webhooks

### 9.1 Events and storage

```python title="servers/fastapi/enums/webhook_event.py"
from enum import Enum


class WebhookEvent(str, Enum):
    PRESENTATION_GENERATION_COMPLETED = "presentation.generation.completed"
    PRESENTATION_GENERATION_FAILED = "presentation.generation.failed"
```

A subscription is one row in `webhook_subscriptions` (`servers/fastapi/models/sql/webhook_subscription.py:12`):

| Column | Notes |
| --- | --- |
| `id` | `webhook-` plus 64 hex characters |
| `owner_id` | FK `user.id`, cascade delete, excluded from JSON |
| `created_at` | UTC timestamp |
| `url` | plain `str`, not validated |
| `secret` | optional `str`, stored as given |
| `event` | the event value, indexed |

One row subscribes one URL to one event; subscribe twice to get both.

### 9.2 Subscribing and unsubscribing

```bash
curl -s -X POST http://localhost:5001/api/v1/webhook/subscribe \
  -H "Authorization: Bearer $PRESENTON_KEY" -H "Content-Type: application/json" \
  -d '{"url": "https://hooks.example.com/presenton", "secret": "my-shared-secret", "event": "presentation.generation.completed"}'
# 201 {"id": "webhook-9f2c..."}

curl -s -X DELETE http://localhost:5001/api/v1/webhook/unsubscribe \
  -H "Authorization: Bearer $PRESENTON_KEY" -H "Content-Type: application/json" \
  -d '{"id": "webhook-9f2c..."}'
# 204, or 404 "Webhook subscription not found"
```

`unsubscribe` takes the id in a JSON body (`Body(embed=True)`), not in the path. There is no list endpoint; keep the id you were given.

### 9.3 When and what is sent

`generate_presentation_handler` schedules delivery with `CONCURRENT_SERVICE.run_task(None, WebhookService.send_webhook, event, payload)` on both outcomes (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:3133` and `servers/fastapi/api/v1/ppt/endpoints/presentation.py:3150`). `run_task` wraps the call in `asyncio.create_task` and keeps a reference until it finishes (`servers/fastapi/services/concurrent_service.py:10`), so the HTTP response does not wait for delivery.

=== "presentation.generation.completed"

    ```json
    {
      "presentation_id": "d3000f96-096c-4768-b67b-e99aed029b57",
      "path": "/app_data/exports/users/<owner-uuid>/<Deck_Title>.pptx",
      "edit_path": "/presentation?id=d3000f96-096c-4768-b67b-e99aed029b57"
    }
    ```

=== "presentation.generation.failed"

    ```json
    {
      "status_code": 500,
      "detail": "Presentation generation failed"
    }
    ```

The success body is `response.model_dump(mode="json")` and the failure body is `APIErrorModel` (`servers/fastapi/models/api_error_model.py:5`). Both are host-relative and unsigned.

### 9.4 Delivery mechanics

```python title="servers/fastapi/services/webhook_service.py (excerpt)"
        headers = {
            "Content-Type": "application/json",
        }
        if subscription.secret:
            headers["Authorization"] = f"Bearer {subscription.secret}"

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    subscription.url,
                    json=data,
                    headers=headers,
                ) as _:
                    pass

        except Exception as e:
            print(f"Error sending request to webhook {subscription.id}: {e}")
            pass
```

`send_webhook` (`servers/fastapi/services/webhook_service.py:12`) selects all subscriptions for the event and posts to them concurrently with `asyncio.gather`. Reading the code, delivery is:

- **Authenticated by bearer secret only.** The subscriber receives `Authorization: Bearer <secret>`. There is no HMAC signature, timestamp, or event-id header.
- **Single attempt.** No retries, no backoff, no dead-letter record. The response status is ignored, so a 500 from the subscriber counts the same as a 200.
- **No explicit timeout.** The `ClientSession` uses aiohttp's defaults.
- **Owner-scoped.** `asyncio.create_task` copies the current context variables, so the owner id set by the middleware (sync path) or by `_run_generate_presentation_task` (async path) is still set inside `send_webhook`, and the session's owner filter limits the `SELECT` to that user's subscriptions. With auth disabled there is no owner and every subscription matches.

!!! warning "Gotcha"
    `trigger_webhook` in the request does nothing: a repository-wide search finds it only in the model definition. Webhooks fire for **every** Standard generation through `generate_presentation_handler`, sync or async, whenever the owner has a matching subscription. Conversely, the failure payload carries no `presentation_id` or task id, so a subscriber cannot tell which job failed when several run at once.

!!! warning "Gotcha"
    `url` is an unvalidated string, and the server posts to it from inside your network. Any user who can authenticate can register an internal address. If you expose the API to untrusted users, add URL validation in `subscribe_to_webhook` (`servers/fastapi/api/v1/webhook/router.py:26`).

### 9.5 The mock router

`API_V1_MOCK_ROUTER` (`servers/fastapi/api/v1/mock/router.py:9`) has two GET endpoints that return a one-element list of each payload type: a `PresentationPathAndEditPath` with a random id, `path` built by `absolute_fastapi_asset_url("/app_data/exports/test.pdf")` and `edit_path` `/presentation?id=123`; and an `APIErrorModel` with 500 / `Presentation generation failed`. Nothing in the application calls them. Their response models are exactly the two webhook bodies, so in practice they document those schemas in the OpenAPI document and return samples you can use when building a receiver. Both handler functions are named `mock_presentation_generation_completed`; FastAPI registered both routes before the second definition shadowed the first name, so the generated operation ids differ only by path. The routes sit under `/api/`, so they require authentication like everything else.

## Step 10: The MCP server

### 10.1 Process and routing

`mcp_server.py` is a separate Python process started by `start.js` as `python mcp_server.py --port 8001` with `stdio: "ignore"` (`start.js:608`). Its `main()` (`servers/fastapi/mcp_server.py:417`) exits immediately when `PRESENTON_ELECTRON` is truthy, otherwise serves FastMCP's HTTP transport on `127.0.0.1:<port>`. nginx exposes it at `/mcp` and `/mcp/` (`nginx.conf:77` and `nginx.conf:94`) with:

- `client_max_body_size 145M`, enough for the 100 MiB base64 upload limit (base64 inflates by a third),
- `proxy_read_timeout 30m`,
- `Host localhost:8001` rewritten, because FastMCP's host check only allows `localhost`, `127.0.0.1` and `::1` (`MCP_ALLOWED_HOSTS`, `servers/fastapi/mcp_server.py:41`), while the public host travels in `X-Forwarded-Host`,
- no `auth_request`: the MCP server authenticates bearer keys itself.

The README describes it as an MCP 2025-11-25 Streamable HTTP endpoint at `/mcp`.

!!! warning "Gotcha"
    Unlike FastAPI and Next.js, the MCP child process is not registered with `watchManagedProcess` in `start.js` (only an `error` listener is attached at `start.js:618`), and its output is discarded. If it crashes, nothing restarts it and nothing is logged. A failing MCP client while the web app works is the usual symptom.

### 10.2 Building tools from OpenAPI

```python title="servers/fastapi/mcp_server.py (excerpt)"
def create_mcp_server(
    api_client: httpx.AsyncClient | httpx2.AsyncClient,
    *,
    name: str = "Presenton",
    auth: TokenVerifier | None = None,
) -> FastMCP:
    """Create the MCP server with only the public presentation workflow exposed."""
    generation_mode = get_presentation_generation_mode()
    return FastMCP.from_openapi(
        openapi_spec=openapi_spec,
        client=api_client,
        name=name,
        auth=auth,
        route_maps=get_mcp_route_maps(generation_mode),
        mcp_names=MCP_TOOL_NAMES,
        instructions=get_mcp_instructions(generation_mode),
    )
```

There is no hand-written tool code. `openapi_spec` is `openai_spec.json`, loaded once at import (`servers/fastapi/mcp_server.py:281`). `FastMCP.from_openapi` turns each allowed operation into a tool whose input schema is the operation's parameters plus its request body properties (the `upload_files` tool exposes `files` directly, as `servers/fastapi/tests/unit/test_mcp_server_auth.py:312` asserts). Calling a tool makes an HTTP request through `api_client`, an `httpx2.AsyncClient` with base URL `http://127.0.0.1:8000`, a 600 s read timeout and a 15 s connect timeout (`servers/fastapi/mcp_server.py:31` to `servers/fastapi/mcp_server.py:34`).

### 10.3 Every tool

`MCP_TOOL_NAMES` (`servers/fastapi/mcp_server.py:101`) renames operation ids to friendly tool names:

| Tool | HTTP route | Inputs (from `openai_spec.json`) |
| --- | --- | --- |
| `start_standard_presentation` | `POST /api/v1/ppt/presentation/generate/async` | all `GeneratePresentationRequest` fields; `content` required |
| `start_smart_presentation` | `POST /api/v2/ppt/presentation/generate/smart/async` | all `GenerateSmartPresentationRequest` fields; none required |
| `list_templates` | `GET /api/v1/ppt/template/all` | `page` (int, min 1, default 1), `page_size` (1 to 100, default 20), `default` (bool or null: true = built-in only, false = user's custom only) |
| `upload_template_assets` | `POST /api/v1/ppt/template/mcp-upload` | `pptx` (`filename` 1 to 255 chars, `content_base64`, optional `original_font_name`), `fonts` (up to 32 of the same shape); returns `pptx_url`, `slide_image_urls`, `fonts` |
| `start_template_generation` | `POST /api/v1/ppt/template/async` | `pptx_url` (required), `slide_image_urls` (required, min 1), `fonts` (object), `name`, `description`, `icon_type` (`bold`, `duotone`, `fill`, `light`, `regular`, `thin`, default `bold`) |
| `upload_files` | `POST /api/v1/ppt/files/mcp-upload` | `files`: 1 to 32 items of `filename` (1 to 255 chars) and `content_base64`; returns `file_paths` |
| `get_job_status` | `GET /api/v1/async-tasks/status/{id}` | `id` (path) |

`upload_files` decodes each item with strict base64 validation (400 `Invalid base64 content for '<name>'`), enforces 100 MiB per file and combined (413), wraps the bytes in `UploadFile` objects and reuses the multipart handler (`servers/fastapi/api/v1/ppt/endpoints/files.py:108`). It exists because MCP tools carry JSON, not multipart bodies.

Example arguments an MCP client would send to `start_standard_presentation` after an upload:

```json
{
  "content": "Turn the attached report into a board update",
  "n_slides": 10,
  "template": "general",
  "files": ["/tmp/presenton/<owner>/<uuid>/q3-report.pdf"],
  "export_as": "pdf"
}
```

### 10.4 Mode gating with `PRESENTATION_GENERATION_MODE`

```python title="servers/fastapi/mcp_server.py (excerpt)"
def get_mcp_route_maps(
    generation_mode: PresentationGenerationMode,
) -> list[RouteMap]:
    """Expose only workflows enabled by PRESENTATION_GENERATION_MODE."""
    route_maps: list[RouteMap] = []
    if generation_mode in {"both", "standard"}:
        route_maps.extend(MCP_STANDARD_ROUTE_MAPS)
        route_maps.extend(MCP_TEMPLATE_ROUTE_MAPS)
    if generation_mode in {"both", "smart"}:
        route_maps.extend(MCP_SMART_ROUTE_MAPS)
    route_maps.extend(MCP_SHARED_ROUTE_MAPS)
    route_maps.append(RouteMap(mcp_type=MCPType.EXCLUDE))
    return route_maps
```

The final catch-all `EXCLUDE` hides everything else: the spec has 100 operations across 93 paths, and at most 7 become tools. `get_presentation_generation_mode` lowercases and trims the variable and falls back to `both` for anything unrecognized (`servers/fastapi/utils/get_env.py:24`).

| Mode | Tools exposed |
| --- | --- |
| `both` (default, or invalid) | all seven |
| `standard` | `start_standard_presentation`, `list_templates`, `upload_template_assets`, `start_template_generation`, `upload_files`, `get_job_status` |
| `smart` | `start_smart_presentation`, `upload_files`, `get_job_status` |

These sets are pinned by `servers/fastapi/tests/unit/test_mcp_server_auth.py:372`. The server `instructions` text is assembled per mode too (`servers/fastapi/mcp_server.py:143`): it tells the model to copy ids and paths verbatim, never to send a client attachment id in place of base64 bytes, to start exactly one job per request, to poll every 10 to 15 seconds, to use `data.path` and `data.edit_path` on completion, and never to ask the user to paste an API key into chat.

!!! warning "Gotcha"
    `PRESENTATION_GENERATION_MODE` gates the MCP tool list and the web UI only. As `docs/presentation-generation-modes.md` states, it is not an authorization control: with `smart` set, `POST /api/v1/ppt/presentation/generate` still works for any authenticated REST caller. The variable is also read once when the MCP server is built, so changing it requires restarting the MCP process.

### 10.5 The token verifier and the key-for-session exchange

When auth is enabled, `create_mcp_auth_provider` returns a `PresentonTokenVerifier`; with `DISABLE_AUTH` it returns `None` and the MCP endpoint is open (`servers/fastapi/mcp_server.py:324`).

```python title="servers/fastapi/mcp_server.py (excerpt)"
class PresentonTokenVerifier(TokenVerifier):
    """Validate the same user-scoped API keys accepted by the REST API."""

    async def verify_token(self, token: str) -> AccessToken | None:
        if not token.startswith(API_KEY_PREFIX):
            return None
        async with async_session_maker() as session:
            verified = await verify_api_key(session, token)
            if verified is None:
                return None
            user = verified.user
            try:
                internal_session_token = await get_jwt_strategy(
                    lifetime_seconds=MCP_INTERNAL_SESSION_TTL_SECONDS
                ).write_token(user)
            except ValueError:
                # ...
                internal_session_token = None
```

The returned `AccessToken` carries claims `u` (username), `role` (`admin` or `user`), `user_id`, `api_key_id` and `internal_session_token`, a one-hour JWT (`MCP_INTERNAL_SESSION_TTL_SECONDS = 60 * 60`, chosen so a 10 to 20 minute generation including export does not outlive its session, per the comment at `servers/fastapi/mcp_server.py:35`).

Then, on every outbound call to FastAPI, the `httpx` request hook `attach_request_auth_header` (`servers/fastapi/mcp_server.py:365`) rewrites the request:

```mermaid
sequenceDiagram
    participant Cl as MCP client
    participant Ng as nginx
    participant Mc as FastMCP on 8001
    participant Fa as FastAPI on 8000
    Cl->>Ng: POST /mcp tools/call with Authorization Bearer sk-presenton key
    Ng->>Mc: same request, Host rewritten, X-Forwarded-Host kept
    Mc->>Mc: verify_api_key against the database
    Mc->>Mc: mint 1 hour presenton_session JWT
    Mc->>Fa: POST generate/async with Cookie presenton_session and X-Presenton-MCP-Request 1
    Fa-->>Mc: AsyncTaskModel JSON
    Mc-->>Cl: tool result with task id
```

1. Always set `X-Presenton-MCP-Request: 1`, and forward the client's `X-Forwarded-Host` (or `Host`) and `X-Forwarded-Proto`.
2. If the outgoing request already has `Authorization` or `Cookie`, stop.
3. If the verified token has an `internal_session_token`, send it as `Cookie: presenton_session=<jwt>`. The long-lived API key is never forwarded to FastAPI.
4. If the token has a `user_id` but no session could be minted, raise `RuntimeError` rather than fall back to the key.
5. Fallbacks for auth-disabled development: forward `Bearer <token>` or the incoming `Authorization` header.

FastAPI then authenticates the cookie like a browser session, which is also why the export step works without further plumbing: `build_export_cookie_header` copies the incoming `cookie` header verbatim.

### 10.6 Absolute result links

```python title="servers/fastapi/utils/mcp_public_urls.py (excerpt)"
def absolute_mcp_url(request: Request, value: str) -> str:
    """Make a host-relative MCP result link usable by client-neutral renderers."""
    if not is_mcp_request(request) or not value.startswith("/"):
        return value

    configured_origin = get_presenton_public_url()
    if configured_origin:
        return f"{configured_origin}{value}"
```

`absolute_mcp_result_links` (`servers/fastapi/utils/mcp_public_urls.py:43`) copies a payload and rewrites only the keys `path`, `edit_path` and `preview_url`, only when the request carried `X-Presenton-MCP-Request: 1`, and only for values starting with `/`. The origin is `PRESENTON_PUBLIC_URL` when it is set to an `http(s)` URL; otherwise the first value of `X-Forwarded-Proto` (if `http` or `https`) and `X-Forwarded-Host`, falling back to the request's own scheme and `Host`. So an MCP client connected through `https://slides.example.com/mcp` receives `https://slides.example.com/app_data/exports/...` and `https://slides.example.com/presentation?id=...`, while REST callers keep relative links. The same function is applied in the sync v1 and v2 handlers and both status endpoints.

### 10.7 Host and origin protection

`mcp.run_async(..., host_origin_protection=True, allowed_hosts=MCP_ALLOWED_HOSTS, allowed_origins=get_mcp_allowed_origins())` (`servers/fastapi/mcp_server.py:457`) enables FastMCP's DNS-rebinding guard. Allowed browser origins are `http(s)://localhost:*`, `http(s)://127.0.0.1:*`, `http(s)://[::1]:*`, plus the origin of `PRESENTON_PUBLIC_URL` when set (`servers/fastapi/mcp_server.py:128`). Set `PRESENTON_PUBLIC_URL` if a browser-based MCP client on your public domain needs to connect.

### 10.8 Worked example: MCP client configuration

From the README, in VS Code's `.vscode/mcp.json` format; any Streamable HTTP client takes the same URL and header:

```json
{
  "servers": {
    "presenton": {
      "url": "http://localhost:5001/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer sk-presenton-0123456789abcdef.REPLACE_WITH_SECRET"
      }
    }
  },
  "inputs": []
}
```

A typical agent session then runs `upload_files` (optional), `list_templates` (optional), `start_standard_presentation`, and `get_job_status` until `status` is `completed`, reading the absolute `data.path` and `data.edit_path` from the final result.

## Step 11: Keeping `openai_spec.json` in sync

`servers/fastapi/openai_spec.json` is a committed, minified copy of the FastAPI OpenAPI document (about 144 KB, OpenAPI 3.1.0, 93 paths). It is produced by:

```python title="servers/fastapi/scripts/generate_openapi_spec.py"
"""Regenerate the static OpenAPI document consumed by the MCP server."""

import json
from pathlib import Path

from api.main import app


OUTPUT_PATH = Path(__file__).resolve().parents[1] / "openai_spec.json"


def main() -> None:
    OUTPUT_PATH.write_text(
        json.dumps(app.openapi(), separators=(",", ":")),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
```

The script does not add its parent directory to `sys.path` (unlike `warm_fastembed_cache.py`), so run it from `servers/fastapi` as a module, `python -m scripts.generate_openapi_spec`, or with `PYTHONPATH=.`; importing `api.main` executes the app's module-level setup, so the environment must be able to import the app. Several routes set explicit `operation_id`s (`generate_smart_presentation_async`, `mcp_files_upload`, `mcp_template_upload`, `template_list`) precisely so the `MCP_TOOL_NAMES` keys stay stable; the others rely on FastAPI's generated ids such as `generate_presentation_async_api_v1_ppt_presentation_generate_async_post`. Unit tests read the committed file to assert template-related operation ids and schemas (`servers/fastapi/tests/unit/test_mcp_openapi_templates.py:28`).

!!! warning "Gotcha"
    The MCP server never asks the live app for its schema. If you add a field to `GeneratePresentationRequest` or rename a route and forget to regenerate `openai_spec.json`, MCP clients keep seeing the old tool schema, and a renamed operation id silently drops out of `MCP_TOOL_NAMES` (keeping its long generated name) or out of the route maps entirely. Regenerate the file and restart the MCP process after any API change.

## What you now know

- Programs authenticate with `sk-presenton-<id>.<secret>` bearer keys that act as one user; the middleware mints an internal session JWT so the export browser can render the deck as that user.
- `GeneratePresentationRequest` has 14 fields with the defaults tabulated above; validation errors are 400s with fixed messages, and `trigger_webhook` is inert.
- Sync and async Standard generation share `generate_presentation_handler`; async progress lives in an `async_tasks` row with only `pending`, `completed` and `error`, carries `presentation_id` from the start and `path` / `edit_path` at the end, and is failed with a 503-style error on restart.
- Smart generation is exposed under `/api/v2` with its own request model, commits the presentation first, parses its own SSE stream, and sends no webhooks.
- Webhooks are owner-scoped, single-attempt, unsigned POSTs carrying a bearer secret, fired for every Standard generation.
- The MCP server is FastMCP built from the committed `openai_spec.json`, exposing at most seven tools gated by `PRESENTATION_GENERATION_MODE`, exchanging API keys for one-hour session cookies, and returning absolute links.

## Next

Turn from how decks are requested to what they are made of: [Template v2 format](16-template-v2-format.md) describes the layout JSON every Standard deck is built from.
