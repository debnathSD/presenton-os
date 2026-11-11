/* Spotlight search engine (Web Worker).
 *
 * Loads the section index written at build time by hooks/spotlight_index.py and the
 * curated quick answers, builds an in-memory inverted index, and answers queries with
 * BM25 ranking plus prefix, fuzzy and synonym matching. No third-party code.
 */
"use strict";

const STOP = new Set(("a an and are as at be but by can do does for from how i if in into is it its " +
  "me my of on or our should so that the their then there these this to use used using was we what " +
  "when where which who why will with work works you your about explain tell show please there's " +
  "does it get got want need find like kind sort way ways actually basically").split(" "));

const SYNONYMS = {
  pptx: ["powerpoint", "ppt"], powerpoint: ["pptx"], ppt: ["pptx"],
  deck: ["presentation", "slide"], presentation: ["deck"], slide: ["deck"],
  auth: ["authentication", "login"], authentication: ["auth"], login: ["auth", "session"],
  db: ["database", "postgres"], database: ["db", "postgres", "table"], postgres: ["database"],
  k8s: ["kubernetes"], kubernetes: ["k8s", "helm"], helm: ["kubernetes"],
  llm: ["model", "provider"], model: ["llm"], ai: ["llm", "model"],
  sse: ["stream", "event"], stream: ["sse"], realtime: ["stream", "live"],
  rls: ["row", "security"], permission: ["rbac", "access"], rbac: ["permission"],
  api: ["endpoint"], endpoint: ["api", "route"], route: ["endpoint"],
  gck: ["generative", "kit"], kit: ["gck"],
  chart: ["graph", "viz"], graph: ["chart"], viz: ["chart", "visualization"],
  dynamic: ["live", "refresh"], live: ["refresh", "dynamic"], refresh: ["live"],
  template: ["layout"], layout: ["template"],
  context: ["prompt", "outline"], prompt: ["context"],
  export: ["pptx", "pdf"], pdf: ["export"], download: ["export"],
  deploy: ["deployment", "docker"], deployment: ["deploy"], docker: ["container"],
  editor: ["tiptap"], superset: ["dashboard"],
  wise: ["per", "each"], per: ["each"], each: ["per"],
  key: ["token"], token: ["key"], timeline: ["release", "plan"], release: ["plan", "schedule"],
  tracker: ["plan", "release"], effort: ["estimate"], estimate: ["effort"],
};

const FIELD_W = { t: 5, k: 3, p: 1.6, b: 0.6, x: 1 };
const K1 = 1.2, B = 0.6;

let docs = [], answers = [];
let secIdx = null, ansIdx = null;

function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

function rawTokens(str) {
  return (str || "").toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
}

function tokens(str, keepStop) {
  const out = [];
  for (const tok of rawTokens(str)) {
    const parts = tok.includes("_") ? [tok, ...tok.split("_")] : [tok];
    for (const p of parts) {
      if (!p || (!keepStop && STOP.has(p))) continue;
      if (p.length < 2 && !/\d/.test(p)) continue;
      out.push(stem(p));
    }
  }
  return out;
}

function splitCamel(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[./:-]/g, " ");
}

function buildIndex(items, fieldsOf) {
  const postings = new Map(); // term -> Map(docId -> weightedTf)
  const lens = new Float32Array(items.length);
  let total = 0;
  items.forEach((item, d) => {
    const fields = fieldsOf(item);
    let len = 0;
    for (const [field, text] of Object.entries(fields)) {
      const w = FIELD_W[field] || 1;
      const toks = tokens(text, false);
      if (field === "x") len += toks.length;
      for (const t of toks) {
        let m = postings.get(t);
        if (!m) postings.set(t, (m = new Map()));
        m.set(d, (m.get(d) || 0) + w);
      }
    }
    lens[d] = Math.max(len, 8);
    total += lens[d];
  });
  const vocab = Array.from(postings.keys()).sort();
  const byFirst = new Map();
  for (const t of vocab) {
    const c = t[0];
    if (!byFirst.has(c)) byFirst.set(c, []);
    byFirst.get(c).push(t);
  }
  return { postings, lens, avg: total / Math.max(items.length, 1), n: items.length, vocab, byFirst };
}

function lowerBound(arr, s) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < s) lo = mid + 1; else hi = mid; }
  return lo;
}

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array(b.length + 1), cur = new Array(b.length + 1), prev2 = null;
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev.slice(); [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/* For one query token, return candidate index terms with a weight in (0, 1]. */
function expand(idx, qt, isLast) {
  const cands = new Map();
  const add = (t, w) => { if (idx.postings.has(t) && (cands.get(t) || 0) < w) cands.set(t, w); };
  add(qt, 1);
  const exact = idx.postings.has(qt);
  for (const s of SYNONYMS[qt] || []) add(stem(s), 0.55);
  if (qt.length >= 3) {
    let i = lowerBound(idx.vocab, qt), n = 0;
    while (i < idx.vocab.length && idx.vocab[i].startsWith(qt) && n < 40) {
      if (idx.vocab[i] !== qt) add(idx.vocab[i], exact ? (isLast ? 0.35 : 0.25) : (isLast ? 0.8 : 0.55));
      i++; n++;
    }
  }
  if (qt.length >= 4 && cands.size < 3) {
    const max = qt.length >= 8 ? 2 : 1;
    for (const t of idx.byFirst.get(qt[0]) || []) {
      if (Math.abs(t.length - qt.length) > max) continue;
      if (editDistance(qt, t, max) <= max) add(t, 0.5);
    }
  }
  return cands;
}

const MAX_Q = 200, MAX_TOKENS = 12; // bounds CPU for pasted paragraphs

function search(idx, items, q, limit) {
  const qTokens = Array.from(new Set(tokens(q, false))).slice(0, MAX_TOKENS);
  const qAll = qTokens.length ? qTokens : Array.from(new Set(tokens(q, true))).slice(0, MAX_TOKENS);
  if (!qAll.length) return { hits: [], terms: [] };
  const scores = new Map(), covered = new Map();
  const matchedTerms = new Set();
  qAll.forEach((qt, qi) => {
    const cands = expand(idx, qt, qi === qAll.length - 1);
    const best = new Map();
    for (const [term, w] of cands) {
      const post = idx.postings.get(term);
      const df = post.size;
      const idf = Math.log(1 + (idx.n - df + 0.5) / (df + 0.5));
      matchedTerms.add(term);
      for (const [d, tf] of post) {
        const s = w * idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * idx.lens[d] / idx.avg));
        if (s > (best.get(d) || 0)) best.set(d, s);
      }
    }
    for (const [d, s] of best) {
      scores.set(d, (scores.get(d) || 0) + s);
      covered.set(d, (covered.get(d) || 0) + 1);
    }
  });
  const phrase = q.toLowerCase().replace(/[^a-z0-9_ ]+/g, " ").replace(/\s+/g, " ").trim();
  const ranked = [];
  for (const [d, s] of scores) {
    const cov = covered.get(d) / qAll.length;
    let score = s * (0.3 + 0.7 * cov * cov);
    const item = items[d];
    const title = (item.t || item.q || "").toLowerCase();
    if (qAll.every((t) => title.includes(t))) score *= 1.35;
    if (phrase.split(" ").length >= 2 && ((item.x || item.a || "").toLowerCase().includes(phrase) || title.includes(phrase))) score *= 1.4;
    ranked.push({ d, score, cov });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { hits: ranked.slice(0, limit), terms: Array.from(matchedTerms) };
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function highlighter(terms) {
  const roots = terms.filter((t) => t.length >= 2).sort((a, b) => b.length - a.length).slice(0, 30)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!roots.length) return null;
  return new RegExp("\\b(" + roots.join("|") + ")[a-z0-9_]*", "gi");
}

/* Highlight on the raw text and escape each piece, so a term like "amp", "lt" or "39"
 * can never land inside an entity ("&amp;", "&#39;") and corrupt the output. */
function highlight(text, re) {
  text = String(text == null ? "" : text);
  if (!re) return esc(text);
  re.lastIndex = 0;
  let out = "", last = 0, m;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += esc(text.slice(last, m.index)) + "<mark>" + esc(m[0]) + "</mark>";
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

function snippet(text, re, size) {
  if (!text) return "";
  let start = 0;
  if (re) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) start = Math.max(0, m.index - 60);
  }
  if (start > 0) { const sp = text.indexOf(" ", start); if (sp > 0 && sp - start < 20) start = sp + 1; }
  let out = text.slice(start, start + size);
  if (start + size < text.length) { const sp = out.lastIndexOf(" "); if (sp > size * 0.6) out = out.slice(0, sp); }
  return (start > 0 ? "… " : "") + highlight(out, re) + (start + size < text.length ? " …" : "");
}

function mark(s, re) {
  return highlight(s || "", re);
}

function runQuery(q) {
  q = String(q || "").slice(0, MAX_Q);
  const sec = search(secIdx, docs, q, 120);
  const ans = ansIdx ? search(ansIdx, answers, q, 6) : { hits: [], terms: [] };
  const re = highlighter(Array.from(new Set([...sec.terms, ...ans.terms, ...tokens(q, false)])));
  const top = sec.hits.length ? sec.hits[0].score : 0;
  const topAns = ans.hits.length ? ans.hits[0].score : 0;
  const answerHits = ans.hits.filter((h) => h.cov >= 0.6 && h.score >= 1.2 && h.score >= topAns * 0.45).slice(0, 3).map((h) => {
    const a = answers[h.d];
    return { id: a.id, q: mark(a.q, re), a: mark(a.a, re), links: a.links };
  });
  // Diversify: at most 3 sections per page in the first 30 results.
  const perPage = new Map(), first = [], rest = [];
  for (const h of sec.hits) {
    const doc = docs[h.d];
    const n = perPage.get(doc.p) || 0;
    if (n < 3) { first.push(h); perPage.set(doc.p, n + 1); } else rest.push(h);
  }
  const ordered = first.concat(rest).slice(0, 40);
  const sections = ordered.filter((h) => h.score >= top * 0.12).map((h) => {
    const doc = docs[h.d];
    return {
      u: doc.u, l: doc.l,
      t: mark(doc.t, re),
      crumb: esc(doc.b ? doc.b + " › " + doc.p : doc.p),
      s: snippet(doc.x || (doc.k || []).join(" "), re, 190),
      page: doc.l === 1,
    };
  });
  return { answers: answerHits, sections };
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    try {
      const [ix, an] = await Promise.all([
        fetch(msg.indexUrl).then((r) => { if (!r.ok) throw new Error("index " + r.status); return r.json(); }),
        fetch(msg.answersUrl).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      ]);
      docs = ix && Array.isArray(ix.docs) ? ix.docs : [];
      answers = Array.isArray(an) ? an.filter((a) => a && typeof a.q === "string") : [];
      secIdx = buildIndex(docs, (d) => ({ t: d.t, k: (d.k || []).map(splitCamel).join(" ") + " " + (d.k || []).join(" "), p: d.p, b: d.b, x: d.x }));
      ansIdx = answers.length ? buildIndex(answers, (a) => ({ t: a.q, k: (a.aliases || []).join(" "), x: a.a, p: (a.links || []).map((l) => l.title).join(" ") })) : null;
      self.postMessage({ type: "ready", sections: docs.length, answers: answers.length,
        suggestions: answers.slice(0, 40).map((a) => a.q) });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err && err.message || err) });
    }
  } else if (msg.type === "query") {
    if (!secIdx) return;
    let res;
    try { res = runQuery(msg.q); } catch (err) { res = { answers: [], sections: [] }; }
    self.postMessage({ type: "results", id: msg.id, q: msg.q, ...res });
  }
};
