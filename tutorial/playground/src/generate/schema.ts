// zod schemas for structured outputs (output_config.format via zodOutputFormat). The section schema is built from the
// Tiptap target manifest, so the model can only emit block types (and chart kinds, heading levels) the editor holds.
// Constraints the API's JSON Schema subset cannot express (counts, lengths) are kept out of the schemas on purpose:
// zodOutputFormat would move them into descriptions and then reject otherwise usable output client-side. They are
// enforced while converting (blocks.ts) instead.

import { z } from "zod/v4";
import type { TargetManifest } from "./types";
import { chartKinds, generatedBlockTypes, headingLevels } from "./blocks";

const text = (d: string) => z.string().describe(d);
const INLINE = "Plain text; optional **bold** or *italic* emphasis; no other Markdown.";

export const outlineSchema = z.object({
  title: text("Concise plain-text page title."),
  sections: z.array(z.object({
    title: text("Short plain-text section title."),
    content: text("Markdown outline of the section content (bullets, a short paragraph, or a compact table)."),
  })).describe("One outline per section, in reading order."),
});

/** Block union for one section, restricted to what `manifest` can hold. */
export function sectionSchema(manifest: TargetManifest) {
  const types = generatedBlockTypes(manifest);
  const variants: Record<string, z.ZodObject<any>> = {
    paragraph: z.object({ type: z.literal("paragraph"), text: text(INLINE) }),
    heading: z.object({
      type: z.literal("heading"),
      level: z.literal(headingLevels(manifest) as [number, ...number[]]).describe("1 = sub-heading; higher = minor heading."),
      text: text("Plain text."),
    }),
    list: z.object({ type: z.literal("list"), ordered: z.boolean(), items: z.array(text(INLINE)) }),
    quote: z.object({ type: z.literal("quote"), text: text(INLINE), attribution: z.string().nullable() }),
    callout: z.object({ type: z.literal("callout"), tone: z.enum(["info", "warning", "success"]), text: text(INLINE) }),
    table: z.object({
      type: z.literal("table"),
      columns: z.array(z.string()).describe("Column headers."),
      rows: z.array(z.array(z.string())).describe("Rows of cell text, one cell per column."),
      caption: z.string().nullable().describe("One short sentence; say when values are illustrative."),
    }),
    chart: z.object({
      type: z.literal("chart"),
      chartType: z.enum(chartKinds(manifest) as [string, ...string[]]),
      title: z.string(),
      categories: z.array(z.string()).describe("Category labels (x values)."),
      series: z.array(z.object({
        name: z.string(),
        values: z.array(z.number()).describe("One plain number per category."),
      })),
      xAxisLabel: z.string().nullable(),
      yAxisLabel: z.string().nullable().describe("Include the unit, e.g. 'EUR m' or '%'."),
      caption: z.string().describe("One sentence; say when values are illustrative estimates."),
    }),
    divider: z.object({ type: z.literal("divider") }),
  };
  const list = types.map((t) => variants[t]);
  const block = list.length === 1 ? list[0] : z.discriminatedUnion("type", list as [z.ZodObject<any>, z.ZodObject<any>, ...z.ZodObject<any>[]]);
  return z.object({ blocks: z.array(block).describe("Blocks in reading order.") });
}

export type RawOutline = z.infer<typeof outlineSchema>;
