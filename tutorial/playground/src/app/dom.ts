// Small DOM helpers. Text is always set with textContent / append(string), never as HTML.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids) if (c != null && c !== false) el.append(typeof c === "number" ? String(c) : c);
  return el;
}

export function svgIcon(path: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "udm-icon");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}

export const ICONS = {
  copy: "M8 8h11v13H8zM5 3h11v3H7v11H5z",
  download: "M11 3h2v9.6l3.3-3.3 1.4 1.4L12 16.4 6.3 10.7l1.4-1.4L11 12.6zM4 19h16v2H4z",
  arrow: "M4 11h12.2l-4.6-4.6L13 5l7 7-7 7-1.4-1.4 4.6-4.6H4z",
  back: "M20 11H7.8l4.6-4.6L11 5l-7 7 7 7 1.4-1.4L7.8 13H20z",
  spark: "M12 2l2.2 6.6L21 11l-6.8 2.4L12 20l-2.2-6.6L3 11l6.8-2.4z",
  close: "M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z",
};

export function prefersReducedMotion(): boolean {
  try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/** Roving tabindex + arrow keys for a tablist. `activate` runs on arrow/Home/End (automatic activation). */
export function tablistKeys(list: HTMLElement, activate: (tab: HTMLElement) => void): void {
  list.addEventListener("keydown", (e) => {
    const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')].filter((t) => !t.hasAttribute("disabled"));
    const i = tabs.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? tabs[(i + 1) % tabs.length]
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? tabs[(i - 1 + tabs.length) % tabs.length]
      : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs[tabs.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    next.focus();
    activate(next);
  });
}

/**
 * Move keyboard focus to `target` when focus would otherwise be lost: it is on <body>, or inside `scope` (the part of
 * the UI that just changed, where the focused control may now be hidden or disabled). Focus the user put somewhere
 * else (the editor, the inspector) is left alone. Non-focusable targets (headings) get tabindex="-1".
 */
export function moveFocus(target: HTMLElement | null | undefined, scope: HTMLElement): void {
  if (!target || !target.isConnected) return;
  const a = document.activeElement as HTMLElement | null;
  if (a && a !== document.body && !scope.contains(a)) return;
  if (!target.matches("a[href], button, input, select, textarea, [tabindex]")) target.setAttribute("tabindex", "-1");
  target.focus();
}
