// Anthropic client wrapper (lazy-loaded: the SDK and zod are only fetched when a visitor generates with a key).
// Verified against the installed @anthropic-ai/sdk 1.8.0 source:
//   - new Anthropic({ apiKey, baseURL, dangerouslyAllowBrowser }) (src/client.ts): a passed apiKey stops env/profile
//     lookups; dangerouslyAllowBrowser adds the anthropic-dangerous-direct-browser-access header.
//   - client.messages.parse(params, { signal }) = create() then parseMessage() (src/resources/messages/messages.ts,
//     src/lib/parser.ts); response.parsed_output comes from output_config.format.parse().
//   - zodOutputFormat from "@anthropic-ai/sdk/helpers/zod" (zod/v4 toJSONSchema + transformJSONSchema).
//   - StopReason: end_turn | max_tokens | stop_sequence | tool_use | pause_turn | refusal | model_context_window_exceeded;
//     stop_details is set only on refusal.
//   - Error classes (src/core/error.ts): APIUserAbortError and APIConnectionError(+Timeout) extend APIError;
//     AuthenticationError 401, PermissionDeniedError 403, NotFoundError 404, RateLimitError 429,
//     OverloadedError 529 and InternalServerError >= 500, BadRequestError 400.
//   - Non-streaming max_tokens must stay under 128000 * 10 / 60 (calculateNonstreamingTimeout), hence 21000 on retry.
// parseMessage() throws when the text is not valid JSON for the schema, which happens on refusal and max_tokens
// (truncated JSON). To check stop_reason first, the format's parse() is wrapped so a failure yields null and the error
// is kept; the stop_reason checks then run before parsed_output is used.
// No temperature, top_p, top_k or thinking budget is sent (adaptive thinking is the default on these models).

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GenerateError } from "./errors";
import { outlineSchema, sectionSchema } from "./schema";
import { outlineSystemPrompt, outlineUserPrompt, sectionSystemPrompt, sectionUserPrompt } from "./prompts";
import type { Effort, ModelId, Outline, PageInput, TargetManifest } from "./types";

export const API_BASE_URL = "https://api.anthropic.com";
export const MAX_TOKENS = 12000;
export const RETRY_MAX_TOKENS = 21000;

export type LlmOptions = {
  apiKey?: string;
  model: ModelId;
  effort: Effort;
  /** Tests only: a client with messages.parse (no network). */
  client?: { messages: { parse: (params: any, options?: any) => Promise<any> } };
  /** Tests only: fetch used by the real SDK client. */
  fetch?: (input: any, init?: any) => Promise<any>;
  maxRetries?: number;
};

export type LlmCall = { system: string; user: string; schema: any; signal?: AbortSignal };

export function makeClient(opts: LlmOptions) {
  if (opts.client) return opts.client;
  if (!opts.apiKey) throw new GenerateError("no_key");
  return new Anthropic({
    apiKey: opts.apiKey,
    baseURL: API_BASE_URL, // never ANTHROPIC_BASE_URL or a profile's URL: the key goes to api.anthropic.com only
    dangerouslyAllowBrowser: true,
    maxRetries: opts.maxRetries ?? 2,
    ...(opts.fetch ? { fetch: opts.fetch as any } : {}),
  });
}

/** A format whose parse() never throws, so stop_reason can be checked before parsed_output is used. */
function safeFormat(schema: any) {
  const f = zodOutputFormat(schema);
  const state: { error?: string } = {};
  const format = {
    ...f,
    parse(content: string) {
      try { return f.parse(content); } catch (e) { state.error = e instanceof Error ? e.message : String(e); return null; }
    },
  };
  return { format, state };
}

/** One structured call: checks stop_reason, retries once on max_tokens with a higher limit, maps SDK errors. */
export async function callParsed(client: NonNullable<LlmOptions["client"]>, opts: LlmOptions, call: LlmCall): Promise<any> {
  let maxTokens = MAX_TOKENS;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { format, state } = safeFormat(call.schema);
    let res: any;
    try {
      res = await client.messages.parse({
        model: opts.model,
        max_tokens: maxTokens,
        system: call.system,
        messages: [{ role: "user", content: call.user }],
        output_config: { effort: opts.effort, format },
      }, { signal: call.signal });
    } catch (e) {
      throw toGenerateError(e, call.signal);
    }
    if (res.stop_reason === "refusal") {
      const category = res.stop_details?.category;
      throw new GenerateError("refusal", { detail: category ? `category: ${category}` : undefined });
    }
    if (res.stop_reason === "max_tokens" && attempt === 0) { maxTokens = RETRY_MAX_TOKENS; continue; }
    if (res.stop_reason === "max_tokens" || res.stop_reason === "model_context_window_exceeded") throw new GenerateError("max_tokens");
    if (res.parsed_output == null) throw new GenerateError("invalid_output", { detail: state.error ?? `stop_reason: ${res.stop_reason}` });
    return res.parsed_output;
  }
  throw new GenerateError("max_tokens");
}

/** SDK error -> GenerateError, most specific class first. The key is never part of the message. */
export function toGenerateError(e: unknown, signal?: AbortSignal): GenerateError {
  if (e instanceof GenerateError) return e;
  if (e instanceof Anthropic.APIUserAbortError || signal?.aborted || (e as any)?.name === "AbortError") return new GenerateError("aborted");
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new GenerateError("timeout");
  if (e instanceof Anthropic.APIConnectionError) return new GenerateError("network");
  if (e instanceof Anthropic.AuthenticationError) return new GenerateError("auth", { status: 401 });
  if (e instanceof Anthropic.PermissionDeniedError) return new GenerateError("permission", { status: 403 });
  if (e instanceof Anthropic.NotFoundError) return new GenerateError("model", { status: 404 });
  if (e instanceof Anthropic.RateLimitError) return new GenerateError("rate_limit", { status: 429 });
  if (e instanceof Anthropic.OverloadedError) return new GenerateError("overloaded", { status: 529 });
  if (e instanceof Anthropic.InternalServerError) return new GenerateError("server", { status: e.status });
  if (e instanceof Anthropic.BadRequestError) {
    const msg = (e as any).error?.error?.message;
    return new GenerateError("bad_request", { status: 400, ...(msg ? { message: `The API rejected the request: ${msg}` } : {}) });
  }
  if (e instanceof Anthropic.APIError) return new GenerateError("unknown", { status: e.status, detail: e.message });
  return new GenerateError("unknown", { detail: e instanceof Error ? e.message : String(e) });
}

export function outlineCall(input: PageInput, now: Date, signal?: AbortSignal): LlmCall {
  return { system: outlineSystemPrompt(input.verbosity), user: outlineUserPrompt(input, now), schema: outlineSchema, signal };
}

export function sectionCall(input: PageInput, outline: Outline, index: number, manifest: TargetManifest, now: Date, signal?: AbortSignal): LlmCall {
  return { system: sectionSystemPrompt(input, manifest), user: sectionUserPrompt(input, outline, index, now),
    schema: sectionSchema(manifest), signal };
}

/** JSON Schema actually sent as output_config.format.schema (for the inspector and tests). */
export function outputJsonSchema(schema: any): any {
  return zodOutputFormat(schema).schema;
}
export { outlineSchema, sectionSchema };
