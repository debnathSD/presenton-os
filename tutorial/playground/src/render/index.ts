// Slide rendering with Presenton's real renderer (servers/nextjs/lib/template-v2-json-to-html.ts, bundled through
// the "@" alias). Server-only and root-relative pieces are replaced by the shims in ./shims (see ./aliases.mjs).
// Each slide is a 1280x720 document in a sandboxed iframe (srcdoc, allow-scripts only: no same-origin), scaled to
// the container width with a CSS transform. Charts run the vendored Chart.js + datalabels inside the iframe, exactly
// as Presenton's own HTML export does.
// Every srcdoc also carries a Content-Security-Policy <meta>: scripts, images and fonts only from the assets folder
// (plus Google Fonts stylesheets and font files, which the general and modern templates use, as the site itself
// does), no fetch/XHR, no nested frames, forms or <base>. A slide built from model output or pasted content cannot
// reach any other host.

import {
  templateV2UiToHtml,
  TEMPLATE_V2_HTML_WIDTH,
  TEMPLATE_V2_HTML_HEIGHT,
} from "@/lib/template-v2-json-to-html";
import { setChartVendorBase } from "@/lib/chart-browser";
import { assetsRoot } from "../data";
import type { TemplateData } from "../data";
import type { DeckSlide } from "../udm/bridge";

export const SLIDE_WIDTH: number = TEMPLATE_V2_HTML_WIDTH;
export const SLIDE_HEIGHT: number = TEMPLATE_V2_HTML_HEIGHT;

export type RenderOptions = {
  /** Mark the slide as changed by the last "Apply to slides" (class udm-slide--changed + outline). */
  highlight?: boolean;
  /** Thumbnail mode: lazy iframe, not focusable, no pointer events. renderThumb sets it. */
  thumb?: boolean;
  /** Accessible name for the iframe; defaults to the slide title. */
  label?: string;
  /** Width to scale to when the container has no layout width yet (e.g. hidden). Default: 1280 (or 240 for thumbs). */
  fallbackWidth?: number;
  /** Resolve the returned promise after this many ms even if the iframe never fires "load". Default 4000. */
  timeoutMs?: number;
};

const FONT_FILE = /^data:font\/|\.(?:eot|otf|ttf|woff2?)(?:[?#].*)?$/i;
const CSS_URL = /^https?:\/\//i;

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Split a template's font map: font files go to Presenton's renderer (it writes @font-face rules for them),
 * stylesheet URLs (Google Fonts css2 links) become <link> tags, which the renderer does not emit itself.
 */
export function splitFonts(fonts: Record<string, string> | undefined): { files: Record<string, string>; stylesheets: string[] } {
  const files: Record<string, string> = {};
  const stylesheets: string[] = [];
  for (const [family, src] of Object.entries(fonts ?? {})) {
    if (typeof src !== "string") continue;
    const s = src.trim();
    if (FONT_FILE.test(s)) files[family] = s;
    else if (CSS_URL.test(s) && !stylesheets.includes(s)) stylesheets.push(s);
  }
  return { files, stylesheets };
}

/** Presenton's font catalog points at /vendor/fonts/... on its own server; those files are not on this site. */
function dropCatalogFontFaces(html: string): string {
  return html.replace(/@font-face\{[^{}]*url\("\/vendor\/fonts\/[^{}]*\}/g, "");
}

/** The srcdoc's CSP for an assets root (empty when the root is not http(s), e.g. a file: URL in a local check). */
export function slideCsp(root: string = assetsRoot()): string {
  let src = "";
  try {
    const u = new URL(root);
    // The assets folder itself (a path prefix, so other sites on the same host are not allowed); the origin alone
    // if the path holds characters a CSP source cannot.
    if (u.protocol === "https:" || u.protocol === "http:") src = /^[\w\-.~/%]*\/$/.test(u.pathname) ? u.origin + u.pathname : u.origin;
  } catch { /* not a URL */ }
  if (!src) return "";
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${src}`,
    `style-src 'unsafe-inline' ${src} https://fonts.googleapis.com`,
    `img-src ${src} data: blob:`,
    `font-src ${src} data: https://fonts.gstatic.com`,
    "connect-src 'none'", "media-src 'none'", "object-src 'none'", "frame-src 'none'", "worker-src 'none'",
    "base-uri 'none'", "form-action 'none'",
  ].join("; ");
}

const cspMeta = (root: string) => {
  const csp = slideCsp(root);
  return csp ? `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">` : "";
};

/** Put `extra` right after <head> (and its <meta charset>, which must stay first). */
function intoHead(html: string, extra: string): string {
  if (!extra) return html;
  let done = false;
  const out = html.replace(/<head>(<meta charset="utf-8">)?/i, (m) => { done = true; return m + extra; });
  return done ? out : html.replace(/^(<!doctype html>)?/i, (m) => `${m}<head><meta charset="utf-8">${extra}</head>`);
}

function emptySlideHtml(background: string, message = "", root: string = assetsRoot()): string {
  const bg = /^#[0-9a-f]{3,8}$/i.test(background) ? background : "#FFFFFF";
  const text = message.length > 300 ? `${message.slice(0, 300)}…` : message;
  return `<!doctype html><html><head><meta charset="utf-8">${cspMeta(root)}<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${bg}}body{display:flex;align-items:center;justify-content:center;padding:40px;box-sizing:border-box;text-align:center;font:28px Arial,Helvetica,sans-serif;color:#667085}</style></head><body>${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</body></html>`;
}

/**
 * The complete srcdoc for one slide: Presenton's templateV2UiToHtml output plus the template's font stylesheets.
 * Pure apart from reading the assets root (for image and Chart.js URLs). Never throws: a renderer error yields a
 * plain slide with the message.
 */
export function slideHtml(slide: Pick<DeckSlide, "ui">, t: Pick<TemplateData, "fonts">, root: string = assetsRoot()): string {
  setChartVendorBase(new URL("vendor/", root).href);
  const { files, stylesheets } = splitFonts(t.fonts);
  let html: string | null;
  try {
    html = templateV2UiToHtml(slide.ui, { fonts: files });
  } catch (e: any) {
    return emptySlideHtml("#FFFFFF", `Could not render this slide: ${e?.message ?? e}`, root);
  }
  if (!html) return emptySlideHtml(String((slide.ui as any)?.background ?? "#FFFFFF"), "", root);
  html = dropCatalogFontFaces(html);
  const links = stylesheets.map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`).join("");
  // Presenton's document starts with <head><meta charset="utf-8">; the CSP and the links go right after it.
  return intoHead(html, cspMeta(root) + links);
}

type Frame = {
  wrapper: HTMLElement; iframe: HTMLIFrameElement; html: string; fallbackWidth: number;
  ro?: ResizeObserver; observing?: boolean;
};
const frames = new WeakMap<HTMLElement, Frame>();

function observe(f: Frame): void {
  if (!f.ro || f.observing) return;
  f.ro.observe(f.wrapper);
  f.observing = true;
}

function unobserve(f: Frame): void {
  if (!f.ro || !f.observing) return;
  f.ro.disconnect();
  f.observing = false;
}

/**
 * Drop a container's slide: stop its ResizeObserver and unload the iframe document. Call it before discarding a
 * container (renderSlide also stops observing by itself once the slide is detached from the page).
 */
export function releaseSlide(container: HTMLElement): void {
  const f = frames.get(container);
  if (!f) return;
  unobserve(f);
  f.iframe.removeAttribute("srcdoc");
  f.iframe.remove();
  f.wrapper.remove();
  frames.delete(container);
}

function fitScale(f: Frame): void {
  const w = f.wrapper.getBoundingClientRect?.().width || f.wrapper.clientWidth || f.fallbackWidth;
  f.iframe.style.transform = `scale(${w / SLIDE_WIDTH})`;
}

/**
 * Render a slide into `container` (its content is replaced the first time; later calls reuse the iframe and only
 * swap srcdoc when the HTML changed). Resolves when the iframe has loaded, or after `timeoutMs`.
 */
export function renderSlide(container: HTMLElement, slide: DeckSlide, t: TemplateData, opts: RenderOptions = {}): Promise<void> {
  const doc = container.ownerDocument;
  const html = slideHtml(slide, t);
  const thumb = !!opts.thumb;
  const fallbackWidth = opts.fallbackWidth ?? (thumb ? 240 : SLIDE_WIDTH);

  let f = frames.get(container);
  if (f && f.wrapper.parentNode !== container) {
    // The container's content was replaced elsewhere: drop the old frame (and its observer) and start over.
    unobserve(f);
    frames.delete(container);
    f = undefined;
  }
  if (!f) {
    const wrapper = doc.createElement("div");
    wrapper.className = "udm-slide";
    wrapper.style.cssText = `position:relative;width:100%;aspect-ratio:${SLIDE_WIDTH} / ${SLIDE_HEIGHT};overflow:hidden;background:#fff;`;
    const iframe = doc.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("scrolling", "no");
    iframe.style.cssText = `position:absolute;left:0;top:0;width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px;max-width:none;max-height:none;border:0;transform-origin:0 0;`;
    // max-width:none: host pages often cap iframes at 100% of their container (MkDocs Material does), which would
    // crop the 1280px slide before the scale transform shrinks it.
    wrapper.appendChild(iframe);
    container.replaceChildren(wrapper);
    f = { wrapper, iframe, html: "", fallbackWidth };
    frames.set(container, f);
    const RO = (doc.defaultView as any)?.ResizeObserver as typeof ResizeObserver | undefined;
    if (RO) {
      const frame = f;
      // A detached slide (thumbnail strip re-rendered, mode switched) stops observing; renderSlide re-observes it.
      frame.ro = new RO(() => (frame.wrapper.isConnected ? fitScale(frame) : unobserve(frame)));
    }
  }
  observe(f);

  const { wrapper, iframe } = f;
  wrapper.classList.toggle("udm-slide--thumb", thumb);
  wrapper.classList.toggle("udm-slide--changed", !!opts.highlight);
  wrapper.toggleAttribute("data-changed", !!opts.highlight);
  wrapper.style.outline = opts.highlight ? "3px solid var(--site-accent, #4f46e5)" : "";
  wrapper.style.outlineOffset = opts.highlight ? "2px" : "";
  iframe.title = opts.label ?? (slide.title ? `Slide: ${slide.title}` : "Slide preview");
  iframe.dataset.slideId = slide.id;
  if (thumb) {
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("tabindex", "-1");
    iframe.style.pointerEvents = "none";
  } else {
    iframe.removeAttribute("loading");
    iframe.removeAttribute("tabindex");
    iframe.style.pointerEvents = "";
  }
  f.fallbackWidth = fallbackWidth;
  fitScale(f);

  if (f.html === html) return Promise.resolve();
  f.html = html;
  return new Promise<void>((resolve) => {
    const view = doc.defaultView ?? globalThis;
    let timer: any;
    const done = () => {
      iframe.removeEventListener("load", done);
      view.clearTimeout(timer);
      resolve();
    };
    iframe.addEventListener("load", done);
    timer = view.setTimeout(done, opts.timeoutMs ?? 4000);
    iframe.srcdoc = html;
  });
}

/** Small thumbnail: the same renderer and iframe, scaled to the (narrow) container, not focusable, lazy. */
export function renderThumb(container: HTMLElement, slide: DeckSlide, t: TemplateData, opts: RenderOptions = {}): Promise<void> {
  return renderSlide(container, slide, t, { ...opts, thumb: true });
}
