// tiptap.json -> UDM. Works for documents this adapter wrote (ids, ext and sections restored from udm* attrs)
// and for foreign Tiptap documents (H1/H2 start sections, unknown nodes degrade to paragraphs with a loss entry).

import { hashId, normalizeRichText, UDM_VERSION, UDM_PROFILE } from "../../core/udm-runtime.mjs";

const MARK = { bold: "bold", italic: "italic", underline: "underline", strike: "strike", code: "code", link: "link" };

export function tiptapToUdm(doc, { adapterId = "tiptap", adapterVersion = "0.1.0" } = {}) {
  const loss = [];
  const bindings = {};
  const sections = [];
  let title;
  let artifact = {};
  let cur = null;
  const top = doc.content ?? [];
  const newSection = (fields, idSeed) => {
    cur = { id: fields.id ?? `sec_${hashId("tt-s", String(sections.length), idSeed ?? "")}`, ...fields, blocks: [] };
    sections.push(cur);
    return cur;
  };
  const section = () => cur ?? newSection({}, "implicit");

  top.forEach((n, i) => {
    const a = n.attrs ?? {};
    if (i === 0 && a.udmMeta?.artifact) artifact = a.udmMeta.artifact;
    const path = `doc/${i}`;
    const blockId = a.udmId ?? `blk_${hashId("tt-b", String(i), textOf(n))}`;
    const base = clean({ id: blockId, role: a.udmRole, group: a.udmGroup, ext: a.udmExt ?? undefined });
    const push = (b) => section().blocks.push(b);

    switch (n.type) {
      case "heading": {
        const rt = inlineToRich(n.content, loss, path);
        if (a.udmKind === "doc-title" || (n.attrs?.level === 1 && !a.udmKind && i === 0 && !sections.length)) { title = plainOf(rt); return; }
        if (a.udmKind === "section" || n.attrs.level <= 2) {
          const m = a.udmMeta ?? {};
          newSection(clean({ id: a.udmKind === "section" ? a.udmId : undefined, title: plainOf(rt), role: m.role, level: m.level, summary: m.summary, ext: a.udmExt ?? undefined }), plainOf(rt));
          return;
        }
        push({ ...base, type: "heading", level: Math.min(3, Math.max(1, n.attrs.level - 2)), text: rt });
        return;
      }
      case "horizontalRule":
        // section boundary: ours (udmKind) or a bare rule in a foreign / attr-less document
        if (a.udmKind === "section" || !a.udmId) {
          const m = a.udmMeta ?? {};
          newSection(clean({ id: a.udmId, role: m.role, level: m.level, summary: m.summary, ext: a.udmExt ?? undefined }), String(i));
        } else push({ ...base, type: "divider" });
        return;
      case "paragraph": push({ ...base, type: "paragraph", text: inlineToRich(n.content, loss, path) }); return;
      case "bulletList": case "orderedList":
        push({ ...base, type: "list", ordered: n.type === "orderedList", items: listItems(n, loss, path) }); return;
      case "blockquote": {
        const rt = blockText(n.content, loss, path);
        if (a.udmKind === "notes") { section().notes = rt; return; }
        if (a.udmKind === "callout") { push({ ...base, type: "callout", tone: a.udmMeta?.tone ?? "info", text: rt }); return; }
        push({ ...base, type: "quote", text: rt, ...(a.udmMeta?.attribution ? { attribution: a.udmMeta.attribution } : {}) });
        return;
      }
      case "codeBlock":
        push({ ...base, type: "code", ...(n.attrs?.language ? { language: n.attrs.language } : {}), code: textOf(n) }); return;
      case "image": {
        const m = a.udmMeta ?? {};
        push(clean({ ...base, type: "image", url: n.attrs?.src ?? undefined, alt: n.attrs?.alt ?? "", kind: m.kind, prompt: m.prompt,
          caption: m.caption ?? (n.attrs?.title ? [{ text: n.attrs.title }] : undefined), assetId: m.assetId }));
        return;
      }
      case "table": {
        const m = a.udmMeta ?? {};
        const rows = (n.content ?? []).map((r) => (r.content ?? []).map((c) => ({ header: c.type === "tableHeader", text: blockPlain(c.content) })));
        const hasHeader = rows.length && rows[0].every((c) => c.header);
        const width = Math.max(0, ...rows.map((r) => r.length));
        const columns = hasHeader ? rows[0].map((c) => c.text) : Array(width).fill("");
        if (!hasHeader) loss.push({ code: "table_no_header", path });
        if (rows.some((r) => r.length !== width)) loss.push({ code: "table_ragged", path, detail: "rows padded to the widest row" });
        const body = (hasHeader ? rows.slice(1) : rows).map((r) => [...r.map((c) => c.text), ...Array(width - r.length).fill("")]);
        const key = m.bindingId ?? `b_${hashId("tt-t", blockId)}`;
        bindings[key] = { kind: "table", source: { type: "static", origin: m.origin ?? "user", data: { columns, rows: body } } };
        push(clean({ ...base, type: "table", bindingId: key, caption: m.caption }));
        return;
      }
      case "dataBlock": {
        const { kind, bindingId, block = {}, binding } = n.attrs ?? {};
        if (bindingId && binding) bindings[bindingId] = binding;
        push({ ...base, type: kind, ...(bindingId ? { bindingId } : {}), ...block });
        return;
      }
      default:
        loss.push({ code: "native_node_degraded", path, detail: `${n.type} -> paragraph` });
        push({ ...base, type: "paragraph", text: [{ text: textOf(n) }] });
    }
  });

  const udm = {
    version: UDM_VERSION, profile: UDM_PROFILE,
    id: artifact.id ?? `art_${hashId("tt", JSON.stringify(doc))}`,
    ...clean({ title: title ?? artifact.title, language: artifact.language, plannedFor: artifact.plannedFor, meta: artifact.meta,
      assets: artifact.assets, sources: artifact.sources }),
    provenance: artifact.provenance ?? { origin: "imported", importedFrom: { adapter: adapterId, adapterVersion } },
    sections: sections.map((s) => ({ ...s, blocks: s.blocks })),
    bindings,
    ...(artifact.ext ? { ext: artifact.ext } : {}),
  };
  return { udm, loss };
}

function listItems(listNode, loss, path) {
  return (listNode.content ?? []).map((li, i) => {
    const kids = li.content ?? [];
    const text = kids[0]?.type === "paragraph" ? inlineToRich(kids[0].content, loss, path) : [];
    const children = [];
    for (const k of kids.slice(1)) {
      if (k.type === "bulletList" || k.type === "orderedList") children.push(...listItems(k, loss, `${path}/${i}`));
      else { loss.push({ code: "list_item_block_flattened", path: `${path}/${i}`, detail: k.type }); children.push([{ text: textOf(k) }]); }
    }
    return children.length ? { text, children } : text;
  });
}

function inlineToRich(content, loss, path) {
  const out = [];
  for (const n of content ?? []) {
    if (n.type === "hardBreak") { out.push({ text: "\n" }); continue; }
    if (n.type !== "text") { loss.push({ code: "inline_node_degraded", path, detail: n.type }); out.push({ text: textOf(n) }); continue; }
    const marks = [];
    let href;
    for (const m of n.marks ?? []) {
      if (MARK[m.type]) { marks.push(MARK[m.type]); if (m.type === "link") href = m.attrs?.href ?? undefined; }
      else loss.push({ code: "native_mark_dropped", path, detail: m.type });
    }
    out.push({ text: n.text, ...(marks.length ? { marks } : {}), ...(href ? { href } : {}) });
  }
  return normalizeRichText(out);
}

/** Several paragraphs -> one RichText joined by "\n". */
function blockText(content, loss, path) {
  const parts = (content ?? []).map((c) => (c.type === "paragraph" || c.type === "heading" ? inlineToRich(c.content, loss, path) : [{ text: textOf(c) }]));
  return normalizeRichText(parts.flatMap((p, i) => (i ? [{ text: "\n" }, ...p] : p)));
}
const blockPlain = (content) => plainOf(blockText(content, [], ""));
const plainOf = (rt) => rt.map((s) => s.text).join("");
const textOf = (n) => (n.type === "text" ? n.text : n.type === "hardBreak" ? "\n" : (n.content ?? []).map(textOf).join(n.type === "tableRow" ? " | " : ""));
function clean(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) r[k] = v;
  return r;
}
