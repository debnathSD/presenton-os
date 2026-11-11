// Shared conformance fixtures: target-neutral UDM documents every adapter must handle.

const base = (id, sections, bindings = {}, extra = {}) => ({
  version: "gck.artifact/1", profile: "udm/1.3", id, provenance: { origin: "generated", runId: "run_fixture", createdAt: "2026-01-01T00:00:00Z" },
  sections, bindings, ...extra,
});
const t = (text, marks, href) => ({ text, ...(marks ? { marks } : {}), ...(href ? { href } : {}) });

export const fixtures = {
  minimal: base("art_minimal", [{ id: "sec_one", title: "Hello", blocks: [{ id: "blk_p1", type: "paragraph", text: [t("One paragraph.")] }] }]),

  "kitchen-sink": base("art_kitchen", [
    { id: "sec_intro", role: "title", title: "Quarterly Review", summary: "Where we are and what changed.",
      notes: [t("Open with the headline number; keep it under a minute.")],
      ext: { "acme.crm": { accountId: "A-17" } },
      blocks: [
        { id: "blk_sub", type: "paragraph", role: "subtitle", text: [t("Q3 2026, "), t("internal", ["italic"])] },
        { id: "blk_h1", type: "heading", level: 1, text: [t("Highlights")] },
        { id: "blk_p", type: "paragraph", text: [t("Revenue grew "), t("strongly", ["bold"]), t(" in "), t("EMEA", ["underline"]), t(", see "),
          t("the dashboard", ["link"], "https://example.com/d?q=1&x=(2)"), t(". Old plan "), t("dropped", ["strike"]), t(" and "), t("x^2", ["math"]), t(" and "), t("code()", ["code"])] },
        { id: "blk_l", type: "list", ordered: false, items: [[t("North")], { text: [t("South")], children: [[t("Coast")], { text: [t("Inland")], children: [[t("Deep")]] }] }, [t("West "), t("bold", ["bold"])]] },
        { id: "blk_ol", type: "list", ordered: true, items: [[t("First")], [t("Second")]] },
      ] },
    { id: "sec_data", title: "Numbers", blocks: [
      { id: "blk_chart", type: "chart", bindingId: "b_rev", chartType: "polar_area", title: "Revenue by region", axes: { x: "Region", y: "EUR k" }, caption: [t("Source: finance")] },
      { id: "blk_tbl", type: "table", bindingId: "b_tbl", caption: [t("Table 1")] },
      { id: "blk_metric", type: "metric", bindingId: "b_m", label: "Active users" },
      { id: "blk_dg", type: "diagram", diagramKind: "timeline", items: [{ heading: "Plan", description: "Scope it", focus: "01" }, { heading: "Build", description: "Ship it", focus: "02" }] },
      { id: "blk_gauge", type: "diagram", diagramKind: "gauge", range: { min: 0, max: 100, value: 72 }, items: [{ label: "Uptime" }] },
    ] },
    { id: "sec_misc", title: "Notes and media", blocks: [
      { id: "blk_q", type: "quote", text: [t("Simple scales.")], attribution: "A. Person" },
      { id: "blk_c", type: "callout", tone: "warning", text: [t("Numbers are preliminary.")] },
      { id: "blk_div", type: "divider" },
      { id: "blk_code", type: "code", language: "sql", code: "select 1;\nselect 2;" },
      { id: "blk_math", type: "math", latex: "E = mc^2" },
      { id: "blk_img", type: "image", url: "https://example.com/a b.png", alt: "Team photo", kind: "photo", caption: [t("Offsite 2026")], group: "grp_card", ext: { "acme.crm": { assetRef: 9 } } },
      { id: "blk_card_h", type: "heading", level: 2, group: "grp_card", text: [t("Card title")] },
      { id: "blk_card_p", type: "paragraph", group: "grp_card", role: "kpi", text: [t("42%")] },
      { id: "blk_embed", type: "embed", bindingId: "b_live", title: "Live sales chart" },
    ] },
  ], {
    b_rev: { kind: "chart", source: { type: "static", origin: "imported", data: { categories: ["North", "South", "West"], series: [{ name: "2025", values: [10, 20.5, 30] }, { name: "2026", values: [12, 22, 31] }] } } },
    b_tbl: { kind: "table", source: { type: "static", origin: "user", data: { columns: ["Region", "Owner | lead"], rows: [["North", "Ana"], ["South", ""]] } } },
    b_m: { kind: "metric", source: { type: "static", origin: "imported", data: { value: 1234 } } },
    b_live: { kind: "embed", source: { type: "superset_chart", chartId: 42 } },
  }, { title: "Board pack", language: "en", meta: { tags: ["fixture"] }, ext: { "acme.crm": { opportunity: "O-1" } } }),

  "non-latin": base("art_intl", [
    { id: "sec_hi", title: "बाज़ार का आकार", blocks: [{ id: "blk_hi", type: "paragraph", text: [t("भारत में विकास "), t("तेज़", ["bold"]), t(" है।")] }] },
    { id: "sec_bn", title: "বাজার", blocks: [{ id: "blk_bn", type: "list", ordered: false, items: [[t("ঢাকা")], [t("কলকাতা")]] }] },
    { id: "sec_ar", title: "حجم السوق", blocks: [{ id: "blk_ar", type: "paragraph", text: [t("النمو قوي في المنطقة 🚀")] }] },
  ]),

  edge: base("art_edge", [
    { id: "sec_empty", title: "Empty section", blocks: [] },
    { id: "sec_untitled", blocks: [
      { id: "blk_breaks", type: "paragraph", text: [t("line one\nline two")] },
      { id: "blk_specials", type: "paragraph", text: [t("1. not a list * _x_ [y] <z> # | ~ \\ `tick`")] },
      { id: "blk_h3", type: "heading", level: 3, text: [t("Deep heading")] },
      { id: "blk_long", type: "paragraph", text: [t("x".repeat(1200))] },
      { id: "blk_bubble", type: "chart", bindingId: "b_bub", chartType: "bubble" },
      { id: "blk_empty_tbl", type: "table", bindingId: "b_et" },
    ] },
  ], {
    b_bub: { kind: "chart", source: { type: "static", origin: "user", data: { categories: ["a"], series: [{ name: "s", values: [1] }] } } },
    b_et: { kind: "table", source: { type: "static", origin: "user", data: { columns: ["A", "B"], rows: [["", ""]] } } },
  }),
};
