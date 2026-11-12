// esbuild alias entries for src/render: browser shims that replace server-only or root-relative pieces of
// Presenton's renderer (servers/nextjs/lib/template-v2-json-to-html.ts). esbuild picks the longest matching alias
// key, so these win over the generic "@" -> servers/nextjs alias. Spread into the alias map in scripts/build.mjs
// and into the test bundle (test/render.test.mjs).

import path from "node:path";
import { fileURLToPath } from "node:url";

const SHIMS = path.join(path.dirname(fileURLToPath(import.meta.url)), "shims");

export const RENDER_ALIASES = {
  "@/utils/api": path.join(SHIMS, "api.ts"),
  "@/lib/chart-browser": path.join(SHIMS, "chart-browser.ts"),
};
