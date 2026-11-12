// "API key" dialog: bring your own Anthropic key. The key lives in memory; "remember in this tab" (opt-in) copies
// it to sessionStorage, which the browser clears when the tab closes. It is only ever handed to src/generate, which
// sends it to api.anthropic.com.

import { h } from "./dom";
import { getApiKey, setApiKey, clearApiKey, isKeyRemembered } from "../generate/index";

// One key store for the whole playground: src/generate/key.ts (memory, plus sessionStorage only when opted in).
export { getApiKey, clearApiKey, maskKey, isKeyRemembered } from "../generate/index";

/** Opens the key dialog. Resolves true when a key was saved, false on cancel or removal. */
export function openKeyDialog(opener: HTMLElement | null, onChange: () => void): Promise<boolean> {
  return new Promise((resolve) => {
    const input = h("input", {
      id: "udm-key-input", class: "udm-input", type: "password", autocomplete: "off", spellcheck: "false",
      placeholder: "sk-ant-…", "aria-describedby": "udm-key-privacy udm-key-error",
    }) as HTMLInputElement;
    input.value = getApiKey() ?? "";
    const remember = h("input", { id: "udm-key-remember", type: "checkbox" }) as HTMLInputElement;
    remember.checked = isKeyRemembered();
    const error = h("p", { id: "udm-key-error", class: "udm-dialog__error", role: "alert" });
    const show = h("button", { type: "button", class: "udm-btn udm-btn--ghost udm-btn--sm", "aria-pressed": "false" }, "Show");
    show.addEventListener("click", () => {
      const on = input.type === "password";
      input.type = on ? "text" : "password";
      show.setAttribute("aria-pressed", String(on));
      show.textContent = on ? "Hide" : "Show";
    });

    const save = h("button", { type: "submit", class: "udm-btn udm-btn--primary" }, "Save key");
    const cancel = h("button", { type: "button", class: "udm-btn" }, "Cancel");
    const remove = h("button", { type: "button", class: "udm-btn udm-btn--danger", hidden: !getApiKey() }, "Remove key");

    const form = h("form", { class: "udm-dialog__form", novalidate: true },
      h("h2", { class: "udm-dialog__title", id: "udm-key-title" }, "Anthropic API key"),
      h("div", { class: "udm-dialog__body" },
        h("label", { class: "udm-label", for: "udm-key-input" }, "API key"),
        h("div", { class: "udm-field-row" }, input, show),
        h("div", { class: "udm-note", id: "udm-key-privacy" },
          h("strong", {}, "Privacy. "),
          "Your key stays in this browser tab. The playground sends it only to api.anthropic.com, directly from your " +
          "browser, with each generation request. It never goes to this site or any other server, and it is not " +
          "written to disk unless you tick the box below. Requests are billed to your Anthropic account, so use a key " +
          "with a spending limit and revoke it in the Anthropic Console when you are done."),
        h("label", { class: "udm-check", for: "udm-key-remember" }, remember,
          h("span", {}, "Remember in this tab (sessionStorage; cleared when you close the tab)")),
        error),
      h("div", { class: "udm-dialog__actions" }, remove, cancel, save));

    const dialog = h("dialog", { class: "udm-dialog", "aria-labelledby": "udm-key-title", "aria-describedby": "udm-key-privacy" }) as HTMLDialogElement;
    dialog.append(form);

    let done = false;
    const finish = (saved: boolean) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      dialog.remove();
      if (opener?.isConnected) opener.focus();
      resolve(saved);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); finish(false); } };
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
    cancel.addEventListener("click", () => finish(false));
    remove.addEventListener("click", () => { clearApiKey(); onChange(); finish(false); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { input.setAttribute("aria-invalid", "true"); error.textContent = "Paste a key, or press Cancel."; input.focus(); return; }
      if (/\s/.test(v) || v.length < 20) { input.setAttribute("aria-invalid", "true"); error.textContent = "That does not look like an Anthropic API key."; input.focus(); return; }
      setApiKey(v, { remember: remember.checked });
      onChange();
      finish(true);
    });

    document.body.append(dialog);
    document.addEventListener("keydown", onKey, true);
    if (typeof dialog.showModal === "function") {
      try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
    } else dialog.setAttribute("open", "");
    input.focus();
  });
}
