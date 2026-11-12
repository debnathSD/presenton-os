// Types for the prompt-to-page pipeline (Presenton's Standard pipeline, with a Tiptap page as the target).

export type Tone = "default" | "casual" | "professional" | "funny" | "educational" | "sales_pitch";
export type Verbosity = "concise" | "standard" | "text-heavy";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelId = "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-5-5";

export const MODELS: { id: ModelId; label: string }[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];
export const DEFAULT_MODEL: ModelId = "claude-opus-5-5";
export const DEFAULT_EFFORT: Effort = "medium";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const TONES: Tone[] = ["default", "casual", "professional", "funny", "educational", "sales_pitch"];
/** Presenton caps slides at 50 (MAX_NUMBER_OF_SLIDES); a page is capped lower. */
export const MAX_SECTIONS = 12;
/** Presenton MAX_OUTLINE_CONTENT_WORDS default. */
export const MAX_OUTLINE_CONTENT_WORDS = 100;
export const VERBOSITIES: Verbosity[] = ["concise", "standard", "text-heavy"];

/** Page form (mirrors POST /presentation/create: content, n_slides, tone, verbosity, language, instructions). */
export type PageInput = {
  prompt: string;
  /** Number of sections; null or undefined = let the model decide (max MAX_SECTIONS). */
  nSections?: number | null;
  tone?: Tone;
  verbosity?: Verbosity;
  /** "auto-detect" (default) or a language name such as "English", "Deutsch". */
  language?: string;
  instructions?: string;
};

export type OutlineSection = { id: string; title: string; content: string };
/** Outline review model: page title + one Markdown outline per section (editable: rename, reorder, delete, add). */
export type Outline = { title: string; sections: OutlineSection[] };

/** One generated section as UDM: the Section plus the static bindings its chart and table blocks point to. */
export type UdmSection = {
  index: number;
  outlineId: string;
  section: any;
  bindings: Record<string, any>;
  /** Set when the model output could not be used and the outline text was inserted as a paragraph instead. */
  fallback?: { reason: "refusal" | "invalid_output" | "max_tokens"; message: string };
  /** Non-fatal repairs made while converting the model output (ragged table rows, dropped empty blocks, ...). */
  notes: string[];
};

export type GenerateErrorKind =
  | "auth" | "permission" | "model" | "rate_limit" | "overloaded" | "server" | "network" | "timeout"
  | "bad_request" | "refusal" | "max_tokens" | "invalid_output" | "aborted" | "no_key" | "unknown";

/** Target manifest subset the section schema is built from (the tiptap adapter's AdapterManifest). */
export type TargetManifest = {
  id: string;
  blocks: string[];
  marks: string[];
  chartKinds?: string[];
  structure: { maxHeadingLevel: number; maxListDepth: number };
};
