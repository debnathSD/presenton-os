// Presenton chart elements -> native PowerPoint charts (pptxgenjs addChart), with the same data normalization,
// default colors, legend rule, axis/grid switches and data label positions as Presenton's Chart.js renderer
// (chartConfig / normalizeChartData / chartScales in servers/nextjs/lib/template-v2-json-to-html.ts).

import { arr, blendOnWhite, clamp, hex, num, rec, str, pt } from "./units";

const DEFAULT_COLORS = ["7F22FE", "155DFC", "F59E0B", "12B76A", "EF4444", "06B6D4", "8B5CF6", "64748B"];

export type ChartKind = "bar" | "horizontal_bar" | "stacked_bar" | "horizontal_stacked_bar" | "line" | "area" | "pie"
  | "donut" | "polar_area" | "radar" | "scatter" | "bubble";

/** Presenton's chartKindFromValue: accepts snake/camel/kebab spellings and a few synonyms. */
export function chartKind(value: unknown): ChartKind {
  const n = String(value ?? "").trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[\s-]+/g, "_").replace(/_+/g, "_");
  if (n === "bubble") return "bubble";
  if (n === "horizontal_bar" || n === "bar_horizontal") return "horizontal_bar";
  if (n === "horizontal_stacked_bar" || n === "stacked_horizontal_bar") return "horizontal_stacked_bar";
  if (n === "stacked_bar" || n === "bar_stacked" || n === "stacked" || n === "stacked_column") return "stacked_bar";
  if (n === "line" || n === "area" || n === "pie" || n === "radar" || n === "scatter") return n;
  if (n === "donut" || n === "doughnut") return "donut";
  if (n === "polar" || n === "polar_area") return "polar_area";
  return "bar";
}

type Series = { name: string; values: number[]; xs: number[]; rs: (number | null)[] };

const value = (v: unknown): number => {
  const d = num(v);
  if (d != null) return d;
  const r = rec(v);
  return num(r.y ?? r.value ?? r.data) ?? 0;
};

/** Presenton's normalizeChartData. */
export function normalizeChart(item: any, kind: ChartKind) {
  const points = arr(item.data).map(rec);
  let series: Series[] = arr(item.series).map(rec).map((s, i) => {
    const raw = arr(s.values ?? s.data);
    return {
      name: str(s.name) ?? `Series ${i + 1}`,
      values: raw.map(value),
      xs: raw.map((v, j) => num(rec(v).x) ?? j + 1),
      rs: raw.map((v) => num(rec(v).r ?? rec(v).radius)),
    };
  }).filter((s) => s.values.length);
  if (!series.length && points.length) {
    series.push({ name: str(item.title) ?? "Series 1", values: points.map(value), xs: points.map((p, j) => num(p.x) ?? j + 1), rs: points.map(() => null) });
  }
  if (!series.length) series.push({ name: "Series 1", values: [0], xs: [1], rs: [null] });
  if ((kind === "pie" || kind === "donut") && series.length > 1) series = series.slice(0, 1);
  const len = Math.min(24, Math.max(1, ...series.map((s) => s.values.length), points.length));
  const rawCats = arr(item.categories).length ? arr(item.categories) : points.map((p, i) => str(p.label) ?? `Value ${i + 1}`);
  const categories = Array.from({ length: len }, (_, i) => {
    const c = rawCats[i];
    return c == null || String(c) === "" ? `Value ${i + 1}` : String(c);
  });
  const colors = [item.colors, item.seriesColors ?? item.series_colors].map((c) => arr(c).map((x) => hex(x)).filter(Boolean) as string[])
    .find((c) => c.length) ?? (() => {
      const pc = points.map((p) => hex(p.color)).filter(Boolean) as string[];
      return pc.length ? pc : [hex(item.color, DEFAULT_COLORS[0])!];
    })();
  series = series.map((s) => ({
    ...s,
    values: Array.from({ length: len }, (_, i) => s.values[i] ?? 0),
    xs: Array.from({ length: len }, (_, i) => s.xs[i] ?? i + 1),
    rs: Array.from({ length: len }, (_, i) => s.rs[i] ?? null),
  }));
  return { categories, series, colors };
}

const LEGEND_POS: Record<string, "t" | "b" | "l" | "r"> = { top: "t", bottom: "b", left: "l", right: "r" };

/** Data label position per chart family (pptxgenjs drops positions a chart type does not accept). */
function labelPosition(kind: ChartKind, p: string): string | undefined {
  const bar = kind === "bar" || kind === "horizontal_bar";
  const stacked = kind === "stacked_bar" || kind === "horizontal_stacked_bar";
  if (bar || stacked) return p === "base" ? "inBase" : p === "mid" ? "ctr" : p === "outside" && bar ? "outEnd" : "inEnd";
  if (kind === "pie" || kind === "polar_area") return p === "mid" ? "ctr" : p === "outside" ? "outEnd" : p === "base" ? "inEnd" : "bestFit";
  if (kind === "line" || kind === "scatter" || kind === "bubble") return p === "base" ? "b" : p === "mid" ? "ctr" : "t";
  return undefined;
}

export type NativeChart = { type: string; data: any[]; options: Record<string, any>; warning?: string };

/** pptxgenjs chart type name, data and options for one Presenton chart element (position added by the caller). */
export function nativeChart(item: any, heightPx: number, fontFace: string): NativeChart {
  const kind = chartKind(item.chart_type ?? item.chartType);
  const { categories, series, colors } = normalizeChart(item, kind);
  const pieLike = kind === "pie" || kind === "donut" || kind === "polar_area";
  const textColor = hex(item.text_color ?? item.textColor ?? item.label_color ?? item.labelColor, "475467")!;
  const axisColor = hex(item.axis_color ?? item.axisColor, "98A2B3")!;
  const gridColor = hex(item.grid_color ?? item.gridColor, axisColor)!;
  const titleColor = hex(item.title_color ?? item.titleColor, "344054")!;
  const legendColor = hex(item.legend_color ?? item.legendColor, textColor)!;
  const fontSize = clamp(heightPx * 0.033, 9, 18);
  const title = (str(item.title) ?? "").replace(/[*_`#>]/g, "").trim();
  const autoLegend = pieLike || series.length > 1 || (series[0]?.name && series[0].name !== "Series 1");
  const showLegend = typeof (item.legend ?? item.showLegend) === "boolean" ? !!(item.legend ?? item.showLegend) : !!autoLegend;
  const rawLabels = Object.prototype.hasOwnProperty.call(item, "data_labels") ? item.data_labels : item.dataLabels;
  const labelPos = rawLabels === true ? "top" : typeof rawLabels === "string" && ["base", "mid", "top", "outside"].includes(rawLabels.toLowerCase()) ? rawLabels.toLowerCase() : null;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const xAxis = bool(item.x_axis ?? item.xAxis, true), yAxis = bool(item.y_axis ?? item.yAxis, true);
  const xGrid = bool(item.x_axis_grid ?? item.xAxisGrid ?? item.grid, true), yGrid = bool(item.y_axis_grid ?? item.yAxisGrid ?? item.grid, true);
  const horizontal = kind === "horizontal_bar" || kind === "horizontal_stacked_bar";
  const stacked = kind === "stacked_bar" || kind === "horizontal_stacked_bar";
  const xTitle = str(item.x_axis_title ?? item.xAxisTitle), yTitle = str(item.y_axis_title ?? item.yAxisTitle);

  const palette = colors.length ? colors : DEFAULT_COLORS;
  // pie-like charts and single-series bars color each category; otherwise one color per series
  const perCategory = pieLike || (series.length === 1 && colors.length > 1 && kind !== "line" && kind !== "area" && kind !== "radar");
  const n = perCategory ? categories.length : series.length;
  const chartColors = Array.from({ length: Math.max(1, n) }, (_, i) => palette[i % palette.length] ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]);

  const o: Record<string, any> = {
    chartColors,
    showLegend,
    legendPos: LEGEND_POS[String(item.legend_position ?? item.legendPosition)] ?? "b",
    legendColor, legendFontFace: fontFace, legendFontSize: pt(fontSize),
    showTitle: !!title, ...(title ? { title, titleColor, titleFontFace: fontFace, titleFontSize: pt(clamp(heightPx * 0.044, 11, 26)) } : {}),
    showValue: !!labelPos, showPercent: false, showLabel: false, showSerName: false,
    dataLabelColor: textColor, dataLabelFontFace: fontFace, dataLabelFontSize: pt(clamp(heightPx * 0.029, 8, 15)),
    ...(labelPos && labelPosition(kind, labelPos) ? { dataLabelPosition: labelPosition(kind, labelPos) } : {}),
    catAxisLabelColor: axisColor, valAxisLabelColor: axisColor,
    catAxisLabelFontFace: fontFace, valAxisLabelFontFace: fontFace,
    catAxisLabelFontSize: pt(fontSize), valAxisLabelFontSize: pt(Math.max(8, fontSize - 2)),
    catAxisLineColor: axisColor, valAxisLineColor: axisColor,
  };

  let warning: string | undefined;
  let type: string;
  let data: any[];

  if (pieLike) {
    type = kind === "donut" ? "doughnut" : "pie";
    if (kind === "donut") o.holeSize = 58;
    if (kind === "polar_area") warning = "polar_area has no native PowerPoint chart; exported as a pie chart";
    data = [{ name: series[0].name, labels: categories, values: series[0].values.map((v) => Math.max(0, v)) }];
    o.dataBorder = { pt: 1, color: "FFFFFF" };
    o.showLeaderLines = !!labelPos;
  } else if (kind === "scatter" || kind === "bubble") {
    type = kind;
    const xs = series[0].xs;
    data = [{ name: "X", values: xs }, ...series.map((s) => ({
      name: s.name, values: s.values, ...(kind === "bubble" ? { sizes: s.rs.map((r) => r ?? 6) } : {}),
    }))];
    if (kind === "scatter") { o.lineSize = 0; o.lineDataSymbol = "circle"; o.lineDataSymbolSize = 7; }
    o.catAxisHidden = !xAxis; o.valAxisHidden = !yAxis;
    o.valGridLine = xGrid ? { color: blendOnWhite(gridColor, 0.35), size: 0.75 } : { style: "none" };
    o.catGridLine = yGrid ? { color: blendOnWhite(gridColor, 0.35), size: 0.75 } : { style: "none" };
    if (xAxis && xTitle) Object.assign(o, { showCatAxisTitle: true, catAxisTitle: xTitle, catAxisTitleColor: axisColor, catAxisTitleFontSize: pt(fontSize) });
    if (yAxis && yTitle) Object.assign(o, { showValAxisTitle: true, valAxisTitle: yTitle, valAxisTitleColor: axisColor, valAxisTitleFontSize: pt(fontSize) });
  } else if (kind === "radar") {
    type = "radar";
    o.radarStyle = "marker";
    o.lineSize = 2.25;
    o.catAxisHidden = !xAxis; o.valAxisHidden = !yAxis;
    o.valGridLine = yGrid ? { color: blendOnWhite(gridColor, 0.35), size: 0.75 } : { style: "none" };
    data = series.map((s) => ({ name: s.name, labels: categories, values: s.values }));
  } else {
    type = kind === "line" ? "line" : kind === "area" ? "area" : "bar";
    const catAxisShown = horizontal ? yAxis : xAxis, valAxisShown = horizontal ? xAxis : yAxis;
    const catGrid = horizontal ? xGrid : yGrid, valGrid = horizontal ? yGrid : xGrid;
    o.catAxisHidden = !catAxisShown;
    o.valAxisHidden = !valAxisShown;
    o.catAxisLineShow = catAxisShown;
    o.valAxisLineShow = valAxisShown;
    o.catGridLine = catGrid ? { color: blendOnWhite(gridColor, 0.25), size: 0.75 } : { style: "none" };
    o.valGridLine = valGrid ? { color: blendOnWhite(gridColor, 0.35), size: 0.75 } : { style: "none" };
    const catTitle = horizontal ? yTitle : xTitle, valTitle = horizontal ? xTitle : yTitle;
    if (catAxisShown && catTitle) Object.assign(o, { showCatAxisTitle: true, catAxisTitle: catTitle, catAxisTitleColor: axisColor, catAxisTitleFontSize: pt(fontSize) });
    if (valAxisShown && valTitle) Object.assign(o, { showValAxisTitle: true, valAxisTitle: valTitle, valAxisTitleColor: axisColor, valAxisTitleFontSize: pt(fontSize) });
    if (type === "bar") {
      o.barDir = horizontal ? "bar" : "col";
      o.barGrouping = stacked ? "stacked" : "clustered";
      o.barGapWidthPct = stacked ? 60 : 80;
      if (stacked) o.barOverlapPct = 100;
    } else {
      o.lineSize = 2.25;
      o.lineSmooth = true;
      o.lineDataSymbol = "circle";
      o.lineDataSymbolSize = 6;
      o.lineDataSymbolLineColor = "FFFFFF";
      if (type === "area") o.chartColorsOpacity = 35;
    }
    data = series.map((s) => ({ name: s.name, labels: categories, values: s.values }));
  }
  return { type, data, options: o, warning };
}
