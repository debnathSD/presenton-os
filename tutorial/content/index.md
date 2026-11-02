# Presenton OS Internals

<div class="chapter-meta" markdown>
**Source snapshot:** `presenton/presenton` at the commit mirrored in this repository (v0.9.12-beta line, November 2026)  ·  **Tutorial repository:** [debnathSD/presenton-os](https://github.com/debnathSD/presenton-os)
</div>

This site is a code-level tutorial on **Presenton**, the open-source AI presentation generator, followed by a complete engineering design for bringing the same "prompt plus template, out comes a deck" workflow to **Apache Superset** with slides that are bound to live data instead of screenshots.

It was written by reading the repository file by file. Every chapter cites the exact source paths (and line numbers where they matter) so you can open the code next to the text and verify each claim.

## How the book is organised

| Part | What it covers | Read it if you want to |
| --- | --- | --- |
| **I · Orientation** | What Presenton is, repository layout, the process topology in Docker and Electron, running it locally | Get a mental map before touching code |
| **II · Backend** | FastAPI startup, configuration precedence, the data model, the Standard generation pipeline, prompts, SSE streaming, document ingestion, images/icons/web search, Smart mode, editing and chat, the REST/MCP API surface | Change how decks are generated |
| **III · Templates** | The Template v2 JSON format, how a template becomes a JSON schema for the LLM and a rendered slide, custom templates from PPTX, themes and fonts | Add or modify designs |
| **IV · Frontend** | Next.js app architecture, the user journey, the slide editor, settings and auth UI | Change the UI |
| **V · Export** | How slides become an editable PPTX and a PDF | Change the output files |
| **VI · Auth, infra, ops** | Authentication and multi-user isolation, Docker image, Electron app, CI and security | Deploy or operate it |
| **VII · Superset integration** | A step-by-step design for a Superset extension plus a generation service that produces data-bound decks, pages and documents from prompts and templates | Build the same thing for Superset |

## Reading paths

- **"I just want to know how a prompt becomes a PPTX."** Read [What Presenton is](presenton/01-what-is-presenton.md), [Runtime topology](presenton/03-runtime-topology.md), then [Standard generation pipeline](presenton/08-standard-pipeline.md), [From template to schema to slide](presenton/17-template-to-slide.md) and [PPTX and PDF export](presenton/24-export-pipeline.md).
- **"I want to add a new template."** Read Part III in order.
- **"I want to integrate Presenton-style generation into my own product."** Read [REST API, async tasks, webhooks, MCP](presenton/15-api-async-mcp.md) and then all of Part VII.
- **"I am going to build the Superset version."** Read Parts I, II, III and V first; Part VII assumes them.

## Conventions

- Paths are relative to the repository root, for example `servers/fastapi/api/main.py`.
- `path:line` references point at the mirrored snapshot. Line numbers drift as upstream changes, so treat them as "near here".
- Diagrams are Mermaid; sequence diagrams show request flows, flowcharts show data flows.
- Blocks marked **Gotcha** describe behaviour that is easy to get wrong when modifying the code.

## Where the code is

The mirrored source lives in this same repository, one directory above this tutorial:

```text
presenton-os/
├── servers/fastapi/     Python backend (FastAPI, SQLModel, llmai, python-pptx)
├── servers/nextjs/      Next.js 16 frontend (React 19, Redux Toolkit, Tiptap, Konva)
├── templates/           16 built-in Template v2 designs (template.json + static assets)
├── electron/            Desktop app wrapper
├── scripts/             Build, sync and security helper scripts
├── start.js             Process supervisor used inside the Docker image
├── Dockerfile, docker-compose.yml, nginx.conf
└── tutorial/            This site (MkDocs Material)
```

Start with [Part I · Orientation](presenton/index.md).
