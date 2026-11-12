// Test bundle entry for src/pptx (the lazily loaded demo exporter) plus the data and bridge helpers it is fed with.
export * from "../src/pptx/index";
export { setAssetsRoot, hydrateTemplate, sampleDeck } from "../src/data";
export { tiptapToUdm, udmToNewDeck } from "../src/udm/bridge";
