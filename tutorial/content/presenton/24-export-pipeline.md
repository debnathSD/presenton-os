# PPTX and PDF export

<div class="chapter-meta" markdown>
**Reads:** `servers/fastapi/utils/export_utils.py`, `servers/fastapi/services/export_task_service.py`, `servers/nextjs/app/api/export-presentation/route.ts`, `servers/nextjs/lib/run-bundled-presentation-export.ts`, `servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx`, `scripts/sync-presentation-export.cjs`, `scripts/run-presentation-export.mjs`, `scripts/export-permissions.cjs`  ·  **Builds on:** [Next.js architecture](20-nextjs-architecture.md)  ·  **Time:** ~50 min
</div>

What you will learn: how a deck stored as slide rows in the database becomes a `.pptx` or `.pdf` file on disk, and how that file gets back to the person or API client that asked for it. You will follow the three entry points (the editor's Export menu, the REST API, and the Electron desktop app) down to a single Node.js runner that drives a closed export engine, `@presenton/export-core`, which loads a special headless page, `/pdf-maker`, in Chromium. Along the way you will see exactly which credentials travel where, why the export browser must be logged in, where files land, which permissions they get, and what this repository can and cannot tell you about the engine's internals.

## The big picture

The single most important fact about Presenton's export pipeline is this: **Presenton does not build PowerPoint files itself.** There is no python-pptx code that writes slides (python-pptx is a dependency, `servers/fastapi/pyproject.toml:37`, but it is used only for template font utilities, see Step 13). Instead, every export follows the same recipe:

1. Write a small JSON "task" file describing what to export.
2. Spawn `node runner.mjs <task.json>`, where `runner.mjs` is a copy of `scripts/run-presentation-export.mjs`.
3. The runner calls `runTask()` from `@presenton/export-core`, a prebuilt package downloaded from GitHub releases at install time.
4. export-core launches Chromium (through Puppeteer, judging by every environment variable it is given), opens `http://<next-origin>/pdf-maker?id=<presentation id>`, and turns the rendered slide DOM into a PPTX or a PDF.
5. The runner writes `<task>.response.json` containing the output path.
6. The caller moves the file into the owner's directory, fixes permissions, and returns a download path.

There are three callers that build the task file, and they differ in how they authenticate the headless browser:

| Entry point | Who builds the task | Code |
|---|---|---|
| Editor header "Export as PDF/PPTX" (web and Docker) | Next.js route `POST /api/export-presentation` | `servers/nextjs/app/api/export-presentation/route.ts:92`, `servers/nextjs/lib/run-bundled-presentation-export.ts:147` |
| REST API and MCP (`/generate`, `/generate/async`, `/edit`, `/derive`, `/{id}/export`, v2 smart generate) | FastAPI `export_presentation()` | `servers/fastapi/utils/export_utils.py:43`, `servers/fastapi/services/export_task_service.py:422` |
| Electron desktop editor | Electron main process IPC handler `export-presentation` | `electron/app/ipc/export_handlers.ts:57` |

```mermaid
flowchart TD
    UI["Editor header: Export PDF or PPTX"] -->|"POST /api/export-presentation"| NR["Next.js route export-presentation/route.ts"]
    API["REST or MCP client: generate, edit, derive, id/export"] --> FA["FastAPI export_presentation()"]
    EL["Electron renderer: window.electron.exportPresentation"] -->|"IPC export-presentation"| EM["Electron main export_handlers.ts"]
    NR --> TJ["export_task.json in a private temp dir"]
    FA --> TJ
    EM --> TJ
    TJ --> RN["node runner.mjs export_task.json"]
    RN --> EC["@presenton/export-core runTask()"]
    EC --> CH["Headless Chromium"]
    CH -->|"GET /pdf-maker?id=..."| PM["Next.js pdf-maker page"]
    PM -->|"GET /api/export-presentation-data/id"| PD["Next.js data bridge route"]
    PD -->|"GET /api/v1/ppt/presentation/id"| DB["FastAPI and the database"]
    EC --> OUT["APP_DATA_DIRECTORY/exports/Title.pptx or .pdf"]
    RN --> RESP["export_task.response.json"]
    RESP --> MOVE["Caller moves file to exports/users/owner and returns a path"]
```

!!! tip "If you are building this for Superset"
    The design choice here (render HTML in a browser, then convert the DOM) is exactly what the Superset part of this site argues against for data-bound slides. Keep this chapter in mind when you read [Native rendering, no screenshots](../superset/35-native-rendering.md).

## Step 1: Install the export runtime

Before anything can be exported, the runtime has to exist on disk. It is not in the repository: `.gitignore:30-32` ignores both `presentation-export/` and `.cache/presentation-export/`, and a search of this checkout (including `electron/resources/`, which only contains `document-extraction` and `ui`) finds no copy of `@presenton/export-core`. Everything below about the runtime comes from the script that installs it and the code that calls it.

### 1.1 The pinned version

The version is pinned in two places that are expected to agree (the root pin drives the download; Electron's `--check-only` validates its bundled copy against `exportVersion`, `electron/scripts/sync-export-runtime.cjs:15`, `35-47`, and the MSIX runtime cache is keyed by it, `electron/app/utils/export-msix-runtime.ts:21-40`):

| File | Key | Value |
|---|---|---|
| `package.json:4` | `presentationExportVersion` | `v1.0.51` |
| `electron/package.json:5` | `exportVersion` | `v1.0.51` |

`readPinnedVersion()` (`scripts/sync-presentation-export.cjs:155-162`) throws if the root key is missing. `getTargetVersion()` (`scripts/sync-presentation-export.cjs:164-168`) honors `EXPORT_RUNTIME_VERSION` only when the `--allow-version-override` flag is also passed, and the literal value `latest` is resolved through the GitHub API at `https://api.github.com/repos/presenton/presenton-export/releases/latest` (`scripts/sync-presentation-export.cjs:214-220`).

### 1.2 Where the archive comes from

```js title="scripts/sync-presentation-export.cjs (excerpt)"
const repoRoot = path.join(__dirname, "..");
const targetRoot = path.join(repoRoot, "presentation-export");
const targetRunner = path.join(targetRoot, "runner.mjs");
// ...
const cacheDir = path.join(repoRoot, ".cache", "presentation-export");
const exportRepoBase =
  "https://github.com/presenton/presenton-export/releases/download";
```

The asset name is built by `assetNameForVersion()` (`scripts/sync-presentation-export.cjs:170-172`) as `presenton-export-core-opensource-<version without v>.tgz`, and the download URL by `main()` (`scripts/sync-presentation-export.cjs:377-379`). For the pinned version that gives:

```text
https://github.com/presenton/presenton-export/releases/download/v1.0.51/presenton-export-core-opensource-1.0.51.tgz
```

The archive is saved to `.cache/presentation-export/presenton-export-core-opensource-1.0.51.tgz`. If `EXPORT_CORE_ARCHIVE` points at a local file, that file is copied there instead of downloading (`scripts/sync-presentation-export.cjs:381-391`). `downloadFile()` follows up to five redirects (301, 302, 303, 307, 308) and fails on any non-2xx status (`scripts/sync-presentation-export.cjs:222-251`).

!!! warning "Gotcha: there is no checksum"
    You might expect the installer to verify what it downloads. In this snapshot there is no checksum, signature, or hash check of the downloaded `.tgz`. "Verification" means only the post-install checks in `validateExistingRuntime()` (`scripts/sync-presentation-export.cjs:253-286`): the installed `package.json` version must equal the pin, the manifest must name the expected archive, and Sharp and KaTeX must be at or above security floors. A tampered archive with the right version string would pass.

### 1.3 Installing into `presentation-export/`

`installRuntime()` builds a tiny npm project around the archive:

```js title="scripts/sync-presentation-export.cjs (excerpt)"
  clearDirectoryContents(targetRoot);
  fs.copyFileSync(sourceRunner, targetRunner);
  fs.copyFileSync(sourcePermissions, targetPermissions);
  fs.writeFileSync(
    path.join(targetRoot, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: { "@presenton/export-core": `file:${archivePath}` },
        overrides: { sharp: "0.35.5", katex: "0.18.10" },
      },
      null,
      2,
    )}\n`,
  );
  const npmArgs = [
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--no-package-lock",
    "--no-fund",
    "--no-audit",
  ];
```

Details worth knowing:

- `clearDirectoryContents()` deletes the *contents* but keeps the directory itself, because Docker development compose mounts a named volume at `/app/presentation-export` (`docker-compose.yml:277`) and removing a mount point fails with `EBUSY` (comment at `scripts/sync-presentation-export.cjs:296-297`).
- npm's cache is forced to `.cache/presentation-export/npm` through the `npm_config_cache` environment variable, after removing any inherited variable with that name in any letter case (`scripts/sync-presentation-export.cjs:322-325`). The test at `scripts/sync-presentation-export.test.mjs:18-52` proves cache paths containing `&`, `%TEMP%` and `!name!` never reach a shell command line.
- On Windows it runs `node npm-cli.js` directly when `npm_execpath` points at one, otherwise `cmd.exe /d /s /c npm ...` (`scripts/sync-presentation-export.cjs:332-348`).
- `--ignore-scripts` means no install scripts from export-core or its dependencies run.
- Finally it writes `presenton-export-version.json` with `{ "version": "v1.0.51", "package": "presenton-export-core-opensource-1.0.51.tgz" }` (`scripts/sync-presentation-export.cjs:349-356`).

The resulting layout, which every caller checks for, is:

```text
presentation-export/
  runner.mjs                       (copy of scripts/run-presentation-export.mjs)
  export-permissions.cjs           (copy of scripts/export-permissions.cjs)
  package.json                     (written by installRuntime)
  presenton-export-version.json    (version manifest)
  node_modules/@presenton/export-core/dist/index.js
  node_modules/sharp, node_modules/@img/sharp-<platform>-<arch>, node_modules/katex, ...
```

### 1.4 Post-install validation

| Check | Rule | Code |
|---|---|---|
| Runner present | `presentation-export/runner.mjs` exists | `scripts/sync-presentation-export.cjs:254-256` |
| Engine version | installed `@presenton/export-core` version equals the pin minus the `v` | `scripts/sync-presentation-export.cjs:266-271` |
| Manifest | `manifest.package` equals the expected `.tgz` name | `scripts/sync-presentation-export.cjs:272-277` |
| Sharp | version `>= 0.35.5`, and the native package `@img/sharp-<platformArch>` (plus `@img/sharp-libvips-<platformArch>` when declared) installed at the exact versions Sharp declares | `scripts/sync-presentation-export.cjs:81-134` |
| KaTeX | version `>= 0.18.2` | `scripts/sync-presentation-export.cjs:136-148` |

`getRuntimePlatformArch()` returns `linux-x64` on glibc Linux and `linuxmusl-x64` on musl, decided by whether `process.report` exposes `glibcVersionRuntime` (`scripts/sync-presentation-export.cjs:40-51`). `resolvedPackagePath()` checks the copy Node will actually load, including copies nested under the engine's own `node_modules` (`scripts/sync-presentation-export.cjs:61-69`), and the test at `scripts/sync-presentation-export.test.mjs:177-197` confirms that a vulnerable nested KaTeX or Sharp fails validation. Version strings must be plain `x.y.z`; `0.35.5-beta.1` is rejected by `versionAtLeast()` (`scripts/sync-presentation-export.cjs:71-79`).

### 1.5 CLI flags and where the script runs

| Invocation | Behavior |
|---|---|
| `node scripts/sync-presentation-export.cjs` (`npm run sync:presentation-export`) | If the installed runtime validates, only refresh `runner.mjs` and `export-permissions.cjs`, then exit. Otherwise download and install. |
| `--force` (`npm run sync:presentation-export:force`) | Always download and reinstall. |
| `--check-only` (`npm run check:presentation-export`) | Validate only, also require `export-permissions.cjs`, print `[presentation-export] OK (1.0.51)`. |
| `--allow-version-override` | Honor `EXPORT_RUNTIME_VERSION`. |

The "refresh the runner even when the pin is unchanged" behavior (`scripts/sync-presentation-export.cjs:368-375`) exists because the runner is Presenton's own auth bridge and can change between releases while the engine pin stays the same. The test at `scripts/sync-presentation-export.test.mjs:151-175` overwrites a stale runner and checks it gets replaced.

Where it is executed:

- Docker image build: the `assets-builder` stage copies the three scripts and runs `node /app/scripts/sync-presentation-export.cjs --force` (`Dockerfile:66-70`); the runtime stage copies `/app/presentation-export` and asserts both `runner.mjs` and `dist/index.js` exist (`Dockerfile:135-140`). `Dockerfile.dev:63-66` does the same.
- Container start: `ensurePresentationExportRuntime()` runs `--check-only`, and in development falls back to `--force`; in production a failed check aborts startup with "presentation-export runtime is missing in this container image" (`start.js:444-466`). Set `ENSURE_PRESENTATION_EXPORT_RUNTIME=false` to skip.
- Electron: `electron/scripts/sync-export-runtime.cjs` runs the root script, then copies `presentation-export/` to `electron/resources/export/` and re-validates (`electron/scripts/sync-export-runtime.cjs:55-73`).
- CI: see Step 14.

!!! warning "Gotcha: do not run a plain sync inside the production container"
    The runtime stage of the image copies only `sync-presentation-export.cjs` and `export-permissions.cjs` into `/app/scripts` (`Dockerfile:136-137`); `scripts/run-presentation-export.mjs` exists only in the `assets-builder` stage (`Dockerfile:67`). `--check-only` never touches the runner, so container startup works. But a plain `node scripts/sync-presentation-export.cjs` (no flags) on a valid runtime takes the "refresh the runner" branch and calls `fs.copyFileSync(sourceRunner, targetRunner)` (`scripts/sync-presentation-export.cjs:371`), which fails with `ENOENT` because the source file is absent. Rebuild the image instead of syncing in place.

## Step 2: The runner contract

Every caller ends up executing the same file with the same contract. If you want to replace export-core, this is the seam.

### 2.1 Command line and files

```text
node <EXPORT_PACKAGE_ROOT>/runner.mjs /path/to/export_task.json
```

- Input: one positional argument, a JSON task file. Missing argument throws `Usage: run-presentation-export.mjs <task.json>` (`scripts/run-presentation-export.mjs:102-105`).
- Output: the runner writes the response next to the task, replacing a trailing `.json` with `.response.json` (`scripts/run-presentation-export.mjs:128-129`). So `export_task.json` produces `export_task.response.json`.
- Exit code: `0` on success; any thrown error is printed with `console.error("[presentation-export]", error)` (so stderr gets the prefix followed by the error and its stack) and sets `process.exitCode = 1` (`scripts/run-presentation-export.mjs:132-135`).
- `process.umask(0o027)` is set first (`scripts/run-presentation-export.mjs:7`), so anything export-core creates is at most `rwxr-x---`.

### 2.2 The task object

The runner strips three keys before handing the task to export-core:

```js title="scripts/run-presentation-export.mjs (excerpt)"
  const rawTask = JSON.parse(await fs.readFile(taskPath, "utf8"));
  const {
    fastapiUrl,
    cookieHeader,
    slide_concurrency: _slideConcurrency,
    ...task
  } = rawTask;
  task.__taskFilePath = path.resolve(taskPath);

  const response = await runTask(
    task,
    buildRunOptions(task, { fastapiUrl, cookieHeader }),
  );
```

So export-core never sees the raw cookie header; it receives cookies only through `urlConfigs` (below). It does receive an extra `__taskFilePath` with the absolute task path. No caller in this repository sends `slide_concurrency`; the runner discards it either way.

The task types that callers in this repository send:

| `type` | Extra fields | Caller | Response used |
|---|---|---|---|
| `export` | `url`, `format` (`pptx` or `pdf`), `title` | `servers/fastapi/services/export_task_service.py:437-447`, `servers/nextjs/lib/run-bundled-presentation-export.ts:181-188`, `electron/app/ipc/export_handlers.ts:83-90` | `path` |
| `pptx-to-html` | `pptx_path`, `get_fonts` | `servers/fastapi/services/export_task_service.py:464-471` | `path` to a JSON manifest |
| `pptx-to-json` | `pptx_path` | `servers/fastapi/services/export_task_service.py:691-700` | `path` to a JSON file with `layouts` |
| `html-to-image` | `html`, `width`, `height` | `servers/fastapi/services/export_task_service.py:533-541` | `path` |
| `html-to-images` | `htmls`, `width`, `height` | `servers/fastapi/services/export_task_service.py:644-652` | `file_paths` |
| `json-to-image` | `data`, `width`, `height`, optional `fonts` | `servers/fastapi/services/export_task_service.py:561-573` | `path` |
| `json-to-images` | `jsons`, `width`, `height`, optional `fonts` | `servers/fastapi/services/export_task_service.py:598-610` | `file_paths` |

The runner also mentions `html-to-any` when choosing an output directory (`scripts/run-presentation-export.mjs:49`), but nothing in this repository sends it.

### 2.3 Environment variables the runner reads

| Variable | Effect in the runner | Set by |
|---|---|---|
| `APP_DATA_DIRECTORY` | `outputDirectory` becomes `<APP_DATA_DIRECTORY>/exports` for `export`, else `<APP_DATA_DIRECTORY>`; also a permissions root | Docker `Dockerfile:82` (`/app_data`), Electron `electron/app/main.ts:371`, FastAPI copies it (`servers/fastapi/services/export_task_service.py:156-162`) |
| `TEMP_DIRECTORY` | `tempDirectory` option and a permissions root | Docker `Dockerfile:83` (`/tmp/presenton`); FastAPI overrides it per owner (`servers/fastapi/services/export_task_service.py:164-171`) |
| `PUPPETEER_EXECUTABLE_PATH` | `browserLaunchOptions.executablePath` | Docker `Dockerfile:92` (`/usr/bin/chromium`), Electron (`electron/app/main.ts:386-388`, `electron/app/ipc/export_handlers.ts:134`) |
| `PUPPETEER_CACHE_DIR` | `puppeteerCacheDirectory` option | FastAPI defaults it under the temp dir (`servers/fastapi/services/export_task_service.py:179-183`), Electron `getCacheDir()/puppeteer` |
| `NEXT_PUBLIC_FAST_API` | fallback for `fastapiUrl`, injected into `window.env` | Electron only (`electron/app/utils/index.ts:12`) |
| `ASSETS_BASE_URL` | injected into `window.env` | FastAPI sets `/app_data` (`servers/fastapi/services/export_task_service.py:199`) |
| `PRESENTON_ELECTRON`, `PRESENTON_DESKTOP_TOKEN`, `PRESENTON_DESKTOP_ORIGINS` | add a desktop-token header rule per desktop origin | Electron main (`electron/app/utils/desktop-auth.ts:18-19`, `electron/app/main.ts:459`) |

`PUPPETEER_TMP_DIR` is created by FastAPI and Electron but the runner does not read it; it is simply inherited by the child, presumably for Puppeteer itself (not verified).

### 2.4 The options passed to `runTask`

```js title="scripts/run-presentation-export.mjs (excerpt)"
function buildRunOptions(task, legacyTask) {
  const appDataDirectory = process.env.APP_DATA_DIRECTORY?.trim();
  const tempDirectory = process.env.TEMP_DIRECTORY?.trim();
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  const puppeteerCacheDirectory = process.env.PUPPETEER_CACHE_DIR?.trim();
  const fastapiUrl = legacyTask.fastapiUrl || process.env.NEXT_PUBLIC_FAST_API?.trim();
  const cookies = parseCookieHeader(legacyTask.cookieHeader);
  // Browser cookies cannot be scoped to a port. The desktop capability is
  // supplied below as an exact-origin header instead, including asset fetches.
  if (cookies) delete cookies.presenton_desktop_session;

  const outputDirectory = appDataDirectory
    ? task.type === "export" || task.type === "html-to-any"
      ? path.join(appDataDirectory, "exports")
      : appDataDirectory
    : undefined;

  const urlConfigs =
    cookies && Object.keys(cookies).length && typeof task.url === "string"
      ? [{ url: task.url, match: "origin", cookies }]
      : [];
  // Export Chromium and Node asset downloads are outside Electron's session.
  // Never attach the desktop capability to arbitrary task/asset URLs.
  const desktopToken = process.env.PRESENTON_DESKTOP_TOKEN;
  if (process.env.PRESENTON_ELECTRON === "true" && desktopToken) {
    for (const url of (process.env.PRESENTON_DESKTOP_ORIGINS || "").split(",")) {
      if (url) urlConfigs.push({
        url,
        match: "origin",
        headers: { "x-presenton-desktop-token": desktopToken },
      });
    }
  }
  // ...
```

The final options object (`scripts/run-presentation-export.mjs:71-80`) contains only the keys that have values:

| Option | Meaning (as far as the caller shows) |
|---|---|
| `outputDirectory` | where export-core writes the result |
| `tempDirectory` | scratch space |
| `browserLaunchOptions.executablePath` | the Chromium binary to launch |
| `puppeteerCacheDirectory` | browser cache location |
| `urlConfigs` | a list of `{ url, match: "origin", cookies? , headers? }` rules; cookies for the page origin, and in Electron a header rule for each app origin |
| `modifyWindow` | a function built with `new Function(...)` that merges `{ NEXT_PUBLIC_FAST_API, ASSETS_BASE_URL }` into `window.env` (`scripts/run-presentation-export.mjs:23-35`) |

`parseCookieHeader()` splits on `;`, keeps everything after the first `=` as the value, and ignores items without a name (`scripts/run-presentation-export.mjs:9-21`).

!!! warning "Gotcha: `ASSETS_BASE_URL` is injected but unused by the page"
    FastAPI always sets `ASSETS_BASE_URL=/app_data` and the runner merges it into `window.env`, but no file under `servers/nextjs` reads `ASSETS_BASE_URL`; the `Window.env` type (`servers/nextjs/types/global.d.ts:25-32`) declares only `NEXT_PUBLIC_FAST_API`, `APP_VERSION` and `DISABLE_AUTH`. If the variable has an effect, it is inside export-core. Do not rely on it from page code without verifying. Note also that the Next.js export path never sets `ASSETS_BASE_URL`, so in Docker (where `NEXT_PUBLIC_FAST_API` is unset) that path passes no `modifyWindow` at all.

### 2.5 The response

After `runTask` returns, the runner fixes permissions on every produced file (recursively for `pptx-to-html` and `pptx-to-json`) and then normalizes the response (`scripts/run-presentation-export.mjs:83-99`, `120-127`):

| export-core returned | Runner writes |
|---|---|
| a string | `{ "data": "<string>" }` |
| an object with `type: "files"` and `filePaths` | the object plus `paths` and `file_paths` (both equal to `filePaths`) |
| any other object with `filePath` | the object plus `path` and `file_path` (both equal to `filePath`) |

So for an export, `export_task.response.json` contains at least `filePath`, `path` and `file_path`, all holding the absolute output path. The test `scripts/desktop-export.test.mjs:30-58` uses a fake export-core whose `runTask` returns a string, which is why it reads `response.data`.

## Step 3: The editor triggers an export

The browser path starts in `servers/nextjs/app/(presentation-generator)/presentation/components/PresentationHeader.tsx`. The "Export as" popover has two buttons that call `handleExportPdf()` and `handleExportPptx()` (`servers/nextjs/app/(presentation-generator)/presentation/components/PresentationHeader.tsx:469-500`). Both are no-ops while a deck is still streaming (`servers/nextjs/app/(presentation-generator)/presentation/components/PresentationHeader.tsx:227`, `309`).

### 3.1 The file name

`buildSafeExportFileName()` (`servers/nextjs/app/(presentation-generator)/presentation/components/PresentationHeader.tsx:62-94`) turns the title into a download name:

1. Default to `presentation`, trim, strip a trailing `.pdf` or `.pptx`.
2. Replace every run of characters outside `[a-zA-Z0-9\s_-]` with `-`, whitespace with `-`, collapse repeated `-`/`_`, trim separators.
3. Truncate to `MAX_EXPORT_TITLE_LENGTH = 40` characters (`servers/nextjs/app/(presentation-generator)/presentation/components/PresentationHeader.tsx:60`).
4. Append `.pdf` or `.pptx`.

A title like `Q3 Review: EMEA & APAC` becomes `Q3-Review-EMEA-APAC.pptx`. The `title` sent to the server is that name without the extension.

!!! warning "Gotcha: non-Latin titles become `presentation`"
    Because step 2 replaces everything outside ASCII letters and digits, a fully Japanese or Arabic title collapses to an empty string and falls back to `presentation`. The REST API path keeps Unicode (it uses `pathvalidate.sanitize_filename` plus a byte budget, see Step 6.3), so the same deck can get different file names depending on how it was exported.

### 3.2 Choosing a transport

If `window.electron?.exportPresentation` exists, the header calls it over IPC (`servers/nextjs/app/(presentation-generator)/presentation/components/PresentationHeader.tsx:209-224`, `253-254`) and the Electron main process takes over (Step 11). Otherwise it posts to Next.js:

```http
POST /api/export-presentation
Content-Type: text/plain;charset=UTF-8
Cookie: presenton_session=<JWT>

{"format":"pptx","id":"6f1c2a0e-3b7d-4c1e-9a55-0b8f4c2d9e11","title":"Q3-Review-EMEA-APAC"}
```

(The browser sends `text/plain` because `fetch` is called with a string body and no `Content-Type` header, `servers/nextjs/app/(presentation-generator)/presentation/components/PresentationHeader.tsx:256-263`; the route reads the raw text, so this does not matter.)

On success the response is:

```json
{
  "success": true,
  "path": "/api/export-presentation/file?name=users%2F2b9e...%2FQ3-Review-EMEA-APAC.pptx"
}
```

The header then creates an `<a href=path download=fileName rel="noopener">`, clicks it, and removes it (`servers/nextjs/app/(presentation-generator)/presentation/components/PresentationHeader.tsx:426-434`). Analytics events `Presentation_Export_Started/Completed/Failed` are sent around the whole operation and are explicitly not allowed to change the result (`servers/nextjs/app/(presentation-generator)/presentation/components/PresentationHeader.tsx:436-467`).

## Step 4: The Next.js export route

`servers/nextjs/app/api/export-presentation/route.ts` is a thin, careful wrapper.

### 4.1 Authentication and validation

1. `authStatusForRequest(req)` (`servers/nextjs/lib/server-auth-role.ts:20-54`) forwards the browser's `Cookie` (and the desktop token header if present) to FastAPI `GET /api/v1/auth/status` and returns `{ configured, authenticated, username, user_id, role }`. Unauthenticated callers get `401 {"detail":"Unauthorized"}` (`servers/nextjs/app/api/export-presentation/route.ts:93-96`).
2. `readExportRequestBody()` reads the raw text, rejects an empty body or a non-object, and parses JSON (`servers/nextjs/app/api/export-presentation/route.ts:16-32`).
3. `id` must be a non-empty string and `format` must be `pdf` or `pptx` (`servers/nextjs/app/api/export-presentation/route.ts:118-130`).
4. `bundledExportPackageAvailable()` checks both `runner.mjs` and `node_modules/@presenton/export-core/dist/index.js` under the package root (`servers/nextjs/lib/run-bundled-presentation-export.ts:46-57`).

| Condition | Status | Body |
|---|---|---|
| Not authenticated | 401 | `{"detail":"Unauthorized"}` |
| Empty, non-object or invalid JSON body | 400 | `{"error":"Invalid export request JSON body"}` |
| Missing or blank `id` | 400 | `{"error":"Missing Presentation ID"}` |
| `format` not `pdf`/`pptx` | 400 | `{"error":"Invalid export format"}` |
| Runtime missing | 500 | `{"error":"presentation-export runtime is not available. Run scripts/sync-presentation-export.cjs to install it.","success":false}` |
| Child failed, output outside exports, and so on | 500 | `{"error":"<message>","success":false}` |

Note that the route never checks that the presentation exists or belongs to the caller. That check happens later, inside the headless browser, when the data bridge asks FastAPI for the presentation with the caller's own cookie (Step 7.3). For a foreign or unknown id FastAPI answers 404, `ApiResponseHandler.handleResponse()` throws, and `PdfMakerPage` replaces the slides with its "Oops!" error panel (`servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx:197-200`, `229-253`). No other user's data is ever rendered. Whether export-core notices the missing `.main-slide` elements and fails, or produces a file from the error panel, cannot be verified from this repository.

### 4.2 Scoping the output to the user

After the runner finishes, `moveExportIntoOwnerDirectory()` (`servers/nextjs/app/api/export-presentation/route.ts:53-90`) moves the file from `<APP_DATA_DIRECTORY>/exports/<file>` to `<APP_DATA_DIRECTORY>/exports/users/<user_id>/<file>` with `fs.rename`. It refuses anything whose real path is not inside `exports/`, or that is already inside some `users/` subtree other than the caller's own directory. When `user_id` is null (auth disabled), the file stays where export-core put it.

### 4.3 Building the download URL

```ts title="servers/nextjs/app/api/export-presentation/route.ts (excerpt)"
function buildExportDownloadUrl(outPath: string): string {
  const appDataDirectory = process.env.APP_DATA_DIRECTORY?.trim();
  if (!appDataDirectory) {
    throw new Error("APP_DATA_DIRECTORY is required to download exported files.");
  }

  const exportsDirectory = path.join(appDataDirectory, "exports");
  const relativePath = path.relative(exportsDirectory, outPath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Export finished outside the configured exports directory.");
  }

  return `/api/export-presentation/file?name=${encodeURIComponent(relativePath)}`;
}
```

The URL carries only a path relative to `exports/`, never an absolute filesystem path. Step 10.3 shows how the file route re-validates it.

## Step 5: Building and running the task from Next.js

`runBundledPresentationExport()` (`servers/nextjs/lib/run-bundled-presentation-export.ts:138-145`) delegates to `runBundledPresentationExportLocked()`. Despite the name, there is no lock in this snapshot; concurrent exports run concurrent Chromium processes.

### 5.1 Roots

| Function | Value |
|---|---|
| `getExportPackageRoot()` | `EXPORT_PACKAGE_ROOT`, else `<cwd>/../../presentation-export` (`servers/nextjs/lib/run-bundled-presentation-export.ts:13-18`) |
| `getPresentonAppRoot()` | `PRESENTON_APP_ROOT`, else `<cwd>/../..` (`servers/nextjs/lib/run-bundled-presentation-export.ts:20-25`) |

In Docker, Next.js runs from `/app/servers/nextjs` (`start.js:554`), so both defaults resolve to `/app/presentation-export` and `/app`, and the Dockerfile also sets them explicitly (`Dockerfile:84-85`). In Electron they are `resources/export` and the resources base directory (`electron/app/main.ts:406-407`). `PRESENTON_APP_ROOT` is also used by `/api/update-svg` to locate the icon directory (Step 12).

### 5.2 The URL the browser will open

```ts title="servers/nextjs/lib/run-bundled-presentation-export.ts (excerpt)"
  const nextjsUrl =
    process.env.NEXT_PUBLIC_URL?.trim() || "http://127.0.0.1";
  const q = new URLSearchParams({ id: presentationId, format });
  const sessionToken = extractSessionTokenFromCookieHeader(cookieHeader);
  if (sessionToken) {
    q.set("exportSession", sessionToken);
  }
  const fastapiUrl = process.env.NEXT_PUBLIC_FAST_API?.trim();
  if (fastapiUrl) {
    q.set("fastapiUrl", fastapiUrl);
  }
  const basePptUrl = `${nextjsUrl}/pdf-maker?${q.toString()}`;
  const pptUrl = cookieHeader?.trim()
    ? `${basePptUrl}#exportCookie=${encodeURIComponent(cookieHeader)}`
    : basePptUrl;
```

So the caller's entire `Cookie` header is copied three ways:

1. `exportSession=<value of presenton_session>` in the query string (`extractSessionTokenFromCookieHeader()` uses the regex `/(?:^|;\s*)presenton_session=([^;]+)/`, `servers/nextjs/lib/run-bundled-presentation-export.ts:27-38`).
2. `#exportCookie=<whole cookie header>` in the URL fragment.
3. `cookieHeader` in the task, which the runner turns into `urlConfigs` cookies for the page origin.

If the incoming request had no cookie, `desktopCookieHeader()` supplies `presenton_desktop_session=<token>` in Electron mode (`servers/nextjs/lib/run-bundled-presentation-export.ts:154`, `servers/nextjs/lib/desktop-auth.ts:7-12`).

!!! warning "Gotcha: the session JWT is in a query string"
    `exportSession` puts the user's 30-day session JWT (`SESSION_TTL_SECONDS`, `servers/fastapi/api/v1/auth/config.py:12`) into the request line of `GET /pdf-maker`. In Docker that request goes through nginx, and `nginx.conf` does not configure `access_log`, so nginx's default access logging applies to it. The fragment (`#exportCookie=...`) is never sent to any server, which is why FastAPI's own logging strips everything after `#` (`servers/fastapi/services/export_task_service.py:430`). Treat access logs on a Presenton host as sensitive.

### 5.3 The task file and the child process

The work directory is `fs.mkdtemp(<TEMP_DIRECTORY or os.tmpdir()/presenton>/export-)` (`servers/nextjs/lib/run-bundled-presentation-export.ts:175-179`), and the task is:

```json
{
  "type": "export",
  "url": "http://127.0.0.1/pdf-maker?id=6f1c...&format=pptx&exportSession=eyJ...#exportCookie=presenton_session%3DeyJ...",
  "format": "pptx",
  "title": "Q3-Review-EMEA-APAC",
  "cookieHeader": "presenton_session=eyJ..."
}
```

(`fastapiUrl` is omitted by `JSON.stringify` when undefined. The token values above are placeholders.) The title is passed through `sanitizeFilename()` (`servers/nextjs/app/(presentation-generator)/utils/others.ts:61-110`), which removes null bytes, `..`, the characters `?<>\:*|"`, control characters, Windows reserved names and trailing dots or spaces. It deliberately keeps forward slashes (it was written for paths), so a client that posts a raw `title` containing `/` passes that slash through to export-core; the editor never does, because `buildSafeExportFileName()` has already replaced it.

The child is `spawn(process.execPath, [entrypoint, exportTaskPath], { cwd: appRoot, stdio: ["ignore", "pipe", "pipe"], env: process.env })` (`servers/nextjs/lib/run-bundled-presentation-export.ts:200-205`), so it runs with the same Node binary as Next.js and inherits Next's entire environment. stdout and stderr go into `BoundedTextBuffer`s that keep only the last 8192 characters (`servers/nextjs/lib/runtime-limits.ts:1-21`). A non-zero exit becomes `Export process exited with code N[ signal S]. <stderr> stdout: <stdout>`.

!!! warning "Gotcha: no timeout on the Next.js path"
    FastAPI kills the export child after 300 seconds (Step 6.5). The Next.js path has no timeout at all: a page that never finishes loading keeps the HTTP request, the Node child and its Chromium alive until export-core gives up on its own (its internal timeouts are not visible here). nginx's `proxy_read_timeout 30m` on `location /` (`nginx.conf:41`) is the outer bound in Docker.

### 5.4 Reading the result

`normalizeExportOutputPath()` (`servers/nextjs/lib/run-bundled-presentation-export.ts:76-123`) accepts, in order: an absolute `path`; a relative `path` (resolved against `APP_DATA_DIRECTORY`, stripping a leading `app_data/`); a `file://` URL (with the Windows `/C:/` prefix fix in `normalizeExportFileUrlPathname()`); or a `/app_data/...` URL. Then `ensureExportFileReadable()` confirms it is a file and runs `chmod 0o755` on its directory and `chmod 0o644` on the file (`servers/nextjs/lib/run-bundled-presentation-export.ts:63-64`, `125-133`). The work directory is removed in `finally`.

!!! warning "Gotcha: two different permission policies"
    The runner's `finalizeExportPermissions()` sets the export to `0o640` and its directory to `0o750` (Step 10.2). Immediately afterwards, the Next.js path widens the file to `0o644` and its directory (the shared `exports/` root, since the move has not happened yet) to `0o755`, both world-readable, and only then does `fs.rename` move the file into `exports/users/<id>/`. The FastAPI path does not widen anything. If you are hardening a multi-user host, this is the place to align the two.

## Step 6: The REST API path in FastAPI

### 6.1 Which endpoints export

| Endpoint | Exports | Code |
|---|---|---|
| `POST /api/v1/ppt/presentation/{id}/export` with body `{"export_as": "pptx"}` | an existing deck, without regenerating | `servers/fastapi/api/v1/ppt/endpoints/presentation.py:1642-1678` |
| `POST /api/v1/ppt/presentation/generate` | the newly generated deck (step 9 of the handler) | `servers/fastapi/api/v1/ppt/endpoints/presentation.py:3098-3104`, `3169-3190` |
| `POST /api/v1/ppt/presentation/generate/async` | same, in a background task; `path` and `edit_path` are stored in the task's `data` | `servers/fastapi/api/v1/ppt/endpoints/presentation.py:3125-3126`, `3240-3271` |
| `POST /api/v1/ppt/presentation/edit` | the edited deck | `servers/fastapi/api/v1/ppt/endpoints/presentation.py:3339-3344` |
| `POST /api/v1/ppt/presentation/derive` | a copied and edited deck | `servers/fastapi/api/v1/ppt/endpoints/presentation.py:3383-3388` |
| v2 smart generation (sync and async) | the smart deck after its SSE stream completes | `servers/fastapi/api/v2/ppt/endpoints/presentation.py:139-149` |

`export_as` defaults to `pptx` everywhere (`servers/fastapi/models/generate_presentation_request.py:41`, `64`, `servers/fastapi/models/presentation_from_template.py:14`, and the `Body(embed=True)` default at `servers/fastapi/api/v1/ppt/endpoints/presentation.py:1646`). The response model is `PresentationPathAndEditPath` (`servers/fastapi/models/presentation_and_path.py:5-11`):

```json
{
  "presentation_id": "6f1c2a0e-3b7d-4c1e-9a55-0b8f4c2d9e11",
  "path": "/app_data/exports/users/2b9e4c3a-.../Q3 Review.pptx",
  "edit_path": "/presentation?id=6f1c2a0e-3b7d-4c1e-9a55-0b8f4c2d9e11"
}
```

`export_existing_presentation` loads the row with `sql_session.get(PresentationModel, id)` and no explicit owner filter; ownership is enforced by the global `do_orm_execute` listener that adds `owner_id == current owner` criteria (`servers/fastapi/services/database.py:67-92`). See [Auth and multi-user](25-auth-and-multiuser.md). The endpoints themselves are cataloged in [REST API, async tasks, webhooks, MCP](15-api-async-mcp.md).

### 6.2 Why the export browser needs a logged-in session

The headless Chromium is a new, empty browser. To render the deck it must (a) load `/pdf-maker`, (b) fetch the presentation JSON from FastAPI, and (c) load every slide image from `/app_data/images/...`. In Docker, (b) is behind the FastAPI auth middleware and (c) is behind nginx `auth_request /_auth_check` (`nginx.conf:133-142`, `159-165`). An API key cannot be used for those browser requests: Next.js's proxy explicitly refuses `Bearer sk-presenton-...` on anything that is not `/api/v1` or `/api/v2` (`servers/nextjs/proxy.ts:146-156`). So FastAPI has to hand the export browser a cookie. `build_export_cookie_header()` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:1473-1496`) decides which one:

```python title="servers/fastapi/api/v1/ppt/endpoints/presentation.py (excerpt)"
def build_export_cookie_header(request: Request) -> Optional[str]:
    from api.v1.auth.desktop import desktop_cookie_header

    desktop_cookie = desktop_cookie_header()
    if desktop_cookie:
        # Header-authenticated renderer/background calls need credentials in
        # the isolated export browser too; account JWT cookies are preserved.
        cookie = (request.headers.get("cookie") or "").strip()
        return f"{cookie}; {desktop_cookie}" if cookie else desktop_cookie
    cookie_header = (request.headers.get("cookie") or "").strip()
    if cookie_header:
        return cookie_header

    internal_session_token = getattr(
        request.state, "internal_session_token", None
    )
    if isinstance(internal_session_token, str) and internal_session_token:
        return f"{SESSION_COOKIE_NAME}={internal_session_token}"

    session_token = request.cookies.get(SESSION_COOKIE_NAME)
    if session_token:
        return f"{SESSION_COOKIE_NAME}={session_token}"

    return None
```

| Situation | Cookie handed to the export browser |
|---|---|
| Electron (`PRESENTON_ELECTRON=true` and a token) | incoming cookies plus `presenton_desktop_session=<token>` (`servers/fastapi/api/v1/auth/desktop.py:18-22`) |
| Browser session (the request already had a `Cookie` header) | that exact header |
| API key request | `presenton_session=<JWT minted by the middleware>`; the auth middleware writes `request.state.internal_session_token` for every `api_key` principal (`servers/fastapi/api/middlewares.py:123-126`) |
| MCP | the MCP server mints a one-hour JWT (`MCP_INTERNAL_SESSION_TTL_SECONDS`, `servers/fastapi/mcp_server.py:35-39`) and forwards it as a `Cookie` (`servers/fastapi/mcp_server.py:393-404`), so the "browser session" row applies |
| Auth disabled, no cookie | `None` (no cookie needed) |

The unit tests in `servers/fastapi/tests/unit/test_export_cookie_header.py:22-50` pin the precedence: the internal token beats a bearer key, a browser cookie beats both, and a desktop-token header produces the desktop cookie.

!!! warning "Gotcha: async exports reuse a cookie captured at request time"
    `/generate/async` captures `build_export_cookie_header(request_http)` when the request arrives and passes it to the background task (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:3264-3271`); export happens only after all slides are generated. The JWT minted for API keys uses the default 30-day lifetime, but a browser session that is logged out (or an MCP token, one hour) in the meantime will make the export browser unauthenticated, and the export fails at the very end of a long, paid generation. `POST /{id}/export` exists precisely to retry that last step (its docstring, `servers/fastapi/api/v1/ppt/endpoints/presentation.py:1649-1663`).

### 6.3 `export_presentation()`

```python title="servers/fastapi/utils/export_utils.py (excerpt)"
def _build_presentation_export_url(
    presentation_id: uuid.UUID, cookie_header: str | None = None
) -> tuple[str, str | None]:
    params = {"id": str(presentation_id)}
    fastapi_url = _get_next_public_fastapi_url()
    if fastapi_url:
        params["fastapiUrl"] = fastapi_url
    export_url = f"{_get_next_public_url().rstrip('/')}/pdf-maker?{urlencode(params)}"
    if cookie_header:
        export_url = f"{export_url}#{urlencode({'exportCookie': cookie_header})}"
    return (
        export_url,
        fastapi_url,
    )
```

Compared with the Next.js path: no `format` and no `exportSession` in the query; the cookie travels only in the fragment and in `cookieHeader`. `_get_next_public_url()` defaults to `http://127.0.0.1` (`servers/fastapi/utils/export_utils.py:18-19`). In the Docker image that is nginx on port 80 inside the container, which proxies `/pdf-maker` to Next.js on port 3000 (`nginx.conf:29-43`).

!!! warning "Gotcha: running FastAPI outside Docker"
    If you run FastAPI and Next.js directly on your machine (see [Running it locally](04-running-locally.md)), nothing listens on `http://127.0.0.1:80`, and every API export fails inside the headless browser. Set `NEXT_PUBLIC_URL` (for example `http://127.0.0.1:3000`) in FastAPI's environment.

The file name is computed as `safe_export_basename(sanitize_filename(name))`, where `name` is the trimmed title or a random UUID (`servers/fastapi/utils/export_utils.py:58-62`). `sanitize_filename` comes from the `pathvalidate` package; `safe_export_basename()` (`servers/fastapi/utils/filename_utils.py:6-18`) keeps names up to 200 UTF-8 bytes unchanged and otherwise truncates to 191 bytes (on a character boundary) plus `_` plus the first 8 hex characters of the MD5 of the full name. The test `servers/fastapi/tests/unit/test_filename_utils.py:22-25` asserts that the result plus `.pptx` fits the 255-byte file name limit. That test only makes sense if export-core uses `title` as the output file's base name, which is the strongest evidence in this repository for how the engine names its output (the engine itself is not available to confirm it).

### 6.4 `ExportTaskService` setup

`EXPORT_TASK_SERVICE = ExportTaskService()` is a module singleton (`servers/fastapi/services/export_task_service.py:863`). Its constructor (`servers/fastapi/services/export_task_service.py:121-126`):

| Attribute | Value |
|---|---|
| `timeout_seconds` | `300` |
| `node_binary` | `LITEPARSE_NODE_BINARY`, else `node` (Electron sets it to its own binary with `ELECTRON_RUN_AS_NODE=1`, `electron/app/main.ts:381-382`) |
| `export_dir` | `EXPORT_PACKAGE_ROOT`, else the first of four candidate `presentation-export` directories that contains `runner.mjs` (`servers/fastapi/services/export_task_service.py:128-147`) |
| `entrypoint_path` | `<export_dir>/runner.mjs` |

Before every task, `_ensure_runtime_ready()` raises `500 Export runtime not found at ...` or `500 Export package not found at .../dist/index.js` (`servers/fastapi/services/export_task_service.py:202-220`).

`_build_node_env()` (`servers/fastapi/services/export_task_service.py:153-200`) copies `os.environ` and then:

1. Requires `APP_DATA_DIRECTORY` (else `500 APP_DATA_DIRECTORY must be set for PPTX-to-HTML export`, a message reused for every task type).
2. Sets `TEMP_DIRECTORY` to `<TEMP_DIRECTORY or tmp/presenton>/<owner_id>` when there is a current owner, creating it.
3. Creates `PUPPETEER_TMP_DIR` (default `<temp>/puppeteer`) and `PUPPETEER_CACHE_DIR` (default `<temp>/puppeteer-cache`). The test at `servers/fastapi/tests/unit/test_runtime_limits.py:62-89` deletes them and checks they are recreated.
4. In Electron, refuses to run without a real file at `PUPPETEER_EXECUTABLE_PATH`:

```python title="servers/fastapi/services/export_task_service.py (excerpt)"
        if env.get("PRESENTON_ELECTRON", "").lower() == "true":
            chromium_executable = (env.get("PUPPETEER_EXECUTABLE_PATH") or "").strip()
            if not chromium_executable or not os.path.isfile(chromium_executable):
                raise HTTPException(
                    status_code=500,
                    detail=(
                        "The pinned Electron Chromium runtime is unavailable. "
                        "Refusing to download or launch a different browser version."
                    ),
                )

        # The export runtime consumes app-data paths relative to the page it is
        # rendering. Docker intentionally leaves NEXT_PUBLIC_FAST_API unset so
        # nginx remains the public origin; Electron supplies its dynamic origin.
        env["ASSETS_BASE_URL"] = "/app_data"
        return env
```

### 6.5 Running the child

`_run_task_locked()` (`servers/fastapi/services/export_task_service.py:299-354`), again with no actual lock:

1. `_create_task_paths()` creates `tempfile.mkdtemp(prefix="export-task-", dir=<temp>/<owner_id>)` and returns `export_task.json` and `export_task.response.json` inside it (`servers/fastapi/services/export_task_service.py:282-294`).
2. Dumps the payload. For an export:

    ```json
    {
      "type": "export",
      "url": "http://127.0.0.1/pdf-maker?id=6f1c...#exportCookie=presenton_session%3DeyJ...",
      "format": "pptx",
      "title": "Q3 Review",
      "fastapiUrl": null,
      "cookieHeader": "presenton_session=eyJ..."
    }
    ```

3. Runs `[node_binary, runner.mjs, task_path]` with `cwd=export_dir` and the built env, through `_run_bounded_child()`.
4. Checks the exit code, then the response file, then parses it, and always removes the temp directory.

`_run_bounded_child()` (`servers/fastapi/services/export_task_service.py:356-420`) uses `asyncio.create_subprocess_exec` (with `CREATE_NO_WINDOW` on Windows, `servers/fastapi/services/export_task_service.py:86-89`), drains stdout and stderr in 64 KiB reads into `BoundedTextBuffer`s that keep the last 8192 characters (`servers/fastapi/utils/runtime_limits.py:39-64`), and wraps everything in `asyncio.wait_for(..., timeout=300)`. On timeout it kills the process.

| Failure | Status and detail |
|---|---|
| Timeout | `500 Export task timed out after 300 seconds` |
| Non-zero exit | `500 Export task failed. returncode=N stderr=<first 600 chars> stdout=<first 600 chars>` (`_snippet`, `servers/fastapi/services/liteparse_service.py:20-31`) |
| No response file | `500 Export task did not produce a response file` |
| Invalid JSON | `500 Export task produced invalid JSON output` |
| `OSError` | `500 Failed to run export task: <error>` |
| No usable path in response | `500 PPTX-to-HTML task completed without a valid output path` |

### 6.6 Trusting, moving and securing the output

`_resolve_output_path()` looks at `path`, then `file_path`, then `url`, and accepts a value only if `_resolve_trusted_runtime_path()` finds an existing file whose real path is inside `APP_DATA_DIRECTORY` or the temp root (`servers/fastapi/services/export_task_service.py:222-266`). A runtime that returned `/etc/passwd` would be rejected.

Then `_move_export_to_owner()` (`servers/fastapi/services/export_task_service.py:772-804`) does what the Next.js route does in Step 4.2: with no current owner it returns the path unchanged; otherwise it requires the source to be inside `exports/` but not in a `users/` subtree (or already in the destination), and `os.replace`s it into `get_exports_directory()`, which is `<APP_DATA_DIRECTORY>/exports/users/<owner_id>` (`servers/fastapi/utils/asset_directory_utils.py:23-30`, `231-232`). The test `servers/fastapi/tests/unit/test_asset_ownership_security.py:326-344` proves another user's file cannot be "stolen" this way.

Finally `_ensure_output_readable()` calls `finalize_export_permissions()` with roots `[APP_DATA_DIRECTORY, temp root]` (`servers/fastapi/services/export_task_service.py:268-280`).

## Step 7: The headless page, `/pdf-maker`

Everything export-core converts comes from this page. It lives in the `(export)` route group, which has no layout of its own, so it gets the root layout and none of the editor chrome.

```mermaid
sequenceDiagram
    participant B as Editor browser
    participant N as Next.js (via nginx in Docker)
    participant R as runner.mjs and export-core
    participant C as Headless Chromium
    participant F as FastAPI
    B->>N: POST /api/export-presentation with id, format, title
    N->>F: GET /api/v1/auth/status with the browser cookie
    F-->>N: authenticated, user_id, role
    N->>R: spawn node runner.mjs export_task.json
    R->>C: launch with cookies scoped to the page origin
    C->>N: GET /pdf-maker?id=...&format=...&exportSession=JWT
    N-->>C: redirect without exportSession, Set-Cookie presenton_session
    C->>N: GET /pdf-maker?id=...&format=... (fragment kept)
    C->>N: GET /api/export-presentation-data/id with x-export-cookie
    N->>F: GET /api/v1/ppt/presentation/id with Cookie
    F-->>N: presentation JSON with ordered slides
    N-->>C: same JSON, Cache-Control no-store
    C->>N: GET app_data images and fonts with the session cookie
    C-->>R: rendered 1280x720 slide DOM
    R-->>N: export_task.response.json with the output path
    N-->>B: success true, path /api/export-presentation/file?name=...
    B->>N: GET /api/export-presentation/file?name=...
    N-->>B: attachment stream
```

### 7.1 The proxy turns `exportSession` into a cookie

`servers/nextjs/proxy.ts` is Next.js's request proxy (middleware). Requests to `/pdf-maker` are always handled by it, even though other pages pass straight through (`servers/nextjs/proxy.ts:103-105`):

```ts title="servers/nextjs/proxy.ts (excerpt)"
  if (pathname === "/pdf-maker") {
    const exportSession = request.nextUrl.searchParams.get("exportSession");
    if (exportSession) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.searchParams.delete("exportSession");

      const response = NextResponse.redirect(redirectUrl);
      response.cookies.set({
        name: SESSION_COOKIE_NAME,
        value: exportSession,
        maxAge: SESSION_TTL_SECONDS,
        httpOnly: true,
        secure:
          request.headers.get("x-forwarded-proto")?.toLowerCase() === "https" ||
          request.nextUrl.protocol === "https:",
        sameSite: "lax",
        path: "/",
      });
      return response;
    }

    return NextResponse.next();
  }
```

The export browser therefore ends up with a normal `presenton_session` cookie on the Next.js origin, and the token disappears from the visible URL. Browsers carry the original fragment across a redirect whose `Location` has none, so `#exportCookie=...` survives. Outside Electron the proxy does not authenticate `/pdf-maker` itself (it returns `NextResponse.next()`); the page is useless without a valid cookie, because the data fetch is what FastAPI authorizes. The root `ConfigurationInitializer` also special-cases the route: no startup splash, no user-config fetch and no LLM provider revalidation for paths starting with `/pdf-maker` (`servers/nextjs/app/ConfigurationInitializer.tsx:56`, `75-83`, `205-209`), so an export never stalls on settings checks. In Electron mode the desktop transport guard runs first (`servers/nextjs/proxy.ts:98-99`), and `servers/nextjs/tests/desktop-security.test.mjs:59-63` checks that `/pdf-maker?exportSession=arbitrary` and `/api/export-presentation-data/id` return 401 without the desktop token.

### 7.2 Reading the id and the cookie

`page.tsx` reads `id` and an optional `exportCookie` query parameter, and shows "No presentation id found" without an id (`servers/nextjs/app/(export)/pdf-maker/page.tsx:7-25`). `PdfMakerPage` then falls back to the fragment:

```tsx title="servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx (excerpt)"
  const exportCookieFromHash =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.hash.replace(/^#/, "")).get(
        "exportCookie"
      ) ?? undefined
      : undefined;
  const effectiveExportCookie = exportCookie ?? exportCookieFromHash;
```

`URLSearchParams` decodes both Python's `quote_plus` style (`+` for spaces) and JavaScript's `encodeURIComponent` style, so both writers in Steps 5.2 and 6.3 round-trip correctly.

### 7.3 Fetching the deck through the data bridge

With a cookie, the page calls its own Next.js route rather than FastAPI directly, using `fetch(..., { cache: "no-store" })` (`servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx:206-222`):

```http
GET /api/export-presentation-data/6f1c2a0e-3b7d-4c1e-9a55-0b8f4c2d9e11
x-export-cookie: presenton_session=eyJ...
```

`servers/nextjs/app/api/export-presentation-data/[id]/route.ts:17-62` returns 401 if `x-export-cookie` is missing, then forwards it as a real `Cookie` header to `<FAST_API_INTERNAL_URL or NEXT_PUBLIC_FAST_API or http://127.0.0.1:8000>/api/v1/ppt/presentation/<id>` and relays FastAPI's status, body and content type with `Cache-Control: no-store`. In Docker, `start.js:485-487` sets `FAST_API_INTERNAL_URL=http://127.0.0.1:8000`. This route is on the proxy's auth-exempt list (`servers/nextjs/proxy.ts:87-95`) because it authenticates with the header instead of the request's own cookies, and FastAPI performs the real check. (The route has its own copy of `getFastApiBaseUrl()`; `servers/nextjs/lib/fastapi-internal.ts` exports an identical function plus `getFastApiAuthHeaders()`, but only `app/api/user-config/route.ts` imports that file, and nothing imports `getFastApiAuthHeaders()`.)

FastAPI's `GET /api/v1/ppt/presentation/{id}` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:1551-1569`) returns the presentation plus slides ordered by `SlideModel.index`. See [Data model](07-data-model.md) for the fields.

Without a cookie (the Electron IPC path, or auth disabled), the page uses `DashboardApi.getPresentation()` with `credentials: "include"` (`servers/nextjs/app/(presentation-generator)/services/api/dashboard.ts:70-82`); in Electron the runner's header rule adds `x-presenton-desktop-token` to those requests.

### 7.4 Preparing the DOM

After the fetch, `fetchUserSlides()` (`servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx:175-204`):

1. Runs `normalizeBackendAssetUrls()` over the whole JSON, rewriting every asset-like string (`/app_data/...`, `/static/...`, local `file:` URLs, absolute URLs pointing at this backend) to the runtime-appropriate form (`servers/nextjs/utils/api.ts:292-343`, `371-416`). In Docker that is a same-origin path served through nginx. With `fastapiUrl` in the query, it becomes an absolute FastAPI URL, but only if that origin equals the configured `NEXT_PUBLIC_FAST_API` origin or the page's own origin (`servers/nextjs/utils/api.ts:56-78`), so a crafted export link cannot redirect credentials elsewhere.
2. Dispatches the data to Redux.
3. Calls `useFontLoader(fonts)`, which fires `ensureTemplateFontLoaded()` for each font without awaiting it (`servers/nextjs/app/(presentation-generator)/hooks/useFontLoad.tsx:7-11`).
4. Applies the presentation theme to `#presentation-slides-wrapper`, ignoring errors so a theme problem cannot block an export (`servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx:186-196`). Themes are covered in [Themes and fonts](19-themes-and-fonts.md).
5. Separately, an effect that runs whenever `presentationData` changes checks whether any slide's `layout` contains `custom` or has non-empty `html_content`, and if so injects the Tailwind browser runtime from `/vendor/tailwindcss-browser-4.3.3.js` scoped to `[data-tailwind-runtime-scope]` (`servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx:160-170`, `servers/nextjs/lib/tailwind-browser.ts:1-49`).

Then it renders this structure (`servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx:257-314`):

```text
div#presentation-slides-wrapper
  div.main-slide#slide-<index>   data-speaker-note="<speaker note>"
    div.slide-export-inner        data-layout="<layout id>"  data-group="<layout group>"
      one of:
        TemplateV2HtmlSlidePreview  (fixedSize)            when the slide has Template v2 ui
        SmartHtmlPdfSlide                                  when the slide has html_content
        SlideScale (PresentationRender.tsx, fixedSize)     otherwise
```

| Renderer | When | What it puts in the DOM |
|---|---|---|
| `TemplateV2HtmlSlidePreview` | `shouldRenderTemplateV2HtmlPreview(slide, version)` is true: the slide has renderable Template v2 `ui` (`servers/nextjs/app/(presentation-generator)/components/TemplateV2HtmlSlidePreview.tsx:205-216`) | the HTML produced by `templateV2UiToHtmlFragment()` at exactly 1280x720; charts are `<canvas data-presenton-chart data-chart-config=...>` drawn by Chart.js (`servers/nextjs/app/(presentation-generator)/components/TemplateV2HtmlSlidePreview.tsx:294-345`) |
| `SmartHtmlPdfSlide` | `slide.html_content` is a non-empty string (smart mode, see [Smart mode](13-smart-mode.md)) | the raw HTML in a 1280x720 box with `data-tailwind-runtime-scope`; its `<script>` blocks are re-run against a scoped `document` by `useSmartChartInjection()` (`servers/nextjs/app/(presentation-generator)/components/useSmartChartInjection.ts:41-101`) |
| `SlideScale` | everything else (classic layouts) | `V1ContentRender` inside a 1280x720 box at `scale(1)`, because `fixedSize` forces `scale = 1` (`servers/nextjs/app/(presentation-generator)/components/PresentationRender.tsx:55-56`, `88-120`) |

Besides the slide index in `id`, the layout id and the layout group, `data-speaker-note` is the only per-slide metadata the page exposes to the exporter; whether export-core writes it into PPTX speaker notes is not verifiable here.

Charts deserve a note. Template v2 charts update a global readiness object, `window.__PRESENTON_JSON_CHARTS__ = { status, pending, rendered, message? }`, setting `status` to `pending` while canvases draw and `ready` (or `error`) afterwards (`servers/nextjs/app/(presentation-generator)/components/TemplateV2HtmlSlidePreview.tsx:16-73`), and mark each element with `data-presenton-charts` (`servers/nextjs/app/(presentation-generator)/components/TemplateV2HtmlSlidePreview.tsx:280-306`). Rendered canvases get `data-presenton-chart-rendered="true"` in both chart paths (`servers/nextjs/app/(presentation-generator)/components/TemplateV2HtmlSlidePreview.tsx:334`, `servers/nextjs/app/(presentation-generator)/components/useSmartChartInjection.ts:109`). The chart script embedded in standalone Template v2 HTML documents initializes the same global (`servers/nextjs/lib/template-v2-json-to-html.ts:3174-3178`). Nothing in this repository reads `__PRESENTON_JSON_CHARTS__`, so it is presumably polled by export-core before capture; that is an inference, not something the code here proves.

### 7.5 The print stylesheet

`PDF_PRINT_STYLE` (`servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx:26-100`) pins the geometry:

```css title="servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx (excerpt)"
  #presentation-slides-wrapper {
    width: 100% !important;
    display: flex !important;
    flex-direction: column !important;
    /*
     * export-core measures PPTX elements in a 3000px-wide viewport. Keep the
     * 1280px slide canvas at x=0 so its clipping rectangle and child element
     * coordinates share the same origin.
     */
    align-items: flex-start !important;
    gap: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
  }

  #presentation-slides-wrapper .main-slide {
    width: 1280px !important;
    min-width: 1280px !important;
    max-width: 1280px !important;
    height: 720px !important;
    min-height: 720px !important;
    max-height: 720px !important;
    flex: 0 0 720px !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
  }
```

and, for printing:

```css title="servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx (excerpt)"
  @media print {
    @page {
      size: 1280px 720px;
      margin: 0;
    }

    #presentation-slides-wrapper {
      overflow: visible !important;
    }

    #presentation-slides-wrapper .main-slide {
      break-after: page;
      page-break-after: always;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    #presentation-slides-wrapper .main-slide:last-child {
      break-after: auto;
      page-break-after: auto;
    }
  }
```

Slides stack vertically with no gap, each exactly 1280x720 CSS pixels, each one printed page. The test `servers/nextjs/tests/pdf-maker-export-layout.test.mjs:10-19` reads the source and fails if `align-items: flex-start !important` disappears, if the wrapper loses the `items-start` class, or if `align-items: center !important` appears.

!!! warning "Gotcha: centering a slide breaks PPTX geometry"
    The comment above is the only description in the repository of export-core's measurement: it uses a 3000px-wide viewport. If you center the 1280px slide (the natural thing to do for a pretty preview), every element's x coordinate shifts by 860px relative to the clipping rectangle and shapes land in the wrong place. Never restyle `#presentation-slides-wrapper` without running that test.

!!! warning "Gotcha: nothing on the page waits for fonts"
    Fonts are loaded fire-and-forget (`void ensureTemplateFontLoaded(font)`), images are ordinary `<img>`/CSS loads, and the page sets no "ready" flag of its own (only the Template v2 chart flag above). The skeleton placeholders shown while loading are also 1280x720 (`servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx:261-271`), and because `isLoading` is `contentLoading || slides.length === 0` (`servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx:224-225`), a deck with zero slides keeps showing two gray skeletons forever instead of `.main-slide` elements. Any waiting for network idle, `document.fonts.ready` or chart completion must therefore be done by export-core, and its exact policy cannot be verified from this repository. If you add a slide element that loads asynchronously, assume the exporter may capture it before it is ready unless you can confirm otherwise.

## Step 8: Inside export-core (what can and cannot be known)

The engine is a closed box from this repository's point of view. The install script calls it the "open-source release" (`scripts/sync-presentation-export.cjs:1-3`) and the archive name contains `opensource`, but its source is in a different repository (`presenton/presenton-export`) and no copy exists in this checkout, so nothing below about its internals is verified.

### 8.1 The interface, precisely

```js
import { runTask } from "@presenton/export-core";
// response: string | { type: "files", filePaths: string[], ... } | { filePath: string, ... }
const response = await runTask(task, options);
```

- `task`: the task object from Step 2.2 (minus `fastapiUrl`, `cookieHeader`, `slide_concurrency`, plus `__taskFilePath`).
- `options`: `{ outputDirectory?, tempDirectory?, browserLaunchOptions?: { executablePath }, puppeteerCacheDirectory?, urlConfigs?: Array<{ url, match: "origin", cookies?: Record<string,string>, headers?: Record<string,string> }>, modifyWindow?: Function }`.
- The package entry is `node_modules/@presenton/export-core/dist/index.js` (checked by `servers/fastapi/services/export_task_service.py:208-220`, `servers/nextjs/lib/run-bundled-presentation-export.ts:50-52`, `Dockerfile:139-140`).
- Its dependencies include Sharp (with platform native binaries) and KaTeX (`scripts/sync-presentation-export.cjs:136-148`, `308`).
- For an `export` task, it writes into `outputDirectory` a file named from `title` (Step 6.3) and returns its `filePath`.

### 8.2 Facts the callers reveal

| Fact | Source |
|---|---|
| PPTX export measures elements in a 3000px-wide viewport | comment, `servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx:46-50` |
| PPTX-to-JSON coordinates are normalized to a 1280px-wide canvas | comment, `servers/fastapi/templates/fonts_and_slides_preview.py:175-178` |
| PPTX-to-HTML writes asset references relative to its `presentation.json` (for example `images/slide.png`) | comment, `servers/fastapi/services/export_task_service.py:477-480` |
| `html-to-images` may be missing in older runtimes; callers fall back to one `html-to-image` task per document on "Invalid task type" or any 500 | `servers/fastapi/services/export_task_service.py:653-670` |
| Template v2 JSON produced by FastAPI and export-core is "the canonical Template V2 JSON model" (text runs, tables with column/row runs, charts with `chart_type`, `categories`, `series`, `data_labels`, infographics) | `servers/nextjs/tests/template-v2-canonical-model-compatibility.ts:3-5`, `servers/nextjs/tests/template-v2-renderer-fields.test.mjs:172-200` |
| Presenton's own code assumes 9525 EMU per pixel when reading PPTX slide sizes | `servers/fastapi/templates/fonts_and_slides_preview.py:141-143`, `183-197` |

### 8.3 What is not verifiable

A natural question is how each kind of DOM element becomes a PowerPoint shape. Without the engine's source or `dist`, none of these can be answered from this repository:

| Question | Status |
|---|---|
| How text runs, font families, weights, sizes and colors become `a:r`/`a:rPr` runs | not verifiable |
| Whether images are embedded at source resolution or re-encoded (Sharp is present, which suggests image processing) | not verifiable |
| Whether rectangles, borders and rounded corners become native preset shapes | not verifiable |
| Whether HTML tables become native PowerPoint tables | not verifiable |
| Whether Chart.js canvases become native charts or pictures | not verifiable; the DOM only contains a `<canvas>` plus its JSON config in `data-chart-config` for Template v2 slides |
| How SVG icons (including `/api/update-svg` URLs) are embedded | not verifiable |
| How backgrounds and z-order are mapped | not verifiable |
| How KaTeX math is converted | not verifiable (KaTeX is a dependency) |
| PDF: whether it uses Chromium printing with the page's `@page` size, and what it waits for before printing | not verifiable |

For orientation only: OOXML uses 914,400 EMU per inch, so at 96 CSS pixels per inch one pixel is 9,525 EMU, and a 1280x720 px slide would be 12,192,000 x 6,858,000 EMU (13.333 x 7.5 inches, PowerPoint's standard 16:9 size). That is arithmetic, not a statement about what export-core writes.

## Step 9: PDF specifics

A PDF export takes the same path as PPTX; only `format` differs. What the page guarantees for PDF:

- Page box: `@page { size: 1280px 720px; margin: 0; }`, which is 13.333 x 7.5 inches.
- One slide per page: `break-after: page` on every `.main-slide` except the last, and `break-inside: avoid`.
- No margins or gaps anywhere (`html, body` margins and the wrapper's padding are forced to 0, `servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx:27-40`).
- `overflow: hidden` on each slide clips content that overflows the 1280x720 box.

Whether export-core honors these print rules (for example by printing with the page's CSS page size) or uses its own page size, viewport and waiting strategy for PDF cannot be confirmed here. The file route serves it as `application/pdf` (`servers/nextjs/app/api/export-presentation/file/route.ts:8-12`).

## Step 10: Output location, permissions and download

### 10.1 Where files live

| Stage | Path |
|---|---|
| export-core output (runner `outputDirectory`) | `<APP_DATA_DIRECTORY>/exports/<title>.<ext>` |
| After owner scoping (FastAPI or Next.js) | `<APP_DATA_DIRECTORY>/exports/users/<owner uuid>/<title>.<ext>` |
| Auth disabled (no owner) | stays at `<APP_DATA_DIRECTORY>/exports/<title>.<ext>` |
| Electron | moved to the OS Downloads folder (Step 11) |
| Task scratch files | `<TEMP_DIRECTORY>[/<owner>]/export-task-XXXX/` (FastAPI) or `<TEMP_DIRECTORY>/export-XXXX/` (Next.js), deleted afterwards |

In Docker, `APP_DATA_DIRECTORY=/app_data` (`Dockerfile:82`), and the image pre-creates `/app_data/exports` among other roots (`Dockerfile:123-124`).

!!! warning "Gotcha: same title, same file"
    Because the base name comes from the title, two exports with the same title target the same path in `exports/` before they are moved. Whether export-core makes names unique is not visible here. If it does not, two users exporting "Quarterly Review" at the same moment could race, and a second export by the same user replaces the first file in `exports/users/<id>/` (`os.replace` and `fs.rename` both overwrite an existing destination).

### 10.2 Permissions

The same algorithm exists in Python (`servers/fastapi/utils/export_permissions.py:1-86`, used by FastAPI) and JavaScript (`scripts/export-permissions.cjs:1-66`, used by the runner). The goal, in the docstring's words, is to grant the app and proxy group access without granting other OS users access.

| Constant or rule | Value |
|---|---|
| Directory mode | `0o750`, keeping any existing setgid/sticky bits (`stat.st_mode & 0o3000`) |
| File mode | `0o640` |
| Group (`export_reader_gid()`) | when running as root: the `www-data` group, else `nginx`; otherwise the process's own group (`servers/fastapi/utils/export_permissions.py:9-20`, `scripts/export-permissions.cjs:4-16`) |
| Symlinks | never followed or changed |
| Boundary | walks up from the file's directory, fixing each ancestor, and stops at the longest configured root that contains it; raises `Export artifact is outside managed storage` if no configured root contains it (`servers/fastapi/utils/export_permissions.py:47-76`) |
| Ancestors (every directory from the output's directory up to the boundary) | processed in "legacy" mode: regrouped to the reader group, mode reduced to `stat.st_mode & 0o7770` (existing bits kept, "other" bits removed), and `EACCES`/`EPERM` ignored (`servers/fastapi/utils/export_permissions.py:23-44`) |
| The output's own directory and file | strict: directory `0o750`, file `0o640`; errors are raised, except that a directory owned by another user (when not running as root) is downgraded to legacy handling (`servers/fastapi/utils/export_permissions.py:28-33`) |

```python title="servers/fastapi/utils/export_permissions.py (excerpt)"
    gid = export_reader_gid()
    current = directory
    while True:
        _permissions(current, True, gid, legacy=True)
        if current == boundary:
            break
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    if recursive:
        for parent, dirs, files in os.walk(directory, followlinks=False):
            dirs[:] = [name for name in dirs if not os.path.islink(os.path.join(parent, name))]
            _permissions(parent, True, gid)
            for name in files:
                _permissions(os.path.join(parent, name), False, gid)
    else:
        _permissions(directory, True, gid)
        if os.path.isfile(resolved):
            _permissions(resolved, False, gid)
```

In the Docker image, the processes run as root (there is no `USER` instruction) and nginx runs as `www-data` (`nginx.conf:1`), so exports end up `root:www-data 0640`: nginx can read and serve them, other users cannot. The tests `scripts/export-permissions.test.mjs:19-60` and `servers/fastapi/tests/unit/test_export_permissions.py:17-110` cover modes, group ownership, private (`0o700`) and group-writable (`0o2770`) roots being preserved, symlink non-following, and the outside-storage error.

### 10.3 Download from the editor: `/api/export-presentation/file`

`GET /api/export-presentation/file?name=<relative path>` (`servers/nextjs/app/api/export-presentation/file/route.ts:58-107`) first requires an authenticated session (401 otherwise), then validates `name` with `getSafeExportName()`:

```ts title="servers/nextjs/app/api/export-presentation/file/route.ts (excerpt)"
  const decodedName = request.nextUrl.searchParams.get("name");

  if (
    !decodedName ||
    decodedName.includes("\\") ||
    path.isAbsolute(decodedName)
  ) {
    return null;
  }

  const normalized = path.normalize(decodedName);
  if (
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    return null;
  }
  if (!userId) return normalized;

  const parts = normalized.split(path.sep);
  if (parts[0] === "users") {
    return parts.length >= 3 && parts[1] === userId ? normalized : null;
  }
  return isAdmin && parts.length === 1 ? normalized : null;
```

So a user can only fetch `users/<own id>/<file>`; legacy files directly in `exports/` are admin-only; with auth disabled any relative name is allowed. Rejections return `400 {"error":"Invalid export file name"}`. After that the route:

1. Resolves real paths of `exports/` and the file and returns `403 Access denied` if the file escapes (for example through a symlink).
2. Streams the file with `Content-Type` from a three-entry table (`.pdf`, `.pptx` as `application/vnd.openxmlformats-officedocument.presentationml.presentation`, `.zip`; anything else `application/octet-stream`), `Content-Length`, `Cache-Control: no-store`, and `Content-Disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<encoded name>`, where the fallback replaces every character outside `[a-zA-Z0-9._-]` with `_` (`servers/nextjs/app/api/export-presentation/file/route.ts:53-56`).
3. Maps `ENOENT` to `404 {"error":"Export file not found"}` and any other error to `500 {"error":"Failed to download export file"}`.

### 10.4 Download for API clients

The FastAPI response's `path` is an absolute filesystem path, for example `/app_data/exports/users/<id>/Q3 Review.pptx`. That works as a URL only because the Docker image sets `APP_DATA_DIRECTORY=/app_data`, so the filesystem path and the URL path are identical, and nginx serves that prefix:

```nginx title="nginx.conf (excerpt)"
    location /app_data/exports/ {
      auth_request /_auth_check;
      alias /app_data/exports/;
      disable_symlinks on;
      expires 1y;
      add_header Cache-Control "private, max-age=31536000";
    }
```

`/_auth_check` is an internal subrequest to FastAPI `GET /api/v1/auth/verify` that forwards `Cookie`, `Authorization` and `X-Original-URI` (`nginx.conf:133-142`). `verify_session()` (`servers/fastapi/api/v1/auth/router.py:81-107`) resolves the principal (session cookie or API key) and then checks `is_app_data_path_authorized(X-Original-URI)`, which for the private roots (`images`, `exports`, `uploads`, `pptx-to-html`, `pptx-to-json`) allows only `users/<own id>/...`, or legacy root files for admins (`servers/fastapi/api/v1/auth/assets.py:10-17`, `106-123`). An API client can therefore download its file with:

```bash
curl -H "Authorization: Bearer sk-presenton-YOUR_KEY" \
  -o deck.pptx "http://localhost:5001/app_data/exports/users/<id>/Q3%20Review.pptx"
```

Outside nginx (Electron, or local development through the Next.js proxy's rewrite of `/app_data/*` to FastAPI, `servers/nextjs/proxy.ts:107-112`), FastAPI serves the same prefix through `_OwnerScopedStaticFiles` mounts that apply the same namespace rule to the exact file being served (`servers/fastapi/api/v1/auth/assets.py:20-44`).

For MCP requests only (marked with `X-Presenton-MCP-Request: 1`, `servers/fastapi/mcp_server.py:380`), `absolute_mcp_result_links()` prefixes `path`, `edit_path` and `preview_url` with `PRESENTON_PUBLIC_URL` when it is an `http(s)` URL, else with the forwarded scheme and host (`servers/fastapi/utils/mcp_public_urls.py:9-52`, `servers/fastapi/utils/get_env.py:17-21`). This is applied by `/generate` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:3185-3190`), the status endpoints (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:3297`, `servers/fastapi/api/v1/async_tasks/router.py:83`) and v2 smart generation, but not by `POST /{id}/export`, which always returns the bare path.

!!! warning "Gotcha: the README's example path is out of date"
    The README shows `"path": "/app_data/<presentation id>/Introduction_to_Machine_Learning.pptx"` (`README.md:937-943`). The code in this snapshot produces `/app_data/exports/users/<owner id>/<title>.pptx` (or `/app_data/exports/<title>.pptx` with auth disabled). Build download URLs from the actual response, not from the README.

## Step 11: Electron differences

The desktop app does not use the Next.js export route at all. The renderer calls `window.electron.exportPresentation(id, title, format)`, which the preload maps to `ipcRenderer.invoke("export-presentation", id, title, format)` (`electron/app/preloads/index.ts:11-12`). The handler (`electron/app/ipc/export_handlers.ts:57-176`):

1. Removes broken Chromium caches and returns `{ success: false, message }` if no export browser is installed (`electron/app/ipc/export_handlers.ts:60-69`).
2. Builds `NEXT_PUBLIC_URL/pdf-maker?id=...[&fastapiUrl=...]`, with no fragment and no `exportSession`:

    ```ts title="electron/app/ipc/export_handlers.ts (excerpt)"
          const params = new URLSearchParams({ id });
          if (process.env.NEXT_PUBLIC_FAST_API) {
            params.set("fastapiUrl", process.env.NEXT_PUBLIC_FAST_API);
          }
          const pptUrl = `${process.env.NEXT_PUBLIC_URL}/pdf-maker?${params.toString()}`;

          const exportTask = {
            type: "export",
            url: pptUrl,
            format: exportAs,
            title: title,
            fastapiUrl: process.env.NEXT_PUBLIC_FAST_API,
            cookieHeader: desktopCookieHeader(),
          };
    ```

3. Writes the task with `{ flag: "wx", mode: 0o600 }` (`electron/app/ipc/export_handlers.ts:97`), stricter than the other two callers.
4. Uses `resources/export/runner.mjs`, or on a Microsoft Store (MSIX) install a fingerprinted copy in the user cache, because native addons cannot load from `WindowsApps` (`electron/app/utils/export-msix-runtime.ts:13-19`, `67-91`).
5. Resolves a launchable Chromium (`resolveLaunchableExportChromiumPath()`, `electron/app/utils/export-chromium.ts:424-444`) and fails with a Store-specific message if there is none.
6. Runs the child with `TEMP_DIRECTORY`, `APP_DATA_DIRECTORY`, `NODE_ENV: "development"`, `PUPPETEER_EXECUTABLE_PATH`, `PUPPETEER_CACHE_DIR` and `PUPPETEER_TMP_DIR` (`electron/app/ipc/export_handlers.ts:129-137`). It tries runtimes in order: `EXPORT_NODE_BINARY`, `NODE_BINARY`, `node`, `node.exe`/`node.cmd` or `/usr/bin/node` and `/usr/local/bin/node`, then Electron itself with `ELECTRON_RUN_AS_NODE=1`, moving on only for `ENOENT`, `EACCES`, `EPERM` or `EAGAIN` (`electron/app/ipc/export_handlers.ts:179-272`). If export-core reports a Puppeteer browser folder whose executable is missing under `.cache/puppeteer/chrome/`, it deletes that folder and retries once (`electron/app/ipc/export_handlers.ts:303-326`). A missing response file after a clean exit is retried once (`electron/app/ipc/export_handlers.ts:274-301`).
7. Moves the output to the OS Downloads directory (falling back to `<userData>/exports`, `electron/app/utils/constants.ts:198-222`), copying across devices on `EXDEV`, and shows an "Open File / Open Folder / Cancel" dialog (`electron/app/ipc/export_handlers.ts:152-154`, `473-483`, `electron/app/utils/dialog.ts:10`).

Authentication is different too. The desktop cookie `presenton_desktop_session=<token>` is passed as `cookieHeader`, but the runner deletes it from `cookies` and instead adds an `x-presenton-desktop-token` header rule for each origin in `PRESENTON_DESKTOP_ORIGINS` (both the Next.js and FastAPI loopback ports). The reason is in the runner's comment: browser cookies cannot be scoped to a port. `scripts/desktop-export.test.mjs:30-58` asserts that the task given to export-core has no `cookieHeader`, that `urlConfigs` contains exactly the two header rules, and that no rule carries cookies, even when the task URL is an external site.

The pinned browser is Chrome for Testing `149.0.7827.196` on Windows and Linux and Chromium builds `1625085` (arm64) and `1625072` (x64) on macOS (`electron/package.json:6-10`), downloaded at build time by `electron/scripts/prepare-export-chromium.cjs` into `electron/resources/chromium/` with a `presenton-runtime.json` manifest (`electron/scripts/prepare-export-chromium.cjs:224-241`). The build script validates the bundle (Windows file layout, `codesign --verify --deep --strict` on macOS, `--version` on Linux, a headless `--dump-dom about:blank` probe elsewhere, `electron/scripts/prepare-export-chromium.cjs:143-222`) and can be skipped with `SKIP_BUNDLED_CHROMIUM=1`. Docker instead pins the Debian package `chromium=149.0.7827.196-1~deb13u1` from a dated snapshot, holds it with `apt-mark hold`, and points `PUPPETEER_EXECUTABLE_PATH` at `/usr/bin/chromium` (`Dockerfile:78-79`, `92`, `94-112`). In Electron, FastAPI's guard (Step 6.4) additionally refuses to export at all if the pinned binary is missing, rather than letting a different browser be downloaded or launched. More in [Electron desktop app](27-electron.md).

### 11.1 The three callers side by side

Everything in Steps 4 to 11 condensed into one table, so you can see where the three task builders diverge:

| Aspect | Next.js route | FastAPI `ExportTaskService` | Electron IPC |
|---|---|---|---|
| Builder | `servers/nextjs/lib/run-bundled-presentation-export.ts:147-272` | `servers/fastapi/services/export_task_service.py:422-455` | `electron/app/ipc/export_handlers.ts:57-176` |
| Page URL base | `NEXT_PUBLIC_URL`, else `http://127.0.0.1` | `NEXT_PUBLIC_URL`, else `http://127.0.0.1` | `NEXT_PUBLIC_URL` (always set by Electron) |
| Query parameters | `id`, `format`, `exportSession`, optional `fastapiUrl` | `id`, optional `fastapiUrl` | `id`, optional `fastapiUrl` |
| Fragment | `#exportCookie=<cookie header>` when a cookie exists | `#exportCookie=<cookie header>` when a cookie exists | none |
| `cookieHeader` in the task | the browser's `Cookie`, else the desktop cookie | from `build_export_cookie_header()` | the desktop cookie |
| Node binary | `process.execPath` (Next's own Node) | `LITEPARSE_NODE_BINARY`, else `node` | `EXPORT_NODE_BINARY`, `NODE_BINARY`, `node`, ..., then Electron as Node |
| Child `cwd` | `getPresentonAppRoot()` (`PRESENTON_APP_ROOT`, else `<cwd>/../..`) | `export_dir` (`EXPORT_PACKAGE_ROOT`, else a discovered `presentation-export/`) | the runner's directory (`electron/app/ipc/export_handlers.ts:341`) |
| Timeout | none | 300 seconds, then kill | none |
| Task scratch dir | `<TEMP_DIRECTORY>/export-XXXX` | `<TEMP_DIRECTORY>/<owner>/export-task-XXXX` | `<tempDir>/export-XXXX`, task file `0600` |
| Output check | `normalizeExportOutputPath()` accepts any absolute path (and chmods it), then the owner move rejects anything outside `exports/` | `_resolve_trusted_runtime_path()`, must be inside app data or temp | `resolveExportedFilePath()`, any absolute path accepted |
| Permissions after the runner | widened to `0644`/`0755` | runner's `0640`/`0750` kept and re-applied | not changed |
| Final location | `exports/users/<owner>/` | `exports/users/<owner>/` | OS Downloads folder |
| What the caller gets | `{"success": true, "path": "/api/export-presentation/file?name=..."}` | `PresentationPathAndEditPath` with a filesystem `path` | `{ success, message }` and a native dialog |

## Step 12: SVG recoloring with `/api/update-svg`

Icons in slides are usually SVG files under `/static/icons/`. To color them to match a theme, the editor and the renderers wrap the URL with `buildSvgUpdateUrl()` (`servers/nextjs/lib/svg-color.ts:416-483`), producing for example:

```text
/api/update-svg?url=%2Fstatic%2Ficons%2Fbold%2Fchart-bar-bold.svg&color=%232563EB
```

Callers include the slide editor surface (`servers/nextjs/components/slide-editor/surface/nodes.tsx:2683`, `6400`), infographics (`servers/nextjs/components/slide-editor/infographics/InfographicEditorContent.tsx:2172`), smart slide icons (`servers/nextjs/lib/smart-slide-icons.ts:31`) and the Template v2 HTML renderer (`servers/nextjs/lib/template-v2-json-to-html.ts:2200`), which is the one the pdf-maker uses for v2 slides. Nested wrapper URLs are unwrapped up to five levels and their parameters merged (`servers/nextjs/lib/svg-color.ts:353-384`).

The route (`servers/nextjs/app/api/update-svg/route.ts:168-242`):

1. Normalizes the query parameters `color`, `stroke`, `fill`, `strokeWidth`/`stroke-width`, `opacity`, `strokeOpacity`, `fillOpacity`, `strokeLinecap`, `strokeLinejoin`; invalid values become null (`servers/nextjs/lib/svg-color.ts:289-351`).
2. Accepts only sources whose path starts with `/static/icons/` and ends in `.svg`, resolved against the real icons directory (found through `PRESENTON_APP_ROOT` or the working directory, `servers/nextjs/app/api/update-svg/route.ts:29-72`). Anything else is `400 Only /static/icons SVG sources are supported`.
3. Opens the file with `O_NOFOLLOW`, checks it is a regular file of at most 5 MiB (`MAX_SVG_SIZE_BYTES`, `servers/nextjs/app/api/update-svg/route.ts:16`) and reads from the same handle, so swapping the path for a symlink after validation cannot change what is read (`servers/nextjs/app/api/update-svg/route.ts:120-165`).
4. Rewrites paint attributes with `transformSvgMarkup()` (`servers/nextjs/lib/svg-color.ts:485-576`): `color` sets the root `color`, `stroke` and `fill`; `fill` and `stroke` override individually; opacities, widths and line caps are replaced or inserted.
5. Returns `image/svg+xml; charset=utf-8` with `Cache-Control: no-store`.

The route is on the proxy's auth-exempt list as a "public image transform used as a browser/Konva image source" (`servers/nextjs/proxy.ts:91-92`), which also means the export browser can load it without cookies. The security tests (`servers/nextjs/tests/svg-route-security.test.mjs:43-120`) cover markup injection through paint values, XML escaping, bounded scanning of unterminated comments and CDATA, path traversal, symlinks, directories, oversized files and the time-of-check race. How export-core turns the resulting SVG into a PowerPoint picture or shape is not verifiable (Step 8.3). Icon search itself is covered in [Images, icons, web search](12-images-icons-search.md).

## Step 13: Other runtime tasks and neighboring routes

**Template tooling uses the same runtime.** `convert_pptx_to_json()` turns an uploaded PPTX into raw layouts (`servers/fastapi/api/v1/ppt/endpoints/template.py:962`), `render_pptx_slides_to_images()` renders preview images for them by calling `EXPORT_TASK_SERVICE.render_jsons_to_images()` (`servers/fastapi/templates/fonts_and_slides_preview.py:775`, `826`), and the Template v2 LLM preview tool calls `render_json_to_image()` at 1280x720 (`servers/fastapi/templates/v2/tools.py:16-17`, `49-64`). Before sending JSON, `_localize_json_image_assets()` replaces the `data` of every `{"type": "image"}` node whose source is an `/app_data/...` or `/static/...` path (or an `http(s)` URL with such a path) and resolves through `resolve_app_path_to_filesystem()` with a base64 `data:` URI, so the headless renderer needs no cookies for them (`servers/fastapi/services/export_task_service.py:33-83`). Conversion outputs are moved to `pptx-to-html/users/<owner>/<session>` or `pptx-to-json/users/<owner>/<session>` and their URLs rewritten (`servers/fastapi/services/export_task_service.py:806-861`). The whole flow is described in [Custom templates from PPTX](18-custom-templates.md).

**Thumbnails.** There is no thumbnail generation in the export pipeline, and export-core is never asked for one. The only "thumbnail" in the backend is an optional URL string for templates: taken from the first entry of `slide_image_urls` when a template is created (`servers/fastapi/api/v1/ppt/endpoints/template.py:444-448`), read back from the template's `assets` (`servers/fastapi/api/v1/ppt/endpoints/template.py:898-906`), and settable on update (`servers/fastapi/api/v1/ppt/endpoints/template.py:2055-2061`). On the frontend, the custom-template page's `ThumbnailStrip` just displays preview URLs, and the presentation-mode sidebar thumbnails are live slide renders scaled down to 252px wide with a CSS transform (`servers/nextjs/app/(presentation-generator)/presentation/components/PresentationMode.tsx:29-31`, `133-175`), not images.

**python-pptx.** It is imported only in `servers/fastapi/templates/pptx_font_utils.py:14` (font discovery and font replacement in uploaded PPTX files, for example `servers/fastapi/templates/pptx_font_utils.py:1093-1100`). Slide size for previews is read straight from `ppt/presentation.xml` with `zipfile` (`servers/fastapi/templates/fonts_and_slides_preview.py:183-197`). Neither participates in producing exported decks.

**`/api/read-file`** (`servers/nextjs/app/api/read-file/route.ts:8-34`) reads decomposed document text for the outline flow, and `resolveReadableLocalFile()` only permits `.txt` files inside per-user asset or temp roots (`servers/nextjs/lib/readable-local-file.ts:101-133`). Its comment explains the export connection: "Export task JSON can contain session credentials." The test `servers/nextjs/tests/desktop-security.test.mjs:167-188` writes an `export_task.json` containing a desktop cookie and checks that both the file and a `.txt` symlink to it are denied.

**`/api/upload-image`** (`servers/nextjs/app/api/upload-image/route.ts:10-81`) saves editor uploads (max 20 MiB) as `<APP_DATA_DIRECTORY>/uploads/users/<id>/<32 hex>.png` and returns the absolute file path, which `normalizeBackendAssetUrls()` later maps to `/app_data/uploads/...` so the export browser can load it with the session cookie.

## Step 14: Tests and CI

| Test | What it pins |
|---|---|
| `scripts/sync-presentation-export.test.mjs` | npm cache path never in shell args (Linux, Windows npm-cli, Windows cmd); glibc vs musl detection; Sharp native package checks; runner refresh on reuse; KaTeX and Sharp security floors including nested copies |
| `scripts/desktop-export.test.mjs` | `runNodeScript()` preserves literal paths and args with shell metacharacters (`scripts/run-node-script.mjs:3-17`); desktop credentials become origin-scoped headers, never cookies |
| `scripts/export-permissions.test.mjs` | 0750/0640 modes and group, preserved private and setgid roots, no symlink following, outside-storage error |
| `servers/nextjs/tests/pdf-maker-export-layout.test.mjs` | slides stay at the viewport origin (`flex-start`, `items-start`, no `center`) |
| `servers/nextjs/tests/desktop-security.test.mjs` | Electron rejects anonymous `/pdf-maker?exportSession=...` and `/api/export-presentation-data/...`; readers refuse export task JSON |
| `servers/nextjs/tests/svg-route-security.test.mjs` | `/api/update-svg` hardening |
| `servers/fastapi/tests/unit/test_export_cookie_header.py` | cookie precedence for the export browser |
| `servers/fastapi/tests/unit/test_runtime_limits.py:41-421` | bounded child output, Puppeteer dirs recreated, Electron Chromium guard, `file_path` key accepted, task payload shapes, `html-to-images` fallbacks, runner entrypoint |
| `servers/fastapi/tests/unit/test_export_permissions.py`, `servers/fastapi/tests/unit/test_filename_utils.py`, `servers/fastapi/tests/unit/test_asset_ownership_security.py:326-344` | Python permissions, 200-byte names, no cross-user moves |

The root `npm test` script runs the repository tool tests (`package.json:8`). Two workflows run them:

- `.github/workflows/export-runtime-regressions.yml:1-39` triggers on pushes to `main` (and a security branch) and pull requests to `main` that touch `scripts/**`, `package.json`, `package-lock.json` or the workflow itself, plus manual dispatch. It runs on a matrix of `ubuntu-latest` and `windows-latest` with Node 22: `npm ci --ignore-scripts --no-audit --no-fund` then `npm test`, with a 15-minute timeout. This is why so many tests above care about Windows shells.
- `.github/workflows/test-all.yml:14-38` additionally runs `npm run sync:presentation-export` and `npm run check:presentation-export` on Ubuntu with Node 20, which is the only place CI actually downloads export-core.

No test in this repository performs a real end-to-end export (Chromium plus export-core producing a PPTX); they test the seams around it. The broader CI picture is in [CI, tests, security](28-ci-tests-security.md).

## What you now know

- Exports are produced by a closed, separately released engine, `@presenton/export-core` v1.0.51, installed by `scripts/sync-presentation-export.cjs` from GitHub releases with version and dependency checks but no checksum, and driven by Presenton's own `runner.mjs` through a JSON task file and a `.response.json` file.
- Three callers (Next.js route, FastAPI `ExportTaskService`, Electron IPC) build the task; they differ in URL parameters, timeouts (none, 300 s, none), permission handling and how they pass credentials.
- The engine renders `/pdf-maker`, a page that fetches the deck through `/api/export-presentation-data/[id]` with the caller's cookie and lays out 1280x720 slides at the viewport origin, with print rules for one slide per PDF page.
- The export browser must be authenticated because slide data and images are protected; FastAPI converts API keys and MCP tokens into short-lived or session JWT cookies, and Electron uses origin-scoped desktop-token headers.
- Outputs land in `app_data/exports`, are moved to `exports/users/<owner>/`, get group-only permissions, and are downloaded through `/api/export-presentation/file` (browser) or nginx's authenticated `/app_data/exports/` (API).
- How DOM elements become PowerPoint shapes, and how PDF printing waits for content, cannot be verified from this repository.

## Next

With export understood, continue to [Auth and multi-user](25-auth-and-multiuser.md) to see how the sessions, API keys and owner scoping used throughout this chapter are implemented.
