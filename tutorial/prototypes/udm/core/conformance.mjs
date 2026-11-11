// Shared conformance kit. Every adapter must pass it on every fixture. Knows nothing about any target.

import { negotiate } from "./negotiate.mjs";
import { checkManifest } from "./registry.mjs";
import { checkUdm, clone, stableStringify, udmAtoms, plain, staticData, flattenItems, normalizeRichText } from "./udm-runtime.mjs";

const norm = (s) => s.replace(/\s+/g, " ").trim();

/** Content projection of a block (what must survive a round trip). */
function project(b, udm, m) {
  const rt = (r) => r && stableStringify(normalizeRichText(r));
  const p = { type: b.type };
  switch (b.type) {
    case "heading": p.level = b.level; p.text = rt(b.text); break;
    case "paragraph": case "callout": p.text = rt(b.text); p.tone = b.tone; break;
    case "quote": p.text = rt(b.text); p.attribution = b.attribution; break;
    case "list": p.ordered = b.ordered; p.items = flattenItems(b.items).map((i) => [i.depth, rt(i.text)]); break;
    case "code": p.code = b.code; p.language = b.language; break;
    case "math": p.latex = b.latex; break;
    case "image": Object.assign(p, { url: b.url, alt: b.alt, kind: b.kind, prompt: b.prompt, caption: rt(b.caption) }); break;
    case "diagram": Object.assign(p, { kind: b.diagramKind, items: b.items, range: b.range, caption: rt(b.caption) }); break;
    case "chart": Object.assign(p, { kind: b.chartType, title: b.title, axes: b.axes, caption: rt(b.caption) }); break;
    case "table": p.caption = rt(b.caption); break;
    case "metric": p.label = b.label; break;
    case "embed": p.title = b.title; break;
  }
  if (b.bindingId) p.data = staticData(udm, b.bindingId) ?? udm.bindings[b.bindingId]?.source;
  if (m.features.ids && m.structure.groups) p.group = b.group;
  if (m.features.ids && m.structure.roles) p.role = b.role;
  return stableStringify(p);
}

function projectSection(s, m) {
  return stableStringify({ title: s.title, ...(m.features.notes ? { notes: s.notes && plain(s.notes), summary: s.summary } : {}),
    ...(m.features.ids && m.structure.roles ? { role: s.role, level: s.level } : {}) });
}

/** First needle element not matched in order within hay, or null. */
function firstMissing(needle, hay) {
  let i = 0;
  for (const h of hay) if (i < needle.length && h === needle[i]) i++;
  return i === needle.length ? null : needle[i];
}

/**
 * @param {import('./adapter.ts').Adapter} adapter
 * @param {Record<string, import('./udm.ts').Udm>} fixtures
 * @returns {{adapter: string, results: {fixture: string, check: string, pass: boolean, detail?: string}[]}}
 */
export function runConformance(adapter, fixtures, opts) {
  const m = adapter.manifest;
  const results = [];
  const check = (fixture, name, pass, detail) => results.push({ fixture, check: name, pass: Boolean(pass), ...(pass ? {} : { detail }) });
  const mp = checkManifest(m);
  check("*", "C0 manifest valid", !mp.length, mp.join("; "));

  for (const [name, fx] of Object.entries(fixtures)) {
    const fxIssues = checkUdm(fx);
    check(name, "C1 fixture is a valid UDM", !fxIssues.length, JSON.stringify(fxIssues.slice(0, 3)));
    // Negotiation.
    const n = negotiate(fx, m);
    const nIssues = checkUdm(n.udm);
    const badTypes = n.udm.sections.flatMap((s) => s.blocks).filter((b) => !m.blocks.includes(b.type)).map((b) => b.type);
    check(name, "C2 negotiated UDM is valid and within manifest", !nIssues.length && !badTypes.length, JSON.stringify([...nIssues.slice(0, 3), ...badTypes]));
    const nText = norm([...udmAtoms(n.udm), ...n.loss.map((l) => l.droppedText ?? "")].join(" \u0001 "));
    const missingN = udmAtoms(fx).filter((a) => !nText.includes(norm(a)));
    check(name, "C3 negotiation completeness (no silent text loss)", !missingN.length, missingN.slice(0, 3).join(" | "));
    check(name, "C4 negotiation deterministic", stableStringify(negotiate(fx, m)) === stableStringify(n));
    // Serialize.
    const frozen = stableStringify(n.udm);
    let s1, s2;
    try { s1 = adapter.serialize(clone(n.udm), opts); s2 = adapter.serialize(clone(n.udm), opts); } catch (e) { check(name, "C5 serialize", false, e.stack); continue; }
    adapter.serialize(n.udm, opts);
    check(name, "C5 serialize deterministic and pure", stableStringify(s1) === stableStringify(s2) && stableStringify(n.udm) === frozen);
    const vIssues = adapter.validateNative(s1.native, opts).filter((i) => i.level === "error");
    check(name, "C6 native output valid", !vIssues.length, JSON.stringify(vIssues.slice(0, 3)));
    const allLoss = [...n.loss, ...s1.loss];
    check(name, "C7 loss report well-formed", allLoss.every((l) => typeof l.code === "string" && typeof l.path === "string"));
    if (!adapter.deserialize) continue;
    // Round trip.
    const r = adapter.deserialize(s1.native, opts);
    const rIssues = checkUdm(r.udm);
    check(name, "C8 deserialized UDM is valid and neutral", !rIssues.length, JSON.stringify(rIssues.slice(0, 3)));
    const rText = norm([...udmAtoms(r.udm), ...s1.loss.map((l) => l.droppedText ?? "")].join(" \u0001 "));
    const missingR = udmAtoms(n.udm).filter((a) => !rText.includes(norm(a)));
    check(name, "C9 round trip loses no text silently", !missingR.length, missingR.slice(0, 3).join(" | "));
    const lossy = new Set([...s1.loss, ...r.loss].map((l) => l.path));
    const problems = [];
    if (n.udm.title !== r.udm.title) problems.push(`title ${n.udm.title} != ${r.udm.title}`);
    n.udm.sections.forEach((s, i) => {
      const rs = m.features.ids ? r.udm.sections.find((x) => x.id === s.id) : r.udm.sections[i];
      if (!rs) { if (!lossy.has(s.id)) problems.push(`section ${s.id} missing`); return; }
      if (projectSection(s, m) !== projectSection(rs, m) && !lossy.has(s.id)) problems.push(`section ${s.id} header differs`);
      const want = s.blocks.filter((b) => !lossy.has(`${s.id}/${b.id}`));
      if (m.features.ids) {
        for (const b of want) {
          const rb = rs.blocks.find((x) => x.id === b.id);
          if (!rb) problems.push(`block ${b.id} id lost`);
          else if (project(b, n.udm, m) !== project(rb, r.udm, m)) problems.push(`block ${b.id} differs: ${project(b, n.udm, m)} vs ${project(rb, r.udm, m)}`);
        }
      } else {
        const hay = rs.blocks.map((b) => project(b, r.udm, m));
        const miss = m.structure.orderPreserved ? firstMissing(want.map((b) => project(b, n.udm, m)), hay)
          : want.map((b) => project(b, n.udm, m)).find((w) => { const i = hay.indexOf(w); if (i < 0) return true; hay.splice(i, 1); return false; }) ?? null;
        if (miss !== null) problems.push(`section ${s.id}: ${miss} not found in ${hay.join(" ; ").slice(0, 300)}`);
      }
    });
    check(name, `C10 round trip equals negotiated input modulo declared loss${m.features.ids ? " (ids preserved)" : ""}`, !problems.length, problems.slice(0, 3).join(" | "));
    // Ext pass-through and isolation.
    const extProblems = [];
    const objs = (u) => [["", u], ...u.sections.map((s) => [s.id, s]), ...u.sections.flatMap((s) => s.blocks.map((b) => [b.id, b]))];
    const rById = new Map(objs(r.udm));
    for (const [id, o] of objs(n.udm)) {
      for (const ns of Object.keys(o.ext ?? {})) {
        if (ns === m.id) continue;
        if (m.features.extPassThrough && !lossy.has(id) && stableStringify(rById.get(id)?.ext?.[ns]) !== stableStringify(o.ext[ns])) extProblems.push(`${id || "artifact"} lost ext ${ns}`);
      }
    }
    const inNs = new Set(objs(n.udm).flatMap(([, o]) => Object.keys(o.ext ?? {})));
    for (const [id, o] of objs(r.udm)) for (const ns of Object.keys(o.ext ?? {})) if (ns !== m.id && !inNs.has(ns)) extProblems.push(`${id} wrote foreign namespace ${ns}`);
    check(name, `C11 ext ${m.features.extPassThrough ? "pass-through and " : ""}isolation`, !extProblems.length, extProblems.slice(0, 3).join(" | "));
  }
  return { adapter: m.id, results };
}
