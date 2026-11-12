// "Watch a sample run": replays the recorded generation in sample-run.json through runPagePipeline, with a RawSource
// that returns the recorded outline and section outputs after the recorded delays (scaled by `speed`).
// No key and no network; same normalization, conversion, validation and ordering as a live run.

import sample from "./sample-run.json";
import { normalizeOutline } from "./blocks";
import { GenerateError } from "./errors";
import { generatorFromSource, runPagePipeline, type PageResult, type PipelineCallbacks } from "./pipeline";
import type { PageInput } from "./types";

export const SAMPLE_RUN = sample as any;
export const SAMPLE_INPUT: PageInput = SAMPLE_RUN.input;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new GenerateError("aborted"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, Math.max(0, ms));
    const stop = () => { clearTimeout(t); reject(new GenerateError("aborted")); };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export function replaySampleRun(callbacks: PipelineCallbacks = {}, opts: { speed?: number } = {}): Promise<PageResult | null> {
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const run = SAMPLE_RUN;
  const recorded = normalizeOutline(run.outline, { nSections: run.input.nSections, runId: run.runId });
  const byOutlineId = new Map(recorded.sections.map((s, i) => [s.id, i]));
  const generator = generatorFromSource({
    model: run.model,
    async outline(_input, _now, signal) {
      await sleep(run.timings.outlineMs / speed, signal);
      return run.outline;
    },
    async section(_input, outline, index, _manifest, _now, signal) {
      const i = byOutlineId.get(outline.sections[index].id);
      await sleep((run.timings.sectionMs[i ?? index] ?? 5000) / speed, signal);
      // A section added during Outline review was never recorded: insert its outline text instead.
      if (i === undefined) throw new GenerateError("invalid_output", { message: "Not part of the recorded run." });
      return run.sections[i];
    },
  }, { runId: run.runId, now: () => new Date(run.recordedAt) });
  return runPagePipeline(run.input, { ...callbacks, generator });
}
