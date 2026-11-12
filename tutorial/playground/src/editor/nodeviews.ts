// Node views for the adapter's atoms. They only change how nodes are drawn, never the schema:
//   dataBlock kind "chart"   -> live Chart.js preview + data table + "Edit data" dialog (writes attrs back)
//   dataBlock kind "diagram" -> readable summary card (diagram kind, items, range)
//   dataBlock kind "metric"  -> value card (value, label, change vs previous)
//   dataBlock other kinds    -> definition card (embed, live table)
//   image                    -> <img> with its alt text shown and an "Alt text" editor

import { chartConfig, chartKindLabel, chartSummary, isEditableChart, readChartData, withChartData, type ChartLoader } from "./chart";
import { h, openChartDialog, openTextDialog } from "./dialog";

export type ViewContext = { loadChart: ChartLoader; onChartError?: (e: Error) => void };

const plain = (rt: any): string => (Array.isArray(rt) ? rt.map((s) => s?.text ?? "").join("") : typeof rt === "string" ? rt : "");
const fmt = (n: any) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : String(n ?? ""));

/** Replace a node's attrs at `pos` in one transaction (undoable). */
export function setNodeAttrs(editor: any, pos: number, attrs: any): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, attrs));
  return true;
}

abstract class AtomView {
  dom: HTMLElement;
  node: any;
  editor: any;
  getPos: () => number | undefined;
  constructor(props: any, tag: string, cls: string) {
    this.node = props.node;
    this.editor = props.editor;
    this.getPos = props.getPos;
    this.dom = h(tag as any, { class: cls, contenteditable: "false" });
    this.editor?.on?.("update", this.syncEditable);
  }
  /**
   * Buttons in the card follow the editor's editable state. A view drawn while the editor was locked (a generated page
   * streams in read-only) is not re-rendered when it unlocks, because its attrs did not change; without this its
   * "Edit data" / "Alt text" buttons stayed disabled. setEditable() emits "update".
   */
  syncEditable = () => {
    for (const b of this.dom.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
      b.disabled = !this.editable || b.dataset.allowed === "false";
    }
  };
  destroy() {
    this.editor?.off?.("update", this.syncEditable);
  }
  /** After a dialog saves, the card re-renders and the opener is gone: focus its replacement. */
  protected button(action: string): HTMLElement | null {
    return this.dom.isConnected ? this.dom.querySelector<HTMLElement>(`button[data-action="${action}"]`) : null;
  }
  abstract render(): void;
  update(node: any) {
    if (node.type !== this.node.type) return false;
    const same = node.attrs === this.node.attrs || JSON.stringify(node.attrs) === JSON.stringify(this.node.attrs);
    this.node = node;
    if (!same) this.render();
    return true;
  }
  selectNode() { this.dom.classList.add("ProseMirror-selectednode"); }
  deselectNode() { this.dom.classList.remove("ProseMirror-selectednode"); }
  // Let buttons, inputs and <details> inside the card work without ProseMirror taking the event.
  stopEvent(e: Event) {
    const t = e.target as Element | null;
    return Boolean(t && t.closest && t.closest("button, input, select, textarea, summary, details, a"));
  }
  ignoreMutation() { return true; }
  protected pos(): number | null {
    const p = typeof this.getPos === "function" ? this.getPos() : undefined;
    return typeof p === "number" ? p : null;
  }
  protected get editable() { return this.editor?.isEditable !== false; }
}

// ---------- theme changes ----------
// Chart.js colours are read from the --site-* tokens when a chart is drawn. When the site switches between light and
// dark ([data-md-color-scheme] on <body>), redraw the charts that are on screen. One observer for all views.
const themed = new Set<DataBlockView>();
let themeObserver: MutationObserver | null = null;
function watchTheme(v: DataBlockView, on: boolean) {
  if (on) themed.add(v);
  else themed.delete(v);
  if (themed.size && !themeObserver && typeof MutationObserver === "function" && typeof document !== "undefined") {
    themeObserver = new MutationObserver(() => { for (const view of [...themed]) view.render(); });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-md-color-scheme"] });
  } else if (!themed.size && themeObserver) {
    themeObserver.disconnect();
    themeObserver = null;
  }
}

// ---------- dataBlock ----------

export class DataBlockView extends AtomView {
  ctx: ViewContext;
  chart: any = null;
  canvas: HTMLCanvasElement | null = null;
  observer: IntersectionObserver | null = null;
  destroyed = false;
  renderToken = 0;

  constructor(props: any, ctx: ViewContext) {
    super(props, "figure", "udm-datablock");
    this.ctx = ctx;
    this.dom.setAttribute("data-type", "data-block");
    this.render();
  }

  render() {
    this.teardownChart();
    const a = this.node.attrs ?? {};
    const kind = a.kind ?? "chart";
    this.dom.dataset.kind = kind;
    this.dom.replaceChildren();
    if (kind === "chart") this.renderChart(a);
    else if (kind === "diagram") this.renderDiagram(a);
    else if (kind === "metric") this.renderMetric(a);
    else this.renderGeneric(a);
  }

  private header(label: string, title: string, actions: HTMLElement[] = []) {
    return h("div", { class: "udm-datablock__head" },
      h("span", { class: "udm-badge", text: label }),
      h("span", { class: "udm-datablock__title", text: title }),
      ...(actions.length ? [h("span", { class: "udm-datablock__actions" }, ...actions)] : []));
  }

  // chart
  private renderChart(a: any) {
    const d = readChartData(a);
    const summary = chartSummary(a);
    const edit = h("button", { type: "button", class: "udm-btn udm-btn--small", "data-action": "edit-chart",
      "aria-haspopup": "dialog", text: "Edit data", onclick: (e: Event) => this.openDialog(e.currentTarget as HTMLElement) });
    if (!isEditableChart(a)) edit.dataset.allowed = "false";
    if (!this.editable || !isEditableChart(a)) edit.setAttribute("disabled", "");
    this.dom.setAttribute("aria-label", summary);
    this.dom.append(this.header(`${chartKindLabel(a.block?.chartType ?? "bar")} chart`, a.block?.title ?? (d.series.map((s) => s.name).join(", ") || "Chart"), [edit]));
    if (a.binding?.source && a.binding.source.type !== "static") {
      this.dom.append(h("p", { class: "udm-datablock__note", text: `Live data source "${a.binding.source.type}": the definition is kept, values are not stored in the document.` }));
      return;
    }
    const canvas = h("canvas", { role: "img", "aria-label": summary }) as HTMLCanvasElement;
    canvas.textContent = summary;
    this.canvas = canvas;
    const frame = h("div", { class: "udm-chart", "data-state": "pending" }, canvas, h("p", { class: "udm-chart__fallback", text: summary }));
    this.dom.append(frame, this.dataTable(d));
    this.scheduleChart(frame);
  }

  private dataTable(d: ReturnType<typeof readChartData>) {
    const table = h("table", { class: "udm-datatable udm-datatable--readonly" });
    table.append(h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Category" }), ...d.series.map((s) => h("th", { scope: "col", text: s.name })))));
    const body = h("tbody");
    d.categories.forEach((c, i) => body.append(h("tr", {}, h("th", { scope: "row", text: c }), ...d.series.map((s) => h("td", { text: fmt(s.values[i]) })))));
    table.append(body);
    return h("details", { class: "udm-datablock__data" }, h("summary", { text: `Data (${d.categories.length} x ${d.series.length})` }), table);
  }

  private scheduleChart(frame: HTMLElement) {
    const token = ++this.renderToken;
    const draw = () => {
      if (this.destroyed || token !== this.renderToken) return;
      this.ctx.loadChart().then((Chart) => {
        if (this.destroyed || token !== this.renderToken || !this.canvas) return;
        try {
          this.chart = new Chart(this.canvas, chartConfig(this.node.attrs, this.dom));
          frame.dataset.state = "ready";
          watchTheme(this, true);
        } catch (e) {
          frame.dataset.state = "error";
          this.ctx.onChartError?.(e as Error);
        }
      }, (e) => {
        if (token !== this.renderToken) return;
        frame.dataset.state = "error";
        this.ctx.onChartError?.(e);
      });
    };
    // Load Chart.js only when a chart scrolls into view.
    if (typeof IntersectionObserver === "function") {
      this.observer = new IntersectionObserver((entries) => {
        if (entries.some((en) => en.isIntersecting)) {
          this.observer?.disconnect();
          this.observer = null;
          draw();
        }
      }, { rootMargin: "200px" });
      this.observer.observe(this.dom);
    } else queueMicrotask(draw);
  }

  private teardownChart() {
    watchTheme(this, false);
    this.renderToken++;
    this.observer?.disconnect();
    this.observer = null;
    try { this.chart?.destroy?.(); } catch { /* already gone */ }
    this.chart = null;
    this.canvas = null;
  }

  openDialog(opener: HTMLElement | null) {
    const a = this.node.attrs;
    return openChartDialog({
      data: readChartData(a), chartType: a.block?.chartType ?? "bar", title: a.block?.title ?? "", opener,
      restoreFocus: () => this.button("edit-chart") ?? this.editor?.view?.dom,
      onSave: (data, patch) => {
        const pos = this.pos();
        if (pos == null) return;
        setNodeAttrs(this.editor, pos, withChartData(this.editor.state.doc.nodeAt(pos).attrs, data, patch));
      },
    });
  }

  // diagram
  private renderDiagram(a: any) {
    const b = a.block ?? {};
    const kind = String(b.diagramKind ?? "other");
    const items: any[] = Array.isArray(b.items) ? b.items : [];
    this.dom.append(this.header("Diagram", `${kind.charAt(0).toUpperCase()}${kind.slice(1)}${items.length ? ` · ${items.length} items` : ""}`));
    if (b.range && typeof b.range.value === "number") {
      const { min = 0, max = 100, value } = b.range;
      const pct = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
      this.dom.append(h("div", { class: "udm-range" },
        h("div", { class: "udm-range__bar", role: "meter", "aria-valuemin": min, "aria-valuemax": max, "aria-valuenow": value,
          "aria-label": `${kind}: ${fmt(value)} of ${fmt(min)} to ${fmt(max)}` }, h("span", { style: `width:${pct.toFixed(1)}%` })),
        h("span", { class: "udm-range__text", text: `${fmt(value)} (range ${fmt(min)} to ${fmt(max)})` })));
    }
    if (items.length) {
      const list = h(["process", "steps", "timeline", "funnel", "pyramid", "cycle"].includes(kind) ? "ol" : "ul", { class: "udm-diagram__items" });
      for (const it of items) {
        const head = it.heading ?? it.label ?? "";
        const extra = [it.focus, typeof it.value === "number" ? fmt(it.value) : ""].filter(Boolean).join(" · ");
        list.append(h("li", {},
          ...(head ? [h("strong", { text: head })] : []),
          ...(extra ? [h("span", { class: "udm-muted", text: ` ${extra}` })] : []),
          ...(it.description ? [h("p", { text: it.description })] : [])));
      }
      this.dom.append(list);
    }
    const cap = plain(b.caption);
    if (cap) this.dom.append(h("figcaption", { text: cap }));
    if (!items.length && !b.range && !cap) this.dom.append(h("p", { class: "udm-datablock__note", text: "Empty diagram" }));
  }

  // metric
  private renderMetric(a: any) {
    const b = a.block ?? {};
    const d = a.binding?.source?.data ?? {};
    const value = d.value;
    const prev = d.previous;
    this.dom.append(this.header("Metric", b.label ?? "Metric"));
    const row = h("div", { class: "udm-metric" }, h("span", { class: "udm-metric__value", text: value == null ? "–" : fmt(value) }));
    if (typeof value === "number" && typeof prev === "number") {
      const diff = value - prev;
      const pct = prev !== 0 ? ` (${diff >= 0 ? "+" : ""}${((diff / Math.abs(prev)) * 100).toFixed(1)}%)` : "";
      row.append(h("span", { class: `udm-metric__delta ${diff >= 0 ? "is-up" : "is-down"}`, text: `${diff >= 0 ? "up" : "down"} ${fmt(Math.abs(diff))} from ${fmt(prev)}${pct}` }));
    }
    this.dom.append(row);
  }

  private renderGeneric(a: any) {
    const b = a.block ?? {};
    const src = a.binding?.source;
    this.dom.append(this.header(String(a.kind ?? "data"), b.title ?? b.label ?? a.bindingId ?? "Data block"));
    this.dom.append(h("p", { class: "udm-datablock__note", text: src ? `Source: ${src.type}${src.origin ? ` (${src.origin})` : ""}` : "No data binding" }));
  }

  destroy() {
    super.destroy();
    this.destroyed = true;
    this.teardownChart();
  }
}

// ---------- image ----------

export class ImageView extends AtomView {
  constructor(props: any) {
    super(props, "figure", "udm-image");
    this.render();
  }

  render() {
    const a = this.node.attrs ?? {};
    const alt = a.alt ?? "";
    const kind = a.udmMeta?.kind;
    this.dom.dataset.kind = kind ?? "image";
    const media = a.src
      ? (() => {
        const img = h("img", { src: a.src, alt, draggable: "false", loading: "lazy", decoding: "async" }) as HTMLImageElement;
        if (a.title) img.title = a.title;
        img.addEventListener("error", () => this.dom.classList.add("is-broken"), { once: true });
        return img;
      })()
      : h("div", { class: "udm-image__empty", role: "img", "aria-label": alt || "Image with no source", text: a.udmMeta?.prompt ? `Image prompt: ${a.udmMeta.prompt}` : "No image source" });
    const edit = h("button", { type: "button", class: "udm-btn udm-btn--small", "data-action": "edit-alt", "aria-haspopup": "dialog",
      text: "Alt text", onclick: (e: Event) => this.editAlt(e.currentTarget as HTMLElement) });
    if (!this.editable) edit.setAttribute("disabled", "");
    const caption = h("figcaption", { class: "udm-image__caption" },
      h("span", { class: alt ? "udm-image__alt" : "udm-image__alt is-missing", text: alt ? `Alt: ${alt}` : "No alt text" }),
      ...(kind ? [h("span", { class: "udm-badge", text: kind })] : []),
      edit);
    this.dom.replaceChildren(media, caption);
  }

  editAlt(opener: HTMLElement | null) {
    return openTextDialog({
      title: "Image alt text", label: "Alt text", value: this.node.attrs?.alt ?? "", opener,
      restoreFocus: () => this.button("edit-alt") ?? this.editor?.view?.dom,
      hint: "Describe what the image shows. Leave empty only for decorative images.",
      onSave: (v) => {
        const pos = this.pos();
        if (pos == null) return;
        setNodeAttrs(this.editor, pos, { ...this.editor.state.doc.nodeAt(pos).attrs, alt: v });
      },
    });
  }
}
