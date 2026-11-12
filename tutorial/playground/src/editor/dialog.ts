// Accessible modal dialogs for the editor: chart data (categories x series table), link URL and image alt text.
// Native <dialog> + showModal() (focus trap, Escape, inert background) where available; a plain open dialog
// otherwise. Focus goes to the first field on open and back to the opener on close.

import { CHART_KINDS, type ChartData } from "./chart";

let seq = 0;
const uid = (p: string) => `udm-dlg-${p}-${++seq}`;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids) el.append(c);
  return el;
}
export { h };

type Shell = { dialog: HTMLDialogElement; body: HTMLElement; error: HTMLElement; close: () => void };
/** Where focus goes on close when the opener is gone (a node view re-renders its buttons after Save). */
export type FocusFallback = () => HTMLElement | null | undefined;

/** Builds and opens a modal with a title, body, an error line and Cancel/Save buttons. */
function openShell(title: string, opener: HTMLElement | null, onSave: () => string | null, describe?: string, fallback?: FocusFallback): Shell {
  const titleId = uid("title");
  const descId = describe ? uid("desc") : undefined;
  const error = h("p", { class: "udm-dialog__error", role: "alert" });
  const body = h("div", { class: "udm-dialog__body" });
  const form = h("form", { class: "udm-dialog__form", novalidate: true });
  const dialog = h("dialog", { class: "udm-dialog", "aria-labelledby": titleId, ...(descId ? { "aria-describedby": descId } : {}) }) as HTMLDialogElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    dialog.remove();
    document.removeEventListener("keydown", onKey, true);
    const back = opener && opener.isConnected ? opener : fallback?.();
    back?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !closed) {
      e.preventDefault();
      close();
    }
  };
  const cancel = h("button", { type: "button", class: "udm-btn", "data-action": "cancel", text: "Cancel", onclick: close });
  const save = h("button", { type: "submit", class: "udm-btn udm-btn--primary", "data-action": "save", text: "Save" });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = onSave();
    if (msg) error.textContent = msg;
    else close();
  });
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  form.append(
    h("h2", { id: titleId, class: "udm-dialog__title", text: title }),
    ...(describe ? [h("p", { id: descId, class: "udm-dialog__hint", text: describe })] : []),
    body,
    error,
    h("div", { class: "udm-dialog__actions" }, cancel, save),
  );
  dialog.append(form);
  document.body.append(dialog);
  document.addEventListener("keydown", onKey, true);
  if (typeof dialog.showModal === "function") {
    try {
      dialog.showModal();
    } catch {
      dialog.setAttribute("open", "");
    }
  } else dialog.setAttribute("open", "");
  return { dialog, body, error, close };
}

const focusFirst = (root: HTMLElement) => {
  const f = root.querySelector<HTMLElement>("input, select, textarea, button");
  f?.focus();
};

/** One-field dialog (link URL, image alt text). `validate` returns an error message or null. */
export function openTextDialog(o: {
  title: string; label: string; value: string; hint?: string; opener: HTMLElement | null; type?: string;
  validate?: (v: string) => string | null; onSave: (v: string) => void; restoreFocus?: FocusFallback;
}): HTMLDialogElement {
  const id = uid("field");
  const input = h("input", { id, type: o.type ?? "text", class: "udm-input", value: o.value, autocomplete: "off" }) as HTMLInputElement;
  input.value = o.value;
  const shell = openShell(o.title, o.opener, () => {
    const v = input.value.trim();
    const msg = o.validate?.(v) ?? null;
    if (msg) {
      input.setAttribute("aria-invalid", "true");
      return msg;
    }
    o.onSave(v);
    return null;
  }, o.hint, o.restoreFocus);
  if (o.hint) input.setAttribute("aria-describedby", shell.dialog.getAttribute("aria-describedby")!);
  shell.body.append(h("label", { for: id, class: "udm-label", text: o.label }), input);
  input.focus();
  input.select?.();
  return shell.dialog;
}

/**
 * Chart data dialog: chart type, title, and a table with one row per category and one column per series.
 * Rows and series can be added and removed. Values must be finite numbers (empty counts as 0).
 */
export function openChartDialog(o: {
  data: ChartData; chartType: string; title: string; opener: HTMLElement | null;
  onSave: (data: ChartData, patch: { chartType: string; title: string }) => void; restoreFocus?: FocusFallback;
}): HTMLDialogElement {
  const state: ChartData = JSON.parse(JSON.stringify(o.data));
  if (!state.categories.length) state.categories.push("Category 1");
  if (!state.series.length) state.series.push({ name: "Series 1", values: state.categories.map(() => 0) });

  const typeId = uid("type");
  const titleId = uid("ctitle");
  const select = h("select", { id: typeId, class: "udm-input" }) as HTMLSelectElement;
  for (const k of CHART_KINDS) select.append(h("option", { value: k.id, text: k.label }));
  select.value = CHART_KINDS.some((k) => k.id === o.chartType) ? o.chartType : "bar";
  const titleInput = h("input", { id: titleId, type: "text", class: "udm-input", autocomplete: "off" }) as HTMLInputElement;
  titleInput.value = o.title;

  const tableWrap = h("div", { class: "udm-dialog__grid" });
  const status = h("p", { class: "udm-sr-only", "aria-live": "polite" });

  // Inputs write straight into `state`; numbers are parsed on save so partial input ("-", "1.") is not lost.
  const raw: string[][] = state.series.map((s) => s.values.map(String));
  const render = () => {
    const table = h("table", { class: "udm-datatable" });
    const caption = h("caption", { class: "udm-sr-only", text: "Chart data: one row per category, one column per series" });
    const headRow = h("tr", {}, h("th", { scope: "col", text: "Category" }));
    state.series.forEach((s, si) => {
      const inp = h("input", { type: "text", class: "udm-input udm-input--cell", "aria-label": `Series ${si + 1} name`, "data-series": si }) as HTMLInputElement;
      inp.value = s.name;
      inp.addEventListener("input", () => (s.name = inp.value));
      headRow.append(h("th", { scope: "col" }, inp));
    });
    const tbody = h("tbody");
    state.categories.forEach((c, ci) => {
      const cat = h("input", { type: "text", class: "udm-input udm-input--cell", "aria-label": `Category ${ci + 1}`, "data-category": ci }) as HTMLInputElement;
      cat.value = c;
      cat.addEventListener("input", () => (state.categories[ci] = cat.value));
      const tr = h("tr", {}, h("th", { scope: "row" }, cat));
      state.series.forEach((s, si) => {
        const v = h("input", { type: "text", inputmode: "decimal", class: "udm-input udm-input--cell udm-input--num",
          "aria-label": `${s.name || `Series ${si + 1}`}, ${c || `category ${ci + 1}`}`, "data-cell": `${ci}:${si}` }) as HTMLInputElement;
        v.value = raw[si][ci] ?? "0";
        v.addEventListener("input", () => (raw[si][ci] = v.value));
        tr.append(h("td", {}, v));
      });
      tbody.append(tr);
    });
    table.append(caption, h("thead", {}, headRow), tbody);
    tableWrap.replaceChildren(table);
  };

  const btn = (text: string, fn: () => void) => h("button", { type: "button", class: "udm-btn udm-btn--small", text, onclick: fn });
  const tools = h("div", { class: "udm-dialog__tools" },
    btn("Add row", () => {
      state.categories.push(`Category ${state.categories.length + 1}`);
      raw.forEach((r) => r.push("0"));
      render();
      status.textContent = `Row ${state.categories.length} added`;
    }),
    btn("Remove last row", () => {
      if (state.categories.length <= 1) { status.textContent = "A chart needs at least one row"; return; }
      state.categories.pop();
      raw.forEach((r) => r.pop());
      render();
      status.textContent = "Last row removed";
    }),
    btn("Add series", () => {
      state.series.push({ name: `Series ${state.series.length + 1}`, values: [] });
      raw.push(state.categories.map(() => "0"));
      render();
      status.textContent = `Series ${state.series.length} added`;
    }),
    btn("Remove last series", () => {
      if (state.series.length <= 1) { status.textContent = "A chart needs at least one series"; return; }
      state.series.pop();
      raw.pop();
      render();
      status.textContent = "Last series removed";
    }),
  );

  const shell = openShell("Edit chart data", o.opener, () => {
    const out: ChartData = { categories: state.categories.map((c) => c.trim()), series: [] };
    for (let si = 0; si < state.series.length; si++) {
      const values: number[] = [];
      for (let ci = 0; ci < out.categories.length; ci++) {
        const t = (raw[si][ci] ?? "").trim().replace(/,/g, "");
        const n = t === "" ? 0 : Number(t);
        if (!Number.isFinite(n)) {
          const cell = tableWrap.querySelector<HTMLInputElement>(`[data-cell="${ci}:${si}"]`);
          cell?.setAttribute("aria-invalid", "true");
          cell?.focus();
          return `"${raw[si][ci]}" is not a number (${state.series[si].name || `series ${si + 1}`}, ${out.categories[ci] || `row ${ci + 1}`})`;
        }
        values.push(n);
      }
      out.series.push({ name: state.series[si].name.trim() || `Series ${si + 1}`, values });
    }
    o.onSave(out, { chartType: select.value, title: titleInput.value.trim() });
    return null;
  }, "Each row is a category; each column is a series. Empty cells count as 0.", o.restoreFocus);

  shell.body.append(
    h("div", { class: "udm-dialog__row" },
      h("div", {}, h("label", { for: typeId, class: "udm-label", text: "Chart type" }), select),
      h("div", {}, h("label", { for: titleId, class: "udm-label", text: "Title (optional)" }), titleInput)),
    tableWrap, tools, status,
  );
  shell.dialog.classList.add("udm-dialog--wide");
  render();
  focusFirst(shell.body);
  return shell.dialog;
}
