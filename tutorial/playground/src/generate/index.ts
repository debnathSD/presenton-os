// Prompt-to-page pipeline (the playground's primary flow). Presenton creates a deck from a prompt in three model
// steps (outline, structure, per-slide content); a page needs two: outline, then per-section content whose schema
// is built from the Tiptap target manifest. Sections arrive as UDM, already converted to Tiptap nodes.
//
// Usage (app):
//   const gen = createGenerator({ apiKey: getApiKey(), model, effort });
//   await runPagePipeline(input, { generator: gen, onOutline, onSectionStart, onSection, onDone, onError, signal });
//   await replaySampleRun({ onOutline, onSectionStart, onSection, onDone, onError, signal }, { speed: 2 });
//
// The Anthropic SDK and zod load lazily (./llm) on the first generator call, so they stay out of the initial bundle.

export * from "./types";
export { GenerateError, defaultMessage, isAbort } from "./errors";
export {
  createGenerator, generatorFromSource, runPagePipeline, pageManifest, sectionNodes, titleNodes, resolveModel, resolveEffort, newRunId,
  type Generator, type RawSource, type GeneratorOptions, type PipelineCallbacks, type PipelineOptions, type PageResult, type SectionEvent,
} from "./pipeline";
export {
  normalizeOutline, toUdmSection, fallbackSection, sectionToUdm, assemblePage, checkSection, inlineMarkdown,
  generatedBlockTypes, chartKinds, GEN_NS, type PageMeta,
} from "./blocks";
export { resolveLanguage, outlineSystemPrompt, outlineUserPrompt, sectionSystemPrompt, sectionUserPrompt } from "./prompts";
export { replaySampleRun, SAMPLE_RUN, SAMPLE_INPUT } from "./replay";
export { setApiKey, getApiKey, clearApiKey, isKeyRemembered, maskKey } from "./key";
