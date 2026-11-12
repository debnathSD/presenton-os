// Prompts for pages, adapted from Presenton's Standard pipeline prompts:
//   servers/fastapi/utils/llm_calls/generate_presentation_outlines.py  (get_system_prompt, get_user_prompt)
//   servers/fastapi/utils/llm_calls/generate_slide_content.py          (SLIDE_CONTENT_SYSTEM_PROMPT, user prompt)
// Slides become sections; the layout's JSON schema becomes the section schema built from the Tiptap target manifest.
// Kept from Presenton: authoritative generation settings, direct content voice (no meta-commentary), tone, verbosity
// and language handling, scoped instructions, "production controls are not content", and the chart rule (a compact
// data table; supplied data preserved; estimates labeled as illustrative). Dropped: presenter name, title slide,
// table of contents, web search, speaker notes, icons and image prompts, LaTeX (the page profile has no math mark).

import type { Outline, PageInput, TargetManifest, Tone, Verbosity } from "./types";
import { MAX_OUTLINE_CONTENT_WORDS, MAX_SECTIONS } from "./types";
import { generatedBlockTypes } from "./blocks";

const DIRECT_CONTENT_VOICE_RULES = `Content voice rules:
- Write the content itself, not commentary about the page or document.
- Never refer to "this page", "this section", "this document", "this report", "the following section", "the previous section", or similar phrases.
- Never use meta-introductions such as "this page explores", "this section presents", "we will discuss", "here we show", or equivalent wording.
- Start directly with the subject, claim, finding, action, or relevant fact.
- Treat the supplied current date as context only. Do not mention it or begin content with it unless the user explicitly requests the date or it is substantively relevant to the source content.
`;

const NO_LIVE_DATA_RULE =
  "No live or connected data is available. Never present a number as current, measured or verified unless the user supplied it; " +
  "numbers you add yourself are illustrative estimates and must be labeled as such.\n";

export function resolveLanguage(language?: string | null): string {
  const s = String(language ?? "").trim();
  return !s || ["auto", "auto-detect"].includes(s.toLowerCase()) ? "auto-detect" : s;
}

const toneText = (tone?: Tone) => (!tone || tone === "default" ? "" : tone.replace(/_/g, " "));

// ---------- outline (generate_ppt_outline -> page outline) ----------

export function outlineSystemPrompt(verbosity?: Verbosity): string {
  const verbosityInstruction =
    verbosity === "concise" ? "Section content should be around 20 words but detailed enough to write a good section."
    : verbosity === "text-heavy" ? "Section content should be around 60 words but detailed enough to write a good section."
    : "Section content should be around 40 words but detailed enough to write a good section.";

  const sectionOutlineStructure =
    "Each section outline:\n" +
    "   - Has a short plain-text section title in the title field (no ## and no numbering).\n" +
    "   - Has its content in Markdown in the content field.\n" +
    "   - Don't use **bold** and __italic__ text.\n" +
    "   - Section titles must not repeat the page title. Do not add a separate title or cover section; the page title is shown above the first section.";

  const contentOnlyRules =
    "Section outlines are a user-visible content plan, not a production brief.\n" +
    "Write only reader-facing content and data that could appear in the finished section.\n" +
    "Never include or paraphrase commands, configuration, or meta-commentary about how to create the section. This includes requests " +
    "about block type, charts, graphs, tables, images, icons, layout, positioning, colors, fonts, styling, or formatting.\n" +
    "Do not write phrases such as 'create a bar chart', 'add an image', 'use a table', 'show this as', 'the section should', or 'place on the left'.\n" +
    "Use visual requests only to choose content for the specified section. For any chart request, include a compact Markdown table with " +
    "labels and numeric values. Preserve supplied data; otherwise add a small relevant dataset and clearly label estimates or illustrative " +
    "values. Do not mention the chart instruction.\n" +
    "Example: for 'section 3: create a bar chart of Q1 10, Q2 20', section 3 may contain a title and a Quarter | Value Markdown table, " +
    "but it must not contain the words 'create a bar chart'.\n";

  return (
    "Generate a page title and content outlines for the sections of a long-form page (a document read top to bottom, not slides).\n" +
    "Generation settings are authoritative. The Number of Sections, Language, and Tone fields override conflicting requests inside " +
    "Content, Instructions, or Context.\n" +
    "If Language is not auto-detect, generate the page title and every section outline in exactly that language, even if Content asks " +
    "for a different language.\n" +
    "Generate flow based on user **content** and use **context** just for reference.\n" +
    `${DIRECT_CONTENT_VOICE_RULES}\n` +
    "Page title should be plain text, not markdown. It should be a concise title for the page.\n" +
    "Each section outline should contain the content for that section.\n" +
    `Never generate more than ${MAX_SECTIONS} section outlines, even if the user asks for more. ` +
    `Each section outline must be ${MAX_OUTLINE_CONTENT_WORDS} words or fewer.\n` +
    `${verbosityInstruction}\n` +
    "Follow the intended outcome of user instructions when they do not conflict with the authoritative generation settings, but never " +
    "copy production instructions into section content.\n" +
    "Apply section-specific instructions only to the exact section mentioned and only once. Do not apply patterns across multiple " +
    "sections unless explicitly requested. Resolve ambiguous instructions using the most direct interpretation.\n" +
    "Follow the user's specified tone across all sections. Maintain clarity, readability, and factual accuracy. If no tone is provided, " +
    "use a clear and professional style. Ensure logical flow between sections and avoid repetition or generic filler content.\n" +
    "Give each section one clear purpose and split overloaded topics across multiple sections.\n" +
    "Minimize repetitive phrasing and do not repeat the same facts across sections.\n" +
    "Build a coherent narrative from the introduction through the conclusion.\n" +
    "Vary reader-facing content structures where appropriate, using bullets, comparisons, chronological facts, tables, or metrics.\n" +
    "Use concrete facts, examples, and numbers when supported by the provided content/context.\n" +
    "Include numerical data or tables if required or asked by the user.\n" +
    "If 'auto-detect' is used, figure it out from the content/context.\n" +
    `${sectionOutlineStructure}\n` +
    contentOnlyRules +
    "Section content must not contain any branding or styling information.\n" +
    "Do not include URLs, hyperlinks, citations, footnotes, references, or source lists in section outlines.\n" +
    "Make sure data is consistent across all sections.\n" +
    NO_LIVE_DATA_RULE
  );
}

export function outlineUserPrompt(input: PageInput, now: Date): string {
  const n = input.nSections ? String(input.nSections) : `auto-detect, maximum ${MAX_SECTIONS}`;
  return (
    "Generation Settings (authoritative):\n" +
    `Number of Sections: ${n}\n` +
    `Maximum Section Outlines: ${MAX_SECTIONS}\n` +
    `Maximum Words Per Outline: ${MAX_OUTLINE_CONTENT_WORDS}\n` +
    `Language: ${resolveLanguage(input.language)}\n` +
    `Tone: ${toneText(input.tone)}\n` +
    "If Content, Instructions, or Context asks for a different language or section count, ignore that conflicting request.\n" +
    `Today's Date: ${now.toISOString().slice(0, 10)}\n` +
    `Content: ${input.prompt ?? ""}\n` +
    `Instructions (apply as constraints; never quote as section content): ${input.instructions ?? ""}\n` +
    "Context: None\n"
  );
}

// ---------- section content (get_slide_content_from_type_and_outline -> one page section) ----------

const BLOCK_HELP: Record<string, string> = {
  paragraph: "paragraph: prose, 1 to 4 sentences.",
  heading: "heading: a sub-heading inside the section (level 1 = sub-heading, deeper levels for minor headings). Never repeat the section title.",
  list: "list: bullet points (ordered=false) or numbered steps (ordered=true); each item is one short line.",
  quote: "quote: a short quotation; attribution only when the outline names the speaker, otherwise null. Never invent quotes from real people.",
  callout: "callout: one highlighted takeaway or warning; tone info, warning or success.",
  table: "table: column headers and rows of cell text (every row has one cell per column); caption one short sentence or null.",
  chart: "chart: static numbers only. categories (the x values), one or more series with one numeric value per category, " +
    "a short title, optional axis labels, and a one-sentence caption.",
  divider: "divider: a thematic break between two parts of a long section. Rarely needed.",
};

export function sectionSystemPrompt(input: PageInput, manifest: TargetManifest): string {
  const types = generatedBlockTypes(manifest);
  const marks = manifest.marks;
  const emphasis = [marks.includes("bold") ? "bolding (**text**)" : "", marks.includes("italic") ? "italicizing (*text*)" : ""]
    .filter(Boolean).join(" or ");
  const tone = toneText(input.tone);
  const v = input.verbosity;
  const blockCount = v === "concise" ? "2 to 3" : v === "text-heavy" ? "4 to 7" : "3 to 5";
  const dataRules = types.includes("chart") || types.includes("table")
    ? "# Data Rules\n" +
      "- Charts and tables hold static numbers only; no live data is connected.\n" +
      "- Preserve every number supplied in the section content. When you add numbers yourself, keep them plausible and consistent " +
      "with the rest of the page, and say in the caption that they are illustrative estimates.\n" +
      (types.includes("chart")
        ? "- Use a chart when the section content has a compact data table or a numeric trend or comparison. A chart needs at least two " +
          "categories and one series, and every series has exactly one value per category. Values are plain numbers (no units, currency " +
          "symbols or % signs inside values); put units in the axis labels, title or caption.\n" +
          "- Do not show the same numbers as both a chart and a table unless the section content asks for both.\n"
        : "") +
      "\n"
    : "";

  return `
You will be given the content outline of one section of a page.
You need to write that section as structured content json made of blocks.

# Steps
1. Analyze the content.
2. Choose the blocks that present it best, using only the block types listed under Output Fields.
3. Generate structured content json.
4. Provide structured content json as output.

# General Rules
- Follow language guidelines.
- Page Language is authoritative when it is explicitly set. If section content or user instructions request a different language, ignore that conflicting language request unless Page Language says auto-detect.
- Do not use emojis.
- Follow the intended outcome of user instructions when they do not conflict with Page Language; do not generalize or expand their scope.
- Apply section-specific instructions only to the exact section mentioned (first/second/last/named) and only once.
- Do not apply patterns across multiple sections unless explicitly requested.
- If instructions are ambiguous, use the most direct interpretation without extending scope.
- Treat chart, layout, styling, positioning, and other visual instructions as production controls. Honor them through the choice of blocks, but never emit those instructions or meta-commentary as a heading, paragraph, list item, table cell, caption, or chart label.
- Output fields must contain only reader-facing content and data. For charts, populate the categories, series, and values rather than text such as "create a bar chart" or "show this data as a graph".
- The section title is already shown above the section: do not repeat it as the first block.
- Write only the current section. The page outline is given so you do not repeat facts that belong to other sections.

${DIRECT_CONTENT_VOICE_RULES}
${dataRules}# Markdown Emphasis Rules
- ${emphasis ? `Strictly use markdown to emphasize important points, by ${emphasis} the part of text.` : "Do not use markdown emphasis."} No other Markdown inside text fields: no headings, links, list markers, or tables.

${input.instructions ? `# User Instructions:\n${input.instructions}\n` : ""}
${tone ? `# Tone Instructions:\nMake the section as ${tone} as possible.\n` : ""}
${v ? `# Verbosity Instructions:\nMake the section as ${v === "text-heavy" ? "text-heavy" : v} as possible.\n` : ""}
# Output Fields:
- Return {"blocks": [...]} with ${blockCount} blocks, in reading order.
- Allowed block types:
${types.map((t) => `  - ${BLOCK_HELP[t] ?? t}`).join("\n")}
- Every text field is plain text with optional emphasis as described above.
`.replace(/\n{3,}/g, "\n\n");
}

export function sectionUserPrompt(input: PageInput, outline: Outline, index: number, now: Date): string {
  const s = outline.sections[index];
  const language = resolveLanguage(input.language);
  return `
# Current Date and Time:
${now.toISOString().slice(0, 19).replace("T", " ")}

# Page Language:
${language === "auto-detect" ? "auto-detect from the section content and use the same language as the section content" : language}

# Page Title:
${outline.title}

# Page Outline (context only; write only the current section):
${outline.sections.map((x, i) => `${i + 1}. ${x.title}`).join("\n")}

# Section Number:
${index + 1} of ${outline.sections.length}

# Section Title:
${s.title}

# SECTION CONTENT: START
${s.content}
# SECTION CONTENT: END
`;
}
