// Sample page for flow 2 ("Start from a Tiptap page"): a small hand-written tiptap.json that uses the adapter's
// "page" schema: a title (H1), sections (H2), paragraphs with marks, a bullet list, a chart data block and a table.
// The smoke test checks it against getSchema(tiptapExtensions()).

const text = (t: string, marks?: string[]) => ({ type: "text", text: t, ...(marks ? { marks: marks.map((m) => ({ type: m })) } : {}) });
const p = (...content: any[]) => ({ type: "paragraph", content });
const h = (level: number, t: string) => ({ type: "heading", attrs: { level }, content: [text(t)] });
const bullets = (items: string[]) => ({ type: "bulletList", content: items.map((t) => ({ type: "listItem", content: [p(text(t))] })) });
const table = (rows: string[][]) => ({
  type: "table",
  content: rows.map((row, i) => ({
    type: "tableRow",
    content: row.map((c) => ({ type: i ? "tableCell" : "tableHeader", content: [p(text(c))] })),
  })),
});

export function samplePage(): any {
  return {
    type: "doc",
    content: [
      h(1, "Quarterly product review"),
      h(2, "Why we are moving to usage pricing"),
      p(text("Seat pricing stopped tracking value once customers "), text("automated", ["bold"]), text(" their workflows.")),
      bullets(["Usage aligns cost with value", "Smaller teams can start cheaper", "Expansion revenue becomes automatic"]),
      h(2, "Revenue by region"),
      p(text("North grew fastest after the spring launch; West is flat.")),
      {
        type: "dataBlock",
        attrs: {
          kind: "chart", bindingId: "b_revenue",
          block: { chartType: "bar", title: "Revenue (USD m)" },
          binding: {
            kind: "chart",
            source: {
              type: "static", origin: "user",
              data: { categories: ["North", "South", "West"], series: [{ name: "2025", values: [10, 20, 30] }, { name: "2026", values: [16, 23, 30] }] },
            },
          },
        },
      },
      h(2, "Plans side by side"),
      p(text("Prices per run replace prices per seat. "), text("Starter stays free for small teams.", ["italic"])),
      table([["Plan", "Today", "Proposed"], ["Starter", "$20/seat", "$0.02/run"], ["Team", "$45/seat", "$0.015/run"], ["Enterprise", "Custom", "Committed use"]]),
      h(2, "Next steps"),
      p(text("Pilot with ten accounts in Q3, then roll out to every new customer in Q4.")),
    ],
  };
}

export function blankPage(): any {
  return { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [text("Untitled page")] }, { type: "paragraph" }] };
}

export function emptyDoc(): any {
  return { type: "doc", content: [{ type: "paragraph" }] };
}
