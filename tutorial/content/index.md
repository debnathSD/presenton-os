---
title: Home
hide:
  - navigation
  - toc
---

<div class="home-hero" markdown>
<span class="home-hero__eyebrow">Code-level tutorial · Presenton + Apache Superset</span>

# How Presenton works, and how to build it into Superset

<p class="home-hero__lead">A step-by-step walkthrough of Presenton, the open-source AI presentation generator, read file by file, plus designs and delivery plans for bringing prompt-to-deck generation with live data into Apache Superset and any editor.</p>

<button type="button" class="home-search" data-spotlight-open aria-haspopup="dialog">
<span class="spx__sr">Search the tutorial.</span>
<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 3a6.5 6.5 0 0 1 5.18 10.43l5.45 5.44-1.42 1.42-5.44-5.45A6.5 6.5 0 1 1 9.5 3m0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9"/></svg>
<span>Ask anything, for example “how is context passed to each slide?”</span>
<kbd aria-hidden="true"><span data-spx-mod>⌘</span>K</kbd>
</button>

<div class="home-hero__chips" role="group" aria-label="Example questions">
<button type="button" class="home-chip" data-spotlight-open aria-haspopup="dialog" data-spotlight-query="How does Presenton pass context to each slide?">Context per slide</button>
<button type="button" class="home-chip" data-spotlight-open aria-haspopup="dialog" data-spotlight-query="How is a template turned into a JSON schema?">Template to schema</button>
<button type="button" class="home-chip" data-spotlight-open aria-haspopup="dialog" data-spotlight-query="How does PPTX export work?">PPTX export</button>
<button type="button" class="home-chip" data-spotlight-open aria-haspopup="dialog" data-spotlight-query="How do slides get live Superset data?">Live Superset data</button>
<button type="button" class="home-chip" data-spotlight-open aria-haspopup="dialog" data-spotlight-query="AI Slides release plan">Release plan</button>
</div>

<div class="home-hero__actions" markdown>
[Start reading :material-arrow-right:](presenton/01-what-is-presenton.md){ .md-button .md-button--primary }
[See the Superset plan](delivery/index.md){ .md-button }
</div>
</div>

## Choose your path

<div class="grid cards" markdown>

-   :material-school-outline:{ .lg .middle } __I want to understand Presenton__

    ---

    How a prompt becomes an outline, slide layouts, streamed content and an editable PPTX.

    [:material-arrow-right: What Presenton is](presenton/01-what-is-presenton.md) · [Standard pipeline](presenton/08-standard-pipeline.md)

-   :material-presentation-play:{ .lg .middle } __I am building AI Slides in Superset__

    ---

    The nine stories with architecture, code, owners, effort and weekly release dates.

    [:material-arrow-right: AI Slides delivery plan](delivery/index.md) · [Release tracker](delivery/51-release-plan.md)

-   :material-puzzle-outline:{ .lg .middle } __I want one AI component for any editor__

    ---

    The Generative Content Kit: slides, Tiptap pages, Superset dashboards and text from natural language, with live data.

    [:material-arrow-right: Generative Content Kit](ai-component/index.md) · [Live Superset data](ai-component/69-live-superset-data.md)

-   :material-swap-horizontal-bold:{ .lg .middle } __I want the final approach: one model, PPT and Tiptap__

    ---

    One generic Unified Document Model with pluggable adapters: Presenton PPT and Tiptap today, any module tomorrow, with the exact code changes in Presenton.

    [:material-arrow-right: Part X: Final approach](final/index.md)

-   :material-chart-box-outline:{ .lg .middle } __I am designing the Superset-native version__

    ---

    Data-bound documents: native charts, no screenshots, refresh as the viewer.

    [:material-arrow-right: Superset integration design](superset/index.md)

</div>

## Browse all parts

<div class="grid cards" markdown>

-   __Part I: Orientation__

    <span class="part-meta">5 pages</span>

    What Presenton is, the repository, the running processes and how to run it locally.

    [:material-arrow-right: Open Part I](presenton/index.md)

-   __Part II: Backend internals__

    <span class="part-meta">11 chapters</span>

    FastAPI startup, providers, data model, the generation pipeline, prompts, streaming, documents, Smart mode, chat and the API.

    [:material-arrow-right: Open Part II](presenton/05-fastapi-startup.md)

-   __Part III: Templates__

    <span class="part-meta">4 chapters</span>

    The Template v2 format, how a template becomes a schema and a slide, custom templates from PPTX, themes and fonts.

    [:material-arrow-right: Open Part III](presenton/16-template-v2-format.md)

-   __Part IV: Frontend__

    <span class="part-meta">4 chapters</span>

    Next.js architecture, the user journey, the slide editor, settings and auth screens.

    [:material-arrow-right: Open Part IV](presenton/20-nextjs-architecture.md)

-   __Part V: Export__

    <span class="part-meta">1 chapter</span>

    How slides become an editable PPTX and a PDF.

    [:material-arrow-right: Open Part V](presenton/24-export-pipeline.md)

-   __Part VI: Auth, infra and ops__

    <span class="part-meta">4 chapters</span>

    Multi-user auth, the Docker image, the Electron app, CI, tests and security.

    [:material-arrow-right: Open Part VI](presenton/25-auth-and-multiuser.md)

-   __Part VII: Superset integration design__

    <span class="part-meta">12 pages</span>

    The long-term, Superset-native design for data-bound decks, documents, text and pages.

    [:material-arrow-right: Open Part VII](superset/index.md)

-   __Part VIII: AI Slides delivery plan__

    <span class="part-meta">13 pages</span>

    The architect's nine stories turned into implementation guides, with a release tracker.

    [:material-arrow-right: Open Part VIII](delivery/index.md)

-   __Part IX: Generative Content Kit__

    <span class="part-meta">11 pages</span>

    A host-agnostic AI component extracted from Presenton, with live Superset data for every target.

    [:material-arrow-right: Open Part IX](ai-component/index.md)

-   __Part X: Final approach__

    <span class="part-meta">8 pages</span>

    The consolidated decision: one generic Unified Document Model with pluggable adapters (Presenton PPT, Tiptap, Markdown and any future module), proven with a prototype.

    [:material-arrow-right: Open Part X](final/index.md)

-   __Appendix: reference__

    <span class="part-meta">3 pages</span>

    Glossary, every API endpoint and an annotated file index.

    [:material-arrow-right: Glossary](appendix-glossary.md) · [Endpoints](appendix-endpoints.md) · [Files](appendix-files.md)

</div>

## How to get around

<div class="home-steps">
<div class="home-step"><strong>Search anything</strong>Press <kbd><span data-spx-mod>⌘</span>K</kbd> or <kbd>/</kbd>, or use the search box at the top. Ask in plain words or type a file or function name.</div>
<div class="home-step"><strong>Use the left sidebar</strong>Every Part is a group you can open and close. The Part you are reading stays highlighted.</div>
<div class="home-step"><strong>Follow the breadcrumbs</strong>The path above each page title shows where you are and links back up.</div>
<div class="home-step"><strong>Read in order</strong>Each chapter ends with a Next link, and the footer has Previous and Next buttons.</div>
</div>

## Where the code is

The mirrored Presenton source lives in the [debnathSD/presenton-os](https://github.com/debnathSD/presenton-os) repository, next to this tutorial. Chapters cite code as `path:line` against snapshot `571461f`; line numbers drift as upstream changes, so treat them as "near here".

```text
presenton-os/
├── servers/fastapi/     Python backend (FastAPI, SQLModel, llmai, python-pptx)
├── servers/nextjs/      Next.js frontend (React, Redux Toolkit, Tiptap, Konva)
├── templates/           16 built-in Template v2 designs
├── electron/            Desktop app wrapper
├── scripts/             Build, sync and security helper scripts
├── start.js             Process supervisor used inside the Docker image
└── tutorial/            This site (MkDocs Material)
```
