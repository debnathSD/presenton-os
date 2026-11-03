# Story 9: Deploy Presenton BE and FE alongside the analytics platform

<div class="chapter-meta" markdown>
**Reads:** `Dockerfile`, `start.js`, `nginx.conf`, `servers/fastapi/server.py`, `servers/fastapi/api/main.py`, `servers/fastapi/utils/asset_directory_utils.py`, `servers/fastapi/services/export_task_service.py`, `servers/fastapi/utils/export_utils.py`, `servers/nextjs/next.config.mjs`, `servers/nextjs/proxy.ts`, `docs/presenton-resource-usage.md`, `apache/superset: helm/superset/values.yaml`  ·  **Builds on:** [Story 2: Platform integration](43-story2-platform-integration.md), [Docker build and deployment](../presenton/26-docker-and-deployment.md), [Runtime topology](../presenton/03-runtime-topology.md)  ·  **Time:** ~60 min
</div>

This chapter takes the pod-ready backend from Story 2 and the prefix-aware frontend from Story 5 and runs them in the analytics platform's Kubernetes namespace. You will split Presenton's single image into a backend and a frontend image, write the Deployments, Ingress, migration Job, autoscaling and network policies, wire secrets and storage, connect the harness, build a CI/CD pipeline with a canary, and define the metrics, traces, alerts and runbook entries that tell you whether AI Slides is healthy.

## Step 0: The story, its owners and its acceptance criteria

| # | Story | What it does | Owners |
| --- | --- | --- | --- |
| 9 | [Infra] Deploy Presenton BE and FE alongside the analytics platform | Deploys both Presenton services with routing, secrets, storage, harness connectivity, CI/CD and monitoring. | Nitesh, Sourav |

Story 9 starts early with a dev environment (so Stories 1 to 8 can integrate against real routing and cookies) and finishes with the production rollout.

Acceptance criteria:

1. **Given** the analytics namespace, **when** the Helm chart `ai-slides` is installed, **then** `presenton-fe` and `presenton-be` Deployments run with at least 2 ready replicas each, as non-root, and `presenton-migrate` completed before any BE pod became ready.
2. **Given** a browser on `https://analytics.example.com`, **when** it requests `/ai-slides/`, `/ai-slides/api/v1/...` and `/ai-slides/app_data/images/...`, **then** they reach the FE, the BE (with the prefix stripped) and the BE asset mounts respectively, and every other path still reaches Superset.
3. **Given** a 25-minute SSE stream through the ingress, **when** no bytes flow for 60 seconds between events, **then** the stream is not cut and events arrive unbuffered.
4. **Given** the secret store, **when** a secret is rotated, **then** the pods pick it up through a rolling restart with no manual edits, and no secret appears in a manifest, image layer or log.
5. **Given** NetworkPolicies in place, **when** a BE pod tries to reach anything other than Postgres, Superset web, the harness, the FE, object storage, DNS or the approved LLM egress, **then** the connection is refused.
6. **Given** a merge to the fork's release branch, **when** CI runs, **then** both images are built, tested, scanned (no critical CVEs), pushed by digest, deployed to dev automatically, to staging after approval, and to production through a 10 percent canary.
7. **Given** production traffic, **when** the refresh success rate drops below the SLO or p95 open-to-fresh latency exceeds it, **then** an alert fires with a link to the runbook entry in Step 11.

## Step 1: The deployment architecture

Stock Presenton runs four processes in one container behind its own nginx: FastAPI on 8000, the app MCP server on 8001, Next.js on 3000 and nginx on 80 (`start.js:46-48`, `nginx.conf:25-212`). The [Runtime topology](../presenton/03-runtime-topology.md) chapter walks that design. In the analytics cluster each of those jobs moves to a platform component: the ingress controller replaces nginx, Kubernetes replaces `start.js`, and Presenton's own MCP server is not deployed.

```mermaid
flowchart LR
    U["Browser on analytics.example.com"] --> IG["Ingress controller (TLS)"]
    subgraph NS["Namespace analytics"]
        IG -->|"/ (everything else)"| SW["superset-web :8088"]
        IG -->|"/ai-slides"| FE["presenton-fe :3000 (Next.js standalone)"]
        IG -->|"/ai-slides/api/v1 and v2, prefix stripped"| BE["presenton-be :8000 (uvicorn, export runtime, Chromium)"]
        IG -->|"/ai-slides/app_data"| BE
        FE -->|"server-side calls"| BE
        BE -->|"export runtime loads pdf-maker"| FE
        BE -->|"JWKS, refresh, catalog"| SW
        BE -->|"planner skill"| H["ai-harness :8080"]
        H -->|"MCP, user JWT"| MCP["superset-mcp :5008"]
        MCP --> SW
        J["Job presenton-migrate"] --> PG
        BE --> PG[("Postgres analytics, schema presenton")]
        SW --> PG2[("Postgres analytics, Superset schema")]
    end
    BE --> OS[("Object storage bucket ai-slides")]
    BE --> LLM["LLM provider (egress allow-list)"]
```

| Workload | Kind | Port | Owner | Notes |
| --- | --- | --- | --- | --- |
| `presenton-fe` | Deployment | 3000 | AI Slides | Next.js standalone, `basePath` `/ai-slides` |
| `presenton-be` | Deployment | 8000 | AI Slides | uvicorn, export runtime, Chromium, fonts |
| `presenton-mcp` | not deployed | 8001 | n/a | Presenton's own MCP is disabled by the contracts |
| `presenton-migrate` | Job (Helm hook) | n/a | AI Slides | `alembic upgrade head` and one-time bootstrap |
| `ai-harness` | Deployment | 8080 | Harness team | Reaches `superset-mcp` and is reached by `presenton-be` |
| `superset-mcp` | Deployment | 5008 | Analytics | From the Superset chart's `supersetMcp` block (`apache/superset: helm/superset/values.yaml:995-1030`) |

!!! warning "Gotcha: the BE calls the FE during every export"
    Exports are rendered by a headless browser that opens the FE's `/pdf-maker` page. `_build_presentation_export_url` builds `{NEXT_PUBLIC_URL}/pdf-maker?id=...` (`servers/fastapi/utils/export_utils.py:27-40`), with `NEXT_PUBLIC_URL` defaulting to `http://127.0.0.1` (`servers/fastapi/utils/export_utils.py:18-19`), which was the stock nginx. The page then fetches `/api/export-presentation-data/{id}` on the FE, which calls FastAPI through `FAST_API_INTERNAL_URL` (`servers/nextjs/app/api/export-presentation-data/[id]/route.ts:34`). In the cluster set `NEXT_PUBLIC_URL=http://presenton-fe:3000/ai-slides` on the BE and `FAST_API_INTERNAL_URL=http://presenton-be:8000` on the FE, and allow both directions in the NetworkPolicies. The [PPTX and PDF export](../presenton/24-export-pipeline.md) chapter has the full flow.

## Step 2: Split the image into `presenton-be` and `presenton-fe`

### 2.1 What the stock Dockerfile does

The `Dockerfile` has four stages: `fastapi-builder` (Python venv, warmed FastEmbed caches, `Dockerfile:3-33`), `nextjs-builder` (`npm ci` and `npm run build`, `:36-48`), `assets-builder` (LiteParse and the pinned export runtime, `:51-70`) and `runtime` (`:73-153`). The runtime installs a pinned Chromium, Noto fonts, ImageMagick, nginx and Node 22 (`:94-115`), copies everything in, and starts `node /app/start.js` as root on port 80 (`:152-153`). The [Docker build and deployment](../presenton/26-docker-and-deployment.md) chapter walks each layer.

Two facts drive the split:

1. The FastAPI process needs Node, Chromium and fonts, because `ExportTaskService` spawns `node runner.mjs` from `EXPORT_PACKAGE_ROOT` (`servers/fastapi/services/export_task_service.py:121-151`) and LiteParse runs through Node too.
2. The Next.js editor also runs exports itself: the Export button posts to the FE route `/api/export-presentation` (`servers/nextjs/app/(presentation-generator)/presentation/components/PresentationHeader.tsx:256`, `:338`), which spawns the same runner in the Next.js process (`servers/nextjs/lib/run-bundled-presentation-export.ts:201`) and reads `APP_DATA_DIRECTORY` (`servers/nextjs/app/api/export-presentation/route.ts:35`).

The recommended default is to change the editor to call the BE endpoint `POST /api/v1/ppt/presentation/{id}/export` (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:1642`) instead, which Story 1 needs anyway (export runs the batch refresh first). Then only the BE image needs Chromium, and the FE needs no `APP_DATA_DIRECTORY`. The alternative, keeping the FE route, means the FE image also carries Chromium and mounts the shared asset volume.

### 2.2 The fork's Dockerfile

Keep the three builder stages byte-for-byte from upstream (that keeps rebases trivial), add a `basePath` build argument to the Next.js build, and replace `runtime` with two targets.

```dockerfile title="Dockerfile.ai-slides (new, builder stages elided)"
# syntax=docker/dockerfile:1.7
# Stages fastapi-builder and assets-builder: copied unchanged from Dockerfile:3-70.

FROM node:22-bookworm-slim AS nextjs-builder
WORKDIR /app/servers/nextjs
ARG AI_SLIDES_BASE_PATH=/ai-slides
ENV NEXT_TELEMETRY_DISABLED=1 AI_SLIDES_BASE_PATH=${AI_SLIDES_BASE_PATH}
COPY servers/nextjs/package.json servers/nextjs/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY servers/nextjs /app/servers/nextjs
RUN npm run build && rm -rf .next-build/cache

# ---------------------------------------------------------------- presenton-be
FROM python:3.11-slim-trixie AS presenton-be
ARG INSTALL_TESSERACT=true
ARG CHROMIUM_VERSION=149.0.7827.196-1~deb13u1
ARG CHROMIUM_SNAPSHOT=20260625T180000Z
ENV APP_DATA_DIRECTORY=/app_data \
    TEMP_DIRECTORY=/tmp/presenton \
    EXPORT_PACKAGE_ROOT=/app/presentation-export \
    PRESENTON_APP_ROOT=/app \
    HF_HOME=/opt/presenton/cache/huggingface \
    FASTEMBED_CACHE_PATH=/opt/presenton/cache/fastembed \
    PRESENTON_FASTEMBED_ICON_CACHE_DIR=/opt/presenton/cache/fastembed-icons \
    PATH="/opt/venv/bin:${PATH}" \
    NODE_ENV=production START_OLLAMA=false \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp
# Same apt layer as Dockerfile:94-115 with "nginx" removed from the package list.
RUN set -eux; \
    # ... chromium snapshot pin, fonts, imagemagick, libs, nodejs 22 (unchanged)
    rm -rf /var/lib/apt/lists/*
RUN find /usr/share/fonts -type f ! -iname 'Noto*' -delete \
    && find /usr/share/fonts -type d -empty -delete && fc-cache -fsv
RUN groupadd -g 10001 presenton && useradd -u 10001 -g 10001 -M -d /tmp presenton \
    && mkdir -p /app_data /tmp/presenton && chown -R 10001:10001 /app_data /tmp/presenton
COPY --from=fastapi-builder /opt/venv /opt/venv
COPY --from=fastapi-builder /app/servers/fastapi /app/servers/fastapi
COPY --from=fastapi-builder /root/.cache/huggingface /opt/presenton/cache/huggingface
COPY --from=fastapi-builder /root/.cache/presenton/fastembed /opt/presenton/cache/fastembed
COPY --from=fastapi-builder /root/.cache/presenton/fastembed-icons /opt/presenton/cache/fastembed-icons
COPY templates /app/templates
COPY --from=assets-builder /app/package.json /app/package.json
COPY --from=assets-builder /app/document-extraction-liteparse /app/document-extraction-liteparse
COPY --from=assets-builder /app/presentation-export /app/presentation-export
COPY --from=assets-builder /app/scripts/export-permissions.cjs /app/scripts/export-permissions.cjs
RUN test -f /app/presentation-export/runner.mjs
WORKDIR /app/servers/fastapi
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", \
     "--proxy-headers", "--forwarded-allow-ips", "*", "--timeout-keep-alive", "75", \
     "--timeout-graceful-shutdown", "90", "--no-server-header"]

# ---------------------------------------------------------------- presenton-fe
FROM node:22-bookworm-slim AS presenton-fe
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=nextjs-builder --chown=1000:1000 /app/servers/nextjs/.next-build/standalone/ /app/
COPY --from=nextjs-builder --chown=1000:1000 /app/servers/nextjs/public /app/public
COPY --from=nextjs-builder --chown=1000:1000 /app/servers/nextjs/.next-build/static /app/.next-build/static
USER 1000:1000
EXPOSE 3000
CMD ["node", "server.js"]
```

The FE layout mirrors the stock runtime, which copies the standalone output to `/app/servers/nextjs/` and starts `server.js` there (`Dockerfile:142-144`, `start.js:35`). The only Next.js source change for the image is in `servers/nextjs/next.config.mjs:8-11`: add `basePath: process.env.AI_SLIDES_BASE_PATH || undefined` next to `distDir` and `output: "standalone"`. Story 5 covers the rest of the prefix work.

!!! warning "Gotcha: build-time values in the FE image"
    `basePath` and every `NEXT_PUBLIC_*` variable are inlined into the client bundle at `npm run build`. Changing them in the Deployment's env does nothing to the browser code. Keep the FE image environment-neutral: one `basePath` for all environments, no `NEXT_PUBLIC_*` value that differs between dev and prod, and server-only variables (such as `FAST_API_INTERNAL_URL`) read at runtime. The stock CI build sets `NEXT_PUBLIC_FAST_API` and `NEXT_PUBLIC_URL` at build time (see [CI, tests, security](../presenton/28-ci-tests-security.md)); the fork must not bake cluster URLs into them.

!!! warning "Gotcha: caches under `/root` are unreadable as non-root"
    The stock image puts the FastEmbed and Hugging Face caches under `/root/.cache` (`Dockerfile:86-88`, `:128-130`). `/root` is mode 700 on Debian, so a non-root process cannot read the baked weights and would try to download them at runtime (which the egress policy blocks). The fork copies them to `/opt/presenton/cache` and points `HF_HOME`, `FASTEMBED_CACHE_PATH` and `PRESENTON_FASTEMBED_ICON_CACHE_DIR` there. Run the existing offline warm check (`Dockerfile:33`, `HF_HUB_OFFLINE=1`) against the new paths in CI.

### 2.3 Read-only root filesystem

Both images can run with `readOnlyRootFilesystem: true` if every write lands on a mounted volume:

| Path | Writer | Mount |
| --- | --- | --- |
| `/tmp`, `/tmp/presenton` | Python temp files, `TEMP_DIRECTORY`, `PUPPETEER_TMP_DIR` and `PUPPETEER_CACHE_DIR` defaults (`servers/fastapi/services/export_task_service.py:164-183`) | `emptyDir`, `sizeLimit: 4Gi` |
| `/dev/shm` | Chromium shared memory | `emptyDir` with `medium: Memory`, `sizeLimit: 1Gi` |
| `/app_data` | Images, exports, uploads, fonts, templates (Step 6) | RWX PVC (phase 1) |
| FE `/app/.next-build/cache` | Next.js image optimizer (`servers/nextjs/next.config.mjs:34-37` explains why Electron disables it) | `emptyDir`, `sizeLimit: 512Mi` |

`HOME=/tmp` keeps tools that write dotfiles (fontconfig, Chromium crash reporter) inside the writable mount. Whether the pinned export runtime launches Chromium with or without its sandbox was not verified here. If it needs the sandbox, the pod needs user namespaces or a seccomp profile that allows them; check the runner's launch arguments before choosing `seccompProfile: RuntimeDefault`.

### 2.4 Image size

The repository contains no measured image size. The split moves the Next.js standalone output and its 91 MB `public/` folder (videos and images) into the FE image and removes nginx from the BE. The BE stays large because of Chromium, CJK fonts, the Python ML stack and baked embedding weights (see the inventory in [Docker build and deployment](../presenton/26-docker-and-deployment.md)). Building with `INSTALL_TESSERACT=false` (`Dockerfile:77`, `:105`) removes OCR. Measure both images in CI (for example with `docker image inspect` and its `Size` field) and alert on growth over 10 percent.

## Step 3: The Kubernetes manifests

The chart lives in the fork at `deploy/helm/ai-slides/` (new). The snippets below show rendered manifests with production values.

### 3.1 Sizing from the load test

The only measurement in the repository is a single-container k6 run: four concurrent generation workflows per wave, 16 in total, no exports (`docs/presenton-resource-usage.md:36-57`). Median CPU was 3.70 percent of one core, with bursts to 1,087 percent; summed process `VmData` rose from 2,670 MB to a peak of 11,866 MB during a post-test burst whose cause was not identified (`docs/presenton-resource-usage.md:17-21`). That container also ran Next.js and nginx, and `VmData` overstates resident memory.

| Container | CPU request | CPU limit | Memory request | Memory limit | Reasoning |
| --- | --- | --- | --- | --- | --- |
| `presenton-be` | 1 | none | 3Gi | 6Gi | LLM-bound and bursty; no CPU limit avoids throttling during export renders; the memory limit leaves room for one Chromium export plus four generations |
| `presenton-fe` | 250m | none | 512Mi | 1Gi | Server-side rendering and proxying only |
| `presenton-migrate` | 250m | 1 | 512Mi | 1Gi | Alembic and template import |

Start with these, run the same k6 profile plus exports against staging, and set the HPA target from the measured per-pod concurrency. The report itself asks for a repeat with stage markers and OOM counters (`docs/presenton-resource-usage.md:170`).

### 3.2 `presenton-be` Deployment

```yaml title="deploy/helm/ai-slides/templates/be-deployment.yaml (new, rendered)"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: presenton-be
  labels: {app.kubernetes.io/name: presenton-be, app.kubernetes.io/part-of: ai-slides}
spec:
  replicas: 2
  strategy: {type: RollingUpdate, rollingUpdate: {maxSurge: 1, maxUnavailable: 0}}
  selector: {matchLabels: {app.kubernetes.io/name: presenton-be}}
  template:
    metadata:
      labels: {app.kubernetes.io/name: presenton-be, app.kubernetes.io/part-of: ai-slides}
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8000"
        prometheus.io/path: /metrics
        checksum/config: "{{ include (print $.Template.BasePath \"/be-configmap.yaml\") . | sha256sum }}"
    spec:
      serviceAccountName: presenton-be
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 120
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile: {type: RuntimeDefault}
      containers:
        - name: presenton-be
          image: registry.example.com/ai-slides/presenton-be@sha256:REPLACE
          ports: [{name: http, containerPort: 8000}]
          envFrom:
            - configMapRef: {name: presenton-be-config}
            - secretRef: {name: presenton-be-secrets}
          env:
            - name: POD_NAME
              valueFrom: {fieldRef: {fieldPath: metadata.name}}
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: "service.name=presenton-be,service.namespace=analytics"
          resources:
            requests: {cpu: "1", memory: 3Gi}
            limits: {memory: 6Gi}
          startupProbe:
            httpGet: {path: /healthz, port: http}
            periodSeconds: 5
            failureThreshold: 36        # up to 3 min: FastEmbed load and template import
          livenessProbe:
            httpGet: {path: /healthz, port: http}
            periodSeconds: 20
            timeoutSeconds: 3
            failureThreshold: 3
          readinessProbe:
            httpGet: {path: /readyz, port: http}
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 2
          lifecycle:
            preStop:
              exec: {command: ["sleep", "10"]}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: {drop: ["ALL"]}
          volumeMounts:
            - {name: tmp, mountPath: /tmp}
            - {name: shm, mountPath: /dev/shm}
            - {name: app-data, mountPath: /app_data}
      volumes:
        - name: tmp
          emptyDir: {sizeLimit: 4Gi}
        - name: shm
          emptyDir: {medium: Memory, sizeLimit: 1Gi}
        - name: app-data
          persistentVolumeClaim: {claimName: presenton-app-data}
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector: {matchLabels: {app.kubernetes.io/name: presenton-be}}
```

The non-secret configuration comes from a ConfigMap built from the Story 2 configuration table:

```yaml title="deploy/helm/ai-slides/templates/be-configmap.yaml (new, rendered)"
apiVersion: v1
kind: ConfigMap
metadata: {name: presenton-be-config}
data:
  DB_SCHEMA: presenton
  DB_POOL_SIZE: "5"
  DB_MAX_OVERFLOW: "5"
  DB_POOL_TIMEOUT: "10"
  MIGRATE_DATABASE_ON_STARTUP: "false"
  DB_SCHEMA_MANAGED_EXTERNALLY: "true"
  AI_SLIDES_LOCAL_LOGIN_ENABLED: "false"
  AI_SLIDES_API_KEYS_ENABLED: "false"
  AI_SLIDES_BASE_PATH: /ai-slides
  AI_SLIDES_ISSUER: https://analytics.example.com
  AI_SLIDES_JWKS_URL: http://superset-web:8088/api/v1/ai_slides/.well-known/jwks.json
  AI_SLIDES_ANALYTICS_URL: http://superset-web:8088
  AI_SLIDES_HARNESS_URL: http://ai-harness:8080
  AI_SLIDES_STALE_AFTER_SECONDS: "3600"
  AI_SLIDES_CUSTOM_TEMPLATES_ENABLED: "false"
  PRESENTON_PUBLIC_URL: https://analytics.example.com/ai-slides
  NEXT_PUBLIC_URL: http://presenton-fe:3000/ai-slides
  PRESENTON_COMMUNITY_ENABLED: "false"
  DISABLE_ANONYMOUS_TRACKING: "true"
  LOG_FORMAT: json
  LOG_LEVEL: INFO
  OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector.observability:4318
```

`PRESENTON_COMMUNITY_ENABLED` is read by `is_community_enabled` (`servers/fastapi/utils/get_env.py:32-37`) and defaults to on, which would make the BE call Presenton's cloud. Turn it off.

!!! warning "Gotcha: CORS origin derived from `NEXT_PUBLIC_URL`"
    `api/main.py` uses `NEXT_PUBLIC_URL` as the single allowed CORS origin, or `*` when it is empty (`servers/fastapi/api/main.py:92-100`). In the cluster that variable now points at the internal FE URL for the export runtime, so the CORS allow-list becomes `http://presenton-fe:3000/ai-slides`, which never matches a browser origin. That is harmless on the same-origin topology (the browser does not send CORS preflights), but if you later move to a subdomain, add a separate `AI_SLIDES_CORS_ORIGINS` variable instead of reusing `NEXT_PUBLIC_URL`.

### 3.3 `presenton-fe` Deployment and the Services

```yaml title="deploy/helm/ai-slides/templates/fe-deployment.yaml (new, rendered, abridged)"
apiVersion: apps/v1
kind: Deployment
metadata: {name: presenton-fe}
spec:
  replicas: 2
  selector: {matchLabels: {app.kubernetes.io/name: presenton-fe}}
  template:
    metadata: {labels: {app.kubernetes.io/name: presenton-fe, app.kubernetes.io/part-of: ai-slides}}
    spec:
      automountServiceAccountToken: false
      securityContext: {runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: {type: RuntimeDefault}}
      containers:
        - name: presenton-fe
          image: registry.example.com/ai-slides/presenton-fe@sha256:REPLACE
          ports: [{name: http, containerPort: 3000}]
          env:
            - {name: FAST_API_INTERNAL_URL, value: "http://presenton-be:8000"}
          resources:
            requests: {cpu: 250m, memory: 512Mi}
            limits: {memory: 1Gi}
          readinessProbe:
            httpGet: {path: /ai-slides/api/telemetry-status, port: http}
            periodSeconds: 10
          livenessProbe:
            tcpSocket: {port: http}
            periodSeconds: 20
          securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: ["ALL"]}}
          volumeMounts:
            - {name: next-cache, mountPath: /app/.next-build/cache}
            - {name: tmp, mountPath: /tmp}
      volumes:
        - {name: next-cache, emptyDir: {sizeLimit: 512Mi}}
        - {name: tmp, emptyDir: {sizeLimit: 256Mi}}
---
apiVersion: v1
kind: Service
metadata: {name: presenton-fe}
spec:
  selector: {app.kubernetes.io/name: presenton-fe}
  ports: [{name: http, port: 3000, targetPort: http}]
---
apiVersion: v1
kind: Service
metadata: {name: presenton-be}
spec:
  selector: {app.kubernetes.io/name: presenton-be}
  ports: [{name: http, port: 8000, targetPort: http}]
```

The FE readiness path `/api/telemetry-status` is one of the routes the Next.js proxy exempts from auth (`servers/nextjs/proxy.ts:87-95`), so it needs no cookie. With `basePath` it is served under `/ai-slides`.

### 3.4 Ingress

ingress-nginx applies `rewrite-target` to every path of one Ingress object, so the chart uses three Ingress objects on the same host. The analytics platform's existing Superset Ingress keeps `/` (the Superset chart's `ingress.path` defaults to `/`, `apache/superset: helm/superset/values.yaml:240-250`); longer prefixes win, so `/ai-slides` routes to Presenton without touching it.

```yaml title="deploy/helm/ai-slides/templates/ingress.yaml (new, rendered)"
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: presenton-be-api
  annotations:
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/rewrite-target: /api/$1/$2
    nginx.ingress.kubernetes.io/proxy-read-timeout: "1800"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "1800"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
    nginx.ingress.kubernetes.io/proxy-body-size: 100m
    nginx.ingress.kubernetes.io/proxy-http-version: "1.1"
spec:
  ingressClassName: nginx
  tls: [{hosts: [analytics.example.com], secretName: analytics-tls}]
  rules:
    - host: analytics.example.com
      http:
        paths:
          - path: /ai-slides/api/(v1|v2)/(.*)
            pathType: ImplementationSpecific
            backend: {service: {name: presenton-be, port: {name: http}}}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: presenton-be-assets
  annotations:
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/rewrite-target: /app_data/$2
    nginx.ingress.kubernetes.io/proxy-body-size: 1m
spec:
  ingressClassName: nginx
  rules:
    - host: analytics.example.com
      http:
        paths:
          - path: /ai-slides/app_data(/|$)(.*)
            pathType: ImplementationSpecific
            backend: {service: {name: presenton-be, port: {name: http}}}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: presenton-fe
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
spec:
  ingressClassName: nginx
  rules:
    - host: analytics.example.com
      http:
        paths:
          - path: /ai-slides
            pathType: Prefix
            backend: {service: {name: presenton-fe, port: {name: http}}}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ai-slides-launch
spec:
  ingressClassName: nginx
  rules:
    - host: analytics.example.com
      http:
        paths:
          - path: /ai-slides/launch
            pathType: Exact
            backend: {service: {name: superset-web, port: {number: 8088}}}
```

| Annotation | Value | Why |
| --- | --- | --- |
| `proxy-read-timeout`, `proxy-send-timeout` | `1800` | Generation and refresh streams; stock nginx uses `30m` (`nginx.conf:49-51`) |
| `proxy-buffering` | `off` | SSE events must flush immediately |
| `proxy-body-size` | `100m` | Document uploads; stock nginx allows `110M` on `/api/v1/` and answers 413 with a JSON message above it (`nginx.conf:46-47`, `:71-74`) |
| `rewrite-target` | `/api/$1/$2` | Strips `/ai-slides` so FastAPI sees the paths it was written for (Story 2, Step 6.6) |

!!! warning "Gotcha: only /api/v1 and /api/v2 belong to the backend"
    Next.js serves its own route handlers under `/api/` (for example `/api/export-presentation`, `/api/runtime-config` and `/api/telemetry-status`, the FE readiness probe above). A blanket `/ai-slides/api` rule would send those to FastAPI and break them, so the backend Ingress matches only `/ai-slides/api/v1/` and `/ai-slides/api/v2/`, mirroring how `servers/nextjs/proxy.ts` decides what is a FastAPI path. The `/ai-slides/launch` host page belongs to Superset ([Story 5](46-story5-menu-and-iframe.md)); its `Exact` rule wins over the `/ai-slides` prefix rule.

!!! warning "Gotcha: Superset's session cookie reaches Presenton"
    On a shared origin the browser sends Superset's `session` cookie to `/ai-slides` too, and stock Presenton forwards the whole Cookie header into the export runtime task (`servers/fastapi/utils/export_utils.py:35-36`, `servers/nextjs/lib/run-bundled-presentation-export.ts:171-188`). Forward only `presenton_session` in the fork, and if the ingress controller allows header rewriting, drop other cookies on `/ai-slides` routes. [Story 8](49-story8-analytics-mcp.md) covers the cookie settings.

!!! warning "Gotcha: one regex Ingress changes the whole host"
    With ingress-nginx, `use-regex: "true"` on any Ingress makes all paths for that host case-insensitive regular expressions, including Superset's. A Superset path that contains regex metacharacters could match differently. Test Superset's own routes after installing the chart, or use Gateway API (`HTTPRoute` with a `URLRewrite` filter, which the Superset chart also supports through its `httproute` values) if the cluster has it.

!!! warning "Gotcha: assets bypass nginx `auth_request` now"
    The stock image serves `/app_data/*` with nginx `alias` and checks each request through `auth_request /_auth_check`, which calls `/api/v1/auth/verify` (`nginx.conf:133-142`, `:159-211`). In the cluster those files are served by FastAPI's own mounts (`servers/fastapi/api/main.py:77-82`), and authorization happens in `SessionAuthMiddleware` and `_OwnerScopedStaticFiles`. Do not add an ingress `auth-url` to the assets Ingress: the BE already authorizes every asset request itself, and an external auth subrequest would double the BE load for every image on every slide.

### 3.5 The migration Job

```yaml title="deploy/helm/ai-slides/templates/migrate-job.yaml (new, rendered)"
apiVersion: batch/v1
kind: Job
metadata:
  name: presenton-migrate
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-weight: "0"
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
spec:
  backoffLimit: 1
  activeDeadlineSeconds: 900
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: presenton-migrate
      automountServiceAccountToken: false
      securityContext: {runAsNonRoot: true, runAsUser: 10001, seccompProfile: {type: RuntimeDefault}}
      containers:
        - name: migrate
          image: registry.example.com/ai-slides/presenton-be@sha256:REPLACE
          command: ["python", "-m", "scripts.ai_slides_migrate"]
          envFrom:
            - configMapRef: {name: presenton-be-config}
            - secretRef: {name: presenton-migrate-secrets}   # DATABASE_URL for presenton_migrator
          resources:
            requests: {cpu: 250m, memory: 512Mi}
            limits: {cpu: "1", memory: 1Gi}
          securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: ["ALL"]}}
          volumeMounts:
            - {name: tmp, mountPath: /tmp}
            - {name: app-data, mountPath: /app_data}
      volumes:
        - {name: tmp, emptyDir: {}}
        - {name: app-data, persistentVolumeClaim: {claimName: presenton-app-data}}
```

The module is the one Story 2 adds (`servers/fastapi/scripts/ai_slides_migrate.py`). It mounts `/app_data` because `import_default_templates_on_startup` copies template static assets into `APP_DATA_DIRECTORY` and refuses to run without it (`servers/fastapi/templates/default_templates.py:295-299`).

!!! warning "Gotcha: hook ordering with External Secrets"
    A `pre-install` hook runs before the chart's normal resources exist. If `presenton-migrate-secrets` is created by an `ExternalSecret` in the same chart, the first install's Job starts before the Secret exists and fails. Either make the `ExternalSecret` a hook with a lower weight (`helm.sh/hook-weight: "-5"`) and wait for its `Ready` condition, or manage the `ExternalSecret` objects in the platform's secrets chart so they exist before `ai-slides` is installed.

Migration ordering rule: every revision must be compatible with the previous BE image, because old pods serve traffic while new ones roll out and during the canary. Use expand and contract: add nullable columns and new tables in release N, start using them in N, backfill in a Job, and drop old columns no earlier than N+1. The Story 2 `/readyz` check compares the database revision with the image's `REVISION_HEAD`, so a new pod never takes traffic on an older schema, and old pods tolerate the newer schema because the change was additive.

### 3.6 HPA and PDB

```yaml title="deploy/helm/ai-slides/templates/autoscaling.yaml (new, rendered)"
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: {name: presenton-be}
spec:
  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: presenton-be}
  minReplicas: 2
  maxReplicas: 6
  metrics:
    - type: Pods
      pods:
        metric: {name: ai_slides_generation_inflight}
        target: {type: AverageValue, averageValue: "3"}
    - type: Resource
      resource: {name: cpu, target: {type: Utilization, averageUtilization: 70}}
  behavior:
    scaleDown: {stabilizationWindowSeconds: 600, policies: [{type: Pods, value: 1, periodSeconds: 300}]}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: {name: presenton-be}
spec:
  minAvailable: 1
  selector: {matchLabels: {app.kubernetes.io/name: presenton-be}}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: {name: presenton-fe}
spec:
  minAvailable: 1
  selector: {matchLabels: {app.kubernetes.io/name: presenton-fe}}
```

Generation is mostly waiting on the LLM (median CPU 3.70 percent in the load test), so CPU alone scales too late. The custom metric `ai_slides_generation_inflight` (Step 9) through prometheus-adapter scales on concurrent work; the target of 3 per pod is below the 4 concurrent workflows the load test ran without failures. The long scale-down window protects in-flight streams and background tasks: a scale-down sends SIGTERM to a pod that may be generating.

### 3.7 NetworkPolicies

```yaml title="deploy/helm/ai-slides/templates/networkpolicy.yaml (new, rendered)"
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: presenton-be}
spec:
  podSelector: {matchLabels: {app.kubernetes.io/name: presenton-be}}
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: ingress-nginx}}
        - podSelector: {matchLabels: {app.kubernetes.io/name: presenton-fe}}
        - podSelector: {matchLabels: {app.kubernetes.io/name: ai-harness}}
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: observability}}
      ports: [{port: 8000}]
  egress:
    - to: [{namespaceSelector: {}, podSelector: {matchLabels: {k8s-app: kube-dns}}}]
      ports: [{port: 53, protocol: UDP}, {port: 53, protocol: TCP}]
    - to: [{podSelector: {matchLabels: {app: postgresql}}}]          # or pgbouncer
      ports: [{port: 5432}]
    - to: [{podSelector: {matchLabels: {app: superset}}}]            # JWKS, refresh, catalog
      ports: [{port: 8088}]
    - to: [{podSelector: {matchLabels: {app.kubernetes.io/name: ai-harness}}}]
      ports: [{port: 8080}]
    - to: [{podSelector: {matchLabels: {app.kubernetes.io/name: presenton-fe}}}]
      ports: [{port: 3000}]                                           # export runtime
    - to: [{namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: egress-gateway}}}]
      ports: [{port: 443}]                                            # LLM and object storage via proxy
    - to: [{namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: observability}}}]
      ports: [{port: 4318}]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: presenton-fe}
spec:
  podSelector: {matchLabels: {app.kubernetes.io/name: presenton-fe}}
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: ingress-nginx}}
        - podSelector: {matchLabels: {app.kubernetes.io/name: presenton-be}}
      ports: [{port: 3000}]
  egress:
    - to: [{namespaceSelector: {}, podSelector: {matchLabels: {k8s-app: kube-dns}}}]
      ports: [{port: 53, protocol: UDP}]
    - to: [{podSelector: {matchLabels: {app.kubernetes.io/name: presenton-be}}}]
      ports: [{port: 8000}]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: ai-harness-to-mcp}
spec:
  podSelector: {matchLabels: {app.kubernetes.io/name: ai-harness}}
  policyTypes: [Egress]
  egress:
    - to: [{podSelector: {matchLabels: {app: superset-mcp}}}]
      ports: [{port: 5008}]
    - to: [{podSelector: {matchLabels: {app.kubernetes.io/name: presenton-be}}}]
      ports: [{port: 8000}]
```

Match the Superset and Postgres pod labels to what the analytics platform's chart actually sets; the labels above are placeholders. Plain NetworkPolicy cannot express hostnames, so LLM egress goes through the platform's egress proxy or gateway with an FQDN allow-list (for example `api.openai.com`, `api.anthropic.com`), or through a CNI with FQDN policies.

!!! warning "Gotcha: image search and stock photo egress"
    Presenton fetches images from providers such as Pexels and Pixabay when an image provider is configured, and the FE's `next.config.mjs` allows remote images from several hosts (`servers/nextjs/next.config.mjs:38-75`). Either add the chosen provider's hosts to the egress allow-list or disable image generation (`DISABLE_IMAGE_GENERATION=true`, used by the stock CI job) for the pilot. Otherwise generation fails slowly on connection timeouts.

### 3.8 ServiceAccounts

`presenton-be` and `presenton-migrate` get their own ServiceAccounts with `automountServiceAccountToken: false` (they never call the Kubernetes API). If object storage uses workload identity (IRSA on EKS, Workload Identity on GKE, or Azure Workload Identity), annotate the BE ServiceAccount with the cloud role and set `automountServiceAccountToken: true` only on the projected token volume the cloud SDK needs. The FE needs no cloud identity.

## Step 4: Secrets management

Use External Secrets Operator with the platform's Vault (or cloud secret manager). Nothing secret goes into the ConfigMap, the Helm values file or the image.

```yaml title="deploy/helm/ai-slides/templates/externalsecret.yaml (new, rendered)"
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata: {name: presenton-be-secrets}
spec:
  refreshInterval: 1h
  secretStoreRef: {kind: ClusterSecretStore, name: vault-analytics}
  target: {name: presenton-be-secrets, creationPolicy: Owner}
  data:
    - {secretKey: DATABASE_URL,             remoteRef: {key: analytics/ai-slides/db, property: app_url}}
    - {secretKey: AUTH_SECRET_KEY,          remoteRef: {key: analytics/ai-slides/session, property: signing_key}}
    - {secretKey: AI_SLIDES_DATA_TOKEN_KEY, remoteRef: {key: analytics/ai-slides/data-token, property: current}}
    - {secretKey: AI_SLIDES_DATA_TOKEN_OLD_KEYS, remoteRef: {key: analytics/ai-slides/data-token, property: previous}}
    - {secretKey: LLM,                      remoteRef: {key: analytics/ai-slides/llm, property: provider}}
    - {secretKey: OPENAI_API_KEY,           remoteRef: {key: analytics/ai-slides/llm, property: openai_api_key}}
    - {secretKey: AI_SLIDES_HARNESS_TOKEN,  remoteRef: {key: analytics/ai-slides/harness, property: token}}
```

| Variable | Kind | Consumer | Rotation |
| --- | --- | --- | --- |
| `DATABASE_URL` (app role) | secret | BE | Vault database engine or manual; rolling restart |
| `DATABASE_URL` (migrator role) | secret | Job only | Same; separate Secret `presenton-migrate-secrets` |
| `AUTH_SECRET_KEY` | secret | BE | Rotation logs every user out and invalidates stored API keys (Story 2); users re-enter through the handoff transparently, so rotate in a quiet window |
| `AI_SLIDES_DATA_TOKEN_KEY`, `AI_SLIDES_DATA_TOKEN_OLD_KEYS` | secret | BE | New key current, old key in `OLD_KEYS` for 15 minutes, then remove |
| `LLM`, `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, ...) | secret | BE | Provider-side rotation; rolling restart |
| `PEXELS_API_KEY`, `PIXABAY_API_KEY` | secret | BE | Only if image search is enabled |
| `AI_SLIDES_JWKS_URL`, `AI_SLIDES_ISSUER` | config | BE | Not secret; ConfigMap |
| `AI_SLIDES_HARNESS_TOKEN` | secret | BE | Shared with the harness team's secret; dual-accept window on the harness side |
| Object storage credentials | workload identity preferred | BE | Cloud-managed; static keys only if unavoidable |
| `AI_SLIDES_SIGNING_KEY` | secret | Superset (Story 8) | Publish new `kid` in JWKS first, sign with it after one JWKS TTL, retire the old key after 15 minutes |

Provider keys are read with `os.getenv` at call time (for example `get_openai_api_key_env`, `servers/fastapi/utils/get_env.py`), but a running process's environment does not change when a Secret changes. Roll the Deployment on secret change: the `checksum/config` annotation covers the ConfigMap, and a controller such as Stakater Reloader (`reloader.stakater.com/auto: "true"`) covers Secrets synced by External Secrets.

!!! warning "Gotcha: secrets leak into the export child process"
    `ExportTaskService._build_node_env` starts from `os.environ.copy()` (`servers/fastapi/services/export_task_service.py:154`), so every secret above is in the environment of the Node runner and of Chromium. Story 2 replaces this with an allow-list. Until that lands, treat the export runtime as part of the secret boundary when reviewing its dependencies.

## Step 5: Storage

### 5.1 Where Presenton writes

Every persistent file goes under `APP_DATA_DIRECTORY`. The code-level touchpoints:

| Data | Code | Path |
| --- | --- | --- |
| Generated and uploaded images | `get_images_directory` via `_owned_directory` (`servers/fastapi/utils/asset_directory_utils.py:23-30`, `:227-228`), upload handler `servers/fastapi/api/v1/ppt/endpoints/images.py:322` | `images/users/<owner_id>/<uuid>.<ext>` |
| Exports (PPTX, PDF) | `get_exports_directory` (`servers/fastapi/utils/asset_directory_utils.py:231-232`), export runtime env (`servers/fastapi/services/export_task_service.py:156-162`) | `exports/users/<owner_id>/...` |
| Uploaded documents | `get_uploads_directory` (`servers/fastapi/utils/asset_directory_utils.py:234-235`) | `uploads/users/<owner_id>/...` |
| Uploaded fonts | `get_fonts_directory` (`servers/fastapi/utils/font_uploads.py:66-70`) | `fonts/` (shared) |
| Default template assets | `_copy_default_template_static_assets` (`servers/fastapi/templates/default_templates.py:295-299`) | `templates/` (shared) |
| PPTX conversion artifacts | export task service checks (`servers/fastapi/services/export_task_service.py:735-740`) | `pptx-to-html/`, `pptx-to-json/` |
| Served over HTTP | `mount_app_data_assets` (`servers/fastapi/api/v1/auth/assets.py:39-44`) | `/app_data/<root>/...` |
| Deleted with a user | admin router cleanup (`servers/fastapi/api/v1/admin/router.py:253-257`) | `<root>/users/<id>` |

Slides store these as `/app_data/...` URLs in their JSON (`filesystem_image_path_to_app_data_url`, `servers/fastapi/utils/asset_directory_utils.py:63-99`), and the export runtime resolves them relative to `ASSETS_BASE_URL=/app_data` (`servers/fastapi/services/export_task_service.py:199`).

### 5.2 RWX volume versus object storage

| | RWX PVC (NFS, EFS, Filestore, Azure Files) | Object storage (bucket `ai-slides`) |
| --- | --- | --- |
| Code change | None; mount at `/app_data` in BE (and Job) | A storage abstraction behind every touchpoint in 5.1, plus serving via signed URLs or a streaming proxy |
| Multi-pod correctness | Yes, all pods see the same files | Yes |
| Latency | File-system latency; `os.path.realpath` and `isfile` checks in `assets.py` stay cheap | Network round trip per read; must cache or presign |
| Authorization | Existing path checks keep working | Per-object keys and short-lived signed URLs (better isolation for shared decks) |
| Backups, lifecycle | Volume snapshots | Bucket versioning and lifecycle rules (expire exports after 30 days) |
| Risk | NFS locking and throughput limits, single-AZ volumes on some clouds | Larger change touching export and template code that upstream changes often |

Recommended phased approach:

1. **Phase 1 (pilot):** RWX PVC `presenton-app-data` (`ReadWriteMany`, 100Gi, a zonal or regional class per platform standard), mounted in the BE and the migrate Job. No code changes beyond Story 2.
2. **Phase 2:** move `exports/` to the bucket first (write once, read rarely, biggest files). After the runner writes the file, upload it and return a signed URL; delete the local copy. This changes only the end of `export_presentation` (`servers/fastapi/utils/export_utils.py:43-75`).
3. **Phase 3:** move `images/` and `uploads/` behind a `StorageBackend` interface with `put`, `open`, `url_for` and `delete`, keep `/app_data/...` as the stable URL in slide JSON, and let FastAPI stream or redirect to signed URLs. Fonts and templates can stay on the volume or be baked into the image.

!!! warning "Gotcha: `chmod` and ownership on network volumes"
    The stock supervisor creates the `app_data` folders and fixes permissions at start, treating `chmod` failures as best effort because PVCs may be owned by an arbitrary UID (`start.js:68-82`). Without `start.js`, nothing does that. `fsGroup: 10001` in the pod security context handles most block and NFS volumes; for NFS servers that squash ownership, pre-create the seven folders listed in `start.js:59-67` in an init step of the migrate Job.

## Step 6: Harness connectivity

The BE calls the planner at `POST http://ai-harness:8080/v1/skills/presentation-planner:run` (contracts, Story 7). Inside the namespace the short name resolves; use the full name `ai-harness.analytics.svc.cluster.local` if the BE and harness may ever live in different namespaces.

| Concern | Recommended default | Alternative |
| --- | --- | --- |
| Service identity | Service mesh mTLS (Istio or Linkerd) with an authorization policy that admits only the `presenton-be` ServiceAccount | Shared service token `AI_SLIDES_HARNESS_TOKEN` in `X-Service-Token`, compared in constant time by the harness |
| User identity | The user's data token as `Authorization: Bearer` (Story 2 stores it; the harness passes it to Superset MCP) | none; the harness must never call MCP with a service identity |
| Timeouts | connect 2 s, read 120 s (planner wall limit is 90 s) | Async job with polling if plans exceed 120 s |
| Retries | None on `:run` (not idempotent) unless the harness accepts an `Idempotency-Key`; retry connect errors once | |
| Concurrency | `httpx.AsyncClient` with `max_connections=20` per BE pod | |
| Trace context | `traceparent` and `tracestate` headers propagated (Step 9) | |

The harness reaches Superset MCP at `http://superset-mcp:5008/mcp` (the Superset chart's `supersetMcp.service.port` is 5008, `apache/superset: helm/superset/values.yaml:1030`). Data tokens live 15 minutes; a planner run that starts with less than 2 minutes of token life left should first trigger the FE's `ai-slides:handoff-request` so it does not fail mid-run.

## Step 7: CI/CD

### 7.1 Keeping the fork in sync with upstream

The fork tracks `presenton/presenton` with an `upstream` remote and keeps all AI Slides work on a branch that is rebased onto upstream release tags.

```bash title="fork sync (maintainer workstation or scheduled job)"
git remote add upstream https://github.com/presenton/presenton.git   # once
git fetch upstream --tags
git checkout -b sync/v0.9.13 ai-slides/main
git rebase --onto v0.9.13 v0.9.12-beta     # replay fork commits onto the new upstream tag
# resolve conflicts, run the full test suite, open a PR into ai-slides/main
git push --force-with-lease origin sync/v0.9.13
```

Rules that keep rebases cheap: new code in new files (`api/v1/platform/`, `api/v1/auth/access.py`, `services/platform_*.py`, `deploy/`), small flag-guarded edits in hot upstream files (`services/database.py`, `api/middlewares.py`, `api/v1/auth/users.py`), a separate `Dockerfile.ai-slides` instead of editing `Dockerfile`, and Alembic revisions that chain after the newest upstream revision (if upstream adds a revision after yours, re-point your `down_revision` during the rebase, or use an Alembic merge revision). Rebase at least monthly; a scheduled workflow can open the sync PR automatically and let CI report conflicts.

### 7.2 The release workflow

```yaml title=".github/workflows/ai-slides-release.yml (new)"
name: ai-slides-release
on:
  push:
    branches: [ai-slides/main]
  workflow_dispatch:
permissions: {contents: read, packages: write, id-token: write}
env:
  REGISTRY: registry.example.com/ai-slides
jobs:
  test:
    uses: ./.github/workflows/test-all.yml        # upstream suites, unchanged
  test-postgres:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: {POSTGRES_PASSWORD: postgres, POSTGRES_DB: analytics}
        ports: ["5432:5432"]
        options: --health-cmd pg_isready --health-interval 5s --health-retries 10
    defaults: {run: {working-directory: servers/fastapi}}
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v6
      - run: uv sync --locked --dev
      - run: psql postgresql://postgres:postgres@localhost/analytics -c 'CREATE SCHEMA presenton'
      - run: uv run --locked python -m scripts.ai_slides_migrate
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/analytics
          DB_SCHEMA: presenton
          APP_DATA_DIRECTORY: /tmp/presenton-app-data
      - run: uv run --locked python -m pytest tests/unit -k "platform or collaborator or access" -q
  build:
    needs: [test, test-postgres]
    runs-on: ubuntu-latest
    strategy:
      matrix: {target: [presenton-be, presenton-fe]}
    outputs:
      be-digest: ${{ steps.out.outputs.presenton-be }}
      fe-digest: ${{ steps.out.outputs.presenton-fe }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: {registry: registry.example.com, username: "${{ secrets.REGISTRY_USER }}", password: "${{ secrets.REGISTRY_TOKEN }}"}
      - id: build
        uses: docker/build-push-action@v6
        with:
          file: Dockerfile.ai-slides
          target: ${{ matrix.target }}
          push: true
          tags: ${{ env.REGISTRY }}/${{ matrix.target }}:${{ github.sha }}
          cache-from: type=gha,scope=${{ matrix.target }}
          cache-to: type=gha,mode=max,scope=${{ matrix.target }}
          provenance: true
          sbom: true
      - uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: ${{ env.REGISTRY }}/${{ matrix.target }}@${{ steps.build.outputs.digest }}
          severity: CRITICAL
          exit-code: "1"
          ignore-unfixed: true
      - id: out
        run: echo "${{ matrix.target }}=${{ steps.build.outputs.digest }}" >> "$GITHUB_OUTPUT"
  deploy-dev:
    needs: build
    runs-on: ubuntu-latest
    environment: dev
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-helm@v4
      - run: >
          helm upgrade --install ai-slides deploy/helm/ai-slides -n analytics
          -f deploy/helm/ai-slides/values-dev.yaml
          --set be.image.digest=${{ needs.build.outputs.be-digest }}
          --set fe.image.digest=${{ needs.build.outputs.fe-digest }}
          --wait --timeout 15m
      - run: ./deploy/smoke.sh https://analytics-dev.example.com
  deploy-staging:
    needs: [build, deploy-dev]
    runs-on: ubuntu-latest
    environment: staging          # required reviewers
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-helm@v4
      - run: helm upgrade --install ai-slides deploy/helm/ai-slides -n analytics -f deploy/helm/ai-slides/values-staging.yaml --set be.image.digest=${{ needs.build.outputs.be-digest }} --set fe.image.digest=${{ needs.build.outputs.fe-digest }} --wait --timeout 15m
      - run: ./deploy/smoke.sh https://analytics-staging.example.com && k6 run deploy/k6/ai-slides.js
  deploy-prod-canary:
    needs: [build, deploy-staging]
    runs-on: ubuntu-latest
    environment: production       # required reviewers
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-helm@v4
      - run: helm upgrade --install ai-slides-canary deploy/helm/ai-slides -n analytics -f deploy/helm/ai-slides/values-prod.yaml --set canary.enabled=true --set canary.weight=10 --set be.image.digest=${{ needs.build.outputs.be-digest }} --set fe.image.digest=${{ needs.build.outputs.fe-digest }} --wait
```

The workflow pins actions by major version for readability; pin them by commit SHA in the real file, as the platform's supply-chain policy requires. Note that the upstream `test-all.yml` triggers on push and pull request; calling it with `uses:` requires adding `workflow_call` to its `on:` block, which is a one-line fork change.

The `ai-slides-canary` release renders only a `presenton-be-canary` Deployment, Service and a copy of the API Ingress with `nginx.ingress.kubernetes.io/canary: "true"` and `canary-weight: "10"`. It shares the database and volume with the primary release. Promotion is a second manual job: after 30 minutes with the SLOs in Step 9 green, upgrade the primary `ai-slides` release to the same digests and uninstall the canary. The migrate Job runs in the canary release's `pre-install` hook, which is why every migration must be backward compatible (Step 3.5).

!!! warning "Gotcha: canary by request, not by user"
    ingress-nginx canary weights apply per request. One user's page load, its SSE stream and its export can hit different versions. That is fine only because the API is stateless and the schema is compatible both ways. If a release changes an SSE event shape (Story 4) or a payload the FE depends on, canary the FE and BE together with `canary-by-cookie` on a test cohort instead of a weight.

## Step 8: Release checks after each deploy

`deploy/smoke.sh` (new) runs as a test user with a pre-provisioned Superset account in non-production environments:

1. `GET /ai-slides/` returns 200 and HTML; `GET /ai-slides/api/v1/auth/status` returns JSON.
2. Exercise the handoff through Superset's `POST /api/v1/ai_slides/handoff` and `POST /ai-slides/api/v1/platform/session`; assert the cookie attributes.
3. Create a two-slide deck with one binding against a fixture chart, open the refresh stream, assert `refresh_complete` with `errors=0`.
4. Export PPTX through the BE endpoint and download it through `/ai-slides/app_data/exports/...`.
5. `GET /ai-slides/api/v1/auth/setup` returns 404 (local login disabled).

## Step 9: Monitoring

### 9.1 Metrics

Add `prometheus-client` and expose `/metrics` on the BE (not routed by the ingress; scraped in-cluster). Keep labels low-cardinality: never label by user id, presentation id or chart id.

| Metric | Type | Labels | Source |
| --- | --- | --- | --- |
| `ai_slides_http_requests_total` | counter | `route`, `method`, `status_class` | Request middleware (route template, not raw path) |
| `ai_slides_http_request_duration_seconds` | histogram | `route`, `method` | Same; excludes SSE routes |
| `ai_slides_refresh_bindings_total` | counter | `status` (`ok`, `stale`, `error`, `forbidden`, `pending`), `kind` | Story 1 refresh service, one per binding result |
| `ai_slides_refresh_duration_seconds` | histogram | `trigger` (`open`, `export`, `manual`) | Stream accept to `refresh_complete` (the server side of open-to-fresh) |
| `ai_slides_refresh_upstream_duration_seconds` | histogram | `status` | Analytics BE `POST /api/v1/ai_slides/refresh` call |
| `ai_slides_generation_total` | counter | `mode` (`standard`, `smart`, `planner`), `outcome` | Generation endpoints and async tasks |
| `ai_slides_generation_duration_seconds` | histogram | `mode` | Same |
| `ai_slides_generation_inflight` | gauge | none | Incremented and decremented around generation; drives the HPA |
| `ai_slides_harness_request_duration_seconds` | histogram | `skill`, `outcome` | Harness client |
| `ai_slides_export_duration_seconds` | histogram | `format`, `outcome` | Around `export_presentation` |
| `ai_slides_export_inflight` | gauge | `format` | Same |
| `ai_slides_handoff_total` | counter | `outcome` (`ok`, `invalid`, `replayed`, `expired`, `jwks_error`) | Story 2 session endpoint |
| `ai_slides_data_token_expired_total` | counter | `caller` | Token helper |
| `ai_slides_async_tasks` | gauge | `status` | Periodic count of `async_tasks` rows |
| `ai_slides_db_pool_checked_out` | gauge | none | `sql_engine.pool.checkedout()` sampled every 15 s |

The browser-side part of open-to-fresh (page load to first paint) is not visible to the BE. If the product needs it, have the FE send one beacon per deck open to a small BE endpoint that records it in a separate histogram.

### 9.2 Traces across Superset, Presenton, the harness and MCP

Use OpenTelemetry with W3C trace context (`traceparent`, `tracestate`) everywhere, exporting OTLP to the platform collector.

```mermaid
sequenceDiagram
    participant B as Browser FE
    participant P as presenton-be
    participant S as superset-web
    participant H as ai-harness
    participant M as superset-mcp
    B->>P: GET refresh stream (traceparent from FE fetch instrumentation)
    P->>S: POST /api/v1/ai_slides/refresh (traceparent injected by httpx instrumentation)
    S-->>P: results (span per chart query)
    B->>P: POST generate-from-prompt/async
    P->>H: POST presentation-planner run (same trace)
    H->>M: MCP tool calls (traceparent in HTTP headers)
    M->>S: chart data queries
```

| Hop | Instrumentation |
| --- | --- |
| Browser to BE | `@opentelemetry/sdk-trace-web` with fetch instrumentation in the FE, propagating only to same-origin `/ai-slides/api` URLs; optional for v1 |
| BE inbound | `opentelemetry-instrumentation-fastapi` (route-template span names) and `opentelemetry-instrumentation-sqlalchemy` on `sql_engine.sync_engine` |
| BE outbound | `opentelemetry-instrumentation-httpx` for refresh, catalog, JWKS and harness calls |
| BackgroundTasks | Capture the context in the request and attach it inside the task, so async generation stays in the request's trace (as a linked span if the task outlives the request) |
| Superset | Superset ships no tracing setup; register `FlaskInstrumentor` through `FLASK_APP_MUTATOR` in `superset_config.py` (the hook exists at `apache/superset: superset/config.py:2364`) |
| Harness and MCP | Owned by those teams; the contract is only that they accept and forward `traceparent` |

The export runtime is a child process, so its work appears as one BE span around `_run_bounded_child` (`servers/fastapi/services/export_task_service.py:356`). Never put prompts, tokens or query results into span attributes.

### 9.3 Logs

Story 2's JSON formatter writes one object per line with `ts`, `level`, `logger`, `msg`, `request_id` and `user_id`, plus `trace_id` and `span_id` from the OpenTelemetry logging integration. The platform's log agent ships stdout; nothing writes log files. The existing `[export_runtime] child started` and `child exited` lines (`servers/fastapi/services/export_task_service.py:375-379`, `:411-415`) and the `[memory]` lines from `log_memory` (`servers/fastapi/utils/runtime_limits.py:24-25`) become searchable fields for export and memory investigations.

### 9.4 Dashboards and SLOs

One Grafana dashboard with four rows: traffic and errors (RED per route), refresh (status mix, duration, upstream latency), generation and harness (rate, duration, in-flight, outcomes), export and resources (duration, in-flight, memory per pod against the limit, restarts, OOM kills, DB pool).

| SLO | Target (recommended starting point) | Measurement |
| --- | --- | --- |
| Refresh success rate | 99 percent of bindings over 28 days | `ok` divided by all statuses except `forbidden` (forbidden is correct behavior) |
| Open-to-fresh latency | p95 under 5 s for decks with up to 12 bindings | `ai_slides_refresh_duration_seconds{trigger="open"}` |
| Generation success | 97 percent over 7 days | `ai_slides_generation_total{outcome="ok"}` share |
| Export duration | p95 under 60 s, success 99 percent | `ai_slides_export_duration_seconds` |
| Availability | 99.5 percent of non-SSE requests not 5xx | `ai_slides_http_requests_total` |

### 9.5 Alerts

```yaml title="deploy/helm/ai-slides/templates/prometheusrule.yaml (new, rendered, excerpt)"
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata: {name: ai-slides}
spec:
  groups:
    - name: ai-slides.slo
      rules:
        - alert: AISlidesRefreshSuccessLow
          expr: |
            sum(rate(ai_slides_refresh_bindings_total{status="ok"}[30m]))
              / sum(rate(ai_slides_refresh_bindings_total{status!="forbidden"}[30m])) < 0.97
          for: 15m
          labels: {severity: page}
          annotations: {runbook: "https://wiki.example.com/ai-slides/runbook#refresh-failures"}
        - alert: AISlidesOpenToFreshSlow
          expr: |
            histogram_quantile(0.95, sum by (le) (rate(ai_slides_refresh_duration_seconds_bucket{trigger="open"}[15m]))) > 5
          for: 30m
          labels: {severity: ticket}
        - alert: AISlidesHandoffFailures
          expr: sum(rate(ai_slides_handoff_total{outcome!="ok"}[10m])) > 0.2
          for: 10m
          labels: {severity: page}
        - alert: AISlidesBEMemoryNearLimit
          expr: |
            max(container_memory_working_set_bytes{container="presenton-be"})
              / max(kube_pod_container_resource_limits{container="presenton-be", resource="memory"}) > 0.9
          for: 5m
          labels: {severity: ticket}
```

## Step 10: Rollout plan

| Phase | Environment | Exit criteria |
| --- | --- | --- |
| 0 | Dev cluster with chart, PVC, Ingress, stub Superset endpoints | Stories 1 to 8 integrate against real routing; smoke test green |
| 1 | Staging with real Superset, real MCP, harness | k6 profile plus exports within resource limits; all alerts wired and tested by firing them |
| 2 | Production, AI Slides menu hidden behind a Superset feature flag, pilot role only | 2 weeks within SLOs; no access-violation findings |
| 3 | Production, all analytics users | Error budget intact; on-call trained on the runbook |
| 4 | Object storage for exports, then images and uploads | PVC usage flat; signed URL path covered by tests |

## Step 11: Runbook entries

| Symptom | First checks | Likely causes and actions |
| --- | --- | --- |
| Refresh failures (`AISlidesRefreshSuccessLow`) | Status mix on the dashboard; upstream latency; Superset logs for `/api/v1/ai_slides/refresh` | Superset database slow or down (escalate to analytics on-call); data tokens expiring (`ai_slides_data_token_expired_total` rising, check FE handoff-request flow); chart definitions changed (bindings report `error` with `not_found`) |
| Handoff failures | `ai_slides_handoff_total` by outcome; BE logs for `invalid_assertion` | `jwks_error`: Superset JWKS unreachable or NetworkPolicy change; `invalid`: clock skew over 30 s or issuer mismatch after a domain change; `replayed`: FE double-posting (bug) or an attack |
| SSE streams cut at a fixed time | Ingress annotations on `presenton-be-api` | `proxy-read-timeout` lost in a chart change; a load balancer in front of the ingress with a shorter idle timeout |
| Exports fail or time out | `ai_slides_export_duration_seconds`, `[export_runtime]` log lines, pod memory | OOM kill during Chromium render (raise limit or lower concurrency); BE cannot reach `presenton-fe:3000` (NetworkPolicy); `/dev/shm` too small; default runner timeout is 300 s (`servers/fastapi/services/export_task_service.py:122`) |
| Async jobs marked "interrupted by server restart" | Recent rollouts or scale-downs | Story 2 heartbeat change missing or `AI_SLIDES_TASK_STALE_SECONDS` too low |
| BE pods not ready after deploy | `/readyz` body | `schema at X, expected Y`: migrate Job failed or did not run (check hook logs); `storage`: PVC not mounted or not writable for UID 10001 |
| Database connection errors | `ai_slides_db_pool_checked_out`, Postgres `pg_stat_activity` by `application_name` | Pool too small for in-flight streams; PgBouncer prepared-statement errors (Story 2 flags) |

## Step 12: Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Memory bursts like the unexplained 11.8 GB `VmData` peak | OOM kills, failed generations | Memory limit with headroom, alert at 90 percent, repeat load test with recovery window |
| RWX volume performance or outage | All asset reads and exports fail | Regional storage class, snapshots, phase 2 and 3 object storage |
| Regex Ingress affects Superset routes | Superset regressions | Test Superset routes in staging; Gateway API alternative |
| Upstream drift makes rebases slow | Security fixes delayed | Monthly rebase, new-file policy, automated sync PR |
| LLM egress blocked or rate-limited | Generation fails | Egress allow-list owned with the platform team; per-provider error metrics; provider fallback is a product decision, not automatic |
| Canary mixing versions within one user session | Broken streams | Backward-compatible contracts; cookie-based canary for breaking FE and BE pairs |

## Tracking: subtasks, effort and release dates

This story is planned as 7 subtasks, 15 d in total, finishing in train R11 on Fri 5 Feb 2027. The full plan, the weekly load per person and the spreadsheet download are in the [release plan and tracker](51-release-plan.md).

| ID | SubTask | Owner | Effort | Depends on | Release date | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 9.1 | Split the Dockerfile into presenton-be and presenton-fe images | Sourav | 2 d | - | R1 · Fri 13 Nov 2026 | Not started |
| 9.2 | Dev namespace: Helm chart, prefix ingress, migrate Job | Nitesh | 3 d | 9.1 | R3 · Fri 27 Nov 2026 | Not started |
| 9.3 | Secrets through External Secrets | Sourav | 1 d | 9.2 | R4 · Fri 4 Dec 2026 | Not started |
| 9.4 | Storage: RWX PVC for v1, object-storage plan | Sourav | 1 d | 9.2 | R5 · Fri 11 Dec 2026 | Not started |
| 9.5 | CI/CD: build, scan, push, deploy dev, staging and prod | Sourav | 3 d | 9.1 | R3 · Fri 27 Nov 2026 | Not started |
| 9.6 | Monitoring: metrics, tracing, dashboards, alerts | Sourav | 3 d | 9.2 | R4 · Fri 4 Dec 2026 | Not started |
| 9.7 | Production rollout: canary and pilot role | Nitesh, Sourav | 2 d | all other subtasks | R11 · Fri 5 Feb 2027 | Not started |


## What you now know

- How the stock four-process container maps onto the analytics namespace: ingress for nginx, Kubernetes for `start.js`, separate FE and BE Deployments, and no Presenton MCP.
- How to split the Dockerfile into a Chromium-carrying BE image and a lean Next.js FE image that run as non-root with a read-only root filesystem, and which build-time values the FE bakes in.
- The full set of manifests: Deployments sized from the repository's load test, Services, three Ingress objects with SSE-safe annotations, the migration hook Job, HPA on in-flight work, PDBs, NetworkPolicies and ServiceAccounts.
- Where every secret comes from and how it rotates, and every place Presenton writes to `APP_DATA_DIRECTORY`, with a phased path from an RWX volume to object storage.
- How the CI/CD pipeline builds, scans, deploys and canaries both images while the fork keeps rebasing onto upstream, and which metrics, traces, SLOs, alerts and runbook entries show whether AI Slides is healthy.

## Next

Return to the [Part VIII landing page](index.md) for the delivery plan overview, or use the [Endpoint index](../appendix-endpoints.md) to look up any route mentioned in these stories.
