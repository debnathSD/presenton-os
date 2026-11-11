// Adapter "tiptap": UDM <-> tiptap.json. The manifest is derived from the configured extension list,
// so the same code serves a full "page" editor and a bare StarterKit editor (id "tiptap.basic").

import { getSchema } from "@tiptap/core";
import { udmToTiptap } from "./to-tiptap.mjs";
import { tiptapToUdm } from "./from-tiptap.mjs";
import { pageExtensions } from "./extensions.mjs";

export const VERSION = "0.1.0";
const UDM_MARKS = ["bold", "italic", "underline", "strike", "code", "link"];

/** Capabilities = what this schema can hold. */
export function deriveManifest(schema, id) {
  const has = (n) => Boolean(schema.nodes[n]);
  const udmAttrs = Boolean(schema.nodes.paragraph.spec.attrs?.udmId);
  const blocks = ["paragraph"];
  if (has("heading")) blocks.push("heading");
  if (has("bulletList") && has("orderedList") && has("listItem")) blocks.push("list");
  if (has("blockquote")) blocks.push("quote");
  // callout tone and a divider distinct from a section break need the UDM attrs to survive a round trip
  if (has("blockquote") && udmAttrs) blocks.push("callout");
  if (has("horizontalRule") && udmAttrs) blocks.push("divider");
  if (has("codeBlock")) blocks.push("code");
  if (has("table") && has("tableRow") && has("tableHeader") && has("tableCell")) blocks.push("table");
  if (has("image")) blocks.push("image");
  if (has("dataBlock")) blocks.push("chart", "diagram", "metric", "embed");
  return {
    id, version: VERSION, displayName: `Tiptap document (${id})`, nativeFormat: "application/vnd.tiptap+json",
    blocks,
    marks: UDM_MARKS.filter((m) => schema.marks[m]),
    ...(has("dataBlock") ? { chartKinds: ["bar", "horizontal_bar", "stacked_bar", "horizontal_stacked_bar", "line", "area", "pie", "donut", "polar_area", "scatter", "radar", "bubble"] } : {}),
    structure: { maxHeadingLevel: has("heading") ? 3 : 0, maxListDepth: 8, groups: udmAttrs, roles: udmAttrs, orderPreserved: true },
    features: { notes: udmAttrs && has("blockquote"), captions: udmAttrs, citations: false, staticData: true,
      ids: udmAttrs, extPassThrough: udmAttrs, sectionTitles: has("heading") },
    applyModes: udmAttrs ? ["replace", "insert_at_cursor", "append", "patch"] : ["replace", "insert_at_cursor", "append"],
    roundTrip: "lossy",
  };
}

export function createTiptapAdapter({ id = "tiptap", extensions = pageExtensions() } = {}) {
  const schema = getSchema(extensions);
  const manifest = deriveManifest(schema, id);
  const profile = { udmAttrs: manifest.features.ids };
  return {
    manifest,
    schema,
    extensions, // for hosts and tests that load a real Editor
    serialize: (udm) => udmToTiptap(udm, { profile }),
    deserialize: (doc) => tiptapToUdm(doc, { adapterId: id, adapterVersion: VERSION }),
    validateNative: (doc) => validateTiptap(schema, doc),
  };
}

/** schema.nodeFromJSON(json).check() + no silently dropped attrs + attr range checks. */
export function validateTiptap(schema, doc) {
  const issues = [];
  let node;
  try {
    node = schema.nodeFromJSON(doc);
    node.check();
  } catch (e) {
    return [{ level: "error", code: "schema", path: "doc", message: e.message }];
  }
  const out = node.toJSON();
  (function diff(a, b, path) {
    for (const [k, v] of Object.entries(a.attrs ?? {})) {
      if (!b.attrs || !(k in b.attrs)) issues.push({ level: "error", code: "attr_dropped", path, message: `${a.type}.attrs.${k} not in schema` });
      else if (JSON.stringify(b.attrs[k]) !== JSON.stringify(v)) issues.push({ level: "error", code: "attr_changed", path, message: `${a.type}.attrs.${k}` });
    }
    if (a.type === "heading" && !(a.attrs?.level >= 1 && a.attrs?.level <= 6)) issues.push({ level: "error", code: "heading_level", path, message: String(a.attrs?.level) });
    (a.content ?? []).forEach((c, i) => diff(c, b.content?.[i] ?? {}, `${path}/${i}`));
  })(doc, out, "doc");
  return issues;
}
