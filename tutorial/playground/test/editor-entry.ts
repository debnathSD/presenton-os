// Test bundle entry for src/editor (bundled with the shared esbuild settings, so one Tiptap/ProseMirror copy).
export * from "../src/editor/index";
export { newChartAttrs, safeHref } from "../src/editor/toolbar";
export { readChartData, withChartData, chartConfig } from "../src/editor/chart";
export { deckToUdm, udmToTiptap, tiptapToUdm, tiptapExtensions } from "../src/udm/bridge";
export { hydrateTemplate, sampleDeck, setAssetsRoot } from "../src/data";
export { getSchema } from "@tiptap/core";
