// Tiptap extension packs (schema profiles). The adapter's manifest is DERIVED from whichever pack it gets.

import { Node, Extension, getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";

const json = (name) => ({
  default: null,
  parseHTML: (el) => { const v = el.getAttribute(`data-${name}`); try { return v ? JSON.parse(v) : null; } catch { return null; } },
  renderHTML: (attrs) => (attrs[toCamel(name)] == null ? {} : { [`data-${name}`]: JSON.stringify(attrs[toCamel(name)]) }),
});
const str = (name) => ({
  default: null,
  parseHTML: (el) => el.getAttribute(`data-${name}`),
  renderHTML: (attrs) => (attrs[toCamel(name)] == null ? {} : { [`data-${name}`]: attrs[toCamel(name)] }),
});
const toCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Generic atom for data-bearing blocks (chart, diagram, metric, live table, embed). One node, not one per kind. */
export const DataBlock = Node.create({
  name: "dataBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      kind: { default: "chart", parseHTML: (el) => el.getAttribute("data-kind"), renderHTML: (a) => ({ "data-kind": a.kind }) },
      bindingId: str("binding-id"),
      block: json("block"),     // UDM block fields minus id/ext/group/role
      binding: json("binding"), // binding DEFINITION (static data or live source), never runtime state
    };
  },
  parseHTML: () => [{ tag: "figure[data-type=data-block]" }],
  renderHTML: ({ HTMLAttributes }) => ["figure", { "data-type": "data-block", ...HTMLAttributes }],
});

/** UDM identity and semantics on top-level nodes: ids, groups, roles, ext pass-through. */
export const TOP_LEVEL = ["paragraph", "heading", "bulletList", "orderedList", "blockquote", "codeBlock", "horizontalRule", "table", "image", "dataBlock"];
export const UdmAttrs = Extension.create({
  name: "udmAttrs",
  addGlobalAttributes() {
    return [{ types: TOP_LEVEL, attributes: {
      udmId: str("udm-id"), udmGroup: str("udm-group"), udmRole: str("udm-role"), udmKind: str("udm-kind"),
      udmMeta: json("udm-meta"), udmExt: json("udm-ext"),
    } }];
  },
});

/** "page" profile: what a document editor offers (StarterKit + tables + images + data blocks + UDM attrs). */
export const pageExtensions = () => [StarterKit, TableKit, Image, DataBlock, UdmAttrs];
/** "basic" profile: vanilla StarterKit only. Proves negotiation: no tables, images, data blocks or UDM attrs. */
export const basicExtensions = () => [StarterKit];

export { getSchema };
