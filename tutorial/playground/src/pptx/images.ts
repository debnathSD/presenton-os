// Image loading for the PPTX exporter: fetch the playground's own images, embed them as base64 data URLs, read
// their natural size from the file header (needed for cover/contain crops), recolor icons the way the renderer
// does (SVG: Presenton's transformSvgMarkup; PNG: a canvas "source-in" fill, browser only).

import { transformSvgMarkup } from "@/lib/svg-color";

export type LoadedAsset = { bytes: Uint8Array; type: string };
export type AssetLoader = (url: string) => Promise<LoadedAsset>;

export type EmbeddedImage = {
  /** pptxgenjs `data` value: "image/png;base64,..." */
  data: string;
  type: string;
  /** Natural size in px, when the header could be read. */
  width: number | null;
  height: number | null;
  /** The icon color could not be applied (raster icon without a canvas, e.g. in Node). */
  notRecolored?: boolean;
};

export const fetchLoader: AssetLoader = async (url) => {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, type: (res.headers.get("content-type") ?? "").split(";")[0].trim() };
};

/**
 * A loader that only fetches from `base`'s origin (the playground's own assets) and blob: URLs. Anything else, such
 * as an image pasted into the editor from another site, is refused, so the export never contacts a third party
 * (the image becomes a placeholder box with an "image_unavailable" warning).
 */
export function sameOriginLoader(base: string, load: AssetLoader = fetchLoader): AssetLoader {
  let origin = "";
  try { origin = new URL(base).origin; } catch { /* no usable origin: refuse all */ }
  return async (url) => {
    let u: URL;
    try { u = new URL(url); } catch { throw new Error("not a valid URL"); }
    if (u.protocol !== "blob:" && (!origin || origin === "null" || u.origin !== origin)) {
      throw new Error(`${u.protocol === "data:" ? "data URL" : u.host || u.protocol} is not the playground's own origin`);
    }
    return load(url);
  };
}

const EXT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
};

/** The real media type from magic bytes (servers sometimes send octet-stream), else the URL extension. */
export function sniffType(bytes: Uint8Array, url: string, declared = ""): string {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  if (/^image\//.test(declared)) return declared;
  const ext = url.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  return EXT_TYPES[ext] ?? "image/png";
}

/** Natural size from PNG / JPEG / GIF / WebP headers or SVG width/height/viewBox. */
export function imageSize(bytes: Uint8Array, type: string): { width: number; height: number } | null {
  const b = bytes;
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u32be = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  try {
    if (type === "image/png" && b.length >= 24) return { width: u32be(16), height: u32be(20) };
    if (type === "image/gif" && b.length >= 10) return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = u16be(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: u16be(i + 7), height: u16be(i + 5) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (type === "image/webp" && b.length >= 30) {
      const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (chunk === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      if (chunk === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
      if (chunk === "VP8L") {
        const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    if (type === "image/svg+xml") return svgSize(new TextDecoder().decode(b));
  } catch { /* unreadable header */ }
  return null;
}

function svgSize(svg: string): { width: number; height: number } | null {
  const tag = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) return null;
  const attr = (n: string) => tag.match(new RegExp(`\\s${n}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  const px = (v?: string) => (v && /^\s*[\d.]+\s*(px)?\s*$/i.test(v) ? parseFloat(v) : null);
  const w = px(attr("width")), h = px(attr("height"));
  if (w && h) return { width: w, height: h };
  const vb = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3] };
  return null;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}

const dataUrl = (bytes: Uint8Array, type: string) => `${type};base64,${base64(bytes)}`;

/** Fill the opaque pixels of a raster icon with one color (the renderer's CSS mask). Browser only; null elsewhere. */
async function recolorRaster(bytes: Uint8Array, type: string, color: string): Promise<string | null> {
  const g = globalThis as any;
  if (typeof g.createImageBitmap !== "function" || typeof g.Blob !== "function") return null;
  try {
    const bmp = await g.createImageBitmap(new g.Blob([bytes], { type }));
    let canvas: any;
    if (typeof g.OffscreenCanvas === "function") canvas = new g.OffscreenCanvas(bmp.width, bmp.height);
    else if (g.document?.createElement) { canvas = g.document.createElement("canvas"); canvas.width = bmp.width; canvas.height = bmp.height; }
    else return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, bmp.width, bmp.height);
    if (canvas.convertToBlob) {
      const blob = await canvas.convertToBlob({ type: "image/png" });
      return dataUrl(new Uint8Array(await blob.arrayBuffer()), "image/png");
    }
    return String(canvas.toDataURL("image/png")).replace(/^data:/, "");
  } catch {
    return null;
  }
}

/** Load, recolor (icons) and embed one image. Results are cached per URL + color for one export. */
export class ImageCache {
  private cache = new Map<string, Promise<EmbeddedImage>>();
  constructor(private load: AssetLoader) {}

  get(url: string, iconColor?: string | null): Promise<EmbeddedImage> {
    const key = `${url}|${iconColor ?? ""}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.embed(url, iconColor ?? null);
      this.cache.set(key, p);
    }
    return p;
  }

  private async embed(url: string, color: string | null): Promise<EmbeddedImage> {
    let bytes: Uint8Array, type: string;
    if (/^data:/i.test(url)) {
      const m = url.match(/^data:([^;,]+)(;base64)?,(.*)$/is);
      if (!m) throw new Error("unreadable data URL");
      bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
      type = sniffType(bytes, "", m[1]);
    } else {
      const a = await this.load(url);
      bytes = a.bytes;
      type = sniffType(bytes, url, a.type);
    }
    const size = imageSize(bytes, type);
    if (color && type === "image/svg+xml") {
      const svg = transformSvgMarkup(new TextDecoder().decode(bytes), { color });
      bytes = new TextEncoder().encode(svg);
    } else if (color) {
      const recolored = await recolorRaster(bytes, type, color);
      if (recolored) return { data: recolored, type: "image/png", width: size?.width ?? null, height: size?.height ?? null };
      return { data: dataUrl(bytes, type), type, width: size?.width ?? null, height: size?.height ?? null, notRecolored: true };
    }
    return { data: dataUrl(bytes, type), type, width: size?.width ?? null, height: size?.height ?? null };
  }
}
