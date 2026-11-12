// Bundles test/entry.ts with the app's esbuild settings (same package dedupe) and imports it.
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { PLAYGROUND, common } from "../scripts/esbuild-shared.mjs";

export async function loadBundle() {
  const outfile = path.join(PLAYGROUND, "test/.build/entry.mjs");
  await esbuild.build({ ...common, entryPoints: [path.join(PLAYGROUND, "test/entry.ts")], outfile, platform: "node", minify: false });
  return import(pathToFileURL(outfile).href);
}
