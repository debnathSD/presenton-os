// Browser shim for "@/utils/api" (aliased in scripts/build.mjs via src/render/aliases.mjs).
//
// Presenton's renderer only needs resolveBackendAssetUrl. The real one reads process.env / window.env to find the
// FastAPI backend and rewrites same-origin URLs containing "/images/" to "/app_data/images/...", which would break
// the playground's copied images (they are served from the same origin as the page). Here every asset resolves
// against the playground assets root instead.

import { assetsRoot } from "../../data";

/** "images/general/x.png" -> <assets root>/images/general/x.png; absolute, data: and blob: URLs pass through. */
export function resolveBackendAssetUrl(path?: string): string {
  if (!path) return "";
  const p = path.trim();
  if (!p) return "";
  if (/^(?:data|blob|https?):/i.test(p)) return p;
  try {
    // Leftover backend paths ("/static/...", "static/...") are looked up under the assets root as well.
    return new URL(p.replace(/^\/+/, ""), assetsRoot()).href;
  } catch {
    return p;
  }
}

export type BackendAssetLike = { file_url?: string | null; path?: string | null; url?: string | null };

export function getBackendAssetSource(asset: BackendAssetLike | string | null | undefined): string {
  if (typeof asset === "string") return asset;
  if (!asset) return "";
  return (asset.file_url || asset.path || asset.url || "").trim();
}

export function resolveBackendAssetSource(asset: BackendAssetLike | string | null | undefined): string {
  return resolveBackendAssetUrl(getBackendAssetSource(asset));
}
