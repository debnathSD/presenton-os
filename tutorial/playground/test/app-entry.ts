// Test bundle entry for the app shell (bundled with the render aliases, like scripts/build.mjs).
export { mountApp } from "../src/app/app";
export { samplePage } from "../src/app/sample-page";
export { setAssetsRoot } from "../src/data";
export { validateTiptap, tiptapExtensions } from "../src/udm/bridge";
export { getSchema } from "@tiptap/core";
