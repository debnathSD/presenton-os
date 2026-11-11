// Adapter "markdown": UDM <-> GitHub-flavored Markdown.
// Written only against core/adapter.ts + core/udm-runtime.mjs: no change to the UDM, registry or negotiation.
// Charts and diagrams are not declared, so negotiation degrades them (chart -> table, diagram -> list) first.

import { Lexer, Tokenizer } from "marked";
import { hashId, normalizeRichText, plain, staticData, itemText, itemChildren, UDM_VERSION, UDM_PROFILE } from "../core/udm-runtime.mjs";

export const manifest = {
  id: "markdown", version: "0.1.0", displayName: "Markdown (GFM)", nativeFormat: "text/markdown",
  blocks: ["heading", "paragraph", "list", "quote", "divider", "code", "table", "image"],
  marks: ["bold", "italic", "strike", "code", "link"],
  structure: { maxHeadingLevel: 3, maxListDepth: 8, groups: false, roles: false, orderPreserved: true },
  features: { notes: false, captions: false, citations: false, staticData: true, ids: false, extPassThrough: false, sectionTitles: true },
  applyModes: ["replace", "append"],
  roundTrip: "lossy",
};

// ---------- serialize ----------

const esc = (s) => s.replace(/([\\`*_[\]<>~|#])/g, "\\$1");
/** Escape what would turn a line into a list item, rule or setext underline; applied to every line. */
const escLines = (md) => md.split("\\\n").map((l) => l.replace(/^(\s*)([-+=])/, "$1\\$2").replace(/^(\s*)(\d+)([.)])(?=\s|$)/, "$1$2\\$3")).join("\\\n");

function inline(rt) {
  return rt.map((seg) => {
    const m = new Set(seg.marks ?? []);
    if (m.has("code")) {
      const ticks = "`".repeat(Math.max(1, ...[...seg.text.matchAll(/`+/g)].map((x) => x[0].length + 1)));
      return `${ticks}${ticks.length > 1 ? " " : ""}${seg.text}${ticks.length > 1 ? " " : ""}${ticks}`;
    }
    return seg.text.split("\n").map((part) => {
      const [, lead, core, trail] = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!core) return part;
      let t = esc(core);
      // CommonMark flanking rules reject `**Presenter:**Lorem`; use the HTML form when the edge is punctuation.
      const html = !/^[\p{L}\p{N}]/u.test(core) || !/[\p{L}\p{N}]$/u.test(core);
      const wrap = (md, tag) => (html ? `<${tag}>${t}</${tag}>` : `${md}${t}${md}`);
      if (m.has("strike")) t = wrap("~~", "del");
      if (m.has("italic")) t = wrap("*", "em");
      if (m.has("bold")) t = wrap("**", "strong");
      if (m.has("link")) t = `[${t}](${encodeURI(seg.href ?? "")})`;
      return lead + t + trail;
    }).join("\\\n");
  }).join("");
}

function listMd(items, ordered, indent = "") {
  return items.map((it, i) => {
    const marker = ordered ? `${i + 1}. ` : "- ";
    const kids = itemChildren(it);
    const pad = indent + " ".repeat(marker.length);
    return `${indent}${marker}${escLines(inline(itemText(it))).replace(/\\\n/g, `\\\n${pad}`)}${kids.length ? `\n${listMd(kids, false, pad)}` : ""}`;
  }).join("\n");
}

const cellMd = (s) => esc(s).replace(/\n/g, " ");

function blockMd(b, udm, loss, path) {
  switch (b.type) {
    case "heading": return `${"#".repeat(b.level + 2)} ${inline(b.text).replace(/\\\n/g, " ")}`;
    case "paragraph": return escLines(inline(b.text));
    case "list": return listMd(b.items, b.ordered);
    case "quote": {
      if (b.attribution) loss.push({ code: "quote_attribution_inlined", path });
      const body = inline([...b.text, ...(b.attribution ? [{ text: `\n— ${b.attribution}` }] : [])]);
      return body.split("\n").map((l) => `> ${l}`).join("\n");
    }
    case "divider": return "***";
    case "code": return `\`\`\`${b.language ?? ""}\n${b.code}\n\`\`\``;
    case "image":
      if (b.kind || b.prompt) loss.push({ code: "image_meta_dropped", path, detail: [b.kind && "kind", b.prompt && "prompt"].filter(Boolean).join(",") });
      return `![${esc(b.alt)}](${encodeURI(b.url ?? "")})`;
    case "table": {
      const d = staticData(udm, b.bindingId);
      if (!d) { loss.push({ code: "live_table_unbound", path }); return ""; }
      const row = (cells) => `| ${cells.map(cellMd).join(" | ")} |`;
      return [row(d.columns), `|${d.columns.map(() => " --- ").join("|")}|`, ...d.rows.map(row)].join("\n");
    }
    default: loss.push({ code: "unsupported_block", path, detail: b.type }); return "";
  }
}

export function serialize(udm) {
  const loss = [];
  const out = [];
  if (udm.title) out.push(`# ${esc(udm.title).replace(/\n/g, " ")}`);
  udm.sections.forEach((s, i) => {
    if (s.title !== undefined) out.push(`## ${esc(s.title).replace(/\n/g, " ")}`);
    else if (i > 0 || udm.title) out.push("---");
    if (s.title?.includes("\n")) loss.push({ code: "line_break_in_title", path: s.id });
    s.blocks.forEach((b, k) => {
      // two adjacent lists would merge into one in Markdown: separate them with an empty comment
      if (b.type === "list" && s.blocks[k - 1]?.type === "list") out.push("<!-- -->");
      out.push(blockMd(b, udm, loss, `${s.id}/${b.id}`));
    });
  });
  return { native: `${out.filter((x) => x !== "").join("\n\n")}\n`, loss };
}

// ---------- deserialize ----------

class NoAutolink extends Tokenizer { url() { return undefined; } }
const lex = (md) => new Lexer({ gfm: true, tokenizer: new NoAutolink() }).lex(md);

const HTML_MARK = { strong: "bold", em: "italic", del: "strike" };

function rich(tokens, outer = [], href) {
  const out = [];
  const open = [];
  for (const t of tokens ?? []) {
    const tag = t.type === "html" && t.raw.match(/^<(\/?)(strong|em|del)>$/);
    if (tag) { if (tag[1]) open.splice(open.lastIndexOf(HTML_MARK[tag[2]]), 1); else open.push(HTML_MARK[tag[2]]); continue; }
    const marks = [...outer, ...open];
    switch (t.type) {
      case "strong": out.push(...rich(t.tokens, [...marks, "bold"], href)); break;
      case "em": out.push(...rich(t.tokens, [...marks, "italic"], href)); break;
      case "del": out.push(...rich(t.tokens, [...marks, "strike"], href)); break;
      case "link": out.push(...rich(t.tokens, [...marks, "link"], decodeURI(t.href))); break;
      case "codespan": out.push({ text: t.raw.replace(/^(`+) ?([\s\S]*?) ?\1$/, "$2"), marks: [...marks, "code"] }); break;
      case "br": out.push({ text: "\n", marks }); break;
      case "text": out.push(...(t.tokens ? rich(t.tokens, marks, href) : [{ text: t.text.replace(/\n/g, " "), marks }])); break;
      case "escape": out.push({ text: t.text, marks }); break;
      case "image": out.push({ text: t.text, marks }); break;
      default: out.push({ text: t.raw, marks });
    }
  }
  return normalizeRichText(out.map((s) => ({ ...s, ...(s.marks?.includes("link") ? { href: s.href ?? href } : {}) })));
}

function items(list) {
  return list.items.map((it) => {
    const kids = [];
    let text = [];
    for (const t of it.tokens) {
      if (t.type === "list") kids.push(...items(t));
      else if (t.type !== "space") text = [...text, ...rich(t.tokens ?? [t])];
    }
    return kids.length ? { text: normalizeRichText(text), children: kids } : normalizeRichText(text);
  });
}

export function deserialize(md) {
  const loss = [];
  const bindings = {};
  const sections = [];
  let title;
  let cur = null;
  const section = () => cur ?? (cur = sections[sections.push({ id: `sec_${hashId("md", "0")}`, blocks: [] }) - 1]);
  const start = (t) => (cur = sections[sections.push({ id: `sec_${hashId("md", String(sections.length), t ?? "")}`, ...(t !== undefined ? { title: t } : {}), blocks: [] }) - 1]);
  lex(md).forEach((t, i) => {
    const id = `blk_${hashId("md", String(i), t.raw)}`;
    const push = (b) => section().blocks.push({ id, ...b });
    switch (t.type) {
      case "space": return;
      case "html": if (t.raw.trim() === "<!-- -->") return;
        loss.push({ code: "native_node_degraded", path: `md/${i}`, detail: "html" });
        push({ type: "paragraph", text: [{ text: t.raw.trim() }] });
        return;
      case "heading": {
        const rt = rich(t.tokens);
        if (t.depth === 1 && title === undefined && !sections.length) title = plain(rt);
        else if (t.depth <= 2) start(plain(rt));
        else push({ type: "heading", level: Math.min(3, t.depth - 2), text: rt });
        return;
      }
      case "hr": if (t.raw.trim() === "---") start(); else push({ type: "divider" }); return;
      case "paragraph":
        if (t.tokens.length === 1 && t.tokens[0].type === "image") {
          const im = t.tokens[0];
          push({ type: "image", alt: im.text, ...(im.href ? { url: decodeURI(im.href) } : {}) });
        } else push({ type: "paragraph", text: rich(t.tokens) });
        return;
      case "list": push({ type: "list", ordered: t.ordered, items: items(t) }); return;
      case "blockquote": {
        const parts = t.tokens.filter((x) => x.tokens).map((x) => rich(x.tokens));
        push({ type: "quote", text: normalizeRichText(parts.flatMap((p, k) => (k ? [{ text: "\n" }, ...p] : p))) });
        return;
      }
      case "code": push({ type: "code", ...(t.lang ? { language: t.lang } : {}), code: t.text }); return;
      case "table": {
        const key = `b_${hashId("md", id)}`;
        const cell = (c) => plain(rich(c.tokens));
        bindings[key] = { kind: "table", source: { type: "static", origin: "imported", data: { columns: t.header.map(cell), rows: t.rows.map((r) => r.map(cell)) } } };
        push({ type: "table", bindingId: key });
        return;
      }
      default:
        loss.push({ code: "native_node_degraded", path: `md/${i}`, detail: t.type });
        push({ type: "paragraph", text: [{ text: t.raw.trim() }] });
    }
  });
  const udm = { version: UDM_VERSION, profile: UDM_PROFILE, id: `art_${hashId("md", md)}`, ...(title !== undefined ? { title } : {}),
    provenance: { origin: "imported", importedFrom: { adapter: manifest.id, adapterVersion: manifest.version } }, sections, bindings };
  return { udm, loss };
}

/** Valid Markdown for this adapter = re-parses into the same block sequence it was written from. */
export function validateNative(md) {
  if (typeof md !== "string") return [{ level: "error", code: "type", path: "", message: "native must be a string" }];
  const issues = [];
  try { lex(md); } catch (e) { issues.push({ level: "error", code: "parse", path: "", message: e.message }); }
  return issues;
}

export const markdownAdapter = { manifest, serialize, deserialize, validateNative };
