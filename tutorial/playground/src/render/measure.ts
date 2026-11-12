// Text measurement with the template's real fonts, for slide text auto-fit (bridge.autofitText).
// The font files are loaded into this page with the FontFace API (same origin as the playground, so no CORS), then a
// canvas measures each word in the same family, size and weight the slide renderer uses. If a font cannot load, the
// bridge keeps its character-width estimate.

import { setTextMeasurer, type TextMeasure } from "../udm/bridge";
import type { TemplateData } from "../data";

const loaded = new Map<string, Promise<boolean>>();
let ctx2d: CanvasRenderingContext2D | null = null;

/** Weight from a family or file name, the way the slide renderer declares its @font-face rules (Black -> 900). */
export function weightOf(name: string): number {
  const n = name.toLowerCase().replace(/[\s_-]+/g, "");
  if (/black|heavy/.test(n)) return 900;
  if (/extrabold|ultrabold/.test(n)) return 800;
  if (/semibold|demibold/.test(n)) return 600;
  if (/bold/.test(n)) return 700;
  if (/medium/.test(n)) return 500;
  if (/extralight|ultralight/.test(n)) return 200;
  if (/light/.test(n)) return 300;
  if (/thin|hairline/.test(n)) return 100;
  return 400;
}

function loadFamily(family: string, url: string): Promise<boolean> {
  const key = `${family}|${url}`;
  let p = loaded.get(key);
  if (!p) {
    p = (async () => {
      try {
        const file = decodeURIComponent(url.split("/").pop() ?? "");
        const weight = String(Math.max(weightOf(family), weightOf(file)));
        const face = new FontFace(family, `url("${url}")`, { weight });
        document.fonts.add(await face.load());
        // "Lato Bold" is also Lato at 700, as in the renderer's rules.
        const base = family.replace(/\s+(black|heavy|extra ?bold|semi ?bold|bold|medium|light|thin)$/i, "");
        if (base !== family) document.fonts.add(new FontFace(base, `url("${url}")`, { weight }));
        return true;
      } catch {
        return false;
      }
    })();
    loaded.set(key, p);
  }
  return p;
}

const measure: TextMeasure = (text, f) => {
  ctx2d ??= document.createElement("canvas").getContext("2d");
  if (!ctx2d) return NaN;
  ctx2d.font = `${f.italic ? "italic " : ""}${f.bold ? "700 " : ""}${f.size}px "${f.family.replace(/"/g, "")}", sans-serif`;
  return ctx2d.measureText(text).width;
};

/** Load the template's font files and switch auto-fit to canvas measurement (only when every file loaded). */
export async function prepareTextMeasure(t: Pick<TemplateData, "fonts">): Promise<boolean> {
  if (typeof document === "undefined" || typeof FontFace === "undefined" || !document.fonts) return false;
  // Font files only (the same test as the renderer's splitFonts; not imported, to keep the renderer chunk lazy).
  const entries = Object.entries((t.fonts ?? {}) as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === "string" && /^data:font\/|\.(?:otf|ttf|woff2?)(?:[?#].*)?$/i.test(e[1].trim()));
  const ok = entries.length > 0 && (await Promise.all(entries.map(([fam, url]) => loadFamily(fam, url)))).every(Boolean);
  setTextMeasurer(ok ? measure : null);
  return ok;
}
