// Download helpers and the "Download" menu button (menu button pattern: Enter/Space/ArrowDown opens,
// arrows move, Escape closes and returns focus).

import { h, svgIcon, ICONS } from "./dom";

export function saveFile(name: string, data: string | Blob, type = "application/json"): void {
  const blob = typeof data === "string" ? new Blob([data], { type: `${type};charset=utf-8` }) : data;
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type MenuItem = { id: string; label: string; hint?: string; enabled(): boolean; run(): void | Promise<void> };
export type DownloadMenu = { el: HTMLElement; button: HTMLButtonElement; refresh(): void; close(): void };

export function createDownloadMenu(idPrefix: string, items: MenuItem[]): DownloadMenu {
  const menuId = `${idPrefix}-download-menu`;
  const button = h("button", {
    type: "button", class: "udm-btn udm-btn--secondary", id: `${idPrefix}-download`,
    "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": menuId,
  }, svgIcon(ICONS.download), "Download");
  const buttons = items.map((it) => h("button", { type: "button", role: "menuitem", class: "udm-menu__item", tabindex: "-1", "data-id": it.id },
    h("span", {}, it.label), it.hint ? h("small", {}, it.hint) : null));
  const menu = h("div", { class: "udm-menu", role: "menu", id: menuId, "aria-labelledby": button.id, hidden: true }, ...buttons);
  const el = h("div", { class: "udm-menu-wrap" }, button, menu);

  const enabledButtons = () => buttons.filter((b) => b.getAttribute("aria-disabled") !== "true");
  function refresh() {
    items.forEach((it, i) => buttons[i].setAttribute("aria-disabled", String(!it.enabled())));
  }
  function open(focusLast = false) {
    refresh();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const list = enabledButtons();
    (focusLast ? list[list.length - 1] : list[0])?.focus();
    document.addEventListener("pointerdown", outside, true);
  }
  function close(focusButton = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (focusButton) button.focus();
  }
  function outside(e: Event) {
    if (!el.contains(e.target as Node)) close();
  }

  button.addEventListener("click", () => (menu.hidden ? open() : close()));
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(e.key === "ArrowUp"); }
  });
  menu.addEventListener("keydown", (e) => {
    const list = enabledButtons();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === "Tab") close();
  });
  buttons.forEach((b, i) => b.addEventListener("click", () => {
    if (b.getAttribute("aria-disabled") === "true") return;
    close(true);
    void items[i].run();
  }));
  refresh();
  return { el, button, refresh, close: () => close() };
}
