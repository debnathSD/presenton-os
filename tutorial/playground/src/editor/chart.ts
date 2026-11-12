// Chart data helpers for the dataBlock node (kind "chart") and the on-demand Chart.js preview.
// Chart data lives in attrs.binding.source.data as UDM ChartData { categories, series: [{ name, values }] }.
// Chart.js 4.5.1 is the copy vendored into <assets>/vendor by scripts/build.mjs; it is loaded with a <script> tag
// the first time a chart preview becomes visible (never bundled, never eval'd).

import { resolveAsset } from "../data";

export type ChartData = { categories: string[]; series: { name: string; values: number[] }[] };
export type ChartLoader = () => Promise<any>;

/** The chart kinds the tiptap adapter manifest declares (UDM ChartKind). */
export const CHART_KINDS: { id: string; label: string }[] = [
  { id: "bar", label: "Bar" },
  { id: "horizontal_bar", label: "Horizontal bar" },
  { id: "stacked_bar", label: "Stacked bar" },
  { id: "horizontal_stacked_bar", label: "Horizontal stacked bar" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "pie", label: "Pie" },
  { id: "donut", label: "Donut" },
  { id: "polar_area", label: "Polar area" },
  { id: "radar", label: "Radar" },
  { id: "scatter", label: "Scatter" },
  { id: "bubble", label: "Bubble" },
];
export const chartKindLabel = (k: string) => CHART_KINDS.find((c) => c.id === k)?.label ?? k;

/** Sample data used by the toolbar's "Insert chart". */
export const SAMPLE_CHART: ChartData = {
  categories: ["Q1", "Q2", "Q3", "Q4"],
  series: [{ name: "Revenue", values: [12, 19, 15, 24] }, { name: "Costs", values: [8, 11, 10, 13] }],
};

/** Normalise whatever is in a binding into ChartData (ragged series padded with 0, non-numbers -> 0). */
export function readChartData(attrs: any): ChartData {
  const d = attrs?.binding?.source?.data ?? {};
  const categories: string[] = Array.isArray(d.categories) ? d.categories.map((c: any) => String(c ?? "")) : [];
  const series = (Array.isArray(d.series) ? d.series : []).map((s: any, i: number) => ({
    name: String(s?.name ?? `Series ${i + 1}`),
    values: categories.map((_, j) => {
      const v = Number(s?.values?.[j]);
      return Number.isFinite(v) ? v : 0;
    }),
  }));
  return { categories, series };
}

/** True when the binding holds static chart data the dialog can edit (live sources are definitions only). */
export function isEditableChart(attrs: any): boolean {
  const src = attrs?.binding?.source;
  return attrs?.kind === "chart" && (!src || src.type === "static");
}

/** New attrs for a dataBlock with `data` (and optionally chart type / title) written in. Pure. */
export function withChartData(attrs: any, data: ChartData, patch: { chartType?: string; title?: string } = {}): any {
  const binding = attrs.binding ?? { kind: "chart", source: { type: "static", origin: "user" } };
  const source = { ...(binding.source ?? { type: "static", origin: "user" }), data: clone(data) };
  const block = { ...(attrs.block ?? {}) };
  if (patch.chartType) block.chartType = patch.chartType;
  if (patch.title !== undefined) {
    if (patch.title) block.title = patch.title;
    else delete block.title;
  }
  return { ...attrs, block, binding: { ...binding, source } };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** One-line text summary (canvas aria-label and the fallback when Chart.js is unavailable). */
export function chartSummary(attrs: any): string {
  const d = readChartData(attrs);
  const kind = chartKindLabel(attrs?.block?.chartType ?? "bar");
  const title = attrs?.block?.title ? `${attrs.block.title}: ` : "";
  const names = d.series.map((s) => s.name).join(", ");
  return `${title}${kind} chart, ${d.categories.length} ${d.categories.length === 1 ? "category" : "categories"}, ` +
    `${d.series.length} series${names ? ` (${names})` : ""}`;
}

// ---------- Chart.js ----------

const JS_TYPE: Record<string, string> = {
  bar: "bar", horizontal_bar: "bar", stacked_bar: "bar", horizontal_stacked_bar: "bar",
  line: "line", area: "line", scatter: "line", bubble: "line",
  pie: "pie", donut: "doughnut", polar_area: "polarArea", radar: "radar",
};
const PALETTE = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#ec4899"];

function token(el: Element, name: string, fallback: string) {
  try {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

const reducedMotion = () => {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

/** Chart.js config for a dataBlock's attrs. Pure apart from reading theme tokens from `el`. */
export function chartConfig(attrs: any, el: Element): any {
  const kind = attrs?.block?.chartType ?? "bar";
  const type = JS_TYPE[kind] ?? "bar";
  const d = readChartData(attrs);
  const radial = type === "pie" || type === "doughnut" || type === "polarArea";
  const text = token(el, "--site-muted", "#5b6472");
  const grid = token(el, "--site-border", "rgba(17,24,39,.1)");
  const horizontal = kind.startsWith("horizontal");
  const stacked = kind.includes("stacked");
  const datasets = d.series.map((s, i) => {
    const color = PALETTE[i % PALETTE.length];
    return {
      label: s.name,
      data: s.values,
      backgroundColor: radial ? d.categories.map((_, j) => PALETTE[j % PALETTE.length]) : kind === "area" ? `${color}33` : color,
      borderColor: radial ? token(el, "--site-surface", "#ffffff") : color,
      borderWidth: radial ? 2 : type === "line" ? 2 : 0,
      fill: kind === "area",
      tension: 0.25,
      pointRadius: type === "line" ? 3 : undefined,
      showLine: kind !== "scatter",
    };
  });
  const axes = radial || type === "radar" ? undefined : {
    x: { stacked, ticks: { color: text }, grid: { color: grid }, title: attrs?.block?.axes?.x ? { display: true, text: attrs.block.axes.x, color: text } : undefined },
    y: { stacked, beginAtZero: true, ticks: { color: text }, grid: { color: grid }, title: attrs?.block?.axes?.y ? { display: true, text: attrs.block.axes.y, color: text } : undefined },
  };
  return {
    type,
    data: { labels: d.categories, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: reducedMotion() ? false : { duration: 300 },
      indexAxis: horizontal ? "y" : "x",
      plugins: {
        legend: { display: radial || d.series.length > 1, labels: { color: text } },
        title: { display: false },
        tooltip: { enabled: true },
      },
      ...(axes ? { scales: axes } : type === "radar" ? { scales: { r: { ticks: { color: text, backdropColor: "transparent" }, grid: { color: grid }, angleLines: { color: grid }, pointLabels: { color: text } } } } : {}),
    },
  };
}

let pending: Promise<any> | null = null;

/** Loads the vendored Chart.js UMD build once (window.Chart). */
export const loadVendoredChart: ChartLoader = () => {
  const w = window as any;
  if (w.Chart) return Promise.resolve(w.Chart);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = resolveAsset("vendor/chart-4.5.1.umd.min.js");
    s.async = true;
    s.dataset.udmVendor = "chart.js";
    s.onload = () => (w.Chart ? resolve(w.Chart) : reject(new Error("Chart.js did not define window.Chart")));
    s.onerror = () => {
      pending = null;
      s.remove();
      reject(new Error(`Could not load ${s.src}`));
    };
    document.head.appendChild(s);
  });
  return pending;
};
