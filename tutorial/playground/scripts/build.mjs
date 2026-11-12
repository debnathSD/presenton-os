// esbuild: src/main.ts -> ../content/assets/playground/app/ (ESM, code-split, minified, no sourcemaps),
// plus the vendored Chart.js and datalabels plugin from servers/nextjs/public/vendor (with their licenses).

import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { PLAYGROUND, NEXTJS, ASSETS, common } from "./esbuild-shared.mjs";
import { RENDER_ALIASES } from "../src/render/aliases.mjs";

// ---- Alias map ----------------------------------------------------------------------------------------------
// Module-specific aliases on top of common.alias ("@" -> servers/nextjs). esbuild uses the longest matching key,
// so "@/utils/api" here beats "@". Add new entries below; keep each module's entries in its own spread/line.
const ALIASES = {
  ...common.alias,
  ...RENDER_ALIASES, // src/render: browser shims for Presenton's renderer (@/utils/api, @/lib/chart-browser)
};
// ---- end alias map ------------------------------------------------------------------------------------------

const outdir = path.join(ASSETS, "app");
fs.rmSync(outdir, { recursive: true, force: true });

const result = await esbuild.build({
  ...common,
  alias: ALIASES,
  entryPoints: [path.join(PLAYGROUND, "src/main.ts")],
  outdir,
  splitting: true,
  minify: true,
  sourcemap: false,
  platform: "browser",
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  metafile: true,
});

const vendor = path.join(ASSETS, "vendor");
fs.mkdirSync(vendor, { recursive: true });
for (const f of ["chart-4.5.1.umd.min.js", "chart-4.5.1-LICENSE.md",
  "chartjs-plugin-datalabels-2.2.0.min.js", "chartjs-plugin-datalabels-2.2.0-LICENSE.md"]) {
  fs.copyFileSync(path.join(NEXTJS, "public/vendor", f), path.join(vendor, f));
}

const outputs = Object.entries(result.metafile.outputs)
  .map(([f, o]) => `${path.relative(ASSETS, f).padEnd(48)} ${(o.bytes / 1024).toFixed(1).padStart(8)} KB`);
console.log(outputs.join("\n"));
