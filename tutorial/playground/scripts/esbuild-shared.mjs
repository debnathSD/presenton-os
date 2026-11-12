// Shared esbuild settings for the app build and the tests.

import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLAYGROUND = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO = path.resolve(PLAYGROUND, "../..");
export const NEXTJS = path.join(REPO, "servers/nextjs");
export const PROTOTYPE = path.join(REPO, "tutorial/prototypes/udm");
export const ASSETS = path.join(REPO, "tutorial/content/assets/playground");

const inside = (file, dir) => {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * One copy of every package. Files outside the playground (the UDM prototype, the Presenton renderer) import bare
 * packages such as "@tiptap/core", "marked" or "katex"; resolve those from the playground's node_modules so the
 * editor and the adapters share one ProseMirror/Tiptap instance and the bundle holds each package once.
 */
export function dedupePlugin() {
  return {
    name: "playground-dedupe",
    setup(build) {
      build.onResolve({ filter: /^(?:@[^/]+\/|[^./@])/ }, async (args) => {
        if (args.pluginData?.dedupe || !args.importer || inside(args.importer, PLAYGROUND)) return undefined;
        const r = await build.resolve(args.path, { kind: args.kind, resolveDir: PLAYGROUND, pluginData: { dedupe: true } });
        if (r.errors.length) return { errors: r.errors };
        return { path: r.path, external: r.external, namespace: r.namespace, sideEffects: r.sideEffects };
      });
    },
  };
}

/** Options shared by the app build and the test bundles. */
export const common = {
  bundle: true,
  format: "esm",
  target: "es2020",
  loader: { ".css": "css" },
  alias: { "@": NEXTJS },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [dedupePlugin()],
  logLevel: "warning",
  legalComments: "none",
};
