// Curated sample decks for the playground.
// Copies ~8 layouts per template from ../../templates/<id>/template.json, copies (and shrinks with macOS `sips`)
// only the images and font files those layouts reference, and rewrites their URLs to "images/<id>/<file>",
// which the app resolves against the playground assets root (<site>/assets/playground/).
//
// Output: ../content/assets/playground/data/{index.json,<id>.json} and ../content/assets/playground/images/<id>/

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.resolve(HERE, "../..");
const TEMPLATES = path.join(REPO, "templates");
const FASTAPI_STATIC = path.join(REPO, "servers/fastapi/static"); // "/static/..." URLs (placeholder image and icon)
const OUT = path.join(HERE, "../content/assets/playground");
const MAX_W = 1280;
const JPEG_QUALITY = 75;

/** Curated order per deck: title, text, bullets/list, cards, chart, table, image. */
export const DECKS = [
  { id: "general", layouts: [
    "title_intro",                      // title + subtitle + image
    "title_description_bullet_points",  // text + bullet cards
    "title_description_chart_cards",    // chart + metric cards
    "title_table_description",          // table + text
    "title_metrics_description",        // metric cards
    "title_image_bullet_points_1",      // image + icon cards
    "title_description_image",          // text + image
    "title_quote_image",                // quote + image
  ] },
  { id: "momentum", layouts: [
    "title_with_accent_footer_6891",      // title
    "title_text_image_columns_5015",      // text + image
    "title_over_cards_layout_8558",       // cards
    "title_process_cards_9539",           // process steps (bullets)
    "title_chart_callout_footer_4748",    // chart + callout
    "title_text_chart_panel_cards_5852",  // chart + cards
    "title_table_with_accents_1720",      // table
    "title_metrics_cards_8330",           // metrics + image
  ] },
  { id: "modern", layouts: [
    "title_slide",                                     // title + image
    "title_description_bullet_points_list_with_icon",  // bullet list with icons
    "title_description_chart",                         // chart
    "title_description_chart_table",                   // chart + table
    "title_list_of_cards_with_image",                  // cards + images
    "title_description_bullet_points_grid_with_icon",  // grid of points
    "title_description_image",                         // text + image
    "title_image_description_list_with_highlighted_text_heading_description", // image + list
  ] },
];

const ASSET_RE = /^\/?static\/.+\.(png|jpe?g|gif|webp|svg|ttf|otf|woff2?)$/i;
const FONT_RE = /\.(ttf|otf|woff2?)$/i;
const safeName = (f) => f.replace(/[^A-Za-z0-9._-]+/g, "-");

/** Source file for an asset URL; null when the URL points outside the template folder or fastapi/static ("../"). */
function sourceOf(templateId, url) {
  const [dir, rel] = url.startsWith("/static/") ? [FASTAPI_STATIC, url.slice("/static/".length)] : [path.join(TEMPLATES, templateId), url];
  const file = path.resolve(dir, decodeURIComponent(rel));
  const inside = path.relative(dir, file);
  return inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? file : null;
}

function dims(file) {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "hasAlpha", file], { encoding: "utf8" });
  return { width: Number(/pixelWidth: (\d+)/.exec(out)?.[1] ?? 0), alpha: /hasAlpha: yes/.test(out) };
}

/** Copy one asset into dir; returns the output file name. Raster images are resized and recompressed. */
function copyAsset(src, dir, preferredName) {
  const ext = path.extname(src).toLowerCase();
  let name = safeName(preferredName);
  const dst = () => path.join(dir, name);
  if (!/\.(png|jpe?g)$/.test(ext)) { fs.copyFileSync(src, dst()); return name; }
  const { width, alpha } = dims(src);
  const size = fs.statSync(src).size;
  const resize = width > MAX_W ? ["--resampleWidth", String(MAX_W)] : [];
  if (!alpha && (resize.length || size > 60_000 || ext !== ".png")) {
    // opaque photo-like raster: JPEG
    name = name.replace(/\.(png|jpe?g)$/i, ".jpg");
    execFileSync("sips", [...resize, "-s", "format", "jpeg", "-s", "formatOptions", String(JPEG_QUALITY), src, "--out", dst()], { stdio: "ignore" });
  } else if (resize.length) {
    execFileSync("sips", [...resize, src, "--out", dst()], { stdio: "ignore" });
  } else {
    fs.copyFileSync(src, dst());
  }
  if (fs.statSync(dst()).size > size && !resize.length && path.extname(name) === ext) fs.copyFileSync(src, dst());
  return name;
}

/** Deep-map every string value. */
function mapStrings(v, fn) {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}

function collect(v, set) {
  mapStrings(v, (s) => { if (ASSET_RE.test(s)) set.add(s); return s; });
  return set;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const dirSize = (d) => fs.readdirSync(d).reduce((a, f) => a + fs.statSync(path.join(d, f)).size, 0);

function main() {
  fs.mkdirSync(path.join(OUT, "data"), { recursive: true });
  const index = [];
  const report = [];
  for (const deck of DECKS) {
    const tpl = JSON.parse(fs.readFileSync(path.join(TEMPLATES, deck.id, "template.json"), "utf8"));
    const layouts = deck.layouts.map((id) => {
      const l = tpl.layouts.find((x) => x.id === id);
      if (!l) throw new Error(`${deck.id}: layout ${id} not found`);
      return l;
    });
    // fonts: keep only families the chosen layouts use (plus the theme text font)
    const families = new Set();
    (function fam(v) {
      if (Array.isArray(v)) v.forEach(fam);
      else if (v && typeof v === "object") { if (typeof v.family === "string") families.add(v.family); Object.values(v).forEach(fam); }
    })(layouts);
    const fonts = Object.fromEntries(Object.entries(tpl.fonts ?? {}).filter(([name, url]) => families.has(name) || !ASSET_RE.test(url)
      || url === tpl.theme?.fonts?.textFont?.url));

    const imgDir = path.join(OUT, "images", deck.id);
    fs.rmSync(imgDir, { recursive: true, force: true });
    fs.mkdirSync(imgDir, { recursive: true });
    const urls = collect([layouts, fonts, tpl.theme, tpl.thumbnail], new Set());
    const map = new Map();
    const names = new Set();
    for (const url of [...urls].sort()) {
      const src = sourceOf(deck.id, url);
      if (!src) { console.warn(`  skipped ${deck.id}: ${url} (outside the template folder)`); continue; }
      if (!fs.existsSync(src)) { console.warn(`  missing ${deck.id}: ${url}`); continue; }
      let name = path.basename(url);
      if (names.has(safeName(name))) name = `${path.basename(url, path.extname(url))}-${map.size}${path.extname(url)}`;
      const out = copyAsset(src, imgDir, name);
      names.add(out);
      map.set(url, `images/${deck.id}/${out}`);
    }
    const rewrite = (v) => mapStrings(v, (s) => map.get(s) ?? s);
    const data = {
      id: tpl.id, name: tpl.name, description: tpl.description,
      thumbnail: map.get(tpl.thumbnail) ?? null,
      ...(tpl.icon_type ? { icon_type: tpl.icon_type } : {}),
      fonts: rewrite(fonts), theme: rewrite(tpl.theme),
      layouts: rewrite(layouts),
    };
    fs.writeFileSync(path.join(OUT, "data", `${deck.id}.json`), JSON.stringify(data));
    index.push({ id: data.id, name: data.name, description: data.description, thumbnail: data.thumbnail, layoutCount: layouts.length });
    report.push({ id: deck.id, json: fs.statSync(path.join(OUT, "data", `${deck.id}.json`)).size, images: dirSize(imgDir), files: fs.readdirSync(imgDir).length });
  }
  fs.writeFileSync(path.join(OUT, "data", "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  let total = fs.statSync(path.join(OUT, "data", "index.json")).size;
  for (const r of report) {
    total += r.json + r.images;
    console.log(`${r.id.padEnd(10)} data ${kb(r.json).padStart(10)}  images ${kb(r.images).padStart(10)} (${r.files} files)`);
  }
  console.log(`total data + images: ${(total / 1024 / 1024).toFixed(2)} MB`);
  if (total > 6 * 1024 * 1024) { console.error("over the 6 MB budget"); process.exitCode = 1; }
}

main();
