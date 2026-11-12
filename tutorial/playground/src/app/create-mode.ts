// Mode "Create a page from a prompt" (the main flow): Presenton's Standard pipeline with a Tiptap page as the target.
//   1. Prompt   (Presenton's upload page): prompt, number of sections, tone, verbosity, language, instructions, model
//   2. Outline  (Presenton's outline page): page title + one Markdown outline per section; rename, reorder, delete, add
//   3. Page     (Presenton's presentation page): sections stream into the editor one by one, skeletons for the rest
//   4. Slides   (optional): the finished page -> a Presenton deck in a chosen template -> PPTX
// The pipeline itself lives in src/generate (createGenerator, runPagePipeline, replaySampleRun); this file is the UI.

import { h, svgIcon, ICONS, prefersReducedMotion, moveFocus } from "./dom";
import { createPicker } from "./picker";
import { openKeyDialog, getApiKey, maskKey } from "./key-dialog";
import { saveFile } from "./downloads";
import { exportDeckPptx } from "./pptx";
import { slidesFromPage } from "./to-slides";
import { EMPTY_DOC, slug } from "./doc";
import { fmtMs, lossSummary, now, plural } from "./format";
import { udmToMarkdown, tiptapToUdm, type Loss, type Issue } from "../udm/bridge";
import {
  MODELS, DEFAULT_MODEL, EFFORTS, DEFAULT_EFFORT, TONES, VERBOSITIES, MAX_OUTLINE_CONTENT_WORDS,
  createGenerator, runPagePipeline, replaySampleRun, SAMPLE_INPUT, GenerateError, isAbort,
  type Generator, type Outline, type OutlineSection, type PageInput, type PageResult, type SectionEvent, type UdmSection,
} from "../generate/index";
import type { Ctx } from "./state";
import type { ModeView } from "./app";

type Phase = "form" | "outline-loading" | "outline" | "generating" | "done";

const LANGUAGES: [string, string][] = [
  ["auto-detect", "Auto-detect (from the prompt)"], ["English", "English"], ["Spanish", "Español"], ["French", "Français"],
  ["German", "Deutsch"], ["Portuguese", "Português"], ["Italian", "Italiano"], ["Hindi", "हिन्दी (Hindi)"],
  ["Bengali", "বাংলা (Bengali)"], ["Japanese", "日本語"], ["Chinese (Simplified)", "简体中文"], ["Arabic", "العربية"],
];
/** BCP 47 tags for the option labels written in their own language (screen readers switch voice). */
const LANG_TAGS: Record<string, string> = {
  Spanish: "es", French: "fr", German: "de", Portuguese: "pt", Italian: "it", Hindi: "hi", Bengali: "bn", Japanese: "ja",
  "Chinese (Simplified)": "zh-Hans", Arabic: "ar",
};
const label = (s: string) => s.replace(/_/g, " ").replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

let uid = 0;
const newId = () => `o_${Date.now().toString(36)}_${(++uid).toString(36)}`;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const trimWords = (s: string, max = MAX_OUTLINE_CONTENT_WORDS) => {
  const w = words(s);
  return w.length <= max ? s : w.slice(0, max).join(" ");
};

export function createCreateMode(ctx: Ctx, opts: { editorExtra: HTMLElement; sampleSpeed?: number }): ModeView {
  const ID = "create" as const;
  const extra = opts.editorExtra;
  let phase: Phase = "form";
  let outline: Outline | null = null;
  let runKind: "live" | "sample" = "live";
  let abort: AbortController | null = null;
  let generator: Generator | null = null;
  let titleNodes: any[] = [];
  let sectionNodes: any[][] = [];
  let sectionMeta: UdmSection[] = [];
  let started = new Set<number>();
  let lossAcc: Loss[] = [];
  let issueAcc: Issue[] = [];
  let startedAt = 0;
  const sampleSpeed = opts.sampleSpeed ?? 2;
  let resultNote = "";
  let slidesTemplate: string | null = ctx.index[0]?.id ?? null;

  // ---------- journey ----------
  const JOURNEY = [
    ["Prompt", "like Presenton’s upload page"], ["Outline", "review and edit"], ["Page", "sections stream in"], ["Slides", "optional: page to deck"],
  ];
  const journey = h("ol", { class: "udm-journey", "aria-label": "Page generation steps" },
    ...JOURNEY.map(([a, b]) => h("li", {}, h("strong", {}, a), h("small", {}, b))));

  // ---------- 1. prompt form ----------
  const field = (id: string, text: string, control: HTMLElement, wide = false, hint?: string) =>
    h("div", { class: `udm-field${wide ? " udm-field--wide" : ""}` }, h("label", { class: "udm-label", for: id }, text), control,
      hint ? h("small", { class: "udm-hint", id: `${id}-hint` }, hint) : null);
  const select = (id: string, options: [string, string][], value: string) => {
    const s = h("select", { id, class: "udm-input" }, ...options.map(([v, t]) => h("option", { value: v }, t))) as HTMLSelectElement;
    s.value = value;
    return s;
  };
  const prompt = h("textarea", { id: "udm-prompt", class: "udm-input udm-prompt", rows: "4", required: true,
    placeholder: "For example: A one-page guide to moving a SaaS product from seat pricing to usage pricing, for the leadership team.",
    "aria-describedby": "udm-prompt-hint udm-prompt-error" }) as HTMLTextAreaElement;
  const promptError = h("p", { class: "udm-field-error", id: "udm-prompt-error" });
  const nSections = select("udm-nsections", Array.from({ length: 8 }, (_, i) => [String(i + 3), String(i + 3)]), "6");
  const tone = select("udm-tone", TONES.map((t) => [t, label(t)]), "default");
  const verbosity = select("udm-verbosity", VERBOSITIES.map((v) => [v, label(v)]), "standard");
  const language = select("udm-language", LANGUAGES, "auto-detect");
  for (const o of language.options) if (LANG_TAGS[o.value]) o.lang = LANG_TAGS[o.value];
  const instructions = h("textarea", { id: "udm-instructions", class: "udm-input", rows: "3",
    placeholder: "Optional. For example: Use British spelling. Include one table comparing the options." }) as HTMLTextAreaElement;
  const model = select("udm-model", MODELS.map((m) => [m.id, m.label]), DEFAULT_MODEL);
  const effort = select("udm-effort", EFFORTS.map((e) => [e, label(e)]), DEFAULT_EFFORT);

  const keyState = h("span", { class: "udm-key-state" });
  const keyBtn = h("button", { type: "button", class: "udm-btn udm-btn--sm", "aria-haspopup": "dialog" }, "API key…");
  const outlineBtn = h("button", { type: "submit", class: "udm-btn udm-btn--primary udm-btn--lg", "data-action": "generate-outline" },
    svgIcon(ICONS.spark), "Generate outline");
  const sampleBtn = h("button", { type: "button", class: "udm-btn udm-btn--lg", "data-action": "sample-run" }, "Watch a sample run");

  const form = h("form", { class: "udm-card-section", novalidate: true, "aria-labelledby": "udm-form-title" },
    h("h3", { class: "udm-card-section__title", id: "udm-form-title" }, "1. Describe the page"),
    field("udm-prompt", "Prompt (required)", prompt, true, "What the page is about, who it is for, and anything it must include."),
    promptError,
    h("div", { class: "udm-form-grid" },
      field("udm-nsections", "Sections", nSections),
      field("udm-tone", "Tone", tone),
      field("udm-verbosity", "Verbosity", verbosity),
      field("udm-language", "Language", language)),
    h("details", { class: "udm-details" }, h("summary", {}, "Advanced settings"),
      h("div", { class: "udm-form-grid" },
        field("udm-instructions", "Instructions", instructions, true),
        field("udm-model", "Model", model),
        field("udm-effort", "Effort", effort))),
    h("div", { class: "udm-key-row" }, keyState, keyBtn,
      h("span", { class: "udm-hint" }, "Live generation calls the Anthropic API from your browser with your own key.")),
    h("div", { class: "udm-btn-row" }, outlineBtn, h("span", { class: "udm-or" }, "or"), sampleBtn,
      h("span", { class: "udm-hint" }, "The sample run replays a recorded generation; no key needed.")));

  keyBtn.addEventListener("click", () => void openKeyDialog(keyBtn, refreshKey));
  prompt.addEventListener("input", () => {
    if (prompt.value.trim() && prompt.hasAttribute("aria-invalid")) { prompt.removeAttribute("aria-invalid"); promptError.textContent = ""; }
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); void startOutline(); });
  sampleBtn.addEventListener("click", () => void startSample());

  function refreshKey() {
    const k = getApiKey();
    keyState.dataset.on = String(!!k);
    keyState.textContent = k ? `API key: ${maskKey(k)} (this tab only)` : "API key: not set";
    keyBtn.textContent = k ? "Change key…" : "API key…";
  }

  // ---------- 2. outline review ----------
  const pageTitle = h("input", { id: "udm-outline-title", class: "udm-input udm-outline-item__title", type: "text" }) as HTMLInputElement;
  const outlineList = h("ol", { class: "udm-outline", "aria-label": "Sections" });
  const outlineStatus = h("p", { class: "udm-hint", "aria-live": "polite" });
  const addBtn = h("button", { type: "button", class: "udm-btn" }, "Add section");
  const backBtn = h("button", { type: "button", class: "udm-btn udm-btn--ghost" }, svgIcon(ICONS.back), "Back to prompt");
  const pageBtn = h("button", { type: "button", class: "udm-btn udm-btn--primary udm-btn--lg", "data-action": "generate-page" },
    "Generate page", svgIcon(ICONS.arrow));
  const outlineHead = h("h3", { class: "udm-card-section__title", id: "udm-outline-head" }, "2. Review the outline");
  const outlineCard = h("section", { class: "udm-card-section", "aria-labelledby": "udm-outline-head", hidden: true },
    outlineHead,
    h("p", { class: "udm-hint" }, `As on Presenton’s outline page: rename, reorder, delete or add sections. Each outline is Markdown, up to ${MAX_OUTLINE_CONTENT_WORDS} words; the section call writes the content from it.`),
    field("udm-outline-title", "Page title", pageTitle),
    outlineList, outlineStatus,
    h("div", { class: "udm-btn-row" }, addBtn, backBtn, pageBtn));
  pageTitle.addEventListener("input", () => { if (outline) outline = { ...outline, title: pageTitle.value }; });
  addBtn.addEventListener("click", () => {
    if (!outline) return;
    outline = { ...outline, sections: [...outline.sections, { id: newId(), title: "New section", content: "" }] };
    renderOutline(outline.sections.length - 1);
  });
  backBtn.addEventListener("click", () => { phase = "form"; refresh(); prompt.focus(); });
  pageBtn.addEventListener("click", () => void startPage());

  function renderOutline(focusIndex?: number, focusWhat: "title" | "up" | "down" = "title") {
    const secs = outline?.sections ?? [];
    const readOnly = phase !== "outline" || runKind === "sample";
    pageTitle.value = outline?.title ?? "";
    pageTitle.readOnly = readOnly;
    outlineList.replaceChildren(...secs.map((s, i) => {
      const n = i + 1;
      const tId = `udm-o-t-${s.id}`;
      const cId = `udm-o-c-${s.id}`;
      const title = h("input", { id: tId, class: "udm-input udm-outline-item__title", type: "text", "aria-label": `Section ${n} title` }) as HTMLInputElement;
      title.value = s.title;
      title.readOnly = readOnly;
      const content = h("textarea", { id: cId, class: "udm-input", rows: "3", "aria-label": `Section ${n} outline (Markdown)` }) as HTMLTextAreaElement;
      content.value = s.content;
      content.readOnly = readOnly;
      title.addEventListener("input", () => update(i, { title: title.value }));
      content.addEventListener("input", () => update(i, { content: content.value }));
      content.addEventListener("blur", () => {
        const t = trimWords(content.value);
        if (t !== content.value) { content.value = t; update(i, { content: t }); outlineStatus.textContent = `Section ${n} outline trimmed to ${MAX_OUTLINE_CONTENT_WORDS} words.`; }
      });
      const up = h("button", { type: "button", class: "udm-btn udm-btn--ghost udm-btn--sm", "aria-label": `Move section ${n} up`, disabled: readOnly || i === 0, "data-move": "up" }, "↑");
      const down = h("button", { type: "button", class: "udm-btn udm-btn--ghost udm-btn--sm", "aria-label": `Move section ${n} down`, disabled: readOnly || i === secs.length - 1, "data-move": "down" }, "↓");
      const del = h("button", { type: "button", class: "udm-btn udm-btn--ghost udm-btn--sm udm-btn--danger", "aria-label": `Delete section ${n}`, disabled: readOnly || secs.length <= 1 }, "Delete");
      up.addEventListener("click", () => move(i, -1));
      down.addEventListener("click", () => move(i, 1));
      del.addEventListener("click", () => {
        if (!outline) return;
        const gone = outline.sections[i];
        outline = { ...outline, sections: outline.sections.filter((_, k) => k !== i) };
        renderOutline(Math.min(i, outline.sections.length - 1));
        outlineStatus.textContent = `Deleted “${gone.title}”.`;
      });
      return h("li", { class: "udm-outline-item" },
        h("span", { class: "udm-outline-item__num", "aria-hidden": "true" }, String(n)),
        h("div", { class: "udm-outline-item__fields" }, title, content),
        h("div", { class: "udm-outline-item__tools" }, up, down, del));
    }));
    if (focusIndex != null && focusIndex >= 0) {
      const li = outlineList.children[focusIndex];
      const target = focusWhat === "title" ? li?.querySelector<HTMLElement>("input")
        : li?.querySelector<HTMLElement>(`[data-move="${focusWhat}"]:not(:disabled)`) ?? li?.querySelector<HTMLElement>("input");
      target?.focus();
    }
    refresh();
  }
  function update(i: number, patch: Partial<OutlineSection>) {
    if (!outline) return;
    outline = { ...outline, sections: outline.sections.map((s, k) => (k === i ? { ...s, ...patch } : s)) };
    refreshButtons();
  }
  function move(i: number, d: number) {
    if (!outline) return;
    const j = i + d;
    if (j < 0 || j >= outline.sections.length) return;
    const list = [...outline.sections];
    [list[i], list[j]] = [list[j], list[i]];
    outline = { ...outline, sections: list };
    renderOutline(j, d < 0 ? "up" : "down");
    outlineStatus.textContent = `Moved “${list[j].title}” to position ${j + 1}.`;
  }

  // ---------- 3. generation progress ----------
  const progressLabel = h("span", { class: "udm-progress__label" });
  const progressBar = h("progress", { max: "1", value: "0", "aria-labelledby": "udm-progress-label" }) as HTMLProgressElement;
  progressLabel.id = "udm-progress-label";
  const progressNote = h("p", { class: "udm-progress__note" });
  const cancelBtn = h("button", { type: "button", class: "udm-btn udm-btn--danger", "data-action": "cancel" }, "Cancel");
  cancelBtn.addEventListener("click", () => abort?.abort());
  const progressHead = h("h3", { class: "udm-card-section__title", id: "udm-progress-head" }, "3. Writing the page");
  const progressCard = h("section", { class: "udm-card-section udm-progress", "aria-labelledby": "udm-progress-head", hidden: true },
    progressHead,
    h("div", { class: "udm-progress__row" }, progressLabel, cancelBtn), progressBar, progressNote);

  // ---------- 4. done ----------
  const doneNote = h("p", { class: "udm-done__note" });
  const dl = (text: string, fn: () => void) => {
    const b = h("button", { type: "button", class: "udm-btn" }, svgIcon(ICONS.download), text);
    b.addEventListener("click", () => { try { fn(); } catch (e) { ctx.fail(ID, `Download ${text} failed`, e); } });
    return b;
  };
  const base = () => slug(outline?.title || "generated-page");
  const currentUdm = () => tiptapToUdm(ctx.getDoc(ID)).udm;
  const slidesPicker = createPicker({
    label: "Template for the slides",
    templates: ctx.index, selected: slidesTemplate,
    onPick: (id) => { slidesTemplate = id; refreshButtons(); },
  });
  const slidesBtn = h("button", { type: "button", class: "udm-btn udm-btn--primary", "data-action": "create-slides" },
    "Create slides from this page", svgIcon(ICONS.arrow));
  const pptxBtn = h("button", { type: "button", class: "udm-btn", "data-action": "pptx" }, svgIcon(ICONS.download), "Download PPTX");
  const newBtn = h("button", { type: "button", class: "udm-btn udm-btn--ghost" }, "Start a new page");
  slidesBtn.addEventListener("click", () => void createSlides());
  pptxBtn.addEventListener("click", () => {
    // ctx.run puts focus back on this button when the export finishes (it is disabled meanwhile).
    void ctx.run(ID, "PPTX export", async () => {
      const m = ctx.mode(ID);
      if (!m.deck || !m.template) return;
      await exportDeckPptx(m.deck, m.template, `${base()}.pptx`);
      ctx.status(`PPTX saved: ${plural(m.deck.slides.length, "slide")}.`, "success");
    });
  });
  newBtn.addEventListener("click", () => {
    phase = "form"; outline = null; sectionNodes = []; sectionMeta = []; generator = null; resultNote = "";
    ctx.setDoc(ID, EMPTY_DOC);
    ctx.patchMode(ID, { deck: null, template: null, udm: null, loss: [], issues: [], errors: [], changed: [], stage: 0, op: "" });
    refresh();
    prompt.focus();
  });
  const doneHead = h("h3", { class: "udm-card-section__title", id: "udm-done-head" }, "Your page is ready");
  const doneCard = h("section", { class: "udm-card-section udm-done", "aria-labelledby": "udm-done-head", hidden: true },
    doneHead,
    doneNote,
    h("div", { class: "udm-btn-row", role: "group", "aria-label": "Download the page" },
      dl("tiptap.json", () => saveFile(`${base()}.tiptap.json`, JSON.stringify(ctx.getDoc(ID), null, 2))),
      dl("Markdown", () => saveFile(`${base()}.md`, udmToMarkdown(currentUdm()).markdown, "text/markdown")),
      dl("UDM", () => saveFile(`${base()}.udm.json`, JSON.stringify(currentUdm(), null, 2)))),
    h("h3", { class: "udm-card-section__title" }, "4. Create slides from this page"),
    h("p", { class: "udm-hint" }, "The page goes back through the UDM into a Presenton deck: each section gets the template layout whose slots fit it best."),
    slidesPicker.el,
    h("div", { class: "udm-btn-row" }, slidesBtn, pptxBtn, newBtn));

  const panel = h("div", {},
    h("p", { class: "udm-panel__lead" },
      "Presenton’s Standard pipeline, aimed at a page instead of a deck: the prompt and settings produce an outline with one " +
      "Markdown outline per section; after your review, one structured call per section writes UDM blocks (headings, " +
      "paragraphs, lists, quotes, callouts, tables, charts with static data) that stream into the Tiptap editor below."),
    journey, form, outlineCard, progressCard, doneCard);

  // ---------- pipeline (src/generate) ----------
  function readInput(): PageInput {
    return {
      prompt: prompt.value.trim(),
      nSections: Number(nSections.value),
      tone: tone.value as PageInput["tone"],
      verbosity: verbosity.value as PageInput["verbosity"],
      language: language.value,
      instructions: instructions.value.trim() || undefined,
    };
  }

  /** `opener` gets focus back when the dialog closes: the button that asked for the key, not "API key…". */
  async function ensureKey(opener: HTMLElement): Promise<boolean> {
    if (getApiKey()) return true;
    ctx.status("Add an Anthropic API key to generate a page, or watch the sample run.");
    const ok = await openKeyDialog(opener, refreshKey);
    refreshKey();
    return ok && !!getApiKey();
  }

  /** User-facing error: GenerateError messages are written for people; add the next step where there is one. */
  function explain(e: unknown): Error {
    if (e instanceof GenerateError) {
      const next = e.kind === "auth" || e.kind === "no_key" ? " Use “API key…” to paste another key."
        : e.kind === "model" || e.kind === "permission" ? " Pick another model under Advanced settings." : "";
      const where = e.sectionIndex != null ? ` (section ${e.sectionIndex + 1})` : "";
      return new Error(`${e.message}${where}${next}`);
    }
    return e instanceof Error ? e : new Error(String(e));
  }

  async function startOutline() {
    if (!prompt.value.trim()) {
      prompt.setAttribute("aria-invalid", "true");
      promptError.textContent = "Write a prompt first: what should the page be about?";
      prompt.focus();
      ctx.status(promptError.textContent, "error");
      return;
    }
    prompt.removeAttribute("aria-invalid");
    promptError.textContent = "";
    if (!(await ensureKey(outlineBtn))) return;
    runKind = "live";
    generator = null;
    phase = "outline-loading";
    abort = new AbortController();
    const signal = abort.signal;
    refresh();
    moveFocus(progressHead, panel); // "Generate outline" is about to be disabled; Cancel is the next Tab stop
    ctx.status("Generating the outline…", "busy");
    const t0 = now();
    await ctx.run(ID, "Generate outline", async () => {
      try {
        const gen = createGenerator({ apiKey: getApiKey() ?? undefined, model: model.value, effort: effort.value });
        const o = await gen.outline(readInput(), signal);
        generator = gen;
        outline = o;
        phase = "outline";
        ctx.patchMode(ID, { stage: 1, op: `Outline: ${plural(o.sections.length, "section")} from ${gen.model} (${fmtMs(now() - t0)})` });
        renderOutline();
        moveFocus(outlineHead, panel);
        ctx.status(`Outline ready in ${((now() - t0) / 1000).toFixed(1)} s: ${plural(o.sections.length, "section")}. Review it, then Generate page.`, "success");
      } catch (e) {
        phase = "form";
        refresh();
        moveFocus(outlineBtn, panel); // re-enabled when the run ends; ctx.run focuses it then if this could not
        if (isAbort(e) || signal.aborted) { ctx.status("Outline generation stopped."); return; }
        throw explain(e);
      } finally { abort = null; refreshButtons(); }
    });
  }

  async function startPage() {
    if (!outline || !outline.sections.length) return;
    if (!(await ensureKey(pageBtn))) return;
    runKind = "live";
    const edited: Outline = {
      ...outline, title: pageTitle.value.trim() || outline.title,
      sections: outline.sections.map((s) => ({ ...s, title: s.title.trim() || "Untitled section", content: trimWords(s.content) })),
    };
    outline = edited;
    const gen = generator ?? createGenerator({ apiKey: getApiKey() ?? undefined, model: model.value, effort: effort.value });
    generator = gen;
    await generate("Generate page", (cb) => runPagePipeline(readInput(), { ...cb, generator: gen, outline: edited }));
  }

  async function startSample() {
    runKind = "sample";
    outline = null;
    generator = null;
    fillForm(SAMPLE_INPUT);
    await generate("Sample run", (cb) => replaySampleRun({
      ...cb,
      // Show the recorded outline for a moment, as the outline page would, then write the sections.
      onOutline: async (o, info) => { cb.onOutline(o, info); await pause(1500 / sampleSpeed, cb.signal); },
    }, { speed: sampleSpeed }));
  }

  const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

  type Callbacks = {
    onOutline: (o: Outline, info: { titleNodes: any[] }) => void;
    onSectionStart: (i: number) => void;
    onSection: (i: number, s: UdmSection, out: SectionEvent) => void;
    onDone: (r: PageResult) => void;
    onError: (e: GenerateError) => void;
    signal: AbortSignal;
  };

  async function generate(what: string, run: (cb: Callbacks) => Promise<PageResult | null>) {
    sectionNodes = [];
    sectionMeta = [];
    started = new Set();
    titleNodes = [];
    let error: GenerateError | null = null;
    abort = new AbortController();
    const signal = abort.signal;
    startedAt = now();
    ctx.patchMode(ID, { deck: null, template: null, changed: [], loss: [], issues: [], errors: [], udm: null, stage: runKind === "sample" ? 0 : 2 });
    if (runKind === "sample") {
      phase = "outline-loading";
      ctx.setDoc(ID, EMPTY_DOC);
      refresh();
      moveFocus(progressHead, panel); // the form (and the focused button) is hidden during the sample run
      ctx.status(`Sample run: replaying a recorded generation (“${SAMPLE_INPUT.prompt}”)…`, "busy");
    } else beginPage();

    const cb: Callbacks = {
      signal,
      onOutline(o, info) {
        outline = o;
        titleNodes = info.titleNodes ?? [];
        if (runKind === "sample") {
          phase = "outline";
          ctx.patchMode(ID, { stage: 1 });
          renderOutline();
          ctx.status(`Sample run: outline ready with ${plural(o.sections.length, "section")}. Writing the page next…`, "busy");
        } else {
          insert();
        }
      },
      onSectionStart(i) {
        if (phase !== "generating") beginPage();
        started.add(i);
        renderProgress();
      },
      onSection(i, s, out) {
        sectionNodes[i] = out.nodes;
        sectionMeta[i] = s;
        lossAcc = [...lossAcc, ...out.loss];
        issueAcc = [...issueAcc, ...out.issues];
        insert();
        renderProgress();
        const total = outline?.sections.length ?? 0;
        ctx.status(`Section ${i + 1} of ${total} in the editor: “${outline?.sections[i]?.title ?? ""}”.`, "busy");
      },
      onDone(r) {
        outline = r.outline;
        if (!ctx.setDoc(ID, r.doc)) throw new Error("The finished page did not pass the editor schema.");
        ctx.patchMode(ID, { udm: r.udm, loss: r.loss, issues: r.issues });
      },
      onError(e) { error = e; },
    };

    lossAcc = [];
    issueAcc = [];
    await ctx.run(ID, what, async () => {
      try {
        await run(cb);
      } finally {
        abort = null;
        lockEditor(false);
      }
      const err = error as GenerateError | null;
      if (!err) { finish(false); return; }
      if (err.kind === "aborted") { finish(true); return; }
      const arrived = sectionNodes.filter(Boolean).length;
      if (arrived) finish(true, err.message);
      else {
        phase = outline && runKind === "live" ? "outline" : "form";
        extra.replaceChildren();
        refresh();
        moveFocus(phase === "outline" ? outlineHead : prompt, panel);
      }
      throw explain(err);
    });
  }

  function fillForm(input: Partial<PageInput>) {
    if (input.prompt) prompt.value = input.prompt;
    if (input.nSections) nSections.value = String(Math.min(10, Math.max(3, input.nSections)));
    if (input.tone) tone.value = input.tone;
    if (input.verbosity) verbosity.value = input.verbosity;
    if (input.language) language.value = [...language.options].some((o) => o.value === input.language) ? input.language : "auto-detect";
    instructions.value = input.instructions ?? "";
  }

  function beginPage() {
    if (phase === "generating") return;
    phase = "generating";
    ctx.patchMode(ID, { stage: 2, op: "" });
    ctx.setDoc(ID, EMPTY_DOC);
    lockEditor(true);
    insert();
    renderOutline();
    renderProgress();
    moveFocus(progressHead, panel); // "Generate page" is disabled now; Cancel is the next Tab stop
  }

  /** No typing into the page while sections stream in (only when this mode owns the editor). */
  function lockEditor(lock: boolean) {
    if (ctx.store.get().mode === ID) ctx.editor.editor.setEditable?.(!lock);
  }

  /** Progressive insertion: the page title, then every section that has arrived, in outline order. */
  function insert() {
    const content = [...titleNodes];
    for (const nodes of sectionNodes) if (nodes) content.push(...nodes);
    if (!content.length) return;
    if (!ctx.setDoc(ID, { type: "doc", content })) throw new Error("A generated section did not pass the editor schema.");
    lockEditor(phase === "generating");
    ctx.patchMode(ID, { loss: lossAcc, issues: issueAcc });
  }

  function renderProgress() {
    const total = outline?.sections.length ?? 0;
    const done = sectionNodes.filter(Boolean).length;
    progressBar.max = Math.max(total, 1);
    progressBar.value = done;
    progressLabel.textContent = !total ? "Starting…" : done >= total ? `All ${total} sections written` : `Section ${done + 1} of ${total}`;
    const writing = [...started].filter((i) => !sectionNodes[i]).map((i) => `“${outline!.sections[i]?.title ?? ""}”`);
    progressNote.textContent = total && done < total
      ? `${writing.length ? `Writing ${writing.join(" and ")}. ` : ""}${plural(done, "section")} in the editor.` : "";
    renderSkeletons();
  }

  function renderSkeletons() {
    if (phase !== "generating" || !outline) { extra.replaceChildren(); return; }
    const pending = outline.sections.map((s, i) => ({ s, i })).filter(({ i }) => !sectionNodes[i]);
    extra.replaceChildren(...pending.map(({ s, i }) => {
      const active = started.has(i);
      return h("div", { class: `udm-skeleton${active ? " is-active" : ""}`, "aria-hidden": "true", "data-section": String(i) },
        h("span", { class: "udm-skeleton__state" }, active ? `Writing section ${i + 1}…` : `Section ${i + 1}: waiting`),
        h("span", { class: "udm-skeleton__title" }, s.title),
        h("span", { class: "udm-skeleton__line" }), h("span", { class: "udm-skeleton__line" }), h("span", { class: "udm-skeleton__line" }));
    }));
    const first = extra.querySelector(".udm-skeleton");
    if (first && ctx.store.get().mode === ID) first.scrollIntoView?.({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  function finish(stopped: boolean, why?: string) {
    const total = outline?.sections.length ?? 0;
    const arrived = sectionNodes.filter(Boolean).length;
    const ms = now() - startedAt;
    phase = arrived ? "done" : outline && runKind === "live" ? "outline" : "form";
    extra.replaceChildren();
    const fallbacks = sectionMeta.filter((s) => s?.fallback).length;
    const label = runKind === "sample" ? "Sample run" : "Generate page";
    resultNote = stopped
      ? `Stopped after ${arrived} of ${total} sections${why ? ` (${why})` : ""}. The page keeps what arrived.`
      : `${runKind === "sample" ? "Sample run finished" : "Page generated"}: ${plural(arrived, "section")} in ${(ms / 1000).toFixed(1)} s` +
        (fallbacks ? `; ${plural(fallbacks, "section")} fell back to the outline text` : "") + ".";
    ctx.patchMode(ID, { stage: arrived ? 2 : 0, dirty: false, op: `${label}: ${plural(arrived, "section")} (${fmtMs(ms)})` });
    refresh();
    // Cancel and the progress card are gone: continue from the result (or the outline / prompt when nothing arrived).
    moveFocus(phase === "done" ? doneHead : phase === "outline" ? outlineHead : prompt, panel);
    const m = ctx.mode(ID);
    ctx.status(`${resultNote} ${lossSummary(m.loss, m.issues)}.${arrived ? " Edit it, download it, or create slides from it." : ""}`, stopped ? "info" : "success");
  }

  async function createSlides() {
    if (!slidesTemplate) return;
    const id = slidesTemplate;
    await ctx.run(ID, "Create slides from this page", () => slidesFromPage(ctx, ID, id, 4));
    refresh();
  }

  // ---------- view ----------
  function refreshButtons() {
    const busy = !!ctx.store.get().busy;
    outlineBtn.disabled = busy;
    sampleBtn.disabled = busy;
    keyBtn.disabled = busy && phase !== "form";
    pageBtn.disabled = busy || phase !== "outline" || !outline?.sections.length;
    addBtn.disabled = busy || phase !== "outline";
    backBtn.disabled = busy;
    cancelBtn.disabled = !abort;
    slidesPicker.setDisabled(busy);
    slidesBtn.disabled = busy || phase !== "done" || !slidesTemplate;
    const m = ctx.mode(ID);
    pptxBtn.disabled = busy || !m.deck?.slides.length;
    newBtn.disabled = busy;
  }

  function refresh() {
    const active = ctx.store.get().mode === ID;
    extra.hidden = !active;
    if (!active) return;
    const showOutline = phase === "outline" || (!!outline && (phase === "generating" || phase === "outline-loading"));
    form.hidden = !(phase === "form" || phase === "outline-loading") || (runKind === "sample" && phase === "outline-loading");
    outlineCard.hidden = !showOutline;
    // The sample run pauses on its outline before writing: keep the progress card (and Cancel) on screen meanwhile.
    const samplePause = phase === "outline" && runKind === "sample" && !!abort;
    progressCard.hidden = !(phase === "generating" || phase === "outline-loading" || samplePause);
    if (samplePause) {
      progressLabel.textContent = "Outline ready";
      progressBar.removeAttribute("value");
      progressNote.textContent = "The recorded run writes the sections next.";
    }
    doneCard.hidden = phase !== "done";
    if (phase === "outline-loading") {
      progressLabel.textContent = runKind === "sample" ? "Loading the recorded run…" : "Generating the outline…";
      progressBar.removeAttribute("value");
      progressNote.textContent = runKind === "sample" ? "" : "One structured call returns the page title and one outline per section.";
    }
    doneNote.textContent = resultNote;
    const step = phase === "form" ? 0 : phase === "outline-loading" || phase === "outline" ? 1 : phase === "generating" ? 2 : ctx.mode(ID).deck ? 3 : 2;
    [...journey.children].forEach((li, i) => {
      li.classList.toggle("is-done", i < step);
      li.classList.toggle("is-current", i === step);
      if (i === step) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
    refreshButtons();
  }

  refreshKey();
  return {
    id: ID, panel, refresh,
    activate() { refreshKey(); refresh(); },
  };
}

