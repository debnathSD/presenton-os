// Adapter registry. Adding a module = register one more adapter; nothing else in core changes.

import { negotiate } from "./negotiate.mjs";
import { BLOCK_TYPES, MARKS, CHART_KINDS, NAMESPACE_RE } from "./udm-runtime.mjs";

/** Returns a list of problems with a manifest (empty = valid). */
export function checkManifest(m) {
  const p = [];
  if (!NAMESPACE_RE.test(m?.id ?? "")) p.push(`id "${m?.id}" must match ${NAMESPACE_RE}`);
  for (const k of ["version", "displayName", "nativeFormat"]) if (typeof m?.[k] !== "string") p.push(`${k} required`);
  for (const b of m?.blocks ?? []) if (!BLOCK_TYPES.includes(b)) p.push(`unknown block type ${b}`);
  for (const x of m?.marks ?? []) if (!MARKS.includes(x)) p.push(`unknown mark ${x}`);
  for (const c of m?.chartKinds ?? []) if (!CHART_KINDS.includes(c)) p.push(`unknown chart kind ${c}`);
  if (!m?.blocks?.includes("paragraph")) p.push("every target must support paragraph (the last fallback)");
  if (!m?.structure || !m?.features) p.push("structure and features required");
  if (!["lossless", "lossy", "write-only"].includes(m?.roundTrip)) p.push("roundTrip invalid");
  return p;
}

/** @returns {import('./adapter.ts').Registry} */
export function createRegistry() {
  const adapters = new Map();
  const aliases = new Map();
  const get = (id) => {
    const a = adapters.get(aliases.get(id) ?? id);
    if (!a) throw new Error(`no adapter registered for "${id}"`);
    return a;
  };
  return {
    register(adapter, alias = []) {
      const problems = checkManifest(adapter.manifest);
      if (problems.length) throw new Error(`invalid manifest ${adapter.manifest?.id}: ${problems.join("; ")}`);
      if (typeof adapter.serialize !== "function" || typeof adapter.validateNative !== "function") throw new Error("serialize and validateNative required");
      if (adapter.manifest.roundTrip !== "write-only" && typeof adapter.deserialize !== "function") throw new Error("deserialize required");
      if (adapters.has(adapter.manifest.id)) throw new Error(`duplicate adapter ${adapter.manifest.id}`);
      adapters.set(adapter.manifest.id, adapter);
      for (const a of alias) aliases.set(a, adapter.manifest.id);
    },
    get,
    list: () => [...adapters.values()].map((a) => a.manifest),
    convert(udm, targetId, opts) {
      const adapter = get(targetId);
      const n = negotiate(udm, adapter.manifest);
      const s = adapter.serialize(n.udm, opts);
      return { native: s.native, loss: [...n.loss, ...s.loss], negotiated: n.udm };
    },
  };
}
