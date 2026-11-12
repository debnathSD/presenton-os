// Browser shim for "@/lib/chart-browser" (aliased in scripts/build.mjs via src/render/aliases.mjs).
//
// Presenton serves Chart.js from "/vendor/..." at the site root; the playground copies the same files to
// <assets root>/vendor/. Everything else is re-exported from the real module (it is plain browser code); the two
// URL constants are overridden with live bindings that src/render sets before rendering (local exports shadow
// `export *`). The relative path below is deliberate: it bypasses the "@" alias so this file does not import itself.

export * from "../../../../../servers/nextjs/lib/chart-browser";

export let CHART_BROWSER_SCRIPT_URL = "vendor/chart-4.5.1.umd.min.js";
export let CHART_DATALABELS_SCRIPT_URL = "vendor/chartjs-plugin-datalabels-2.2.0.min.js";

/** Point the Chart.js script tags at `<vendorBase>chart-...js` (vendorBase must end in "/"). */
export function setChartVendorBase(vendorBase: string): void {
  CHART_BROWSER_SCRIPT_URL = new URL("chart-4.5.1.umd.min.js", vendorBase).href;
  CHART_DATALABELS_SCRIPT_URL = new URL("chartjs-plugin-datalabels-2.2.0.min.js", vendorBase).href;
}
