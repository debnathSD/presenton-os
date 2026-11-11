// Adapter "plain-text": UDM -> plain text (an email body, an SMS digest, a TTS script). Write-only.
// Written AFTER core/ was frozen (core.lock.json): it proves a new module needs only an adapter.

import { plain, flattenItems } from "../core/udm-runtime.mjs";

export const manifest = {
  id: "plain-text", version: "0.1.0", displayName: "Plain text", nativeFormat: "text/plain",
  blocks: ["heading", "paragraph", "list", "quote", "divider", "code"],
  marks: [],
  structure: { maxHeadingLevel: 3, maxListDepth: 3, groups: false, roles: false, orderPreserved: true },
  features: { notes: false, captions: false, citations: false, staticData: true, ids: false, extPassThrough: false, sectionTitles: true },
  applyModes: ["replace"],
  roundTrip: "write-only",
};

const underline = (s, ch) => `${s}\n${ch.repeat(Math.min(72, [...s].length))}`;

function block(b) {
  switch (b.type) {
    case "heading": return b.level === 1 ? underline(plain(b.text), "-") : plain(b.text);
    case "paragraph": return plain(b.text);
    case "list": return flattenItems(b.items).map((it, i) => `${"  ".repeat(it.depth)}${b.ordered && !it.depth ? `${i + 1}.` : "-"} ${plain(it.text)}`).join("\n");
    case "quote": return plain(b.text).split("\n").map((l) => `> ${l}`).join("\n") + (b.attribution ? `\n> - ${b.attribution}` : "");
    case "divider": return "----";
    case "code": return b.code.split("\n").map((l) => `    ${l}`).join("\n");
    default: return "";
  }
}

export function serialize(udm) {
  const parts = [];
  if (udm.title) parts.push(underline(udm.title, "="));
  for (const s of udm.sections) {
    if (s.title) parts.push(underline(s.title, "="));
    for (const b of s.blocks) parts.push(block(b));
  }
  return { native: `${parts.filter(Boolean).join("\n\n")}\n`, loss: [] };
}

export const validateNative = (txt) => (typeof txt === "string" ? [] : [{ level: "error", code: "type", path: "", message: "string expected" }]);

export const plainTextAdapter = { manifest, serialize, validateNative };
