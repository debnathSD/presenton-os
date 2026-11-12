// Prompt -> page, mirroring Presenton's Standard pipeline: outline call (page title + one outline per section),
// optional Outline review, then one content call per section whose schema comes from the Tiptap target manifest.
// Sections are generated two at a time and handed to the app strictly in outline order, each already converted to
// Tiptap nodes with bridge.udmToTiptap and schema-checked, so the editor can append them one by one.

import { hashId } from "../../../prototypes/udm/core/udm-runtime.mjs";
import { registry, udmToTiptap, type Issue, type Loss } from "../udm/bridge";
import { assemblePage, fallbackSection, normalizeOutline, sectionToUdm, toUdmSection, type PageMeta, type SectionContext } from "./blocks";
import { GenerateError, isAbort } from "./errors";
import { resolveLanguage } from "./prompts";
import {
  DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, MAX_SECTIONS, MODELS,
  type Effort, type ModelId, type Outline, type OutlineSection, type PageInput, type TargetManifest, type UdmSection,
} from "./types";

// ---------- generator ----------

export type Generator = {
  model: string;
  runId: string;
  outline(input: PageInput, signal?: AbortSignal): Promise<Outline>;
  section(input: PageInput, outline: Outline, index: number, manifest: TargetManifest, signal?: AbortSignal): Promise<UdmSection>;
};

/** Where raw (schema-shaped) model output comes from: the Anthropic API, or a recording. */
export type RawSource = {
  model: string;
  outline(input: PageInput, now: Date, signal?: AbortSignal): Promise<any>;
  section(input: PageInput, outline: Outline, index: number, manifest: TargetManifest, now: Date, signal?: AbortSignal): Promise<any>;
};

const SECTION_FALLBACK_KINDS = new Set(["refusal", "invalid_output", "max_tokens"]);

export function newRunId(): string {
  const c = (globalThis as any).crypto;
  return c?.randomUUID ? c.randomUUID() : hashId("run", String(Date.now()), String(Math.random()));
}

/** Wrap a raw source with normalization, conversion, checkUdm validation and the outline fallback. */
export function generatorFromSource(src: RawSource, opts: { runId?: string; now?: () => Date } = {}): Generator {
  const runId = opts.runId ?? newRunId();
  const now = opts.now ?? (() => new Date());
  return {
    model: src.model,
    runId,
    async outline(input, signal) {
      const raw = await src.outline(input, now(), signal);
      const o = normalizeOutline(raw, { nSections: input.nSections, runId, fallbackTitle: input.prompt });
      if (!o.sections.length) throw new GenerateError("invalid_output", { message: "The model returned an outline with no sections." });
      return o;
    },
    async section(input, outline, index, manifest, signal) {
      const ctx: SectionContext = { runId, index, outline, manifest };
      let raw: any;
      try {
        raw = await src.section(input, outline, index, manifest, now(), signal);
      } catch (e) {
        if (e instanceof GenerateError && SECTION_FALLBACK_KINDS.has(e.kind)) {
          return fallbackSection(ctx, e.kind as any, [e.message, e.detail].filter(Boolean).join(" "));
        }
        throw e;
      }
      // Conversion is ours, not the model's: an exception here (unexpected output shape reaching the prototype's
      // checks) costs this section its content, not the whole run.
      try {
        return toUdmSection(raw, ctx);
      } catch (e) {
        return fallbackSection(ctx, "invalid_output", `Conversion failed: ${(e as any)?.message ?? e}`);
      }
    },
  };
}

export type GeneratorOptions = {
  apiKey?: string;
  model?: string;
  effort?: string;
  /** Tests only (see llm.ts). */
  client?: any;
  fetch?: any;
  maxRetries?: number;
  runId?: string;
  now?: () => Date;
};

export const resolveModel = (m?: string): ModelId => (MODELS.some((x) => x.id === m) ? (m as ModelId) : DEFAULT_MODEL);
export const resolveEffort = (e?: string): Effort => (EFFORTS.includes(e as Effort) ? (e as Effort) : DEFAULT_EFFORT);

/** Anthropic-backed generator. The SDK, zod and the prompts load on the first call (separate chunk). */
export function createGenerator(opts: GeneratorOptions): Generator {
  const model = resolveModel(opts.model);
  const effort = resolveEffort(opts.effort);
  if (!opts.apiKey && !opts.client) throw new GenerateError("no_key");
  let llm: Promise<{ mod: typeof import("./llm"); client: any }> | null = null;
  // The chunk is fetched once; a failed fetch (offline, deploy in progress) is not cached, so the next call retries.
  const load = () => (llm ??= import("./llm").then(
    (mod) => ({ mod, client: mod.makeClient({ ...opts, model, effort }) }),
    (e) => {
      throw new GenerateError("network", {
        message: "Could not load the generator code from this site. Check your connection and try again.",
        detail: String((e as any)?.message ?? e),
      });
    },
  ).catch((e) => { llm = null; throw e; }));
  const settings = { model, effort, apiKey: opts.apiKey, client: opts.client };
  return generatorFromSource({
    model,
    async outline(input, now, signal) {
      const { mod, client } = await load();
      return mod.callParsed(client, settings, mod.outlineCall(input, now, signal));
    },
    async section(input, outline, index, manifest, now, signal) {
      const { mod, client } = await load();
      return mod.callParsed(client, settings, mod.sectionCall(input, outline, index, manifest, now, signal));
    },
  }, { runId: opts.runId, now: opts.now });
}

/** The editor target: the tiptap (page profile) adapter's manifest from the bridge registry. */
export function pageManifest(): TargetManifest {
  return registry.get("tiptap").manifest as TargetManifest;
}

// ---------- tiptap nodes ----------

/** Top-level Tiptap nodes for one section, without the artifact metadata udmToTiptap puts on a doc's first node. */
export function sectionNodes(s: UdmSection): { nodes: any[]; loss: Loss[]; issues: Issue[] } {
  const { doc, loss, issues } = udmToTiptap(sectionToUdm(s));
  const nodes = doc.content.map((n: any, i: number) => {
    if (i !== 0 || !n.attrs?.udmMeta?.artifact) return n;
    const { artifact, ...rest } = n.attrs.udmMeta;
    return { ...n, attrs: { ...n.attrs, udmMeta: Object.keys(rest).length ? rest : null } };
  });
  return { nodes, loss, issues };
}

/** The page title (H1, udmKind doc-title) carrying the artifact metadata, to insert before the first section. */
export function titleNodes(outline: Outline, meta: PageMeta): any[] {
  return udmToTiptap(assemblePage(outline, [], meta)).doc.content;
}

// ---------- pipeline ----------

export type SectionEvent = { nodes: any[]; loss: Loss[]; issues: Issue[] };
export type PageResult = { runId: string; model: string; input: PageInput; outline: Outline; sections: UdmSection[]; udm: any; doc: any; loss: Loss[]; issues: Issue[] };

export type PipelineCallbacks = {
  /** Outline review: return an edited outline (renamed, reordered, deleted or added sections) to use it instead. */
  onOutline?: (outline: Outline, info: { runId: string; titleNodes: any[] }) => void | Outline | Promise<void | Outline>;
  onSectionStart?: (index: number, section: OutlineSection) => void;
  /** Called in outline order. `nodes` are ready to append to the editor. */
  onSection?: (index: number, section: UdmSection, out: SectionEvent) => void;
  onDone?: (result: PageResult) => void;
  onError?: (error: GenerateError) => void;
  signal?: AbortSignal;
};

export type PipelineOptions = PipelineCallbacks & GeneratorOptions & {
  generator?: Generator;
  /** Start from an outline (skips the outline call). */
  outline?: Outline;
  manifest?: TargetManifest;
  /** Parallel section calls (default 2). */
  concurrency?: number;
};

function normalizeInput(input: PageInput): PageInput {
  const prompt = String(input?.prompt ?? "").trim();
  if (!prompt) throw new GenerateError("bad_request", { message: "Enter a prompt for the page." });
  const n = input.nSections == null ? null : Math.min(MAX_SECTIONS, Math.max(1, Math.round(Number(input.nSections)) || 1));
  return { ...input, prompt, nSections: n, language: resolveLanguage(input.language) };
}

/**
 * Section with a schema-valid Tiptap rendering; falls back to the outline paragraph when the nodes fail the check
 * or the conversion throws.
 */
function finalize(s: UdmSection, ctx: SectionContext): { s: UdmSection; out: SectionEvent } {
  let out: SectionEvent | null = null;
  let why = "";
  try {
    out = sectionNodes(s);
    if (out.issues.some((i) => i.level === "error")) why = `Tiptap schema: ${out.issues.map((i) => i.message).join("; ")}`;
  } catch (e) {
    why = `Tiptap conversion failed: ${(e as any)?.message ?? e}`;
  }
  if (!why && out) return { s, out };
  s = fallbackSection(ctx, "invalid_output", why);
  return { s, out: sectionNodes(s) };
}

/**
 * Runs outline -> (review) -> sections. Never rejects when onError is given: errors (including abort) go to onError
 * and the promise resolves to null. Without onError the error is thrown.
 */
export async function runPagePipeline(input: PageInput, opts: PipelineOptions = {}): Promise<PageResult | null> {
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const aborted = () => opts.signal?.aborted || inner.signal.aborted;
  try {
    const page = normalizeInput(input);
    const gen = opts.generator ?? createGenerator(opts);
    const manifest = opts.manifest ?? pageManifest();
    if (aborted()) throw new GenerateError("aborted");

    let outline = opts.outline
      ? normalizeOutline(opts.outline, { nSections: null, runId: gen.runId, fallbackTitle: page.prompt })
      : await gen.outline(page, inner.signal);
    if (aborted()) throw new GenerateError("aborted");
    const meta: PageMeta = { runId: gen.runId, model: gen.model, prompt: page.prompt, createdAt: new Date().toISOString(), language: page.language };
    const edited = await opts.onOutline?.(outline, { runId: gen.runId, titleNodes: titleNodes(outline, meta) });
    if (edited) outline = normalizeOutline(edited, { nSections: null, runId: gen.runId, fallbackTitle: page.prompt });
    if (!outline.sections.length) throw new GenerateError("bad_request", { message: "The outline has no sections." });
    if (aborted()) throw new GenerateError("aborted");

    const n = outline.sections.length;
    const done: ({ s: UdmSection; out: SectionEvent } | undefined)[] = new Array(n);
    let next = 0;
    let emitted = 0;
    let failed = false;
    const flush = () => {
      while (!failed && emitted < n && done[emitted]) {
        const { s, out } = done[emitted]!;
        opts.onSection?.(emitted, s, out);
        emitted++;
      }
    };
    const worker = async () => {
      while (!failed) {
        const i = next++;
        if (i >= n) return;
        if (aborted()) throw new GenerateError("aborted");
        opts.onSectionStart?.(i, outline.sections[i]);
        let s: UdmSection;
        try {
          s = await gen.section(page, outline, i, manifest, inner.signal);
        } catch (e) {
          const err = e instanceof GenerateError ? e : new GenerateError(isAbort(e) ? "aborted" : "unknown", { detail: String((e as any)?.message ?? e) });
          if (err.sectionIndex === undefined) err.sectionIndex = i;
          throw err;
        }
        if (aborted()) throw new GenerateError("aborted");
        done[i] = finalize(s, { runId: gen.runId, index: i, outline, manifest });
        flush();
      }
    };
    const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, n)) }, () => worker());
    try {
      await Promise.all(workers);
    } catch (e) {
      failed = true;
      inner.abort();
      await Promise.allSettled(workers);
      throw e;
    }

    const sections = done.map((d) => d!.s);
    const udm = assemblePage(outline, sections, meta);
    const full = udmToTiptap(udm);
    const result: PageResult = { runId: gen.runId, model: gen.model, input: page, outline, sections, udm, doc: full.doc,
      loss: full.loss, issues: full.issues };
    opts.onDone?.(result);
    return result;
  } catch (e) {
    // Only the caller's signal turns an error into "aborted"; the inner abort after a failed section keeps that error.
    const err = opts.signal?.aborted ? new GenerateError("aborted")
      : e instanceof GenerateError ? e
      : isAbort(e) ? new GenerateError("aborted")
      : new GenerateError("unknown", { detail: String((e as any)?.message ?? e) });
    if (!opts.onError) throw err;
    opts.onError(err);
    return null;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
