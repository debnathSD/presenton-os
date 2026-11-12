// Step indicator: Presenton -> UDM -> Tiptap and back, with the current stage highlighted.

import { h, svgIcon, ICONS } from "./dom";

export type StepFlow = "create" | "deck" | "page";

export const FLOW_STEPS: Record<StepFlow, { label: string; hint: string }[]> = {
  create: [
    { label: "Prompt", hint: "page settings" },
    { label: "Outline", hint: "one per section" },
    { label: "Tiptap page", hint: "sections stream in" },
    { label: "UDM", hint: "deserialize" },
    { label: "Presenton slides", hint: "layouts chosen" },
  ],
  deck: [
    { label: "Presenton slides", hint: "slides.ui" },
    { label: "UDM", hint: "deserialize" },
    { label: "Tiptap page", hint: "tiptap.json" },
    { label: "UDM", hint: "deserialize" },
    { label: "Presenton slides", hint: "patched in place" },
  ],
  page: [
    { label: "Tiptap page", hint: "tiptap.json" },
    { label: "UDM", hint: "deserialize" },
    { label: "Presenton slides", hint: "layouts chosen" },
  ],
};

export function renderSteps(list: HTMLOListElement, flow: StepFlow, stage: number): void {
  const steps = FLOW_STEPS[flow];
  list.replaceChildren(...steps.map((s, i) => {
    const state = i < stage ? "done" : i === stage ? "current" : "todo";
    const li = h("li", { class: `udm-step udm-step--${state}`, "aria-current": i === stage ? "step" : null },
      h("span", { class: "udm-step__dot", "aria-hidden": "true" }, String(i + 1)),
      h("span", { class: "udm-step__text" }, h("span", { class: "udm-step__label" }, s.label), h("small", {}, s.hint)),
      h("span", { class: "udm-sr" }, state === "done" ? " (done)" : state === "current" ? " (current stage)" : ""));
    return i < steps.length - 1 ? [li, h("li", { class: "udm-step__sep", "aria-hidden": "true" }, svgIcon(ICONS.arrow))] : [li];
  }).flat());
}
