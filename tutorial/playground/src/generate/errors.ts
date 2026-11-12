// User-facing error type for the generator. SDK errors are mapped to it in llm.ts (typed classes, never message
// matching). Messages never include the API key or request headers.

import type { GenerateErrorKind } from "./types";

const MESSAGES: Record<GenerateErrorKind, string> = {
  auth: "The API key was rejected. Check that it is a valid Anthropic API key and try again.",
  permission: "This API key is not allowed to use the selected model.",
  model: "The selected model is not available to this API key. Pick another model.",
  rate_limit: "Rate limit reached for this API key. Wait a minute and try again.",
  overloaded: "The Anthropic API is temporarily overloaded. Try again in a moment.",
  server: "The Anthropic API returned a server error. Try again in a moment.",
  network: "Could not reach api.anthropic.com. Check your connection (and any blocker that filters API calls).",
  timeout: "The request to api.anthropic.com timed out. Try again, or pick a lower effort.",
  bad_request: "The API rejected the request.",
  refusal: "The model declined to write this content. Try rephrasing the prompt.",
  max_tokens: "The model ran out of output tokens before finishing, even after a retry with a higher limit.",
  invalid_output: "The model returned output that did not match the page schema.",
  aborted: "Generation was stopped.",
  no_key: "Add an Anthropic API key to generate a page, or watch the sample run.",
  unknown: "Something went wrong while generating the page.",
};

export class GenerateError extends Error {
  readonly kind: GenerateErrorKind;
  readonly status?: number;
  readonly detail?: string;
  sectionIndex?: number;
  constructor(kind: GenerateErrorKind, opts: { message?: string; status?: number; detail?: string; sectionIndex?: number } = {}) {
    super(opts.message ?? MESSAGES[kind]);
    this.name = "GenerateError";
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.detail !== undefined) this.detail = opts.detail;
    if (opts.sectionIndex !== undefined) this.sectionIndex = opts.sectionIndex;
  }
}

export const defaultMessage = (kind: GenerateErrorKind) => MESSAGES[kind];

export function isAbort(e: unknown) {
  return e instanceof GenerateError ? e.kind === "aborted" : (e as any)?.name === "AbortError";
}
