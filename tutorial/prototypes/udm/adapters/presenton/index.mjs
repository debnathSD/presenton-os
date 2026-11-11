// Adapter "presenton.slides": UDM <-> Presenton Template v2 deck. Implements core/adapter.ts.

import { presentonToUdm, NS } from "./from-presenton.mjs";
import { udmToPresenton, validatePresenton } from "./to-presenton.mjs";

export const VERSION = "0.1.0";

/** @param {{layouts: Record<string, object[]>, defaultTemplateId?: string}} catalog  template id -> Template v2 layouts */
export function createPresentonAdapter(catalog) {
  return {
    manifest: {
      id: NS, version: VERSION, displayName: "Presenton slides (Template v2)",
      nativeFormat: "application/vnd.presenton.slides+json",
      blocks: ["heading", "paragraph", "list", "table", "chart", "image", "diagram", "math"],
      marks: ["bold", "italic", "underline", "math"],
      chartKinds: ["bar", "horizontal_bar", "stacked_bar", "horizontal_stacked_bar", "line", "area", "pie", "donut",
        "polar_area", "scatter", "radar", "bubble"],
      structure: { maxHeadingLevel: 2, maxListDepth: 1, groups: true, roles: true, orderPreserved: false },
      features: { notes: true, captions: true, citations: false, staticData: true, ids: false, extPassThrough: false, sectionTitles: true },
      applyModes: ["replace", "append", "patch"],
      roundTrip: "lossy",
    },
    serialize: (udm, opts) => udmToPresenton(udm, { ...catalog, ...opts }),
    deserialize: (native) => {
      const { udm, loss } = presentonToUdm(native, { adapterVersion: VERSION });
      return { udm, loss };
    },
    validateNative: (native) => validatePresenton(native),
  };
}
