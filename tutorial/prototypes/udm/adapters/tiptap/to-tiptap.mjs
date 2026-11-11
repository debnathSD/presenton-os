// UDM -> tiptap.json (ProseMirror JSON). Pure; the input is already negotiated against the derived manifest.
//
// Section strategy: every section starts with a boundary node carrying the section identity:
//   titled section   -> heading level 2, udmKind "section"
//   untitled section -> horizontalRule, udmKind "section"
// Block headings 1..3 -> H3..H5. Doc title -> H1 (udmKind "doc-title"). Speaker notes -> blockquote (udmKind "notes").

import { staticData, itemText, itemChildren, plain } from "../../core/udm-runtime.mjs";

const TT_MARK = { bold: "bold", italic: "italic", underline: "underline", strike: "strike", code: "code", link: "link" };

export function udmToTiptap(udm, { profile }) {
  const loss = [];
  const ids = profile.udmAttrs;
  const content = [];
  const artifact = pick(udm, ["id", "title", "language", "plannedFor", "meta", "provenance", "assets", "sources", "ext"]);
  const attrs = (o) => (ids ? clean(o) : undefined);
  const node = (type, a, c) => ({ type, ...(a && Object.keys(a).length ? { attrs: a } : {}), ...(c ? { content: c } : {}) });

  if (udm.title) content.push(node("heading", { level: 1, ...attrs({ udmKind: "doc-title" }) }, inline([{ text: udm.title }], [], loss, "title")));
  for (const s of udm.sections) {
    const meta = clean({ role: s.role, level: s.level, summary: s.summary });
    const boundary = attrs({ udmKind: "section", udmId: s.id, udmMeta: Object.keys(meta).length ? meta : null, udmExt: s.ext ?? null });
    if (s.title) content.push(node("heading", { level: 2, ...boundary }, inline([{ text: s.title }], [], loss, s.id)));
    else content.push(node("horizontalRule", boundary));
    for (const b of s.blocks) content.push(...block(b, udm, profile, loss, `${s.id}/${b.id}`));
    if (s.notes) content.push(node("blockquote", attrs({ udmKind: "notes" }), [node("paragraph", undefined, inline(s.notes, [], loss, `${s.id}/notes`))]));
  }
  if (!content.length) content.push({ type: "paragraph" });
  if (ids) {
    const first = content[0];
    first.attrs = { ...(first.attrs ?? {}), udmMeta: { ...(first.attrs?.udmMeta ?? {}), artifact } };
  }
  return { native: { type: "doc", content }, loss };
}

function block(b, udm, profile, loss, path) {
  const a = profile.udmAttrs
    ? clean({ udmId: b.id, udmGroup: b.group, udmRole: b.role, udmExt: b.ext ?? null })
    : {};
  const n = (type, extra, c) => ({ type, ...((extra || Object.keys(a).length) ? { attrs: { ...(extra ?? {}), ...a } } : {}), ...(c ? { content: c } : {}) });
  const para = (rt) => ({ type: "paragraph", ...(rt?.length ? { content: inline(rt, [], loss, path) } : {}) });
  switch (b.type) {
    case "heading": return [n("heading", { level: b.level + 2 }, inline(b.text, [], loss, path))];
    case "paragraph": return [n("paragraph", undefined, inline(b.text, [], loss, path))];
    case "list": return [list(b.ordered, b.items, n, para)];
    case "quote":
      if (b.attribution && !profile.udmAttrs) {
        loss.push({ code: "quote_attribution_inlined", path });
        return [n("blockquote", undefined, [para([...b.text, { text: `\n— ${b.attribution}` }])])];
      }
      return [n("blockquote", meta(profile, { udmKind: "quote", udmMeta: b.attribution ? { attribution: b.attribution } : null }), [para(b.text)])];
    case "callout": return [n("blockquote", meta(profile, { udmKind: "callout", udmMeta: { tone: b.tone } }), [para(b.text)])];
    case "divider": return [n("horizontalRule")];
    case "code": return [n("codeBlock", { language: b.language ?? null }, b.code ? [{ type: "text", text: b.code }] : undefined)];
    case "image": {
      const m = clean({ kind: b.kind, prompt: b.prompt, caption: b.caption, assetId: b.assetId });
      return [n("image", { src: b.url ?? null, alt: b.alt, title: b.caption ? plain(b.caption) : null,
        ...meta(profile, { udmMeta: Object.keys(m).length ? m : null }) })];
    }
    case "table": {
      const d = staticData(udm, b.bindingId);
      if (d) {
        const cell = (type, t) => ({ type, content: [t ? { type: "paragraph", content: [{ type: "text", text: t }] } : { type: "paragraph" }] });
        const rows = [{ type: "tableRow", content: d.columns.map((c) => cell("tableHeader", c)) },
          ...d.rows.map((r) => ({ type: "tableRow", content: r.map((c) => cell("tableCell", c)) }))];
        const m = clean({ bindingId: b.bindingId, origin: udm.bindings[b.bindingId].source.origin, caption: b.caption });
        return [n("table", meta(profile, { udmMeta: m }), rows)];
      }
      // live table: falls through to a data block (definition only)
    }
    // eslint-disable-next-line no-fallthrough
    case "chart": case "diagram": case "metric": case "embed": {
      const { id, ext, group, role, type, bindingId, ...rest } = b;
      return [n("dataBlock", { kind: type, bindingId: bindingId ?? null, block: rest, binding: bindingId ? udm.bindings[bindingId] : null })];
    }
    default:
      loss.push({ code: "unsupported_block", path, detail: b.type });
      return [];
  }
}

const meta = (profile, o) => (profile.udmAttrs ? clean(o) : {});

function list(ordered, items, n, para) {
  const li = (it) => ({ type: "listItem", content: [para(itemText(it)),
    ...(itemChildren(it).length ? [{ type: "bulletList", content: itemChildren(it).map(li) }] : [])] });
  // nested lists inherit bullet style; the top-level list carries the UDM attrs
  return n(ordered ? "orderedList" : "bulletList", ordered ? { start: 1 } : undefined, items.map(li));
}

/** RichText -> inline nodes. "\n" -> hardBreak. code excludes other marks in Tiptap: keep code, report the rest. */
export function inline(rt, extraMarks, loss, path) {
  const out = [];
  for (const seg of rt) {
    let marks = [...(seg.marks ?? []), ...extraMarks].filter((m) => TT_MARK[m]);
    if (marks.includes("code") && marks.length > 1) {
      loss.push({ code: "mark_conflict", path, detail: `code excludes ${marks.filter((m) => m !== "code").join(",")}` });
      marks = ["code"];
    }
    const pm = marks.map((m) => (m === "link" ? { type: "link", attrs: { href: seg.href ?? null } } : { type: TT_MARK[m] }));
    if (seg.token) { loss.push({ code: "token_unsupported", path }); continue; }
    seg.text.split("\n").forEach((part, i) => {
      if (i > 0) out.push({ type: "hardBreak" });
      if (part) out.push({ type: "text", text: part, ...(pm.length ? { marks: pm } : {}) });
    });
  }
  return out;
}

function clean(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) r[k] = v;
  return r;
}
const pick = (o, keys) => clean(Object.fromEntries(keys.map((k) => [k, o[k]])));
