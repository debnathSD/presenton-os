# Running it locally

<div class="chapter-meta" markdown>
**Reads:** `README.md`, `docker-compose.yml`, `Dockerfile.dev`, `start.js`, `scripts/user-config-env.cjs`, `scripts/sync-presentation-export.cjs`, `test-local.sh`, `servers/fastapi/api/v1/auth/router.py`, `servers/fastapi/api/v1/auth/bootstrap.py`, `servers/fastapi/api/v1/admin/router.py`, `servers/fastapi/services/api_keys.py`, `servers/fastapi/models/generate_presentation_request.py`, `servers/fastapi/api/v1/ppt/endpoints/presentation.py`, `electron/package.json`  ·  **Builds on:** [Runtime topology](03-runtime-topology.md)  ·  **Time:** ~40 min
</div>

## What you will learn

This is the hands-on chapter. You will start Presenton from the published image, then from source with each of the four Compose services, then with FastAPI and Next.js as two plain processes on your machine, and finally as the Electron app. Along the way you will create the first administrator (both through the UI and unattended), open Swagger, mint an API key and generate a deck with `curl`, and run the same test suites CI runs. The chapter ends with a troubleshooting table built from error strings that actually exist in the code.

## Step 1: Run the published image

The quickest start, straight from `README.md:328`:

```bash
docker run -it --name presenton -p 5001:80 -v "./app_data:/app_data" ghcr.io/presenton/presenton:latest
```

- Port 80 inside the container is nginx; nothing else is reachable from the host (see [Runtime topology](03-runtime-topology.md)).
- `./app_data` on the host becomes `APP_DATA_DIRECTORY=/app_data` (`Dockerfile:82`). Everything that must survive a restart lives there: `userConfig.json`, `fastapi.db`, images, exports and so on.
- Open `http://localhost:5001`. With no account yet, the first screen is the account setup form (Step 4).

To preconfigure a text and image provider, pass them as environment variables (`README.md:679`):

```bash
docker run -it --name presenton -p 5001:80 \
  -e LLM="openai" -e OPENAI_API_KEY="******" -e IMAGE_PROVIDER="gpt-image-2" \
  -v "./app_data:/app_data" ghcr.io/presenton/presenton:latest
```

`start.js` copies the recognized variables into `app_data/userConfig.json` before FastAPI starts (`start.js:490-497`, key list in `scripts/user-config-env.cjs:20-116`).

!!! warning "Gotcha"
    Provider variables are authoritative only on the first boot. FastAPI's lifespan imports `userConfig.json` into a `ProviderSettings` database row the first time, and on every later start mirrors that row back over the file (`servers/fastapi/services/provider_settings.py:85-127`). Changing `OPENAI_MODEL` in your `docker run` command after the first boot therefore may not change anything. Use Settings in the UI, which writes the database row. Configuration precedence is detailed in [Configuration and LLM providers](06-configuration-and-providers.md).

## Step 2: The four Compose services

`docker-compose.yml` defines four services. They are services, not Compose `profiles`: there is no `profiles:` key in the file, so you name the service you want, for example `docker compose up production`. Running a bare `docker compose up` starts all four, which collide on the same host port.

| Service | Dockerfile | Ports | Volumes | Command in container | GPU |
| --- | --- | --- | --- | --- | --- |
| `production` | `Dockerfile` (multi-stage) | `${PRESENTON_HTTP_HOST_PORT:-5001}:80`, `1455:1455` | `./app_data:/app_data`, `./servers/fastapi/templates:/app/servers/fastapi/templates:ro` | `node /app/start.js` | no |
| `production-gpu` | `Dockerfile` | same | `./app_data:/app_data` only | `node /app/start.js` | 1 NVIDIA device (`docker-compose.yml:136-142`) |
| `development` | `Dockerfile.dev` | same | `.:/app`, named volumes for `/app/node_modules`, `/app/document-extraction-liteparse`, `/app/presentation-export`, `./app_data:/app_data` | `node /app/start.js --dev` | no |
| `development-gpu` | `Dockerfile.dev` | same | same as `development` | `node /app/start.js --dev` | 1 NVIDIA device |

Line references: `production` at `docker-compose.yml:2-128`, `production-gpu` at `:130-262`, `development` at `:264-393`, `development-gpu` at `:395-520`, named volumes at `:530-534`. Every service sets `MIGRATE_DATABASE_ON_STARTUP=true`, `PRESENTATION_GENERATION_MODE=${...:-both}`, `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`, and forwards about a hundred provider, search, Mem0 and auth variables with empty defaults. Port `1455` exists for the Codex OAuth callback, because OpenAI redirects the browser to `localhost:1455` (`docker-compose.yml:11-12`).

### 2.1 What the development image does differently

`Dockerfile.dev` is a single stage on `python:3.11-slim-trixie` (`Dockerfile.dev:2`). It installs nginx, Chromium (pinned to `149.0.7827.196-1~deb13u1`), fonts, Tesseract and Node 22, runs the LiteParse and export-runtime sync scripts, installs FastAPI dependencies into the system interpreter with `uv pip install --system` (`Dockerfile.dev:73-76`), warms the FastEmbed caches, and ends with `CMD ["node", "/app/start.js", "--dev"]` (`Dockerfile.dev:93`).

The comment at `Dockerfile.dev:68-69` explains the system-wide install: the `.:/app` bind mount hides any `.venv` you may have under `servers/fastapi`, so dependencies must live outside the source tree. The three named volumes do the same job for Node: they stop your host's `node_modules` (built for macOS, say) from shadowing the Linux ones.

With `--dev`, `start.js` (see [Runtime topology](03-runtime-topology.md)) additionally:

1. Runs `npm ci` in `servers/nextjs` (`start.js:171-195`). On the first start this takes several minutes.
2. Re-syncs the export runtime with `--force` if the check fails, instead of exiting (`start.js:456-465`).
3. Copies your working-tree `nginx.conf` into `/etc/nginx/nginx.conf` (`start.js:468-479`).
4. Starts uvicorn with `--reload true` and `next dev --webpack`, and restarts either one after a clean exit (`start.js:521-536`, `538-566`, `582-590`).

```bash
docker compose up development
# edit servers/fastapi/... and uvicorn reloads; edit servers/nextjs/... and Next hot-reloads
```

!!! warning "Gotcha"
    Python dependencies are baked into the dev image. If you change `servers/fastapi/pyproject.toml`, rebuild with `docker compose build development`; uvicorn's reloader will not install new packages. Node dependencies in `servers/nextjs` are reinstalled by `npm ci` at every container start.

!!! warning "Gotcha"
    The host port is controlled by `PRESENTON_HTTP_HOST_PORT` (the port mapping), while the container receives `PRESENTON_HOST_HTTP_PORT` (only used by the startup banner, `scripts/presenton-terminal-banner.mjs:98`). The names differ by word order. The banner reads `PRESENTON_HTTP_HOST_PORT` first, but Compose does not pass that variable into the container, so in practice it uses `PRESENTON_HOST_HTTP_PORT` (`scripts/presenton-terminal-banner.mjs:95-99`). Both GPU services default the banner variable to `5000` (`docker-compose.yml:152`, `docker-compose.yml:419`) while mapping `5001`, so their banner can print the wrong URL.

## Step 3: A minimal `.env`

Compose substitutes `${VAR:-default}` from a `.env` file next to `docker-compose.yml`. A minimal working setup needs one text provider and, optionally, one image provider:

```bash title=".env"
LLM=openai
OPENAI_API_KEY=sk-...
# OPENAI_MODEL defaults to gpt-4.1 when empty (servers/fastapi/constants/llm.py:4)
IMAGE_PROVIDER=pexels
PEXELS_API_KEY=...
# Optional unattended admin (Step 4.2)
AUTH_USERNAME=admin
AUTH_PASSWORD=change-this-password
```

`start.js`'s config writer knows these `LLM` values: `ollama`, `openai`, `deepseek`, `google`, `vertex`, `azure`, `bedrock`, `openrouter`, `fireworks`, `together`, `cerebras`, `anthropic`, `litellm`, `lmstudio`, `custom`, `codex` (`scripts/user-config-env.cjs:1-18`). The list is applied only to the value already in `userConfig.json`, which is dropped when it is not in the set (`sanitizeExistingConfig`, `scripts/user-config-env.cjs:224-230`); a value coming from the environment is copied as is and is only rejected later, by FastAPI, at the first LLM call. Note that `presenton` (the Presenton Cloud provider) is not in this set, so a rewrite by `start.js` drops an `LLM=presenton` from the file; the database-backed provider row is mirrored back over the file when FastAPI starts (Step 1). Image providers are the `ImageProvider` enum: `pexels`, `pixabay`, `gemini_flash`, `nanobanana_pro`, `gpt-image-2`, `gpt-image-1.5`, `comfyui`, `open_webui`, `openai_compatible` (`servers/fastapi/enums/image_provider.py:4-13`).

If you omit `IMAGE_PROVIDER`, `normalizeImageConfig` picks one in this order (`scripts/user-config-env.cjs:194-219`): `openai_compatible` if its base URL, key and model are all set; `open_webui` if `OPEN_WEBUI_IMAGE_URL`; `comfyui` if `COMFYUI_URL`; `pexels` or `pixabay` if their keys exist; `gpt-image-1.5` (quality `medium`) when `LLM=openai` with a key; `gemini_flash` when `LLM=google` with a key; otherwise it sets `DISABLE_IMAGE_GENERATION=true`. A legacy `IMAGE_PROVIDER=dall-e-3` is rewritten to `gpt-image-2` (`:187-192`).

## Step 4: First-run administrator

Every `/api/` route except the public `/api/v1/auth/status`, `verify`, `setup`, `login` and `logout` paths is behind `SessionAuthMiddleware` (`servers/fastapi/api/middlewares.py:30-36`). Until a user exists it answers `428 {"detail":"Login setup is required","setup_required":true}` (`servers/fastapi/api/middlewares.py:82-93`). There are two ways to create the first account.

### 4.1 Through the UI

1. Open the app. The root page's `AuthGate` asks `GET /api/v1/auth/status`; when `configured` is `false` it shows setup mode (`servers/nextjs/components/Auth/AuthGate.tsx:39`).
2. Submit username, password and confirmation. The client checks the two passwords match, then posts to `/api/v1/auth/setup` (`AuthGate.tsx:199-235`).

```http
POST /api/v1/auth/setup
Content-Type: application/json

{"username": "admin", "password": "change-this-password"}
```

3. `setup_credentials` (`servers/fastapi/api/v1/auth/router.py:110-152`) returns 409 if any user already exists, validates the body (`AuthCredentialsRequest`: username 3 to 128 non-whitespace characters, password 8 to 128, `servers/fastapi/api/v1/auth/schemas.py:28-34`), creates a `User` with `is_superuser=True` and `admin_slot="primary"`, writes a recovery copy of the hash and a signing secret to `userConfig.json` (`persist_admin_credentials`, `servers/fastapi/api/v1/auth/config.py:95-107`), and responds:

```json
{"configured": true, "authenticated": false, "username": "admin", "role": "admin"}
```

4. Setup does not sign you in (`authenticated: false`). The UI shows "Account created" and asks you to sign in, which calls `POST /api/v1/auth/login`; that sets the `presenton_session` cookie (HttpOnly, SameSite=Lax, 30 days, `Secure` only when the request or `X-Forwarded-Proto` is HTTPS, `router.py:39-55`, `config.py:11-12`).

### 4.2 Unattended, from environment variables

`bootstrap_database_admin()` runs in FastAPI's lifespan on every start (`servers/fastapi/api/lifespan.py:58`). Its logic (`servers/fastapi/api/v1/auth/bootstrap.py:43-125`):

| State at startup | Variables | Result |
| --- | --- | --- |
| No users, `AUTH_USERNAME` and `AUTH_PASSWORD` set | (no flags) | creates the primary admin with that password; password must be at least 8 characters, username at least 3 |
| No users, legacy `AUTH_USERNAME`/`AUTH_PASSWORD_HASH` in `userConfig.json` | no flag | migrates the legacy account (pre-multi-user installs); `AUTH_USERNAME`/`AUTH_PASSWORD` from the environment are ignored |
| No users, legacy credentials present | `RESET_AUTH=true` or `AUTH_OVERRIDE_FROM_ENV=true` plus `AUTH_PASSWORD` | creates the admin from the environment values instead of the legacy ones (`bootstrap.py:91-106`) |
| No users, nothing set | none | does nothing; UI setup is required |
| Admin exists | `RESET_AUTH=true` or `AUTH_OVERRIDE_FROM_ENV=true` plus `AUTH_PASSWORD` | replaces password (and username if given), bumps `auth_version` so old sessions die, deletes all API keys, rotates the signing secret |
| Admin exists | a flag without `AUTH_PASSWORD` | raises `RuntimeError("RESET_AUTH and AUTH_OVERRIDE_FROM_ENV require AUTH_PASSWORD ...")`, FastAPI fails to start |
| Users exist but none is superuser | any | raises `User accounts exist but no bootstrap administrator is configured` |

```bash
docker run -it --name presenton -p 5001:80 \
  -e AUTH_USERNAME=admin -e AUTH_PASSWORD=change-this-password \
  -v "./app_data:/app_data" ghcr.io/presenton/presenton:latest
```

!!! warning "Gotcha"
    Leaving `RESET_AUTH=true` or `AUTH_OVERRIDE_FROM_ENV=true` in your `.env` rotates the admin on every container restart, which also deletes every API key (`bootstrap.py:61-74`). Remove the flag after one successful start, as the README advises.

!!! warning "Gotcha"
    Do not delete `AUTH_*` fields from `app_data/userConfig.json` to "reset" login. `AUTH_SECRET_KEY` there signs every session JWT and derives the Fernet key that encrypts stored API keys (`servers/fastapi/services/api_keys.py:39-43`). Losing it invalidates sessions and makes existing keys impossible to reveal again.

## Step 5: Run FastAPI and Next.js without Docker

For fast iteration on one side you can run both servers directly. There is no nginx, so Next.js's `proxy.ts` takes over the routing role (`servers/nextjs/proxy.ts:43-55`, `107-112`).

```mermaid
flowchart LR
  BR["Browser at http://127.0.0.1:3000"]
  NX["next dev (port 3000) with proxy.ts"]
  FA["uv run python server.py --port 8000"]
  EXR["presentation-export/runner.mjs + Chromium"]
  DB["SQLite in APP_DATA_DIRECTORY/fastapi.db"]
  BR -->|"pages, /api/* route handlers"| NX
  NX -->|"rewrite /api/v1, /api/v2, /app_data, /static"| FA
  FA --> DB
  FA -->|"spawn per export"| EXR
  EXR -->|"loads NEXT_PUBLIC_URL/pdf-maker"| NX
```

### 5.1 Prerequisites

- Python 3.11 exactly (`requires-python = ">=3.11,<3.12"`, `servers/fastapi/pyproject.toml:11`) and `uv`.
- Node 22 (the Docker images use NodeSource 22.x, `Dockerfile:113-114`) and npm.
- A Chrome or Chromium for exports, pointed to by `PUPPETEER_EXECUTABLE_PATH` (the images use `/usr/bin/chromium`). Whether the export package can fetch its own browser when the variable is unset is not verified here.

### 5.2 Sync the export runtime once

From the repository root:

```bash
npm ci
npm run sync:presentation-export      # node scripts/sync-presentation-export.cjs
npm run check:presentation-export     # --check-only, prints "[presentation-export] OK (<version>)"
```

The sync downloads `presenton-export-core-opensource-<version>.tgz` for the version pinned by `presentationExportVersion` in `package.json` from `github.com/presenton/presenton-export` releases into `presentation-export/` (`scripts/sync-presentation-export.cjs:32-33`, `155-172`, `359-394`). Use `npm run sync:presentation-export:force` to reinstall, or set `EXPORT_CORE_ARCHIVE=/path/to/file.tgz` to install from a local archive (`:381-388`). FastAPI finds the runtime at `../../presentation-export` relative to `servers/fastapi`, or wherever `EXPORT_PACKAGE_ROOT` points (`servers/fastapi/services/export_task_service.py:128-147`).

### 5.3 Start FastAPI

```bash
cd servers/fastapi
uv sync
mkdir -p /tmp/presenton-dev/app_data /tmp/presenton-dev/tmp
export APP_DATA_DIRECTORY=/tmp/presenton-dev/app_data
export TEMP_DIRECTORY=/tmp/presenton-dev/tmp
export USER_CONFIG_PATH=/tmp/presenton-dev/app_data/userConfig.json
export MIGRATE_DATABASE_ON_STARTUP=true
export NEXT_PUBLIC_URL=http://127.0.0.1:3000
export PUPPETEER_EXECUTABLE_PATH="/path/to/chrome"
uv run python server.py --port 8000 --reload true
```

Why each variable:

| Variable | Required? | Reason in code |
| --- | --- | --- |
| `APP_DATA_DIRECTORY` | yes | lifespan calls `os.makedirs(get_app_data_directory_env(), ...)` and fails on `None` (`servers/fastapi/api/lifespan.py:55`); asset mounts are only added when it is set (`servers/fastapi/api/main.py:77-82`); exports raise 500 without it (`export_task_service.py:155-161`) |
| `USER_CONFIG_PATH` | effectively yes | the JWT secret is created and saved there; without it `_save_auth_config` raises `ValueError("USER_CONFIG_PATH is not set")` on the first login or bootstrap (`servers/fastapi/api/v1/auth/config.py:32-35`) |
| `TEMP_DIRECTORY` | no | defaults to the system temp dir plus `presenton` (`export_task_service.py:164-166`) |
| `MIGRATE_DATABASE_ON_STARTUP` | no | defaults to `"true"` when unset (`servers/fastapi/utils/get_env.py:453-454`); Alembic runs only when the value is exactly `true` or `True` (`servers/fastapi/migrations.py:40-42`); `create_db_and_tables` still runs either way |
| `DATABASE_URL` | no | defaults to `sqlite:///$APP_DATA_DIRECTORY/fastapi.db`, rewritten to `sqlite+aiosqlite://`; `postgresql://` and `mysql://` become `asyncpg`/`aiomysql` (`servers/fastapi/utils/db_utils.py:57-67`) |
| `NEXT_PUBLIC_URL` | yes for exports | the exporter opens `{NEXT_PUBLIC_URL or http://127.0.0.1}/pdf-maker` (`servers/fastapi/utils/export_utils.py:18-40`); without nginx on port 80 the default points nowhere. It also narrows CORS to that origin (`api/main.py:92-100`) |

`server.py` accepts `--port` (required), `--reload` (`"true"` enables it) and `--log-level` (default `info`) and always binds `127.0.0.1` (`servers/fastapi/server.py:6-28`). The lifespan steps that run next are described in [FastAPI app and startup](05-fastapi-startup.md).

!!! warning "Gotcha"
    `update_env_with_user_config()` runs on every request (`UserConfigEnvUpdateMiddleware`, `servers/fastapi/api/middlewares.py:23-26`). When `USER_CONFIG_PATH` is set and the file has no `LLM` key, it removes `LLM` from `os.environ` (`servers/fastapi/utils/user_config.py:378-383`). An `export LLM=openai` in your shell can therefore vanish after the first request. Configure the provider through Settings, which persists it, rather than relying on shell variables.

### 5.4 Start Next.js

```bash
cd servers/nextjs
npm ci
export FAST_API_INTERNAL_URL=http://127.0.0.1:8000
export USER_CONFIG_PATH=/tmp/presenton-dev/app_data/userConfig.json
export APP_DATA_DIRECTORY=/tmp/presenton-dev/app_data
export TEMP_DIRECTORY=/tmp/presenton-dev/tmp
export NEXT_PUBLIC_URL=http://127.0.0.1:3000
export PUPPETEER_EXECUTABLE_PATH="/path/to/chrome"
npm run dev        # "next dev", serves http://localhost:3000
```

| Variable | Used by | Default when unset |
| --- | --- | --- |
| `FAST_API_INTERNAL_URL` | `proxy.ts` rewrites and auth checks, server layouts | `NEXT_PUBLIC_FAST_API`, then `http://127.0.0.1:8000` (`proxy.ts:10-23`, `utils/serverAuth.ts:17-30`) |
| `NEXT_PUBLIC_FAST_API` | browser and server code that needs an absolute backend origin | none; leave it unset in this setup so browser calls stay same-origin and go through `proxy.ts` (`utils/api.ts:88-98`) |
| `USER_CONFIG_PATH` | `app/api/user-config`, `lib/fastapi-internal.ts` | none |
| `APP_DATA_DIRECTORY` | `app/api/export-presentation/*`, `app/api/upload-image` | those routes throw `APP_DATA_DIRECTORY is required ...` |
| `NEXT_PUBLIC_URL` | the browser export route builds `{NEXT_PUBLIC_URL}/pdf-maker?...` for the export runtime (`servers/nextjs/lib/run-bundled-presentation-export.ts:159-160`) | `http://127.0.0.1`, which is nothing without nginx on port 80 |
| `PRESENTON_APP_ROOT`, `EXPORT_PACKAGE_ROOT` | where the browser export route finds `presentation-export/runner.mjs` | the repository root two levels above `servers/nextjs` (`run-bundled-presentation-export.ts:20-25`) |
| `PRESENTATION_GENERATION_MODE` | which generation UI is offered | `both` (see [What Presenton is](01-what-is-presenton.md)) |

Open `http://127.0.0.1:3000`. A browser request to `/api/v1/...` hits Next.js, `proxy.ts` asks FastAPI `/api/v1/auth/status` with your cookie, then rewrites the request to `http://127.0.0.1:8000/api/v1/...` (`proxy.ts:138-171`, `51-55`). Requests to `/app_data/*` and `/static/*` are rewritten unconditionally and FastAPI's own owner-scoped static mounts enforce access (`proxy.ts:110-112`, `servers/fastapi/api/v1/auth/assets.py:20-44`).

!!! warning "Gotcha"
    Because each `/api/v1` call in this mode costs an extra `auth/status` round trip from `proxy.ts` to FastAPI, it is slower than Docker, where nginx routes `/api/v1` straight to FastAPI. Do not benchmark from this setup.

## Step 6: Electron in development

```bash
cd electron
npm run setup:env   # npm install, uv sync in servers/fastapi, npm install in servers/nextjs,
                    # export runtime sync, ImageMagick prep (electron/package.json:38)
npm run dev         # export runtime + bundled Chromium prep, copy templates, tsc, electron . --no-sandbox
```

In dev mode Electron starts FastAPI with `uv run python server.py --port <port> --reload true` and Next.js with `npm run dev -- -H 127.0.0.1 -p <port>` (`electron/app/utils/servers.ts:137-143`, `208-212`). Ports are the first two free ones from 40000 upward, auth is disabled by default, and MCP is off. The full lifecycle is in [Electron desktop app](27-electron.md).

## Step 7: Swagger and the OpenAPI document

nginx proxies `/docs` and `/openapi.json` to FastAPI (`nginx.conf:110-128`). Both are in `SessionAuthMiddleware._PROTECTED_NON_API_PATHS` (`servers/fastapi/api/middlewares.py:42`), so sign in through the UI first; the browser then sends `presenton_session` and Swagger loads. In the no-Docker setup, sign in through the UI at `http://127.0.0.1:3000`, then open `http://127.0.0.1:8000/docs`. Browser cookies are scoped to the host name, not the port, so the `presenton_session` cookie set on `127.0.0.1:3000` is also sent to `127.0.0.1:8000`. Use the same host name for both (`localhost` and `127.0.0.1` are different cookie hosts).

The MCP server does not read the live `/openapi.json`. It uses the checked-in `servers/fastapi/openai_spec.json`, regenerated by `servers/fastapi/scripts/generate_openapi_spec.py`. After adding or renaming an endpoint the MCP layer depends on, regenerate that file.

## Step 8: An API key and a generation with curl

API keys are created by an admin with a browser session, then used by scripts. The full API surface is in [REST API, async tasks, webhooks, MCP](15-api-async-mcp.md); this step is the shortest working path.

### 8.1 Log in and capture the session cookie

```bash
curl -s -c cookies.txt -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"change-this-password"}' \
  http://localhost:5001/api/v1/auth/login
```

```json
{"configured": true, "authenticated": true, "id": "6f1c2d8e-...", "username": "admin", "role": "admin", "created_at": "..."}
```

The handler is `login` (`servers/fastapi/api/v1/auth/router.py:155-188`); the user fields come from `serialize_user` (`servers/fastapi/api/v1/auth/users.py:227-233`). IDs and timestamps above are placeholders. Wrong credentials give 401 `Unauthorized`; no account gives 428 `Login setup is required`.

### 8.2 Create the key

```bash
curl -s -b cookies.txt -H "Content-Type: application/json" \
  -d '{"user_id":"6f1c2d8e-...","label":"My API client","expiry_days":90}' \
  http://localhost:5001/api/v1/admin/api-keys
```

`AdminCreateApiKeyRequest` requires `user_id`; `label` defaults to `"API client"` (1 to 120 characters) and `expiry_days` to 90 (1 to 365) (`servers/fastapi/api/v1/auth/schemas.py:56-59`). The endpoint (`servers/fastapi/api/v1/admin/router.py:60-82`) returns 201 with `ApiKeyCreated`:

```json
{
  "id": "0123456789abcdef",
  "user_id": "6f1c2d8e-...",
  "created_by_id": "6f1c2d8e-...",
  "label": "My API client",
  "created_at": "...",
  "expires_at": "...",
  "last_used_at": null,
  "revoked_at": null,
  "token": "sk-presenton-0123456789abcdef.<secret>"
}
```

The token format is `sk-presenton-<16 hex id>.<secret>` where the secret is `secrets.token_urlsafe(40)` (`servers/fastapi/services/api_keys.py:19-22`, `79-104`). Only a hash of the secret is used for verification, plus a Fernet-encrypted copy so an admin can reveal it again with `GET /api/v1/admin/api-keys/{id}/token`.

!!! warning "Gotcha"
    `/api/v1/admin/*` accepts only a browser JWT from an admin (`servers/fastapi/api/middlewares.py:100-119`). Calling it with an API key, even an admin's, returns 403 `Admin browser session required`. That is why this step logs in with a cookie first.

### 8.3 Generate a deck

```bash
curl -X POST http://localhost:5001/api/v1/ppt/presentation/generate \
  -H "Authorization: Bearer sk-presenton-0123456789abcdef.<secret>" \
  -H "Content-Type: application/json" \
  -d '{"content":"Introduction to Machine Learning","n_slides":5,"language":"English","template":"general","export_as":"pptx"}'
```

`GeneratePresentationRequest` (`servers/fastapi/models/generate_presentation_request.py:8-46`):

| Field | Type | Default |
| --- | --- | --- |
| `content` | string, required | (none) |
| `slides_markdown` | list of strings | `null` |
| `instructions` | string | `null` |
| `tone` | `default`, `casual`, `professional`, `funny`, `educational`, `sales_pitch` | `default` |
| `verbosity` | `concise`, `standard`, `text-heavy` | `standard` |
| `web_search` | bool | `false` |
| `n_slides` | int | `null` (model decides) |
| `language` | string | `null` (model decides) |
| `template` | string | `"general"` |
| `include_table_of_contents` | bool | `false` |
| `include_title_slide` | bool | `true` |
| `files` | list of uploaded file paths | `null` |
| `export_as` | `pptx` or `pdf` | `pptx` |
| `trigger_webhook` | bool | `false` |

`check_if_api_request_is_valid` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:2620-2681`) returns 400 when `content`, `slides_markdown` and `files` are all empty, when `n_slides` is not positive or exceeds `MAX_NUMBER_OF_SLIDES = 50` (`servers/fastapi/constants/presentation.py:4`), when `slides_markdown` has more than 50 items, when a table of contents is requested with fewer than 3 slides, or with `Template not found. Please use a valid template.` The 16 bundled names are the folder names under `templates/` (`civic`, `dynamic`, `editorial`, `executive`, `general`, `horizon`, `landmark`, `modern`, `momentum`, `mosaic`, `nova`, `pulse`, `signal`, `standard`, `swift`, `verdant`).

The synchronous endpoint (`presentation.py:3169-3195`) blocks until export finishes and returns `PresentationPathAndEditPath`:

```json
{
  "presentation_id": "d3000f96-096c-4768-b67b-e99aed029b57",
  "path": "/app_data/exports/users/6f1c2d8e-.../Introduction_to_Machine_Learning.pptx",
  "edit_path": "/presentation?id=d3000f96-096c-4768-b67b-e99aed029b57"
}
```

The file name is derived from the generated presentation title, so the values above are illustrative. `path` is the filesystem path returned by the export service after it moves the file into the owner's folder (`servers/fastapi/services/export_task_service.py:449-455`, `773-805`); in Docker it is also the nginx URL. Download it with the same bearer key, since nginx's `/_auth_check` forwards `Authorization` (`nginx.conf:141`):

```bash
curl -H "Authorization: Bearer sk-presenton-..." -o deck.pptx \
  "http://localhost:5001/app_data/exports/users/6f1c2d8e-.../Introduction_to_Machine_Learning.pptx"
```

For long decks use `POST /api/v1/ppt/presentation/generate/async`, which returns an `AsyncTaskModel` immediately, then poll `GET /api/v1/ppt/presentation/status/{id}` until `status` is `completed`; `data.path` and `data.edit_path` carry the same values (`presentation.py:3240-3298`, completion data at `:3113-3127`).

!!! warning "Gotcha"
    The README example shows a `path` like `/app_data/<id>/<name>.pptx`. In this snapshot, authenticated exports land in `exports/users/<owner-id>/`. Always use the `path` the API returns rather than building it yourself.

## Step 9: Running the test suites

`test-local.sh` reproduces `.github/workflows/test-all.yml` and runs three checks, counting failures instead of stopping at the first one (`test-local.sh:15-30`, `73-83`). It needs `uv`, `npm` and `node` on `PATH` (`:63-68`).

| Check | Commands (`test-local.sh` lines) |
| --- | --- |
| Repository tooling | `npm ci && npm test && npm run sync:presentation-export && npm run check:presentation-export` at the root (`:32-38`) |
| FastAPI | `uv sync --locked --dev`, then `uv run --locked python -m pytest --verbose --tb=short` with `APP_DATA_DIRECTORY=/tmp/presenton-tests/app-data`, `TEMP_DIRECTORY=/tmp/presenton-tests/temp`, `DATABASE_URL=sqlite+aiosqlite:////tmp/presenton-tests/test.db`, `DISABLE_ANONYMOUS_TRACKING=true`, `DISABLE_IMAGE_GENERATION=true` (`:40-50`) |
| Next.js | `npm ci && npm test && npm run lint && NEXT_PUBLIC_FAST_API=http://localhost:8000 NEXT_PUBLIC_URL=http://localhost:3000 npm run build && npx cypress run --component --browser electron` (`:52-61`) |

Per suite, run the same commands by hand. The root `npm test` runs the template converter tests and seven `node --test` files under `scripts/` (`package.json`, `"test"` script). In `servers/nextjs`, `npm test` is plain `node --test`, which discovers the `*.test.mjs` files in `servers/nextjs/tests/`, and component tests live in `servers/nextjs/cypress/`. Electron has its own `npm run test:security` (`electron/package.json:41`). CI wiring is covered in [CI, tests, security](28-ci-tests-security.md).

```bash
# just the FastAPI suite, one file
cd servers/fastapi
APP_DATA_DIRECTORY=/tmp/presenton-tests/app-data TEMP_DIRECTORY=/tmp/presenton-tests/temp \
DATABASE_URL=sqlite+aiosqlite:////tmp/presenton-tests/test.db DISABLE_IMAGE_GENERATION=true \
uv run python -m pytest tests/integration -q
```

## Step 10: Troubleshooting

Every message below is a literal string from the code.

| Symptom | Where it comes from | Cause and fix |
| --- | --- | --- |
| Container exits with `APP_DATA_DIRECTORY is required` | `start.js:50-53` | running `start.js` outside the images without the variable; set it |
| Container exits with `presentation-export runtime is missing in this container image. Rebuild the image so the runtime package is installed.` | `start.js:457-461` | production check failed; rebuild, or in a custom image run `node scripts/sync-presentation-export.cjs --force`. `ENSURE_PRESENTATION_EXPORT_RUNTIME=false` skips the check but exports will then fail |
| `[presentation-export] Expected export-core X, found Y.` | `scripts/sync-presentation-export.cjs:267-271` | `presentationExportVersion` in `package.json` changed; run `npm run sync:presentation-export` |
| `Nginx failed to start with exit code: ...` but the logs continue | `start.js:713` | nginx config error; nothing on port 80. Check `/var/log/nginx/error.log` |
| `Skipping startup banner: FastAPI did not respond at http://127.0.0.1:8000/api/v1/auth/status within 60000ms` | `start.js:358-363`, `689` | slow first boot (migrations, model cache) or a lifespan crash; read the FastAPI traceback above it |
| `428 {"detail":"Login setup is required","setup_required":true}` | `servers/fastapi/api/middlewares.py:86-93`, `servers/nextjs/proxy.ts:162-167` | no user yet; complete setup (Step 4) |
| `401 {"detail":"Unauthorized"}` | `middlewares.py:95-99`, `proxy.ts:168-171` | missing or expired cookie, revoked or expired API key, wrong `Bearer` format; keys must start with `sk-presenton-` and have a secret of at least 32 characters (`servers/fastapi/services/api_keys.py:50-61`) |
| `403 {"detail":"Admin browser session required"}` | `middlewares.py:115-119` | admin endpoint called with an API key or a non-admin account |
| `403 {"detail":"API keys are only accepted by the Presenton API"}` | `proxy.ts:150-155` | API key sent to a Next.js `/api/*` route handler |
| `409 Credentials already configured` | `router.py:116-117` | setup called twice; log in instead |
| FastAPI fails with `RESET_AUTH and AUTH_OVERRIDE_FROM_ENV require AUTH_PASSWORD ...` | `servers/fastapi/api/v1/auth/bootstrap.py:56-60` | recovery flag without a password |
| `500 Invalid LLM provider. Please select one of: ...` | `servers/fastapi/utils/llm_provider.py:47-59` | `LLM` empty or unknown; choose a provider in Settings |
| `400 Google API Key is not set` (and similar per provider) | `utils/llm_provider.py:177-180` | provider selected without credentials |
| `400 Template not found. Please use a valid template.` | `presentation.py:2677-2680` | misspelled template name or a custom template ID from another user |
| `413 {"detail":"File size must be less than 100MB."}` | `nginx.conf:71-74` | upload above the 110M `/api/v1/` limit; `/api/v2/` uses the 100M default without the JSON body |
| Images or downloads 403 behind nginx, 404 without | `router.py:96-102`, `middlewares.py:138-148` | the file is in another user's `users/<id>/` folder or a legacy root-level file and you are not admin |
| `/mcp` returns 502 | MCP process not watched, logs discarded (`start.js:608-620`) | run `python mcp_server.py --port 8001` in the container to see why it died |
| Exports hang or fail in a no-Docker setup | `servers/fastapi/utils/export_utils.py:18-19` | `NEXT_PUBLIC_URL` not set, so Chromium loads `http://127.0.0.1/pdf-maker` on port 80 |
| `APP_DATA_DIRECTORY is required to download exported files.` | `servers/nextjs/app/api/export-presentation/route.ts:35-38` | Next.js started without `APP_DATA_DIRECTORY` |

## What you now know

- `docker run -p 5001:80 -v ./app_data:/app_data ghcr.io/presenton/presenton:latest` is the fastest start; Compose offers four named services (`production`, `production-gpu`, `development`, `development-gpu`), and the dev ones bind-mount the source and run `start.js --dev`.
- Provider environment variables seed `userConfig.json`, but after the first boot the database copy wins; change providers in Settings.
- The first admin is created either through `POST /api/v1/auth/setup` from the UI or by `bootstrap_database_admin()` from `AUTH_USERNAME`/`AUTH_PASSWORD`, with `RESET_AUTH`/`AUTH_OVERRIDE_FROM_ENV` for recovery.
- Without Docker you need `APP_DATA_DIRECTORY`, `USER_CONFIG_PATH` and, for exports, `NEXT_PUBLIC_URL` on the FastAPI side, plus a synced `presentation-export/`; `proxy.ts` stands in for nginx.
- API keys are minted by an admin browser session at `POST /api/v1/admin/api-keys` and sent as `Authorization: Bearer sk-presenton-...` to `POST /api/v1/ppt/presentation/generate` or its async twin.

## Next

Now look inside the backend process you just started, beginning with [FastAPI app and startup](05-fastapi-startup.md).
