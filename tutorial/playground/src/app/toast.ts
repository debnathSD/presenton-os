// Toasts: short messages in a corner. The container is a polite live region that exists from the start, so new
// toasts are announced (a role="status" element inserted later often is not); errors use role="alert".
// Dismissable; they auto-hide, but not while the pointer or keyboard focus is on them.

import { h, svgIcon, ICONS } from "./dom";

export type ToastKind = "info" | "success" | "error";
export type Toaster = { el: HTMLElement; show(message: string, kind?: ToastKind, detail?: string): void };

export function createToaster(): Toaster {
  const el = h("div", { class: "udm-toasts", "aria-live": "polite", "aria-relevant": "additions" });
  function show(message: string, kind: ToastKind = "info", detail?: string) {
    const close = h("button", { type: "button", class: "udm-toast__close", "aria-label": `Dismiss: ${message}` }, svgIcon(ICONS.close));
    const t = h("div", { class: `udm-toast udm-toast--${kind}`, role: kind === "error" ? "alert" : null },
      h("div", { class: "udm-toast__body" }, h("strong", {}, message), detail ? h("span", {}, ` ${detail}`) : null), close);
    const ttl = kind === "error" ? 9000 : 4000;
    let timer: any = setTimeout(() => remove(), ttl);
    let hovered = false;
    let cameFrom: HTMLElement | null = null; // where keyboard focus was before it moved into this toast
    const remove = () => {
      clearTimeout(timer);
      const had = t.contains(document.activeElement);
      t.remove();
      if (had && cameFrom?.isConnected) cameFrom.focus();
    };
    const hold = () => { clearTimeout(timer); };
    const resume = () => {
      if (hovered || t.contains(document.activeElement)) return;
      clearTimeout(timer);
      timer = setTimeout(() => remove(), ttl / 2);
    };
    t.addEventListener("pointerenter", () => { hovered = true; hold(); });
    t.addEventListener("pointerleave", () => { hovered = false; resume(); });
    t.addEventListener("focusin", (e) => {
      const from = (e as FocusEvent).relatedTarget as HTMLElement | null;
      if (from && !t.contains(from)) cameFrom = from;
      hold();
    });
    t.addEventListener("focusout", () => setTimeout(resume, 0));
    close.addEventListener("click", remove);
    el.append(t);
    while (el.children.length > 4) el.firstElementChild!.remove();
  }
  return { el, show };
}
