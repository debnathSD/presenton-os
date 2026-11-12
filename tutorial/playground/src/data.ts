// Sample data: the curated decks written by scripts/build-data.mjs into <site>/assets/playground/data/.
// Asset URLs in the data are stored as "images/<template>/<file>" relative to the playground assets root and are
// resolved to absolute URLs here, so slides render the same inside sandboxed srcdoc iframes and in exports.

import { presentonToUdm } from "../../prototypes/udm/adapters/presenton/from-presenton.mjs";
import type { Deck, DeckSlide } from "./udm/bridge";

export type TemplateSummary = { id: string; name: string; description: string; thumbnail: string; layoutCount: number };
export type TemplateLayout = { id: string; description: string; ui: any };
export type TemplateData = {
  id: string; name: string; description?: string; thumbnail?: string; iconType?: string;
  fonts: Record<string, string>; theme: any; layouts: TemplateLayout[];
};

let root: string | undefined;

/**
 * The assets root for a bundle file URL: the folder that holds app/. This module can land in app/main.js or in a
 * shared chunk (app/chunks/<name>.js), so "../" relative to the file is not enough.
 */
export function rootFromBundleUrl(fileUrl: string): string {
  const u = new URL(fileUrl);
  u.search = "";
  u.hash = "";
  const i = u.pathname.lastIndexOf("/app/");
  u.pathname = i >= 0 ? u.pathname.slice(0, i + 1) : u.pathname.replace(/[^/]*$/, "").replace(/[^/]+\/$/, "");
  return u.href;
}

/**
 * The playground assets root, ending in "/". Order: setAssetsRoot(), the mount element's data-assets (or
 * data-assets-root), then the bundle's own location (<root>/app/main.js or <root>/app/chunks/<chunk>.js).
 */
export function assetsRoot(): string {
  if (root) return root;
  const el = typeof document !== "undefined" ? document.getElementById("udm-playground") : null;
  const fromPage = el?.getAttribute("data-assets") ?? el?.getAttribute("data-assets-root");
  if (fromPage) return (root = new URL(fromPage.endsWith("/") ? fromPage : `${fromPage}/`, document.baseURI).href);
  return (root = rootFromBundleUrl(import.meta.url));
}

export function setAssetsRoot(url: string): void {
  root = url.endsWith("/") ? url : `${url}/`;
}

/** "images/general/x.png" -> absolute URL under the assets root. Absolute URLs pass through. */
export function resolveAsset(rel: string, base: string = assetsRoot()): string {
  return new URL(rel, base).href;
}

const LOCAL_ASSET = /^images\/[a-z0-9-]+\/[^\s"]+$/i;

function mapStrings(v: any, fn: (s: string) => string): any {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}

/** Same-origin JSON fetch with readable errors (network failure, HTTP status, not JSON). */
async function getJSON(url: string): Promise<any> {
  const file = url.replace(/^.*\/(?=[^/]+\/[^/]+$)/, "");
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin" });
  } catch (e: any) {
    throw new Error(`Could not load ${file} (network error: ${e?.message ?? e})`);
  }
  if (!res.ok) throw new Error(`Could not load ${file} (HTTP ${res.status})`);
  try {
    return await res.json();
  } catch {
    throw new Error(`Could not load ${file} (the file is not valid JSON)`);
  }
}

const isRecord = (v: any) => !!v && typeof v === "object" && !Array.isArray(v);

export async function loadIndex(base?: string): Promise<TemplateSummary[]> {
  const b = base ?? assetsRoot();
  const list = await getJSON(new URL("data/index.json", b).href);
  if (!Array.isArray(list)) throw new Error("data/index.json is not a list of templates");
  return list
    .filter((t: any) => isRecord(t) && typeof t.id === "string" && /^[a-z0-9-]+$/i.test(t.id))
    .map((t: any) => ({
      id: t.id, name: String(t.name ?? t.id), description: String(t.description ?? ""),
      layoutCount: Number(t.layoutCount) || 0,
      thumbnail: typeof t.thumbnail === "string" && LOCAL_ASSET.test(t.thumbnail) ? resolveAsset(t.thumbnail, b) : "",
    }));
}

const cache = new Map<string, Promise<TemplateData>>();

export function loadTemplate(id: string, base?: string): Promise<TemplateData> {
  const b = base ?? assetsRoot();
  const key = `${b}|${id}`;
  if (!cache.has(key)) {
    const p = getJSON(new URL(`data/${encodeURIComponent(id)}.json`, b).href).then((raw) => hydrateTemplate(raw, b));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key)!;
}

/** Raw data file (as written by build-data.mjs) -> TemplateData with absolute asset URLs. Pure. */
export function hydrateTemplate(raw: any, base: string = assetsRoot()): TemplateData {
  if (!isRecord(raw) || typeof raw.id !== "string" || !Array.isArray(raw.layouts)) {
    throw new Error("The template data file is malformed (expected an id and a layouts list)");
  }
  const bad = raw.layouts.findIndex((l: any) => !isRecord(l) || typeof l.id !== "string");
  if (bad >= 0) throw new Error(`Template ${raw.id}: layout ${bad + 1} is malformed (no id)`);
  const abs = (s: string) => (LOCAL_ASSET.test(s) ? resolveAsset(s, base) : s);
  return {
    id: raw.id, name: raw.name, description: raw.description,
    thumbnail: raw.thumbnail ? abs(raw.thumbnail) : undefined,
    ...(raw.icon_type ? { iconType: raw.icon_type } : {}),
    fonts: mapStrings(raw.fonts ?? {}, abs), theme: mapStrings(raw.theme ?? {}, abs),
    // ui is the whole Template v2 layout (with its id), exactly what Presenton stores in slides.ui
    layouts: (raw.layouts ?? []).map((l: any) => ({ id: l.id, description: l.description ?? "", ui: mapStrings(l, abs) })),
  };
}

const humanize = (id: string) => id.replace(/_\d+$/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The slide's own title text (the prototype's section title rule), else the layout id humanized. */
export function slideTitle(ui: any, layoutId: string, templateId = ""): string {
  try {
    const { udm } = presentonToUdm({ slides: [{ layout: layoutId, layout_group: templateId, ui }] });
    const t = udm.sections[0]?.title?.replace(/\s+/g, " ").trim();
    if (t) return t;
  } catch { /* fall through */ }
  return humanize(layoutId);
}

/** One slide per curated layout, in the curated order, with the layout's own sample content. */
export function sampleDeck(t: TemplateData): Deck {
  const slides: DeckSlide[] = t.layouts.map((l, i) => ({
    id: `${t.id}-${i + 1}`, templateId: t.id, layoutId: l.id, title: slideTitle(l.ui, l.id, t.id), ui: structuredClone(l.ui),
  }));
  return { templateId: t.id, templateName: t.name, slides };
}
