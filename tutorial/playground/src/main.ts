// Entry: mounts the UDM Playground into #udm-playground. The assets root comes from data-assets (or
// data-assets-root) on the mount element, resolved against the page URL; without it, from the bundle location.

import "./styles.css";
import { setAssetsRoot } from "./data";
import { mountApp } from "./app/app";

function start() {
  const mount = document.querySelector<HTMLElement>("div#udm-playground");
  if (!mount || mount.dataset.mounted) return;
  mount.dataset.mounted = "true";
  const assets = mount.getAttribute("data-assets") ?? mount.getAttribute("data-assets-root");
  if (assets) setAssetsRoot(new URL(assets.endsWith("/") ? assets : `${assets}/`, document.baseURI).href);
  mountApp(mount).catch((e) => console.error("[udm playground] failed to start", e));
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();

// MkDocs Material instant navigation swaps the page without a reload: mount again when the playground page appears.
(window as any).document$?.subscribe?.(() => start());
