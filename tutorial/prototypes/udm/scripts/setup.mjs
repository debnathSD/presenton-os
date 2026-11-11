// Wires the registry: the ONLY place that knows which adapters exist.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry } from "../core/registry.mjs";
import { createPresentonAdapter } from "../adapters/presenton/index.mjs";
import { createTiptapAdapter } from "../adapters/tiptap/index.mjs";
import { basicExtensions } from "../adapters/tiptap/extensions.mjs";
import { markdownAdapter } from "../adapters/markdown.mjs";
import { plainTextAdapter } from "../adapters/plaintext.mjs";

export const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const TEMPLATES_DIR = path.resolve(HERE, "../../../templates");

export function loadTemplates() {
  const out = {};
  for (const d of fs.readdirSync(TEMPLATES_DIR).sort()) {
    const f = path.join(TEMPLATES_DIR, d, "template.json");
    if (!fs.existsSync(f)) continue;
    const t = JSON.parse(fs.readFileSync(f, "utf8"));
    out[t.id ?? d] = t.layouts;
  }
  return out;
}

export function setupRegistry(layouts = loadTemplates()) {
  const registry = createRegistry();
  registry.register(createPresentonAdapter({ layouts, defaultTemplateId: "general" }), ["slides"]);
  registry.register(createTiptapAdapter({ id: "tiptap" }), ["tiptap-doc"]);
  registry.register(createTiptapAdapter({ id: "tiptap.basic", extensions: basicExtensions() }));
  registry.register(markdownAdapter, ["md"]);
  registry.register(plainTextAdapter, ["text"]);
  return { registry, layouts };
}
