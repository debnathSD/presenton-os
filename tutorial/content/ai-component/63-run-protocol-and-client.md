# Run protocol and client

<div class="chapter-meta" markdown>
**Reads:** `servers/fastapi/utils/sse.py`, `servers/fastapi/models/sse_response.py`, `servers/fastapi/api/v1/ppt/endpoints/presentation.py`, `servers/fastapi/api/v1/auth/principal.py`, `servers/fastapi/api/main.py`, `servers/nextjs/app/(presentation-generator)/outline/hooks/useOutlineStreaming.ts`, `servers/nextjs/app/(presentation-generator)/services/api/chat.ts`, `servers/nextjs/app/(presentation-generator)/services/api/header.ts`  ·  **Builds on:** [Artifact Spec and targets](62-artifact-spec-and-targets.md)  ·  **Time:** ~60 min
</div>

This chapter specifies the wire contract between the browser and the GCK Engine and builds both ends of it: the run lifecycle and endpoints, every stream event with a JSON example, ordering and idempotency, block-level JSON Patch plus `text.delta`, outline review, the error model, resume with `Last-Event-ID` from a server-side event log, heartbeats, auth and CORS. You get the full TypeScript for `@gck/protocol` events and the `@gck/client` transport, an AG-UI mapping, and a FastAPI sketch of the event log that generalizes Presenton's SSE helpers.

A run resolves each data binding once, but no GCK output may keep the numbers of that moment. The data side of the protocol (protocol 1.1, additive to `gck.artifact/1`) therefore has two halves: inside a run, `binding.resolved` carries each binding's live Superset snapshot, status and error (Step 3); after the run, the **refresh protocol** (`/v1/data/catalog`, `/v1/data/resolve`, `/v1/render`, Step 16) re-resolves the stored binding definitions as the viewing user on open, on demand, on an interval, when artifact parameters change and when host filters change, and headless for schedules. The data model itself (binding sources, snapshots, parameters, refresh policies, per-target behavior and viz coverage) is in [Live Superset data](69-live-superset-data.md).

Files under `gck/` and `gck_engine/` are **new code** for Part IX; files under `servers/` are Presenton at snapshot `571461f`. Superset citations of the form `apache/superset: path:line` refer to the Superset master clone used for Part IX.

## Step 1: What the protocol must fix in Presenton's streams

[Streaming (SSE)](../presenton/10-streaming.md) covers Presenton's streams; four of their properties block reuse.

1. **The stream is the generation.** A dropped outline or Standard stream restarts all LLM calls (the hooks reset their buffers before retrying, `servers/nextjs/app/(presentation-generator)/outline/hooks/useOutlineStreaming.ts:82-100`); a Smart stream re-runs the generator, which replays checkpointed slides and continues (`servers/fastapi/api/v1/ppt/endpoints/presentation.py:1941-1993`).
2. **Frames carry no id.** `SSEResponse.to_string()` writes only `event:` and `data:` lines (`servers/fastapi/models/sse_response.py:10-11`), so the browser has nothing to send back as `Last-Event-ID`.
3. **The browser uses `EventSource`**, which can only `GET` without custom headers (`useOutlineStreaming.ts:105-109`). Auth therefore rides on the session cookie, which `resolve_request_principal` checks before any `Bearer` API key (`servers/fastapi/api/v1/auth/principal.py:22-57`).
4. **Errors are a string plus optional metadata.** Smart streams add `source`, `status_code`, `error_type`, `retryable`, `completed_slides` and `total_slides` (`presentation.py:2246-2267`); outline and Standard streams send only `detail`.

A component mounted inside Superset, a Tiptap page or a third-party site needs the opposite on every point: generation that survives the connection, numbered events, header-based auth with no cookie, and machine-readable errors.

## Step 2: The run lifecycle and endpoints

A **run** is one request to turn a prompt plus host context into an Artifact (the IR from [Artifact Spec and targets](62-artifact-spec-and-targets.md)). The engine executes the run as a background task; HTTP connections only observe it.

Paths below are relative to the engine base URL `{engine}`, the `engineUrl` given to `GckClient`. It never contains `/v1` (the client appends `/v1/runs...` itself): a standalone engine is `https://gck.example.com`, an engine behind a same-origin ingress is for example `/gck-engine`, and an engine mounted inside Presenton is `/api/gck` ([Extracting the engine from Presenton](66-extracting-from-presenton.md)). The URLs in `RunCreated` are absolute paths that include that mount prefix; the client does not rely on them.

| Method and path | Request | Success response | Idempotency |
|---|---|---|---|
| `POST /v1/runs` | `RunRequest` JSON, headers `Authorization`, optional `Idempotency-Key` | `201 {runId, streamUrl, inputUrl, cancelUrl, createdAt}`; with `Accept: text/event-stream` instead `200` and the event stream, run id in header `GCK-Run-Id` | same key within 24 h returns the same run (`200`) |
| `GET /v1/runs/{runId}/events` | headers `Authorization`, optional `Last-Event-ID` | `200 text/event-stream` | safe to repeat |
| `GET /v1/runs/{runId}` | none | `200 RunSummary` (state, `lastEventId`, `artifactVersion`, pending input, error) | safe |
| `GET /v1/runs/{runId}/artifact` | none | `200 {version, lastEventId, artifact, bindingState}`; `bindingState` is the latest `binding.resolved` payload per binding (protocol 1.1) | safe |
| `POST /v1/runs/{runId}/input` | `{inputId, kind, decision, outline?}` | `202 {accepted: true}` | same `inputId` and same body returns `202` again; a different body returns `409 input_already_resolved` |
| `POST /v1/runs/{runId}/cancel` | `{reason?}` | `202 {state}` | always `202`; a terminal run reports its final state |

Bindings are re-resolved outside any run through three more endpoints, `GET /v1/data/catalog`, `POST /v1/data/resolve` and `POST /v1/render`; they share this chapter's auth, SSE framing and error model and are specified in Step 16.

The request body is the one fixed in the blueprint, with the protocol 1.1 data fields filled in for a run started on a filtered Superset dashboard:

```json title="POST /v1/runs (request body)"
{
  "intent": "generate",
  "prompt": "Create a QBR page for EMEA from the Sales dashboard",
  "target": { "id": "tiptap-doc", "manifestVersion": "1.0.0", "manifest": {} },
  "context": { "host": "superset", "surface": "dashboard", "dashboardId": 37, "selection": null,
               "document": null, "locale": "en", "theme": {} },
  "data": { "provider": "superset", "allowedChartIds": [412, 413], "allowedDatasetIds": [12],
            "scope": { "host": "superset_dashboard", "dashboardId": 37,
                       "dataMask": { "NATIVE_FILTER-r1": { "extraFormData": {
                         "filters": [{ "col": "region", "op": "IN", "val": ["EMEA"] }] } } },
                       "permalinkKey": "kq2Lm9PzR4x", "capturedAt": "2026-11-03T10:15:02Z" },
            "rowLimit": 50 },
  "options": { "reviewOutline": true, "maxSections": 8, "tone": "professional" }
}
```

| `data` field | Since | Meaning |
|---|---|---|
| `provider` | 1.0 | Data provider id, `"superset"`. |
| `allowedChartIds` | 1.0 | Saved charts the viewer can see (from the catalog); the planner may bind only these. |
| `allowedDatasetIds` | 1.1 | Datasets the planner may use for `superset_dataset` and `superset_metric` sources. |
| `scope` | 1.1 | `HostDataScope`: the host's filter state at submit. On a dashboard it is the native filters' own `extraFormData` per filter id plus a dashboard permalink key (`POST /api/v1/dashboard/<pk>/permalink`, `apache/superset: superset/dashboards/permalink/api.py:48`), so the capture is durable. The engine stores it as `Artifact.dataContext` and gives every binding it stamps `filter_context: {dashboard_id, mode: "captured", data_mask, permalink_key}`, so the narrative and every later refresh use the same filter selection. |
| `params` | 1.1 | The viewer's current values for the artifact parameters of an `edit` base (`Record<string, ParamValue>`). |
| `rowLimit` | 1.1 | Default `row_limit` for bindings the engine stamps; the server cap is 500 (`AI_SLIDES_MAX_ROW_LIMIT`, [Story 8](../delivery/49-story8-analytics-mcp.md)). |

Every field is optional and additive: a 1.0 engine ignores the 1.1 fields, and a 1.1 engine treats a missing `scope` as "no host filters".

The other two intents use the same body and differ in what `context` carries. A `transform` sends the content to rewrite in `context.selection`, as Artifact blocks (the target's `fromHost` output for the user's selection), and is applied with `replace` by default:

```json title="POST /v1/runs (transform request)"
{
  "intent": "transform",
  "prompt": "Turn the selected text into one chart block. Use only charts from the data catalog.",
  "target": { "id": "tiptap-doc", "manifestVersion": "1.0.0", "manifest": {} },
  "context": { "host": "tiptap", "surface": "document", "locale": "en",
               "selection": [
                 { "id": "blk_u4k9x2m7qa", "type": "paragraph",
                   "text": [{ "text": "Pipeline grew fastest in Germany and France this quarter." }] }],
               "document": { "outline": ["## Pipeline by region"], "before": "", "after": "" } },
  "data": { "provider": "superset", "allowedChartIds": [412, 413] },
  "options": { "reviewOutline": false }
}
```

An `edit` sends the artifact it changes in `context.document`: the artifact applied earlier, re-read from the host with `fromHost` so it includes the user's own edits since, with its `id`, `bindings` and `provenance` kept. It is applied with `patch` by default:

```json title="POST /v1/runs (edit request)"
{
  "intent": "edit",
  "prompt": "Make the pipeline section shorter and add a revenue KPI",
  "target": { "id": "tiptap-doc", "manifestVersion": "1.0.0", "manifest": {} },
  "context": { "host": "tiptap", "surface": "document", "locale": "en",
               "document": {
                 "id": "art_01JC8Q4M6X2N7YB5K3P9R2T8VW", "version": "gck.artifact/1", "title": "EMEA QBR", "target": "tiptap-doc",
                 "sections": [
                   { "id": "sec_q7x2m400", "kind": "section", "title": "EMEA at a glance", "blocks": [] },
                   { "id": "sec_q7x2m401", "kind": "section", "title": "Pipeline by region", "blocks": [
                     { "id": "blk_q7x2m40100", "type": "paragraph", "text": [{ "text": "Pipeline reached a record level across EMEA, led by Germany, France and the Nordics." }] },
                     { "id": "blk_q7x2m40101", "type": "chart", "bindingId": "b_c413", "chartType": "bar" }] }],
                 "bindings": {
                   "b_c412": { "kind": "metric",
                               "source": { "type": "superset_chart", "chart_id": 412, "dashboard_id": 37, "viz_type": "big_number",
                                           "filter_context": { "dashboard_id": 37, "mode": "captured", "permalink_key": "kq2Lm9PzR4x",
                                             "data_mask": { "NATIVE_FILTER-r1": { "extraFormData": {
                                               "filters": [{ "col": "region", "op": "IN", "val": ["EMEA"] }] } } } } },
                               "mapping": { "metric": "revenue", "x": "order_date", "compare": "previous_period" },
                               "format": { "number": "SMART_NUMBER", "delta": "+.1%" },
                               "generatedAgainst": { "snapshot_hash": "5c0e9a71d2b4", "snapshotAt": "2026-11-03T10:15:11Z" } },
                   "b_c413": { "kind": "chart",
                               "source": { "type": "superset_chart", "chart_id": 413, "dashboard_id": 37, "viz_type": "echarts_timeseries_bar",
                                           "filter_context": { "dashboard_id": 37, "mode": "captured", "permalink_key": "kq2Lm9PzR4x",
                                             "data_mask": { "NATIVE_FILTER-r1": { "extraFormData": {
                                               "filters": [{ "col": "region", "op": "IN", "val": ["EMEA"] }] } } } } },
                               "mapping": { "x": "country", "series": ["pipeline"], "series_labels": { "pipeline": "Pipeline" } },
                               "generatedAgainst": { "snapshot_hash": "a81f03c6e9d7", "snapshotAt": "2026-11-03T10:15:12Z" } } },
                 "provenance": { "runId": "run_01JC8Q4M6X2N7Y", "createdAt": "2026-11-03T10:15:03Z", "prompt": "Create a QBR page for EMEA" } } },
  "data": { "provider": "superset", "allowedChartIds": [412, 413], "params": {} },
  "options": { "reviewOutline": false }
}
```

The bindings in an edit base are **definitions only** (`kind`, `source`, `mapping`, `format`, `params`, `refresh`, `generatedAgainst`): hosts persist artifacts through `stripRuntime`, and the engine ignores any `snapshot`, `snapshotAt`, `status` or `error` it receives, because it re-resolves every binding the edited artifact references as the caller (Step 5). A `mapping` is never `{}` except for kind `embed`; mappings are derived by the engine from the catalog, never by the model ([Live Superset data](69-live-superset-data.md)).

| Intent | `context.selection` | `context.document` | Version line starts at | Default apply mode |
|---|---|---|---|---|
| `generate` | optional host hint (a convention per host) | optional compact digest | empty, the first patch is a root replace to version 1 | the host's choice (`insert_at_cursor`, `append`, `replace`) |
| `transform` | required: `Block[]` to rewrite | optional compact digest | empty, as for `generate` | `replace` (the selection) |
| `edit` | optional: blocks to focus on | required: the base `Artifact` | the base, as version 0 (Step 5) | `patch` |

Engine run states are `queued`, `planning`, `awaiting_input`, `generating`, `resolving_data`, `completed`, `failed`, `cancelled` and `expired`. Data resolution starts as soon as the final plan names the bindings, so it overlaps `generating`: `RunSummary.state` stays `generating` while content is still being written and becomes `resolving_data` only when nothing but bindings remains in flight. The browser machine in [React SDK and UI kit](64-react-sdk-and-ui-kit.md) adds `composing`, `submitting`, `ready`, `applying` and `applied`.

The two-step form (`201`, then `GET`) gives the browser a run id before the stream connects, so a reload or a cancel button can address the run; the one-shot form is for server-to-server callers and tests.

## Step 3: The event envelope and every event type

Each SSE frame carries one event: `id:` is the sequence number, `event:` repeats the type for `curl` and devtools, and `data:` is one line of compact JSON:

```text title="One frame on the wire"
id: 7
event: artifact.patch
data: {"v":1,"id":7,"runId":"run_01JC8Q4M6X2N7Y","ts":"2026-11-03T10:15:09.402Z","type":"artifact.patch","data":{"baseVersion":3,"version":4,"ops":[{"op":"add","path":"/sections/1/blocks/-","value":{"id":"blk_q7x2m40100","type":"paragraph","text":[]}}]}}

```

Envelope fields: `v` (protocol major, `1`), `id` (gapless from 1), `runId`, `ts` (ISO 8601), `type`, `data`, and an optional `progress` `{phase, message?, completed?, total?}` that replaces Presenton's free-text `status` frames. The client trusts the JSON `type`, not the `event:` line.

| `type` | `data` | When |
|---|---|---|
| `run.started` | `{runId, target: {id, manifestVersion}}` | first event of every run |
| `plan.proposed` | `{outline: OutlineItem[], planVersion, final}` | after planning; again with `final: true` after review |
| `run.awaiting_input` | `{kind: "outline_review", inputId, expiresAt}` | only when `options.reviewOutline` |
| `artifact.patch` | `{baseVersion, version, ops: JsonPatchOp[]}` | primary content channel |
| `text.delta` | `{blockId, path, delta, format, baseVersion}` | optional, inside one block |
| `binding.resolved` | `BindingUpdate`: `{bindingId, status, snapshot?, snapshotAt?, error?, changed?, reason?}` (Step 16.4) | per data binding, from the final plan on, in section order |
| `run.warning` | `{code, message, blockId?}` | non-fatal problems |
| `run.completed` | `{artifactVersion, usage}` | terminal, success |
| `run.failed` | `{code, message, retryable, retryAfterMs?, details?, completedSections?, totalSections?}` | terminal, failure or cancel |

Examples of each payload (envelope fields other than `type` omitted):

```json title="Event payloads"
{"type":"run.started","data":{"runId":"run_01JC8Q4M6X2N7Y","target":{"id":"tiptap-doc","manifestVersion":"1.0.0"}}}

{"type":"plan.proposed","data":{"planVersion":1,"final":false,"outline":[
  {"sectionId":"sec_q7x2m400","title":"EMEA at a glance","summary":"Headline revenue and growth","layoutHint":null,"bindings":["b_c412"]},
  {"sectionId":"sec_q7x2m401","title":"Pipeline by region","summary":"Bar chart, top 5 countries","layoutHint":null,"bindings":["b_c413"]}]}}

{"type":"run.awaiting_input","data":{"kind":"outline_review","inputId":"in_4c1","expiresAt":"2026-11-03T10:45:05Z"}}

{"type":"artifact.patch","data":{"baseVersion":0,"version":1,"ops":[{"op":"replace","path":"","value":{"id":"art_01JC8Q4M6X2N7YB5K3P9R2T8VW",
  "version":"gck.artifact/1","title":"EMEA QBR","target":"tiptap-doc","sections":[],"bindings":{},"provenance":{"runId":"run_01JC8Q4M6X2N7Y","createdAt":"2026-11-03T10:15:03Z","prompt":"Create..."}}}]}}

{"type":"text.delta","data":{"blockId":"blk_q7x2m40100","path":"/text/0/text","delta":"Revenue grew in every ","format":"text","baseVersion":4}}

{"type":"binding.resolved","data":{"bindingId":"b_c412","status":"ok","snapshotAt":"2026-11-03T10:15:11Z","changed":false,
  "snapshot":{"value":1840000,"previous":1610000,"previous_label":"Sep 2026",
    "meta":{"rowcount":24,"truncated":false,"is_cached":false,"query_ts":"2026-11-03T10:15:10Z",
            "query_context_source":"saved_query_context","resolved_by":"Xq3v9KfR2mPa7LwB",
            "scope_hash":"e3b7c1f09a24","time_range":{"label":"Last year"},
            "applied_filters":[{"column":"region"}],"rejected_filters":[],
            "schema":{"x":"order_date","series":["revenue"]}}}}}

{"type":"run.warning","data":{"code":"binding_dropped","message":"Chart 413 is not visible to you and was left out.","blockId":"blk_q7x2m40101"}}

{"type":"run.completed","data":{"artifactVersion":17,"usage":{"inputTokens":5120,"outputTokens":2210,"durationMs":14890,"model":"gpt-4.1"}}}

{"type":"run.failed","data":{"code":"rate_limited","message":"The model provider is rate limiting requests.","retryable":true,"retryAfterMs":20000,"completedSections":2,"totalSections":6}}
```

`completedSections` and `totalSections` are the generalization of Smart mode's `completed_slides` and `total_slides` error metadata (`presentation.py:2258-2267`).

### 3.1 Data inside a run: `binding.resolved` (protocol 1.1)

`binding.resolved` carries exactly the `BindingUpdate` that the refresh protocol sends (Step 16), so one reducer in the browser serves runs and refreshes. Its `snapshot` has one normative shape per binding kind, in snake_case, the same JSON that Part VIII stores in `slide_data_bindings` ([Story 1](../delivery/42-story1-dynamic-data.md)):

| Binding kind | `snapshot` | Example |
|---|---|---|
| `metric` | `MetricSnapshot {value, previous?, previous_label?, meta?}` | `{"value":1840000,"previous":1610000,"previous_label":"Sep 2026"}` |
| `chart` | `ChartSnapshot {categories, series: [{name, key?, values}], meta?}` | `{"categories":["Germany","France"],"series":[{"name":"Pipeline","key":"pipeline","values":[412000,388000]}]}` |
| `table` | `TableSnapshot {columns, labels?, coltypes?, rows, meta?}` with raw cell values | `{"columns":["country","revenue"],"labels":["Country","Revenue"],"coltypes":["string","number"],"rows":[["Germany",412000]]}` |
| `embed` | none: a live Superset chart, never a snapshot | |

`meta` is what lets a view be honest about the data: `query_ts` is the "data as of" stamp, `truncated` and `rowcount` say whether the row cap cut the result, `resolved_by` is the viewer key of whoever's row-level security view this is, `scope_hash` identifies the effective filters, `time_range` feeds the `period` token, and `applied_filters` / `rejected_filters` show which captured dashboard filters reached the query. Field-by-field definitions are in [Live Superset data](69-live-superset-data.md).

| `status` | `snapshot` | `error` | Meaning |
|---|---|---|---|
| `ok` | present | absent | Fresh result for this viewer and scope. |
| `stale` | absent | absent | A transient failure (`reason` holds the retryable code, for example `timeout`); the client keeps the snapshot it has and shows it as stale with Retry, or the unavailable panel with Retry when it has none. |
| `error` | absent | `{code, message, retryable}` | No usable data; the view shows "Data unavailable" and, when `retryable`, a Retry action. |
| `forbidden` | absent, always | `{code, message, retryable: false}` | The viewer may not read this data; nothing is shown, never another user's snapshot. |

`pending` is the status a binding is stamped with before its first resolution; the engine never sends it.

```json title="binding.resolved for the failure statuses"
{"type":"binding.resolved","data":{"bindingId":"b_c414","status":"error",
  "error":{"code":"no_query_context","message":"Open and save this chart in Superset once.","retryable":false}}}

{"type":"binding.resolved","data":{"bindingId":"b_c415","status":"forbidden",
  "error":{"code":"datasource_forbidden","message":"You do not have access to this data.","retryable":false}}}
```

How the engine produces these events during a run:

1. **Start at the final plan.** As soon as `plan.proposed` with `final: true` names the bindings, the engine resolves them as the run's principal (the data token comes from a token exchange, Step 10) and appends `binding.resolved` in section order, so the first section's numbers arrive while later sections are still being written.
2. **One code path with refresh.** Resolution goes through the same resolver as `POST /v1/data/resolve` (batches of 25 items per Story 8 call, at most 4 calls in flight, the effective scope of captured filters, parameters and pinned overrides), and the same `gck_data` mappers turn rows into snapshots.
3. **Stamp what the text was written against.** Before `run.completed` the engine sends one `artifact.patch` that replaces each resolved binding under `/bindings/{id}` with `generatedAgainst: {snapshot_hash, snapshotAt}` set. A later refresh that returns `changed: true` against it lets a view say "Text was written against data as of ... Regenerate?".
4. **Data errors never fail a run.** Each binding ends `ok`, `stale`, `error` or `forbidden`. The run fails with `data_forbidden` only when the target requires data and every requested binding is `forbidden` (Step 7).

Data-related `run.warning` codes include `data_source_unsupported` (a catalog chart that can only be embedded, with Story 8's reason), `scope_mismatch` (the prose names a filter value no binding in that section carries) and `cross_filter_not_applied` (the captured dashboard state had cross filters, which 1.1 does not propagate).

!!! warning "Gotcha"
    `binding.resolved` is the only place numbers travel. The model never writes a number into prose, and token segments keep `text: ""` in every `artifact.patch`, so a replayed or persisted artifact holds no values that could go stale or leak to another viewer. A host that renders a token from `artifact.patch` alone, without the binding overlay, shows a placeholder, which is correct.

## Step 4: Ordering and idempotency

Three counters keep the client consistent, each with one job.

| Counter | Scope | Rule on the client |
|---|---|---|
| Event `id` | per run, gapless from 1 | Drop any event with `id <= lastEventId` (a replay duplicate). If `id > lastEventId + 1`, a frame was lost: abort and reconnect with `Last-Event-ID: lastEventId`. |
| Artifact `version` | per run, increments by exactly 1 per `artifact.patch` | Apply only when `baseVersion === store.version`. If `version <= store.version`, skip (already applied). Otherwise call `GET /v1/runs/{id}/artifact` and replace the store. |
| `planVersion` | per run | The newest `plan.proposed` wins; `final: true` locks the outline. |

`text.delta`, `binding.resolved` and `run.warning` never change the artifact version. A `text.delta` whose `baseVersion` is older than its block's last replace is discarded. Binding runtime state (`snapshot`, `snapshotAt`, `status`, `error`) lives in an overlay beside the artifact, because the browser's data provider (`@gck/data-superset`) also resolves bindings after the run (Step 16) and must not fork the engine's version line. For the same reason `GET /v1/runs/{id}/artifact` returns the overlay as `bindingState` next to the artifact, and a resync keeps it (`store.reset(artifact, version, { keepBindings: true })`); at `gck.applied` the run controller copies the definitions and the overlay into the host's `BindingStore`, whose refresh controller takes over ([React SDK and UI kit](64-react-sdk-and-ui-kit.md)). Several `binding.resolved` events for one binding are applied last-writer-wins by event `id`.

On the request side, `POST /v1/runs` honors an `Idempotency-Key` header (the client generates a UUID per user submission), so a retried `POST` after a network timeout cannot start two paid runs. `POST /input` is keyed by the engine-issued `inputId`. `POST /cancel` is idempotent by definition.

!!! warning "Gotcha"
    Presenton's Standard slide chunks concatenate without commas into invalid JSON, so the client parses each chunk alone (`servers/nextjs/app/(presentation-generator)/presentation/hooks/usePresentationStreaming.ts:454-510`). In GCK every `artifact.patch` is complete JSON; the only partial JSON is a `format: "json"` `text.delta` for one block.

## Step 5: JSON Patch at block granularity, plus `text.delta`

`artifact.patch` uses RFC 6902 JSON Patch (https://www.rfc-editor.org/rfc/rfc6902) over JSON Pointers (RFC 6901, https://www.rfc-editor.org/rfc/rfc6901). The engine follows four rules that keep patches cheap to apply and easy to render:

1. **The first patch is a root replace** (`"path": ""`, the whole document in RFC 6901) that installs the skeleton at version 1, except in an `edit` run, which starts from the base (below). The same op doubles as the resync snapshot after log compaction (Step 9).
2. **Blocks are the unit of change.** Ops target `/sections/-`, `/sections/{i}/blocks/-`, `/sections/{i}/blocks/{j}`, `/bindings/{id}` or top-level fields such as `/title`, never anything deeper than a block. Renderers key by block `id`, not by index.
3. **Only `add`, `replace` and `remove` are emitted.** `move` and `copy` complicate index bookkeeping in a streaming renderer; `test` is reserved for client-side edit patches.
4. **A patch is atomic.** RFC 6902 requires that a patch with a failing op is not applied at all; the client applier in [React SDK and UI kit](64-react-sdk-and-ui-kit.md) copies on write and commits only after the last op.

A typical section arrives as three patches:

```json title="Three artifact.patch payloads for one section"
{"baseVersion":3,"version":4,"ops":[{"op":"add","path":"/sections/-","value":{"id":"sec_q7x2m401","kind":"section","title":"Pipeline by region","blocks":[]}}]}
{"baseVersion":4,"version":5,"ops":[{"op":"add","path":"/sections/1/blocks/-","value":{"id":"blk_q7x2m40100","type":"paragraph","text":[]}}]}
{"baseVersion":5,"version":6,"ops":[{"op":"replace","path":"/sections/1/blocks/0","value":{"id":"blk_q7x2m40100","type":"paragraph",
  "text":[{"text":"Pipeline reached "},{"text":"","token":{"bindingId":"b_c413","field":"total:","format":",.2s"}},{"text":" across EMEA."}]}}]}
```

An `edit` run has no skeleton to install: the stream starts from the base artifact in `context.document`, which is version 0 on both sides. The engine sends no root replace; its first `artifact.patch` has `baseVersion: 0` and changes the base in place, block by block, and `run.completed` carries the final version. Untouched blocks are never re-sent, changed blocks are replaced under their existing id, removed blocks are removed and new blocks get new ids, so the client can diff the final artifact against the base by block id (the run controller exposes that diff as `run.diff`). For the edit request above:

```json title="The edit run's stream (payloads only)"
{"type":"artifact.patch","data":{"baseVersion":0,"version":1,"ops":[{"op":"replace","path":"/sections/1/blocks/0","value":{"id":"blk_q7x2m40100","type":"paragraph",
  "text":[{"text":"Pipeline hit a record, led by Germany and France."}]}}]}}
{"type":"artifact.patch","data":{"baseVersion":1,"version":2,"ops":[{"op":"add","path":"/sections/0/blocks/-","value":{"id":"blk_q7x2m40102","type":"metric","bindingId":"b_c412","label":"Revenue","compare":"previous_period"}}]}}
{"type":"binding.resolved","data":{"bindingId":"b_c412","status":"ok","snapshotAt":"2026-11-03T10:31:40Z","changed":true,
  "snapshot":{"value":1872000,"previous":1610000,"previous_label":"Sep 2026"}}}
{"type":"binding.resolved","data":{"bindingId":"b_c413","status":"ok","snapshotAt":"2026-11-03T10:31:41Z","changed":false,
  "snapshot":{"categories":["Germany","France","Nordics"],"series":[{"name":"Pipeline","key":"pipeline","values":[412000,388000,251000]}]}}}
{"type":"artifact.patch","data":{"baseVersion":2,"version":3,"ops":[
  {"op":"replace","path":"/bindings/b_c412","value":{"kind":"metric","source":{"type":"superset_chart","chart_id":412,"dashboard_id":37,"viz_type":"big_number",
    "filter_context":{"dashboard_id":37,"mode":"captured","permalink_key":"kq2Lm9PzR4x",
      "data_mask":{"NATIVE_FILTER-r1":{"extraFormData":{"filters":[{"col":"region","op":"IN","val":["EMEA"]}]}}}}},
    "mapping":{"metric":"revenue","x":"order_date","compare":"previous_period"},"format":{"number":"SMART_NUMBER","delta":"+.1%"},
    "generatedAgainst":{"snapshot_hash":"0d4be27f81a3","snapshotAt":"2026-11-03T10:31:40Z"}}}]}}
{"type":"run.completed","data":{"artifactVersion":3,"usage":{"inputTokens":3410,"outputTokens":420,"durationMs":5210,"model":"gpt-4.1"}}}
```

An edit run re-resolves **every** binding the resulting artifact references, not only the one behind the new metric block, so an edited page never mixes fresh numbers with numbers from the original run. `changed` compares the new snapshot hash with the binding's `generatedAgainst`: `b_c412` moved since the page was generated, so the engine re-stamps it (the `artifact.patch` at version 3) because the rewritten text now describes the new value; `b_c413` did not move and keeps its stamp.

A client therefore resets its store to the base at version 0 before it reads the stream (`createRunController` and `runToCompletion` both do). `GET /v1/runs/{runId}/artifact` on an edit run returns the base with the patches applied, and after log compaction the resync snapshot is a root replace at `baseVersion: 0` like in any other run, which replaces the store but keeps every block id.

Between version 5 and 6, `text.delta` events let the paragraph type itself out. Two formats exist:

| `format` | `path` | `delta` | Client behavior |
|---|---|---|---|
| `text` | pointer inside the block, for example `/text/0/text` | plain string to append | append to a draft copy of the block |
| `json` | `""` | raw JSON text of the whole block, in pieces | append to a buffer, run `jsonrepair`, parse, show as a provisional block |

The `json` format streams lists, tables and callouts. It is the technique Presenton's outline hook applies to the whole outline (`useOutlineStreaming.ts:133-139`), narrowed to one block so a failed repair only affects that block. The block's final `replace` always wins and clears the draft.

!!! warning "Gotcha"
    Pointers use array indexes, so they are only safe while the engine is the sole writer. The client store is read-only from `submitting` until `ready`; user edits during a run are limited to the outline review form, which is sent through `POST /input`, not patched locally. Allowing local edits mid-stream would shift indexes under the engine's next op.

## Step 6: Human-in-the-loop outline review

When `options.reviewOutline` is true, the engine pauses after planning for the user to confirm the outline: the checkpoint Presenton implements as a whole page ([User journey](../presenton/21-user-journey.md)), here a pause inside one run.

1. The engine emits `plan.proposed` (`final: false`) then `run.awaiting_input` with an `inputId` and an `expiresAt` (default 30 minutes).
2. The stream stays open and sends heartbeats. The client may disconnect; the run stays parked.
3. The client posts the decision:

```json title="POST /v1/runs/{runId}/input"
{
  "inputId": "in_4c1",
  "kind": "outline_review",
  "decision": "edit",
  "outline": [
    { "sectionId": "sec_q7x2m401", "title": "Pipeline by region", "summary": "Top 5 countries only", "layoutHint": null, "bindings": ["b_c413"] },
    { "sectionId": null, "title": "Risks", "summary": "Three risks with owners", "layoutHint": null, "bindings": [] }
  ]
}
```

`decision` is `approve` (no `outline`), `edit` (full replacement list: reorder, delete, rename and add are all expressed by the list) or `cancel`. New sections have `sectionId: null`; the engine assigns ids.

4. The engine validates: at most `limits.maxSections` from the manifest, titles of at most 200 characters, and `bindings` a subset of what the planner offered (no chart ids outside `allowedChartIds`, no dataset ids outside `allowedDatasetIds`). Failures return `422` and leave the run waiting.
5. On success the engine emits `plan.proposed` with `planVersion: 2, final: true` (normalized, all ids assigned), then `artifact.patch` events.
6. If `expiresAt` passes, the run ends with `run.failed {code: "input_expired", retryable: false}`.

```mermaid
sequenceDiagram
    participant U as User
    participant C as GckClient
    participant E as GCK Engine
    participant L as Event log
    C->>E: POST /v1/runs with reviewOutline true
    E-->>C: 201 runId
    C->>E: GET events
    E->>L: append run.started and plan.proposed
    E->>L: append run.awaiting_input
    L-->>C: events 1 to 3
    Note over C,E: heartbeat comments every 15 s while waiting
    U->>C: reorder, delete, rename sections
    C->>E: POST input decision edit
    E-->>C: 202 accepted
    E->>L: append plan.proposed final and artifact.patch
    L-->>C: events 4 to n
    E->>L: append run.completed
    L-->>C: run.completed
```

## Step 7: The error model

Every error, whether returned as an HTTP response body or as `run.failed`, has the same shape:

```json title="Error body"
{ "error": { "code": "rate_limited", "message": "The model provider is rate limiting requests.",
             "retryable": true, "retryAfterMs": 20000, "details": { "provider": "openai" } } }
```

| `code` | HTTP | `retryable` | Meaning and client action |
|---|---|---|---|
| `invalid_request` | 400 / 422 | false | Validation failed; show `message`. |
| `unauthorized` | 401 | false | No or bad token. |
| `token_expired` | 401 | true | Refresh the token once, retry. |
| `forbidden` | 403 | false | Not allowed for this target, host or run. |
| `not_found` | 404 | false | Unknown run, or someone else's. |
| `conflict` / `input_already_resolved` | 409 | false | Stale input or duplicate decision. |
| `rate_limited` | 429 | true | Wait `retryAfterMs` (also sent as `Retry-After`). |
| `quota_exceeded` | 429 | false | Tenant budget spent. |
| `context_too_large` | 413 / stream | false | Ask the user to narrow context. |
| `model_output_invalid` | stream | true | The model failed schema validation after the engine's own retries. |
| `model_unavailable` | 502 / 503 / stream | true | Provider down or timed out. |
| `data_forbidden` | stream | false | The target requires data and **every** requested binding is `forbidden` for the user. One forbidden binding among others is a `binding.resolved` with `status: "forbidden"`, not a run error. |
| `data_unavailable` | stream | true | Protocol 1.0 only. A 1.1 engine never sends it: a failing data provider becomes per-binding `stale` or `error`. |
| `data_token_expired` | 401 / stream | true | The engine could not exchange the caller's engine token for a data token (protocol 1.1). Call the token provider with `forceRefresh: true` and retry once. |
| `input_expired` | stream | false | Outline review timed out. |
| `cancelled` | stream | false | Cancel endpoint or engine shutdown. |
| `internal` | 500 / stream | true | Anything else. |

For unclassified exceptions, `retryable` follows Presenton's Smart rule: true for 408, 429 and 500 or more (`presentation.py:2257-2264`). A retryable `run.failed` means "a new run with the same request may succeed"; the run itself is terminal. Transport problems (dropped connection, heartbeat timeout, proxy `502` on `GET /events`) never produce `run.failed`; the client reconnects (Step 9).

Data problems are a second, smaller error model that lives **per binding**, in `binding.resolved.data.error` (`{code, message, retryable}`) or, for transient failures, in `binding.resolved.data.reason`, in runs and refreshes alike. The codes, grouped by the status they produce:

| Binding `error.code` | `status` | Retryable | Client action |
|---|---|---|---|
| `forbidden`, `chart_forbidden`, `datasource_forbidden` | `forbidden` | no | Show nothing, never Retry. |
| `chart_not_found`, `datasource_not_found`, `no_query_context`, `unsupported_viz`, `unsupported_viz_type`, `multi_query`, `source_unsupported`, `mapping_invalid`, `mapping_changed`, `invalid_override`, `param_invalid`, `no_data_identity`, `element_missing` | `error` | no | Explain, offer "Open in Superset" where it helps. |
| `query_failed`, `cache_load_failed`, `invalid_query`, `analytics_error`, `missing_result`, `internal_error`, `timeout`, `analytics_unavailable` | `stale`, with the code in `reason` and no `error` | yes | Keep the snapshot the client holds, badge it, offer Retry (with backoff). |

The user-facing text for each code and the 1.2 SQL codes are in [Live Superset data](69-live-superset-data.md). Two whole-request conditions of the refresh protocol, `rate_limited` and `data_token_expired`, arrive as `refresh.failed` or as an HTTP error instead (Step 16).

!!! warning "Gotcha"
    Presenton's outline hook retries on a server `error` frame (`useOutlineStreaming.ts:210-229`), which re-runs the whole LLM pipeline up to three times without asking. GCK separates the two concerns: the client reconnects transparently, but it never restarts a failed run on its own. Restarting is a user action ("Try again") because it costs tokens.

## Step 8: Why fetch-based SSE, not `EventSource`

The WHATWG HTML standard defines `EventSource` with one option, `withCredentials`; there is no way to set the method or request headers (https://html.spec.whatwg.org/multipage/server-sent-events.html). That is why Presenton's stream routes are `GET`s keyed by an id in the path (`useOutlineStreaming.ts:105-109`, `usePresentationStreaming.ts:300`). For GCK the limits are blocking:

| Need | `EventSource` | `fetch` + `ReadableStream` |
|---|---|---|
| `Authorization: Bearer` header | not possible; cookie only | yes |
| `POST` with a JSON body (one-shot mode) | no | yes |
| Read the JSON body of a `401` or `429` | no; any non-200 fails the connection and only fires `error` | yes |
| Control reconnect timing and give up | browser-controlled; the spec reconnects after network errors | fully client-controlled |
| `Last-Event-ID` on reconnect | automatic, but only for its own reconnects | the client sets it explicitly on every reconnect it makes; after a page reload the run is found again by its id |
| Cancel with `AbortSignal` | `close()` only | yes |
| Detect a silent dead connection | no | heartbeat watchdog |

Presenton already has a fetch-based reader for chat: it `POST`s with an `AbortSignal` (`servers/nextjs/app/(presentation-generator)/services/api/chat.ts:104-116`), reads `response.body` with a `TextDecoder` and splits frames on `"\n\n"` (`chat.ts:294-308`; quoted in [Story 4](../delivery/45-story4-native-charts-ux.md)). `@gck/client` keeps that structure and fixes three things for a general transport: it splits lines on CR, LF and CRLF as the SSE grammar requires (the chat reader looks for `"\n\n"` before it strips `\r` inside `processSseFrame`, `chat.ts:136`, so a CRLF-framed stream would never split), it honors `id:` and `retry:` fields (ignored by the chat reader, `chat.ts:141-149`), and it treats comment lines as heartbeats.

!!! warning "Gotcha"
    Presenton's `getHeader()` sends `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers` as request headers (`servers/nextjs/app/(presentation-generator)/services/api/header.ts:1-9`). Those are response headers; on a request they do nothing except force a CORS preflight and require the server to allow them. It works today only because FastAPI allows every header (`servers/fastapi/api/main.py:94-100`). Do not copy `getHeader()` into the kit.

## Step 9: Resume, the event log, backpressure and heartbeats

### 9.1 Resume with `Last-Event-ID`

The SSE standard says that a non-empty last event id is sent in a `Last-Event-ID` header on reconnection, and that an `id` containing U+0000 is ignored. GCK uses the same header for its own reconnects, set by the client:

1. The client remembers `lastEventId`, the highest event id it has processed (not just received).
2. On reconnect it sends `GET /v1/runs/{id}/events` with `Last-Event-ID: 41`.
3. The engine reads events with `seq > 41` from the event log, sends them, then tails new events live.
4. If the log was compacted past 41, the engine first sends a synthetic root-`replace` `artifact.patch` with `baseVersion: 0`, which the client treats as "reset the store" (`isSnapshotPatch`, Step 11). Compaction keeps the latest `binding.resolved` row per binding, and the engine replays those rows right after the synthetic patch, so a resumed client gets its data overlay back and not only the text.

!!! warning "Gotcha"
    The event log holds the run principal's data, so it is readable only by that principal (`load_run_for_principal_or_404`, Step 13), and 24 hours after the run completes the engine rewrites every `binding.resolved` payload to `{bindingId, status, snapshot_hash}`. A replay after that window restores the text and the binding statuses but no numbers; the client's refresh controller fetches fresh ones as the viewer. Never serve a run's log to a different user to "share" a result: share the artifact, whose bindings each viewer resolves as themselves.

A page reload can resume too: with a `resumeKey`, `@gck/react` keeps the active run's `{runId}` in `sessionStorage` and, after the reload, replays that run's log from the first event into a fresh store ([React SDK and UI kit](64-react-sdk-and-ui-kit.md)).

This generalizes what Presenton does for Smart mode. There, slides are checkpointed to the database before they are emitted:

```python title="servers/fastapi/api/v1/ppt/endpoints/presentation.py (excerpt)"
            # Checkpoint before emitting. If the model later runs out of tokens
            # or the SSE client reconnects, generation resumes after this slide
            # instead of throwing away the accepted prefix.
            async with async_session_maker() as checkpoint_session:
```

(`presentation.py:2075-2078`.) On reconnect, `stream_smart_presentation` replays every saved slide as a `slide_html` frame and resumes from the next slide (`presentation.py:1941-1993`). GCK keeps the rule (persist before you emit) and changes two things: it persists events, not domain rows, so any target can replay; and generation is a background task, so a reconnect only replays and tails. In Presenton the generation task is cancelled when the stream generator exits early (`presentation.py:2189-2192`); in GCK only `POST /cancel` cancels.

### 9.2 Backpressure

The log is the buffer. The run task appends and notifies; each subscriber reads the log at its own pace, by sequence number, in pages of 200. A slow browser costs a cursor and a database read, never a growing in-memory queue. At the source, the engine coalesces `text.delta` per block into at most one event per 50 ms, and marks those rows ephemeral so they are pruned once the block's final `replace` is committed. On the client, the store notifies React at most once per animation frame, so a burst of replayed events renders once.

### 9.3 Heartbeats

No Presenton SSE endpoint sends keepalives; the bundled nginx relies on 30-minute read timeouts (`nginx.conf:45-69`). That fails behind a load balancer with a 60-second idle timeout, which is where an embedded component lives. The WHATWG standard suggests a comment line about every 15 seconds. The engine writes `: hb` every 15 seconds of silence, and the client aborts and reconnects after 45 seconds without any bytes (three missed heartbeats). The engine also sends `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` so nginx-style proxies do not buffer the stream.

```mermaid
sequenceDiagram
    participant C as GckClient
    participant P as Proxy
    participant E as GCK Engine
    participant L as Event log
    C->>P: GET events, no Last-Event-ID
    P->>E: forward
    E->>L: read seq after 0
    L-->>C: events 1 to 41
    Note over C,P: proxy drops the idle connection
    C->>C: no bytes for 45 s, abort, backoff 1 s
    C->>P: GET events, Last-Event-ID 41
    P->>E: forward
    E->>L: read seq after 41
    L-->>C: events 42 to 57 replayed
    E->>L: append event 58
    L-->>C: event 58 live
    Note over C: ids 1 to 41 never re-applied
```

## Step 10: Authentication, tokens and CORS

The kit never holds a long-lived secret. The host passes a **token provider** callback:

```ts
type TokenProvider = (opts: { forceRefresh: boolean }) => Promise<string | null>;
```

- The client calls it before **every** request, including every reconnect, so a token that expired during a long review pause is replaced transparently. Hosts cache the token until shortly before expiry.
- Tokens are short-lived (5 minutes) and audience-scoped to the engine, minted by the host's own backend ([Host integrations](65-host-integrations.md)).
- On `401 token_expired` the client calls the provider once with `forceRefresh: true` and retries once.
- Requests use `credentials: "omit"`: no cookie, so no third-party-cookie blocking and no CSRF surface.

The engine token is not a data token, and the browser never holds one. When a run or a refresh needs Superset data, the engine exchanges the caller's engine token for a short-lived data token at a new Story 8 endpoint, `POST /api/v1/ai_slides/token-exchange` (RFC 8693 shape, https://www.rfc-editor.org/rfc/rfc8693: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, the engine token as `subject_token`, `scope=ai_slides:refresh`, client authentication by `private_key_jwt`). Superset verifies the subject token, resolves the user and returns a 15-minute Bearer token with audience `analytics-data`. The engine caches it per `(sub, scope)` until 30 seconds before expiry and never logs it or writes it into an event. Every query then runs inside Superset as that user, under `override_user` (`apache/superset: superset/utils/core.py:1633`), and goes through Superset's chart data command (`apache/superset: superset/commands/chart/data/get_data_command.py:36`), so the user's permissions and row-level security apply. If the exchange fails because the subject token expired, the engine answers `data_token_expired` and the client refreshes its engine token once. Hosts without a Superset session or a shared identity provider get no data token at all; their bindings resolve to `error` with `no_data_identity`. The identity bridges per host are in [Live Superset data](69-live-superset-data.md).

When the engine is cross-origin, every GCK request is preflighted (an `Authorization` header and `Last-Event-ID` are not CORS-safelisted). The engine's CORS policy should be:

| Header | Value |
|---|---|
| `Access-Control-Allow-Origin` | the exact host origin from an allowlist, never `*` for authenticated routes |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS` |
| `Access-Control-Allow-Headers` | `Authorization, Content-Type, Accept, Last-Event-ID, Idempotency-Key, GCK-Protocol` |
| `Access-Control-Expose-Headers` | `GCK-Run-Id, Retry-After` |
| `Access-Control-Max-Age` | `600` (fewer preflights on reconnect storms) |
| `Access-Control-Allow-Credentials` | omitted (no cookies) |

Presenton's policy is a single origin from `NEXT_PUBLIC_URL`, or `*` as a development fallback, with credentials allowed (`servers/fastapi/api/main.py:88-100`). The engine needs a per-tenant origin list, because one engine serves several hosts.

!!! warning "Gotcha"
    Without `Access-Control-Expose-Headers`, `response.headers.get("Retry-After")` returns `null` in the browser on a cross-origin `429`, and the client silently falls back to its own backoff. That is why `retryAfterMs` is also inside the JSON error body.

## Step 11: `@gck/protocol` event types

The protocol package is types plus JSON Schemas with zero runtime dependencies. This file covers runs and events; `Artifact`, `DataBinding` and `TargetId` come from `src/artifact.ts` and `TargetManifest` from `src/target.ts`, both specified in [Artifact Spec and targets](62-artifact-spec-and-targets.md); the protocol 1.1 data types (`BindingUpdate`, `HostDataScope`, `ParamValue` and the refresh events) come from `src/data.ts` (Step 16.4 and [Live Superset data](69-live-superset-data.md)). The package index re-exports every file (`export * from "./artifact"`, `"./target"`, `"./data"`, `"./run"`), so `run.ts` does not re-export `Artifact` itself. Protocol 1.1 is a minor, additive bump: `PROTOCOL_VERSION` (the major in `v` and in the `GCK-Protocol` header) stays `1`, and a 1.0 client that meets the new optional fields or event types ignores them. `HostContext` in `target.ts` is an alias of `RunContext` below: one JSON object, the run request's `context`, under two names.

```ts title="gck/packages/protocol/src/run.ts (new)"
import type { Artifact, TargetId } from "./artifact";
import type { BindingUpdate, HostDataScope, ParamValue } from "./data";   // protocol 1.1 (Step 16.4)
import type { TargetManifest } from "./target";

export const PROTOCOL_VERSION = 1 as const;

export type JsonPointer = string;
export type JsonPatchOp =
  | { op: "add"; path: JsonPointer; value: unknown }
  | { op: "remove"; path: JsonPointer }
  | { op: "replace"; path: JsonPointer; value: unknown }
  | { op: "move"; from: JsonPointer; path: JsonPointer }
  | { op: "copy"; from: JsonPointer; path: JsonPointer }
  | { op: "test"; path: JsonPointer; value: unknown };

export type RunIntent = "generate" | "transform" | "edit";

export interface RunContext {
  host: string;                       // "superset" | "tiptap" | "presenton" | "web" | "element"
  surface?: string;                   // conventions: dashboard, dashboard_markdown, sqllab, alert, document, presentation, page
  locale?: string;
  theme?: Record<string, unknown>;
  selection?: unknown;                // generate: host-defined hint; transform: Block[] from the target's fromHost
  document?: unknown;                 // generate, transform: compact digest; edit: the base Artifact (version 0)
  [key: string]: unknown;             // host-specific ids such as dashboardId
}

export interface RunRequest {
  intent: RunIntent;
  prompt: string;
  target: { id: TargetId; manifestVersion: string; manifest?: TargetManifest };
  context: RunContext;
  data?: {
    provider: string;
    allowedChartIds?: number[];
    allowedDatasetIds?: number[];       // 1.1: superset_dataset and superset_metric sources
    scope?: HostDataScope;              // 1.1: host filter state captured at submit
    params?: Record<string, ParamValue>;  // 1.1: viewer's values for an edit base's parameters
    rowLimit?: number;                  // 1.1: default row_limit for stamped bindings, <= 500
  };
  options?: { reviewOutline?: boolean; maxSections?: number; tone?: string };
}

export interface RunCreated {
  runId: string; streamUrl: string; inputUrl: string; cancelUrl: string; createdAt: string;
}

export type EngineRunState =
  | "queued" | "planning" | "awaiting_input" | "generating"
  | "resolving_data" | "completed" | "failed" | "cancelled" | "expired";

export interface RunSummary {
  runId: string;
  state: EngineRunState;
  lastEventId: number;
  artifactVersion: number;
  pendingInput?: { kind: "outline_review"; inputId: string; expiresAt: string };
  error?: GckErrorBody;
}

export interface OutlineItem {
  sectionId: string | null;           // null only in client edits (new section)
  title: string;
  summary: string;
  layoutHint?: string | null;
  bindings: string[];
}

export type OutlineDecision =
  | { inputId: string; kind: "outline_review"; decision: "approve" }
  | { inputId: string; kind: "outline_review"; decision: "edit"; outline: OutlineItem[] }
  | { inputId: string; kind: "outline_review"; decision: "cancel" };

export type GckErrorCode =
  | "invalid_request" | "unauthorized" | "token_expired" | "forbidden" | "not_found"
  | "conflict" | "input_already_resolved" | "rate_limited" | "quota_exceeded"
  | "context_too_large" | "model_output_invalid" | "model_unavailable"
  | "data_forbidden" | "data_unavailable" | "input_expired" | "cancelled" | "internal"
  | "data_token_expired";              // 1.1; "data_unavailable" is sent by 1.0 engines only

export interface GckErrorBody {
  code: GckErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
  completedSections?: number;
  totalSections?: number;
}

export interface Usage {
  inputTokens: number; outputTokens: number; durationMs: number; model?: string;
}

export interface Progress {
  phase: "planning" | "generating" | "resolving_data";
  message?: string; completed?: number; total?: number;
}

export type GckEventBody =
  | { type: "run.started"; data: { runId: string; target: { id: TargetId; manifestVersion: string } } }
  | { type: "plan.proposed"; data: { outline: OutlineItem[]; planVersion: number; final: boolean } }
  | { type: "run.awaiting_input"; data: { kind: "outline_review"; inputId: string; expiresAt: string } }
  | { type: "artifact.patch"; data: { baseVersion: number; version: number; ops: JsonPatchOp[] } }
  | { type: "text.delta"; data: { blockId: string; path: JsonPointer; delta: string;
                                  format: "text" | "json"; baseVersion: number } }
  | { type: "binding.resolved"; data: BindingUpdate }     // 1.1: same payload as the refresh protocol
  | { type: "run.warning"; data: { code: string; message: string; blockId?: string } }
  | { type: "run.completed"; data: { artifactVersion: number; usage: Usage } }
  | { type: "run.failed"; data: GckErrorBody };

export type GckEvent = GckEventBody & {
  v: typeof PROTOCOL_VERSION;
  id: number;
  runId: string;
  ts: string;
  progress?: Progress;
};

export type GckEventType = GckEvent["type"];
export type EventOf<T extends GckEventType> = Extract<GckEvent, { type: T }>;

export const TERMINAL_EVENTS: ReadonlySet<GckEventType> = new Set(["run.completed", "run.failed"]);

export function isGckEvent(value: unknown): value is GckEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.v === PROTOCOL_VERSION && typeof v.id === "number" &&
    typeof v.type === "string" && typeof v.runId === "string" && "data" in v;
}

/** A root replace at baseVersion 0 is a full snapshot (initial or after compaction). */
export function isSnapshotPatch(e: GckEvent): boolean {
  return e.type === "artifact.patch" && e.data.baseVersion === 0 &&
    e.data.ops.length === 1 && e.data.ops[0].op === "replace" && e.data.ops[0].path === "";
}
```

`isGckEvent` is a structural guard only; full validation uses JSON Schemas shared with the engine's Pydantic models ([Frontend engineering and quality](67-frontend-engineering.md)).

!!! warning "Gotcha"
    An unknown `type` from a newer engine must be ignored, not treated as an error: every `switch` over events ends in a default branch that drops it. Breaking changes bump `v`; the engine rejects a client whose `GCK-Protocol` header is too old with `invalid_request` and `details.minProtocol`.

## Step 12: `@gck/client`

### 12.1 The SSE line parser

```ts title="gck/packages/client/src/sse.ts (new)"
export interface SseMessage {
  event: string;
  data: string;
  id?: string;      // last event id buffer at dispatch time
  retry?: number;   // reconnection time requested by the server, ms
}

export interface SseParser {
  push(chunk: string): void;
}

/** Incremental WHATWG event-stream parser; lines end in CRLF, LF or CR. */
export function createSseParser(
  onMessage: (m: SseMessage) => void,
  onComment?: (text: string) => void,
): SseParser {
  let buffer = "";
  let data: string[] = [];
  let eventName = "";
  let lastId: string | undefined;
  let retry: number | undefined;

  const dispatch = () => {
    if (data.length === 0) { eventName = ""; return; }
    onMessage({ event: eventName || "message", data: data.join("\n"), id: lastId, retry });
    data = [];
    eventName = "";
    retry = undefined;
  };

  const processLine = (line: string) => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return onComment?.(line.slice(1).trim());
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data": data.push(value); break;
      case "event": eventName = value; break;
      case "id": if (!value.includes("\u0000")) lastId = value; break;
      case "retry": if (/^\d+$/.test(value)) retry = Number(value); break;
      default: break; // unknown fields are ignored by the grammar
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch !== "\n" && ch !== "\r") continue;
        if (ch === "\r" && i === buffer.length - 1) break; // CR may pair with an LF in the next chunk
        processLine(buffer.slice(start, i));
        if (ch === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
    },
  };
}
```

### 12.2 Errors, retry policy and helpers

```ts title="gck/packages/client/src/errors.ts (new)"
import type { GckErrorBody, GckErrorCode } from "@gck/protocol";

export class GckError extends Error {
  readonly code: GckErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(body: GckErrorBody, status?: number) {
    super(body.message);
    this.name = "GckError";
    this.code = body.code;
    this.retryable = body.retryable;
    this.status = status;
    this.retryAfterMs = body.retryAfterMs;
    this.details = body.details;
  }

  static async fromResponse(res: Response): Promise<GckError> {
    let body: GckErrorBody | undefined;
    try {
      const json = await res.json();
      body = json?.error;
    } catch { /* non-JSON body, for example an HTML 502 page from a proxy */ }
    const header = Number(res.headers.get("Retry-After"));
    const retryAfterMs = body?.retryAfterMs ?? (Number.isFinite(header) && header > 0 ? header * 1000 : undefined);
    return new GckError({
      code: body?.code ?? statusToCode(res.status),
      message: body?.message ?? `Engine request failed with HTTP ${res.status}`,
      retryable: body?.retryable ?? (res.status === 408 || res.status === 429 || res.status >= 500),
      retryAfterMs,
      details: body?.details,
    }, res.status);
  }
}

const STATUS_CODES: Record<number, GckErrorCode> = { 401: "unauthorized", 403: "forbidden", 404: "not_found",
  409: "conflict", 413: "context_too_large", 429: "rate_limited", 502: "model_unavailable", 503: "model_unavailable" };
const statusToCode = (s: number): GckErrorCode => STATUS_CODES[s] ?? (s < 500 ? "invalid_request" : "internal");

export interface RetryPolicy {
  maxAttempts: number;   // consecutive failures
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;        // 0.2 means plus or minus 20 %
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 6, baseDelayMs: 1000, maxDelayMs: 15000, jitter: 0.2 };

export function backoffDelay(attempt: number, p: RetryPolicy, hintMs?: number): number {
  const exp = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const base = Math.max(exp, hintMs ?? 0);
  const spread = base * p.jitter;
  return Math.round(base - spread + Math.random() * 2 * spread);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
```

### 12.3 `GckClient`

```ts title="gck/packages/client/src/client.ts (new)"
import {
  PROTOCOL_VERSION, TERMINAL_EVENTS, isGckEvent,
  type Artifact, type BindingUpdate, type GckEvent, type OutlineDecision, type RunCreated,
  type RunRequest, type RunSummary,
} from "@gck/protocol";
import { createSseParser, type SseMessage } from "./sse";
import { DEFAULT_RETRY, GckError, backoffDelay, isAbortError, sleep, type RetryPolicy } from "./errors";

export type TokenProvider = (opts: { forceRefresh: boolean }) => Promise<string | null>;

export interface GckClientOptions {
  engineUrl: string;                     // base without /v1, e.g. "https://gck.example.com" or "/api/gck"
  getToken: TokenProvider;
  fetch?: typeof fetch;                  // injectable for tests
  retry?: Partial<RetryPolicy>;
  heartbeatTimeoutMs?: number;           // default 45 000
  onTransport?: (e: TransportEvent) => void;  // telemetry hook, no prompt text
}

export type TransportEvent =
  | { kind: "connect"; runId: string; attempt: number; lastEventId: number }
  | { kind: "disconnect"; runId: string; reason: string }
  | { kind: "gap"; runId: string; expected: number; got: number };

export interface StreamOptions {
  lastEventId?: number;
  signal?: AbortSignal;
}

export class GckClient {
  private readonly base: string;
  private readonly policy: RetryPolicy;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GckClientOptions) {
    this.base = opts.engineUrl.replace(/\/+$/, "");
    this.policy = { ...DEFAULT_RETRY, ...opts.retry };
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Start a run. Safe to retry: the idempotency key makes the POST deduplicated. */
  async startRun(req: RunRequest, init: { signal?: AbortSignal; idempotencyKey?: string } = {}): Promise<RunCreated> {
    const key = init.idempotencyKey ?? crypto.randomUUID();
    return this.json<RunCreated>("POST", "/v1/runs", req, { signal: init.signal, idempotent: true,
      headers: { "Idempotency-Key": key } });
  }

  getRun(runId: string, signal?: AbortSignal): Promise<RunSummary> {
    return this.json("GET", `/v1/runs/${encodeURIComponent(runId)}`, undefined, { signal, idempotent: true });
  }

  getArtifact(runId: string, signal?: AbortSignal): Promise<{ version: number; lastEventId: number; artifact: Artifact;
      bindingState: Record<string, BindingUpdate> }> {                   // bindingState: protocol 1.1
    return this.json("GET", `/v1/runs/${encodeURIComponent(runId)}/artifact`, undefined, { signal, idempotent: true });
  }

  sendInput(runId: string, input: OutlineDecision, signal?: AbortSignal): Promise<{ accepted: true }> {
    return this.json("POST", `/v1/runs/${encodeURIComponent(runId)}/input`, input, { signal, idempotent: true });
  }

  cancel(runId: string, reason = "user"): Promise<{ state: string }> {
    // No signal on purpose: a cancel must survive the abort of the stream it ends.
    return this.json("POST", `/v1/runs/${encodeURIComponent(runId)}/cancel`, { reason }, { idempotent: true });
  }

  /** Reconnects with Last-Event-ID, drops duplicates, detects gaps; abort ends without throwing. */
  async *stream(runId: string, opts: StreamOptions = {}): AsyncGenerator<GckEvent, void, undefined> {
    let lastEventId = opts.lastEventId ?? 0;
    let failures = 0;
    let serverRetryMs: number | undefined;
    const outer = opts.signal;

    while (!outer?.aborted) {
      const attempt = new AbortController();
      const onOuterAbort = () => attempt.abort(outer!.reason);
      outer?.addEventListener("abort", onOuterAbort, { once: true });
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const resetWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => attempt.abort(new DOMException("heartbeat timeout", "AbortError")),
          this.opts.heartbeatTimeoutMs ?? 45_000);
      };

      try {
        this.opts.onTransport?.({ kind: "connect", runId, attempt: failures + 1, lastEventId });
        const res = await this.send("GET", `/v1/runs/${encodeURIComponent(runId)}/events`, undefined, {
          signal: attempt.signal,
          headers: {
            Accept: "text/event-stream",
            ...(lastEventId > 0 ? { "Last-Event-ID": String(lastEventId) } : {}),
          },
        });
        if (!res.ok) throw await GckError.fromResponse(res);
        if (!res.headers.get("Content-Type")?.startsWith("text/event-stream") || !res.body) {
          throw new GckError({ code: "internal", message: "Engine did not return an event stream", retryable: true });
        }

        resetWatchdog();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        const pending: SseMessage[] = [];
        const parser = createSseParser((m) => pending.push(m), () => resetWatchdog());

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          resetWatchdog();
          parser.push(value);

          while (pending.length) {
            const msg = pending.shift()!;
            if (msg.retry !== undefined) serverRetryMs = msg.retry;
            let parsed: unknown;
            try { parsed = JSON.parse(msg.data); } catch { continue; }
            if (!isGckEvent(parsed)) continue;
            if (parsed.id <= lastEventId) continue;                      // replay duplicate
            if (parsed.id !== lastEventId + 1) {                         // lost frame
              this.opts.onTransport?.({ kind: "gap", runId, expected: lastEventId + 1, got: parsed.id });
              throw new GckError({ code: "internal", message: "event gap", retryable: true });
            }
            yield parsed;                                                // consumer has processed it
            lastEventId = parsed.id;
            failures = 0;
            if (TERMINAL_EVENTS.has(parsed.type)) return;
          }
        }
        throw new GckError({ code: "internal", message: "stream ended before a terminal event", retryable: true });
      } catch (err) {
        if (outer?.aborted) return;
        const gck = err instanceof GckError ? err : undefined;
        if (gck && !gck.retryable) throw gck;                            // 401, 403, 404: give up
        failures += 1;
        this.opts.onTransport?.({ kind: "disconnect", runId,
          reason: isAbortError(err) ? "heartbeat timeout" : String((err as Error)?.message ?? err) });
        if (failures >= this.policy.maxAttempts) {
          throw gck ?? new GckError({ code: "internal", message: "Lost connection to the engine", retryable: true });
        }
        try {
          await sleep(backoffDelay(failures, this.policy, gck?.retryAfterMs ?? serverRetryMs), outer);
        } catch { return; }                                              // aborted while waiting
      } finally {
        clearTimeout(watchdog);
        outer?.removeEventListener("abort", onOuterAbort);
        attempt.abort();                                                 // releases the reader and socket
      }
    }
  }

  // --- internals -------------------------------------------------------------

  private async json<T>(method: string, path: string, body: unknown,
    init: { signal?: AbortSignal; idempotent?: boolean; headers?: Record<string, string> }): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.send(method, path, body, init);
        if (res.ok) return (await res.json()) as T;
        throw await GckError.fromResponse(res);
      } catch (err) {
        if (isAbortError(err) || init.signal?.aborted) throw err;
        const gck = err instanceof GckError ? err : undefined;
        const transient = gck ? gck.retryable : err instanceof TypeError;  // TypeError: network failure
        if (!transient || !init.idempotent || attempt >= this.policy.maxAttempts) throw err;
        await sleep(backoffDelay(attempt, this.policy, gck?.retryAfterMs), init.signal);
      }
    }
  }

  /** One HTTP request with auth. Refreshes the token once on 401 token_expired. */
  private async send(method: string, path: string, body: unknown,
    init: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<Response> {
    for (const forceRefresh of [false, true]) {
      const token = await this.opts.getToken({ forceRefresh });
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        signal: init.signal,
        credentials: "omit",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "GCK-Protocol": String(PROTOCOL_VERSION),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status !== 401 || forceRefresh) return res;
      const err = await GckError.fromResponse(res.clone());
      if (err.code !== "token_expired") return res;
    }
    throw new Error("unreachable");
  }
}
```

Two design notes. The generator suspends at `yield` until the consumer asks for the next value, so `lastEventId` moves past an event only after the consumer has processed it; if a reducer throws, the event is replayed after reconnect instead of skipped. And `failures` resets after every successful event, so only consecutive failures count toward `maxAttempts`. `TextDecoderStream` does the job of `decoder.decode(value, { stream: true })` in Presenton's chat reader (`chat.ts:299`).

!!! warning "Gotcha"
    `fetch` rejects with a `TypeError` for network failures and CORS rejections alike, so a misconfigured engine CORS policy looks like a flaky network and burns every retry. When `onTransport` shows only `connect`/`disconnect` pairs and no event was ever received, show "Cannot reach the AI engine (check CORS and network)" instead of retrying silently.

## Step 13: Engine side, the event log in FastAPI

This sketch shows how the engine ([Extracting the engine from Presenton](66-extracting-from-presenton.md)) persists and serves events with Presenton's building blocks: SQLModel and `async_session_maker`, `StreamingResponse`, the error boundary of `safe_sse_stream` (`servers/fastapi/utils/sse.py:10-38`), the `SSEResponse.to_string()` frame format plus an `id:` line, and `smart_error_metadata`'s retryable rule.

```python title="gck_engine/runs/event_log.py (new)"
import asyncio
import json
from datetime import datetime

from sqlalchemy import JSON, Column, func, select
from sqlmodel import Field, SQLModel

from services.database import async_session_maker          # Presenton's session factory
from utils.datetime_utils import get_current_utc_datetime

TERMINAL = {"run.completed", "run.failed"}
HEARTBEAT_SECONDS = 15
PAGE_SIZE = 200


class RunEventRow(SQLModel, table=True):
    __tablename__ = "gck_run_events"
    run_id: str = Field(primary_key=True)
    seq: int = Field(primary_key=True)                       # gapless per run
    type: str
    data: dict = Field(sa_column=Column(JSON, nullable=False))
    progress: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    ephemeral: bool = False                                  # text.delta rows, pruned later
    created_at: datetime = Field(default_factory=get_current_utc_datetime)


def to_sse(row: RunEventRow) -> str:
    body = {"v": 1, "id": row.seq, "runId": row.run_id, "ts": row.created_at.isoformat(),
            "type": row.type, "data": row.data}
    if row.progress:
        body["progress"] = row.progress
    # One line of compact JSON, like SSEResponse.to_string(), plus an id line.
    return f"id: {row.seq}\nevent: {row.type}\ndata: {json.dumps(body, separators=(',', ':'))}\n\n"


class EventLog:
    """Single-process notifier over a durable table. See the multi-worker gotcha."""

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}
        self._conds: dict[str, asyncio.Condition] = {}
        self._last: dict[str, int] = {}

    def _cond(self, run_id: str) -> asyncio.Condition:
        return self._conds.setdefault(run_id, asyncio.Condition())

    async def append(self, run_id: str, type_: str, data: dict, *,
                     progress: dict | None = None, ephemeral: bool = False) -> int:
        async with self._locks.setdefault(run_id, asyncio.Lock()):
            async with async_session_maker() as session:
                last = await session.scalar(
                    select(func.max(RunEventRow.seq)).where(RunEventRow.run_id == run_id))
                seq = (last or 0) + 1
                session.add(RunEventRow(run_id=run_id, seq=seq, type=type_, data=data,
                                        progress=progress, ephemeral=ephemeral))
                await session.commit()                       # persist before anyone can see it
            self._last[run_id] = seq
        cond = self._cond(run_id)
        async with cond:
            cond.notify_all()
        return seq

    async def read_after(self, run_id: str, after: int) -> list[RunEventRow]:
        async with async_session_maker() as session:
            rows = await session.scalars(
                select(RunEventRow)
                .where(RunEventRow.run_id == run_id, RunEventRow.seq > after)
                .order_by(RunEventRow.seq)
                .limit(PAGE_SIZE))
            return list(rows)

    async def wait_for_more(self, run_id: str, after: int, timeout: float) -> bool:
        cond = self._cond(run_id)
        try:
            async with cond:
                await asyncio.wait_for(
                    cond.wait_for(lambda: self._last.get(run_id, 0) > after), timeout)
            return True
        except asyncio.TimeoutError:
            return False


async def stream_run_events(log: EventLog, run_id: str, after: int, is_disconnected):
    yield "retry: 1000\n\n"                                  # reconnect hint for the client
    cursor = after
    while True:
        rows = await log.read_after(run_id, cursor)
        for row in rows:
            yield to_sse(row)
            cursor = row.seq
            if row.type in TERMINAL:
                return
        if rows:
            continue                                         # drain the backlog page by page
        if await is_disconnected():
            return
        if not await log.wait_for_more(run_id, cursor, HEARTBEAT_SECONDS):
            yield ": hb\n\n"
```

The router ties it together. `POST /v1/runs` (omitted) validates the body, resolves the `Idempotency-Key` and starts `run_guard` as a task stored in `RUN_TASKS`, so `POST /cancel` can reach it; the stream endpoint never starts or stops generation.

```python title="gck_engine/runs/router.py (new, excerpt)"
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

RUNS_ROUTER = APIRouter(prefix="/v1/runs")
EVENT_LOG = EventLog()
RUN_TASKS: dict[str, asyncio.Task] = {}


def classify(exc: Exception) -> dict:
    # Same retryable rule as Presenton's smart_error_metadata (presentation.py:2257-2264).
    status = exc.status_code if isinstance(exc, HTTPException) else 500
    code = getattr(exc, "gck_code", None) or ("rate_limited" if status == 429 else "internal")
    return {"code": code, "message": str(getattr(exc, "detail", "") or "Generation failed"),
            "retryable": status in {408, 429} or status >= 500}


async def run_guard(run_id: str, body) -> None:
    """The generalization of safe_sse_stream: failures become a logged terminal event."""
    try:
        await execute_run(run_id, body, EVENT_LOG)           # planning, review, patches, bindings
    except asyncio.CancelledError:
        await EVENT_LOG.append(run_id, "run.failed",
                               {"code": "cancelled", "message": "Run cancelled", "retryable": False})
        raise
    except Exception as exc:
        await EVENT_LOG.append(run_id, "run.failed", classify(exc))
    finally:
        RUN_TASKS.pop(run_id, None)


@RUNS_ROUTER.get("/{run_id}/events")
async def run_events(run_id: str, request: Request,
                     last_event_id: str | None = Header(default=None)):
    await load_run_for_principal_or_404(run_id, request.state.auth_principal)
    after = int(last_event_id) if last_event_id and last_event_id.isdigit() else 0

    async def guarded():
        try:
            async for frame in stream_run_events(EVENT_LOG, run_id, after, request.is_disconnected):
                yield frame
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("event stream failed; client will reconnect")
            return                                           # do NOT emit run.failed here

    return StreamingResponse(guarded(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform",
                                      "X-Accel-Buffering": "no"})


@RUNS_ROUTER.post("/{run_id}/cancel", status_code=202)
async def cancel_run(run_id: str, request: Request):
    await load_run_for_principal_or_404(run_id, request.state.auth_principal)
    task = RUN_TASKS.get(run_id)
    if task and not task.done():
        task.cancel()
    return {"state": "cancelling" if task else await current_state(run_id)}
```

FastAPI's `Header` maps `last_event_id` to the `last-event-id` header. The compaction branch (Step 9.1) belongs at the top of `stream_run_events`: if `after` is below the run's compacted floor, yield one synthetic root-replace frame built from `GET /artifact` data, with the sequence number of the last compacted event.

!!! warning "Gotcha"
    `safe_sse_stream` converts any late exception into an `error` frame (`servers/fastapi/utils/sse.py:24-38`). That is right when the stream is the generation, and wrong here: a database blip while reading the log would tell the client the run failed while the run task is still producing. In GCK the stream wrapper only logs and closes; `run.failed` comes exclusively from `run_guard`, which owns the run.

!!! warning "Gotcha"
    `asyncio.Condition` and `RUN_TASKS` live in one process. With several workers, a subscriber on worker B only sees appends from worker A at the next 15-second poll, and `POST /cancel` on B cannot reach a task on A. In production, use Postgres `LISTEN/NOTIFY` or Redis pub/sub keyed by run id, and make cancel a row flag the run task checks between LLM calls; `stream_generate_events` already polls a stop condition every 0.1 s (`servers/fastapi/utils/llm_utils.py:458-518`, interval `CLIENT_DISCONNECT_POLL_SECONDS` at `:27`) and is the natural place for it.

## Step 14: A normal run end to end

```mermaid
sequenceDiagram
    participant H as Host UI
    participant C as GckClient
    participant E as GCK Engine
    participant T as Run task
    participant L as Event log
    H->>C: startRun with prompt and context
    C->>C: getToken
    C->>E: POST /v1/runs with Idempotency-Key
    E->>T: create task run_guard
    E-->>C: 201 runId and streamUrl
    C->>E: GET events with Bearer token
    T->>L: run.started then plan.proposed final
    L-->>C: events 1 and 2
    Note over T: resolution starts at the final plan, as the user, via token exchange
    loop each section
        T->>L: artifact.patch add section and blocks
        T->>L: text.delta coalesced every 50 ms
        T->>L: binding.resolved for the bindings of this section
        T->>L: artifact.patch replace finished block
        L-->>C: patches, deltas and binding updates
    end
    T->>L: artifact.patch generatedAgainst on resolved bindings
    T->>L: run.completed with artifactVersion
    L-->>C: run.completed
    C-->>H: iterator returns
    H->>H: apply, then hand definitions and bindingState to the host BindingStore
    Note over H: the refresh controller takes over, Step 16
```

## Step 15: Mapping to AG-UI

AG-UI (https://docs.ag-ui.com/concepts/events) is an open event protocol between agent backends and UIs. Its `type` values are names such as `RUN_STARTED` and `STATE_DELTA` (https://docs.ag-ui.com/sdk/js/core/events), and its state deltas are RFC 6902 JSON Patch, so GCK maps closely:

| GCK event | AG-UI event | Mapping notes |
|---|---|---|
| `run.started` | `RUN_STARTED` | `threadId` = host session or run id, `runId` = `runId`. |
| `progress.phase` change | `STEP_STARTED` / `STEP_FINISHED` | `stepName` = `planning`, `generating`, `resolving_data`. |
| `plan.proposed` | `STATE_DELTA` on `/plan` | Or `CUSTOM` `{name: "gck.plan.proposed"}` for clients that do not keep plan state. |
| `run.awaiting_input` | `RUN_FINISHED` with `outcome: {type: "interrupt", interrupts: [...]}` | Interrupt draft (https://docs.ag-ui.com/concepts/interrupts): interrupt `id`, `reason`, optional `responseSchema`, `expiresAt`. The answer arrives as `RunAgentInput.resume` (`interruptId`, `status`, `payload`); the adapter turns it into `POST /input`. |
| first `artifact.patch` (root replace) | `STATE_SNAPSHOT` | `snapshot` = `{artifact}`. |
| `artifact.patch` | `STATE_DELTA` | `delta` = ops with paths prefixed by `/artifact`. Version fields go in `metadata`. |
| `text.delta` | `CUSTOM` `{name: "gck.text.delta"}` | Not `TEXT_MESSAGE_CONTENT`: generic AG-UI chat clients would print the page as a chat reply. |
| `binding.resolved` | `STATE_DELTA` on `/bindingState/{id}` | Refresh streams (Step 16) are not runs and are not mapped. |
| `run.warning` | `CUSTOM` `{name: "gck.warning"}` | |
| `run.completed` | `RUN_FINISHED` | `result` = `{artifactVersion, usage}`. |
| `run.failed` | `RUN_ERROR` | `message`, `code`; `retryable` has no AG-UI field and goes in `metadata`. |
| heartbeat comment | none | Transport concern. |

**Recommendation: keep GCK's own protocol and ship an AG-UI adapter, not a dependency.** GCK needs artifact versions with `baseVersion` checks, a `retryable` flag, ephemeral in-block deltas and a binding overlay, none of which AG-UI models directly; interrupts are still a draft in AG-UI, while outline review is GCK's core interaction; and `@gck/protocol` has a zero-dependency rule. The adapter, `toAgUi(event, threadId)` in `gck/packages/protocol/src/ag-ui.ts` (new), is a pure generator that implements the table row by row with structural types (no `@ag-ui/core` import) and drops unknown event types, so AG-UI clients such as a chat sidebar can observe GCK runs.

!!! warning "Gotcha"
    The `outcome` field on `RUN_FINISHED` comes from AG-UI's interrupt draft; the JS SDK's `RunFinishedEvent` documents only `threadId`, `runId`, `result` and `usage`. An AG-UI client that does not implement the draft will treat `run.awaiting_input` as "the run finished" and never show the review form. Check the AG-UI client version you ship against before relying on interrupts, and keep the native GCK client as the path for outline review.

## Step 16: The refresh protocol (protocol 1.1)

A run ends, but its numbers must not. Every target (slides, `tiptap-doc`, `superset-dashboard`, `text`) shows Superset data fetched **as the person viewing it**, and re-fetches it after generation: when the page opens, when the viewer presses Refresh, on an interval, when the tab becomes visible again after the data went stale, when an artifact parameter or a host filter changes, before an export, and on a schedule for headless outputs. The refresh protocol is the wire contract for all of that. It is new code, it reuses this chapter's auth, SSE framing, heartbeats, CORS and error body, and it carries the same `binding.resolved` payload as a run, so one reducer in the browser serves both. Which binding refreshes when (refresh policies and per-target defaults), the Superset side of every query and the viz coverage are in [Live Superset data](69-live-superset-data.md); this step specifies the endpoints, events and types.

The superset-dashboard target is the one exception on the wire: its data blocks are native Superset charts, which query Superset on open, on native filter change and on the dashboard's own refresh (`refresh_frequency`, read at `apache/superset: superset-frontend/src/dashboard/actions/hydrate.ts:411`), so nothing in the kit calls this protocol for them.

### 16.1 Endpoints and triggers

| Method and path | Request | Success response | Called by |
|---|---|---|---|
| `GET /v1/data/catalog?dashboardId=&q=&datasetIds=&cursor=` | headers `Authorization` | `200 DataCatalog`: the charts and datasets the caller can read (Story 8 catalog plus dataset metadata), each with `refreshable` and a `reason`, plus the caller's `viewerKey` | the run controller before `POST /v1/runs` (it fills `allowedChartIds` and `allowedDatasetIds`) |
| `POST /v1/data/resolve` | `ResolveRequest` (16.4); `Accept: text/event-stream` or `application/json` | SSE stream of refresh events (16.2), or `200 {refreshId, results, summary}` | the browser's refresh controller through `@gck/data-superset`; server callers and tests use the JSON form |
| `POST /v1/render` | `RenderRequest`: `{artifact, target: "text", profile, params?, scope?}` | `200 {output, dataAsOf, warnings}` | headless callers only: schedules, alerts, reports (16.5) |

All three take the engine token from Step 10 and never a data token: the engine exchanges the caller's engine token for a short-lived data token at Story 8's token-exchange endpoint (Step 10), so every row is read inside Superset as the caller, under that user's permissions and row-level security. `ResolveRequest.bindings` holds **definitions only**: the engine ignores any `snapshot`, `snapshotAt`, `status` or `error` sent with them, so a client cannot inject numbers and a persisted artifact never needs to carry any.

Every request names its `trigger`. The engine uses it for `force`, telemetry and the throttles in 16.6; the refresh controller in [React SDK and UI kit](64-react-sdk-and-ui-kit.md) picks the bindings.

| `trigger` | Sent when | Bindings in the request | `force` |
|---|---|---|---|
| `on_open` | the controller starts on a saved page, deck or preview | every binding the view uses, `priority` = the ones in the viewport | `false` |
| `manual` | the viewer presses Refresh, or Retry on one binding | all, or the retried id | `true`, throttled (16.6) |
| `interval` | the controller clock fires (`intervalSec` of at least 60, plus or minus 10 percent, paused while the tab is hidden) | bindings whose policy has `interval` | `false` |
| `on_visible` | the tab becomes visible again | bindings older than `staleAfterSec` (default 3600) | `false` |
| `on_filter_change` | an artifact parameter or the host's filter state changed (16.3) | the dependents of that parameter, or the `follow_host` bindings of that dashboard | `false` |
| `before_export` | the host exports a file (PPTX, PDF, HTML, email) | the bindings the export renders | `false` |
| `on_schedule` | a headless caller re-renders for a scheduled send (16.5) | every binding of the artifact | `false` |
| `run` | the engine resolves bindings inside a run (Step 3.1); clients never send it | the final plan's bindings | `false` |

`force: true` maps to the `force` field of Superset's chart data query context ("Should the queries be forced to load from the source", `apache/superset: superset/charts/schemas.py:1687`). Every other trigger lets Superset serve a cached result when a data cache is configured (`DATA_CACHE_CONFIG`, a `NullCache` by default, `apache/superset: superset/config.py:1532`); that cache's key includes the user's row-level security clauses through `get_rls_cache_key` (`apache/superset: superset/security/manager.py:6304`), so a cached row set is never shared between viewers with different access.

### 16.2 The refresh stream

A refresh stream uses the run stream's frame format with one change in the envelope: `refreshId` replaces `runId`. `id` counts from 1 within the refresh, the engine writes the `: hb` heartbeat comment every 15 seconds of silence (a Story 8 batch can take up to its 30-second timeout), and the response carries the same `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` headers. There is **no resume**: refresh events are not written to the event log, `Last-Event-ID` is ignored, and a dropped refresh stream is simply re-requested, because a refresh is cheap to restart and the engine's 60-second per-viewer cache answers the repeat.

```text title="One refresh frame on the wire"
id: 1
event: refresh.started
data: {"v":1,"id":1,"refreshId":"ref_3f9c1d7a0b2e4c58a6d1e0f7b9c2a4d6","ts":"2026-11-03T11:02:00.118Z","type":"refresh.started","data":{"refreshId":"ref_3f9c1d7a0b2e4c58a6d1e0f7b9c2a4d6","total":2,"viewerKey":"Xq3v9KfR2mPa7LwB","trigger":"on_open"}}

```

| `type` | `data` | When |
|---|---|---|
| `refresh.started` | `{refreshId, total, viewerKey, trigger}` | first event; `viewerKey` is the viewer's opaque key, compared with `meta.resolved_by` by the redact policy |
| `binding.loading` | `{bindingId}` | before the engine sends a binding's item to Superset (not for engine cache hits) |
| `binding.resolved` | `BindingUpdate` `{bindingId, status, snapshot?, snapshotAt?, error?, changed?, reason?}` | once per binding, `priority` ids first, then artifact order |
| `refresh.completed` | `{ok, stale, errors, forbidden, durationMs}` | terminal, the request finished (whatever each binding's status) |
| `refresh.failed` | `GckErrorBody` (Step 7) | terminal, the whole request failed: `rate_limited`, `data_token_expired`, `unauthorized` |

A full `on_open` refresh of the edit example's two bindings, one of which Superset answered too slowly (payloads only):

```json title="POST /v1/data/resolve, trigger on_open (event payloads)"
{"type":"refresh.started","data":{"refreshId":"ref_3f9c1d7a0b2e4c58a6d1e0f7b9c2a4d6","total":2,"viewerKey":"Xq3v9KfR2mPa7LwB","trigger":"on_open"}}
{"type":"binding.loading","data":{"bindingId":"b_c412"}}
{"type":"binding.loading","data":{"bindingId":"b_c413"}}
{"type":"binding.resolved","data":{"bindingId":"b_c412","status":"ok","snapshotAt":"2026-11-04T08:00:03Z","changed":true,
  "snapshot":{"value":1903000,"previous":1610000,"previous_label":"Sep 2026",
    "meta":{"rowcount":24,"truncated":false,"is_cached":true,"query_ts":"2026-11-04T08:00:03Z",
            "query_context_source":"saved_query_context","resolved_by":"Xq3v9KfR2mPa7LwB","scope_hash":"e3b7c1f09a24",
            "time_range":{"label":"Last year"},"applied_filters":[{"column":"region"}],"rejected_filters":[],
            "schema":{"x":"order_date","series":["revenue"]}}}}}
{"type":"binding.resolved","data":{"bindingId":"b_c413","status":"stale","reason":"timeout"}}
{"type":"refresh.completed","data":{"ok":1,"stale":1,"errors":0,"forbidden":0,"durationMs":30412}}
```

`b_c412` came back `changed: true` against its `generatedAgainst` stamp, so a view can offer "Text was written against data as of ... Regenerate?", which starts an `edit` run (Step 5). `b_c413` is `stale`: Story 8 timed out, so the update carries no `snapshot` and the client keeps the snapshot it already holds, badged as stale with a Retry action; the next trigger (Retry, interval or tab return) resolves it again. The JSON form of the same request returns the updates keyed by binding id:

```json title="POST /v1/data/resolve with Accept: application/json (response, snapshot elided)"
{ "refreshId": "ref_3f9c1d7a0b2e4c58a6d1e0f7b9c2a4d6",
  "results": { "b_c412": { "bindingId": "b_c412", "status": "ok", "snapshotAt": "2026-11-04T08:00:03Z", "changed": true, "snapshot": {} },
               "b_c413": { "bindingId": "b_c413", "status": "stale", "reason": "timeout" } },
  "summary": { "ok": 1, "stale": 1, "errors": 0, "forbidden": 0, "durationMs": 30412 } }
```

!!! warning "Gotcha"
    `isGckEvent` (Step 11) requires a `runId`, so it rejects every refresh frame. That is deliberate: a refresh event fed into a run's artifact store by mistake would be dropped, not applied against the run's version line. Refresh events go to the `BindingStore`, whose `apply` accepts both a refresh event and a run's `binding.resolved`.

### 16.3 Parameter and filter changes

Artifact parameters (`Artifact.parameters`, for example `p_region`) are inputs the viewer can change; their current values live in view state (host state or a URL parameter such as `?gck_p_region=APAC`), never in the artifact. A binding depends on a parameter through `params: [{param, as, column?, op?}]`. When a value changes, the refresh controller waits 400 ms for more changes, aborts any in-flight request for the dependent bindings, and sends one request with **only those bindings**, the parameter definitions and the viewer's current values. Tokens and charts over other bindings do not move.

```mermaid
sequenceDiagram
    participant U as Viewer
    participant B as GckParameterBar
    participant C as RefreshController
    participant E as GCK Engine
    participant S as Story 8 refresh
    U->>B: choose APAC for p_region
    B->>C: setParams with p_region APAC
    C->>C: debounce 400 ms, pick bindings whose params name p_region
    C->>C: abort the in-flight request for those bindings
    C->>E: POST /v1/data/resolve, trigger on_filter_change, dependents only
    E->>E: merge scope layers, p_region replaces the captured region filter
    E->>E: per-viewer cache lookup on the new scope
    E->>S: items with the merged scope, as the viewer
    S-->>E: rows under the viewer's row-level security
    E-->>C: refresh.started, binding.loading, binding.resolved, refresh.completed
    C->>U: dependent tokens and charts re-render, the others stay as they are
```

```json title="POST /v1/data/resolve after a parameter change (request body)"
{ "trigger": "on_filter_change",
  "bindings": {
    "b_c413": { "kind": "chart",
                "source": { "type": "superset_chart", "chart_id": 413, "dashboard_id": 37,
                            "filter_context": { "dashboard_id": 37, "mode": "captured", "permalink_key": "kq2Lm9PzR4x",
                              "data_mask": { "NATIVE_FILTER-r1": { "extraFormData": {
                                "filters": [{ "col": "region", "op": "IN", "val": ["EMEA"] }] } } } } },
                "mapping": { "x": "country", "series": ["pipeline"], "series_labels": { "pipeline": "Pipeline" } },
                "params": [{ "param": "p_region", "as": "filter", "column": "region", "op": "IN" }],
                "generatedAgainst": { "snapshot_hash": "a81f03c6e9d7", "snapshotAt": "2026-11-03T10:15:12Z" } } },
  "parameters": {
    "p_region": { "id": "p_region", "label": "Region", "type": "multi_select", "default": ["EMEA"], "column": "region",
                  "options": { "from": { "dataset_id": 12, "column": "region" } } } },
  "params": { "p_region": ["APAC"] },
  "priority": ["b_c413"] }
```

The engine computes one effective scope per binding from four layers, lowest first: the saved query (L0), the dashboard filter context (L1, here the captured `region IN [EMEA]`), artifact parameters with the viewer's values (L2, here `region IN [APAC]`) and the binding's pinned `overrides` (L3). A higher layer **replaces** a lower layer's filter on the same column and replaces `time_range` and `time_grain_sqla`; it does not add to it, because Superset ANDs extra filters and `region IN [EMEA] AND region IN [APAC]` returns no rows. A parameter with `as: "time_range"` or `as: "time_grain"` replaces the time range or grain the same way. The result carries a new `meta.scope_hash`, so the engine's cache, the view and a later comparison can tell the two scopes apart, and `meta.applied_filters` / `meta.rejected_filters` show which filters reached the query. Every filter still passes Story 8's column and operator allowlist inside Superset. A value of the wrong shape for its parameter, or a filter on a column the dataset does not have, ends that binding with `status: "error"` and `param_invalid` or `invalid_override`; it never fails the request. Pinning and parameterizing the same column on one binding is rejected when the artifact is validated (`I12_PARAMS`), not at refresh time.

Host filter changes use the same request with `scope` instead of new `params`. A binding whose `filter_context.mode` is `follow_host` follows the viewer's live dashboard filters: the host's `watchScope` (dashboard Redux `dataMask` inside Superset, or the Embedded SDK's `observeDataMask` with `dashboardUiConfig.emitDataMasks`, `apache/superset: superset-embedded-sdk/src/index.ts:44, 164-165, 613-614`) reports a new `HostDataScope`, the controller sends `{trigger: "on_filter_change", scope, bindings: <the follow_host bindings of that dashboardId>}`, and the engine replaces each binding's `data_mask` with the live one before resolving. Bindings in mode `captured` (the default) ignore `scope` and keep the filter selection the narrative was written against. Inside Superset, Story 8 resolves which native filters apply to which chart: on master with `get_dashboard_filter_context(..., active_data_mask=...)` and `apply_dashboard_filter_context` (`apache/superset: superset/charts/data/dashboard_filter_context.py:272, 365`), on 6.1 with its own resolver, because that module does not exist in 6.1.0 ([Live Superset data](69-live-superset-data.md)).

Options for a `select` or `multi_select` parameter that come `from` a dataset column are loaded as the viewer through Superset's column-values route (`GET /api/v1/datasource/<type>/<id>/column/<column>/values/`, `apache/superset: superset/datasource/api.py:225-227`), so a viewer is never offered a value that row-level security hides from them.

### 16.4 `@gck/protocol` refresh types

The binding model (`BindingDefinition`, `BindingStatus`, `BindingError`, the snapshots, `ArtifactParameter`, `ParamValue`, `HostDataScope`, `RefreshPolicy`) lives in `src/data.ts` and is specified in [Artifact Spec and targets](62-artifact-spec-and-targets.md). The refresh protocol adds the request, the update and the events to the same file:

```ts title="gck/packages/protocol/src/data.ts (new, protocol 1.1, refresh protocol excerpt)"
import type { Artifact } from "./artifact";
import type { GckErrorBody } from "./run";

export type RefreshTrigger = "on_open" | "manual" | "interval" | "on_filter_change" | "on_visible"
                           | "on_schedule" | "before_export" | "run";

export interface ResolveRequest {
  bindings: Record<string, BindingDefinition>;     // definitions only; any snapshot sent is ignored; max 100
  parameters?: Record<string, ArtifactParameter>;  // the artifact's parameter definitions
  params?: Record<string, ParamValue>;             // the viewer's current values
  scope?: HostDataScope;                           // live host scope for follow_host bindings
  force?: boolean;                                 // honored for trigger "manual" only
  priority?: string[];                             // resolve these first (viewport, first section)
  trigger: RefreshTrigger;
  artifactId?: string;                             // telemetry only
}

/** The payload of binding.resolved, in runs (Step 3.1) and refreshes alike. */
export interface BindingUpdate {
  bindingId: string;
  status: BindingStatus;                           // never "pending" on the wire
  snapshot?: ChartSnapshot | MetricSnapshot | TableSnapshot;
  snapshotAt?: string;
  error?: BindingError;                            // error and forbidden
  changed?: boolean;                               // snapshot hash differs from generatedAgainst or the last one seen
  reason?: string;                                 // stale: the retryable code, e.g. "timeout"
}

export interface RefreshSummary { ok: number; stale: number; errors: number; forbidden: number; durationMs: number }

export type DataEventBody =
  | { type: "refresh.started"; data: { refreshId: string; total: number; viewerKey: string; trigger: RefreshTrigger } }
  | { type: "binding.loading"; data: { bindingId: string } }
  | { type: "binding.resolved"; data: BindingUpdate }
  | { type: "refresh.completed"; data: RefreshSummary }
  | { type: "refresh.failed"; data: GckErrorBody };

export type DataEvent = DataEventBody & { v: 1; id: number; refreshId: string; ts: string };

export interface ResolveResponse {                 // Accept: application/json
  refreshId: string;
  results: Record<string, BindingUpdate>;
  summary: RefreshSummary;
}

export interface RenderRequest {                   // POST /v1/render, headless callers only
  artifact: Artifact;                              // bindings as definitions; the engine resolves them as the caller
  target: "text";
  profile: "markdown" | "plain" | "html" | "email";
  params?: Record<string, ParamValue>;
  scope?: HostDataScope;
}
export interface RenderResponse {
  output: string;                                  // ends with the "Data as of" footer
  dataAsOf: { oldest: string | null; anyStale: boolean; anyMissing: boolean };
  warnings: { code: string; message: string; bindingId?: string }[];
}
```

`run.ts` imports `BindingUpdate`, `HostDataScope` and `ParamValue` from this file and `data.ts` imports `GckErrorBody` from `run.ts`; both are `import type`, which TypeScript erases, so the cycle costs nothing at runtime and the package keeps its zero-dependency rule.

### 16.5 Headless resolution: `/v1/render` and `on_schedule`

A schedule, an alert or a report has no browser and no viewer session, yet its text must not repeat the numbers of the day it was generated. Headless refresh needs no model: the stored definitions are re-resolved and re-rendered by the text target. The caller is the Superset-side scheduler, which resolves the schedule's executor the way Superset's own reports do (`ALERT_REPORTS_EXECUTORS`, default `[ExecutorType.EDITOR]` on master, `apache/superset: superset/config.py:2838`; executor lookup `get_executor`, `apache/superset: superset/tasks/utils.py:58`), mints an engine token for that user server side with the same signer as the host's engine-token endpoint ([Host integrations](65-host-integrations.md)), and calls `POST /v1/render` (or `POST /v1/data/resolve` with `trigger: "on_schedule"` when it renders itself). The data is therefore the executor's data, under the executor's row-level security, never a shared service account's.

```json title="POST /v1/render (response)"
{ "output": "## EMEA at a glance\n\nRevenue reached **1.9M** ...\n\nData as of 2026-11-04 08:00 UTC",
  "dataAsOf": { "oldest": "2026-11-04T08:00:03Z", "anyStale": false, "anyMissing": false },
  "warnings": [] }
```

```python title="gck_engine/data/render.py (new, sketch)"
from fastapi import APIRouter, Request

from gck_engine.data.router import resolve_events          # the generator behind /v1/data/resolve
from gck_engine.spec.data import RenderRequest, ResolveRequest, with_binding_state
from gck_engine.targets.text import data_as_of, render_text  # Python port of @gck/target-text

RENDER_ROUTER = APIRouter(prefix="/v1")


@RENDER_ROUTER.post("/render")
async def render(body: RenderRequest, request: Request):
    principal = request.state.auth_principal               # the schedule's executor, not a service account
    req = ResolveRequest(bindings=body.artifact.bindings, parameters=body.artifact.parameters,
                         params=body.params, scope=body.scope, trigger="on_schedule")
    state, warnings = {}, []
    async for type_, data in resolve_events(req, principal):   # raises on rate limit or token exchange failure
        if type_ != "binding.resolved":
            continue
        state[data["bindingId"]] = data
        if data["status"] != "ok":
            warnings.append({"code": (data.get("error") or {}).get("code") or data.get("reason", "stale"),
                             "message": f"{data['bindingId']} is {data['status']}", "bindingId": data["bindingId"]})
    merged = with_binding_state(body.artifact, state)
    return {"output": render_text(merged, body.profile, data_as_of="footer"),
            "dataAsOf": data_as_of(merged), "warnings": warnings}
```

The rendered text always ends with "Data as of" the oldest `snapshotAt` it used, and says when some values could not be refreshed; `error` and `forbidden` tokens render `n/a`. Exported text is still a snapshot once it leaves the engine (an email cannot re-query), which is why the scheduler re-renders per send instead of storing the first rendering.

### 16.6 Errors, limits and the Part VIII event mapping

Request validation (`invalid_request`, `context_too_large` above 100 bindings) and engine-token auth are checked before the stream opens and answer with an HTTP error in the Step 7 body. Rate limiting and the token exchange happen inside the stream, so an SSE caller receives them as `refresh.failed` and a JSON caller as the HTTP status. Per-binding failures never fail the request: each binding ends `ok`, `stale`, `error` or `forbidden` with the codes of Step 7.

| Limit | Value | On breach |
|---|---|---|
| bindings per request | 100 | `413 context_too_large` |
| items per Story 8 call, calls in flight per request | 25, 4 | batching, not an error |
| Story 8 call timeout | 30 s | the item ends `stale` with `reason: "timeout"` and no snapshot; the client keeps the one it holds |
| engine result cache | 60 s, keyed by `(viewerKey, hash of source, effective scope and row limit)`, in-flight dedup on the same key | served as `binding.resolved` without `binding.loading` |
| `force: true` | at most once per binding per viewer per 30 s | downgraded to a cached read, `meta.force_throttled: true` |
| per-viewer rate | 60 resolve requests per minute, 600 binding resolutions per 10 minutes | `429 rate_limited` with `retryAfterMs` (as `refresh.failed` on a stream) |
| data token | 15 minutes, cached per `(sub, scope)` until 30 s before expiry | `data_token_expired`: call `getToken({ forceRefresh: true })` once, retry |

!!! warning "Gotcha: the engine cache key must start with the viewer"
    Superset's data cache is safe across users because its key includes the user's row-level security clauses (`apache/superset: superset/security/manager.py:6304`). The engine's 60-second cache sits in front of Superset and knows nothing about row-level security, so its key starts with `viewerKey`. Without it, two viewers with different access would get each other's rows for up to a minute.

Presenton decks keep Part VIII's deck-scoped refresh routes ([Story 1](../delivery/42-story1-dynamic-data.md)) as a second transport of `@gck/data-superset`. Its events translate one to one, so the same `BindingStore` reducer applies them:

| Part VIII event | Refresh protocol event |
|---|---|
| `refresh_started {total, viewer_key}` (`viewer_key` is a Story 1 addition) | `refresh.started {total, viewerKey}` |
| `binding_loading {binding_id, slide_id}` | `binding.loading {bindingId}` |
| `binding_data {binding_id, element_patch, snapshot_at, changed, meta}` (plus `snapshot`, a Story 1 addition) | `binding.resolved {status: "ok", snapshot, snapshotAt, changed}` |
| `binding_error {binding_id, code, message}` | `binding.resolved {status: "forbidden"` for `forbidden`, `chart_forbidden`, `datasource_forbidden`, else `"error"`, `error}` |
| `binding_stale {binding_id, snapshot_at, reason}` | `binding.resolved {status: "stale", snapshotAt, reason}` |
| `refresh_complete {ok, errors, stale, duration_ms}` | `refresh.completed` |

### 16.7 The client side

`GckClient` owns every engine route, so it gains two methods, `dataCatalog(query, signal)` and `resolveData(request, signal)`, built in [Live Superset data](69-live-superset-data.md). `resolveData` reuses `send` (token provider, `credentials: "omit"`, one retry on `token_expired`) and `createSseParser`, but not `stream()`'s reconnect loop: with no resume, a dropped refresh stream ends the iterator with an error, and the refresh controller retries the whole request (three attempts, 1, 2 and 4 seconds, retryable codes only, `retryAfterMs` for `rate_limited`). The browser never calls `POST /v1/render`, and never calls Superset's chart data API directly: mapping rows into snapshots happens once, server side, in the shared `gck_data` mappers.

!!! warning "Gotcha"
    A `scope` in the request moves only bindings whose `filter_context.mode` is `follow_host`; the default, `captured`, deliberately ignores it so the narrative and its numbers keep describing the same filter selection. A host that sends `scope` on every dashboard filter change and sees nothing move is looking at captured bindings. Either generate with `follow_host` (and accept that the prose can drift from the numbers, which `changed` then reports), or expose the dimension as an artifact parameter so the change is explicit.

## What you now know

- A run is a background task with six endpoints; streams only observe it, so a dropped connection never restarts generation and only `POST /cancel` stops it. Three data endpoints outlive it: `/v1/data/resolve` re-resolves stored binding definitions as the viewer on open, Refresh, interval, tab return, parameter and filter changes and before export, `/v1/render` does the same headless for schedules, and `/v1/data/catalog` lists what the viewer may bind.
- Numbers travel only in `binding.resolved`, whose `BindingUpdate` (`status`, `snapshot`, `snapshotAt`, `error`, `changed`, `reason`) is the same in runs and refreshes; data errors end one binding as `stale`, `error` or `forbidden` and never fail a refresh; a run fails with `data_forbidden` only when the target requires data and every binding is forbidden.
- Events have a gapless per-run `id` and patches carry `baseVersion`/`version`; the client drops duplicates, reconnects on gaps and resyncs from `GET /artifact` on mismatch. Content arrives as RFC 6902 patches at block granularity starting with a root replace, with optional `text.delta` (plain text or `jsonrepair`-able JSON) inside one block.
- Outline review is a pause inside the run (`plan.proposed`, `run.awaiting_input`, `POST /input`, `plan.proposed` with `final: true`), with server-side validation and expiry.
- `@gck/client` replaces `EventSource` with a fetch-based reader that sends `Authorization` and `Last-Event-ID`, parses the full SSE grammar, watches heartbeats, backs off with jitter and refreshes short-lived tokens through a callback.
- The engine persists events before emitting them, generalizing Smart mode's checkpoint-before-emit, and GCK's protocol maps onto AG-UI through an adapter rather than a dependency.

## Next

Continue with [React SDK and UI kit](64-react-sdk-and-ui-kit.md) to build the headless state machine, the artifact store that applies these patches, and the React components that render a run.
