// The playground's Tiptap editor (vanilla @tiptap/core, no React).
//
// Schema: exactly bridge.tiptapExtensions(), the list the tiptap adapter derives its manifest from. On top of it,
// only things that leave the schema unchanged:
//   - node views for dataBlock (chart preview + data dialog, diagram / metric cards) and image (alt text),
//     added with .extend({ addNodeView }) on the same extensions (same name, attrs, content, group);
//   - StarterKit configured with trailingNode: false (the trailing-paragraph plugin would append an empty paragraph,
//     which the adapter reads back as a new block and the deck as a changed slide);
//   - a placeholder decoration for an empty document.
// enableContentCheck is on. Invalid content never silently replaces the document: setJSON() validates first and
// keeps the current document when the new one fails; the error goes to onContentError callbacks.
//
// Styles: src/editor/editor.css (import it from the app stylesheet).

import { Editor, Extension, getSchema } from "@tiptap/core";
import { EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { tiptapExtensions } from "../udm/bridge";
import { loadVendoredChart, withChartData, readChartData, type ChartData, type ChartLoader } from "./chart";
import { DataBlockView, ImageView, setNodeAttrs, type ViewContext } from "./nodeviews";
import { createToolbar } from "./toolbar";

export type ContentError = { error: Error; source: "initial" | "setJSON"; rejected?: any };
export type EditorHandle = {
  getJSON(): any;
  /** Replace the document. Returns false (and reports a content error) when `doc` fails the schema check. */
  setJSON(doc: any): boolean;
  onChange(cb: () => void): () => void;
  onContentError(cb: (e: ContentError) => void): () => void;
  destroy(): void;
  focus(): void;
  /** The underlying Tiptap editor (for the app shell and tests). */
  readonly editor: any;
};
export type EditorOptions = {
  placeholder?: string;
  /** Accessible name of the editing area. */
  label?: string;
  /** id of an element that describes the editing area (keyboard help). */
  describedBy?: string;
  editable?: boolean;
  onContentError?: (e: ContentError) => void;
  /** Override how Chart.js is obtained (tests); default loads the vendored UMD build on demand. */
  loadChart?: ChartLoader;
  onChartError?: (e: Error) => void;
};

export { readChartData, withChartData, setNodeAttrs };
export type { ChartData };

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

/** Decoration-only placeholder for an empty document (no schema change). */
function placeholderExtension(text: string) {
  return Extension.create({
    name: "udmPlaceholder",
    addProseMirrorPlugins() {
      return [new Plugin({
        key: new PluginKey("udmPlaceholder"),
        props: {
          decorations: (state) => {
            const { doc } = state;
            const first = doc.firstChild;
            if (doc.childCount !== 1 || !first || !first.isTextblock || first.content.size) return null;
            return DecorationSet.create(doc, [Decoration.node(0, first.nodeSize, { class: "is-editor-empty", "data-placeholder": text })]);
          },
        },
      })];
    },
  });
}

/** The editor's extension list: the adapter's list with view-only changes (see the header comment). */
export function editorExtensions(ctx: ViewContext, placeholder = "Start writing, or convert a deck to edit it here."): any[] {
  const list = tiptapExtensions().map((ext: any) => {
    switch (ext.name) {
      case "starterKit": return ext.configure({ trailingNode: false });
      case "dataBlock": return ext.extend({ addNodeView: () => (props: any) => new DataBlockView(props, ctx) });
      case "image": return ext.extend({ addNodeView: () => (props: any) => new ImageView(props) });
      default: return ext;
    }
  });
  return [...list, placeholderExtension(placeholder)];
}

/** Check a doc against the editor schema (same as the adapter's): throws on invalid content. */
function checkDoc(schema: any, doc: any) {
  if (!doc || doc.type !== "doc") throw new Error("[udm editor]: content must be a tiptap.json document ({ type: \"doc\" })");
  schema.nodeFromJSON(doc).check();
}

let seq = 0;

export function createEditor(mount: HTMLElement, toolbarMount: HTMLElement, initial?: any, opts: EditorOptions = {}): EditorHandle {
  const changeCbs = new Set<() => void>();
  const errorCbs = new Set<(e: ContentError) => void>();
  if (opts.onContentError) errorCbs.add(opts.onContentError);
  const report = (e: ContentError) => {
    if (!errorCbs.size) console.warn("[udm editor] content error", e.error);
    for (const cb of errorCbs) cb(e);
    mount.dispatchEvent(new CustomEvent("udm-editor:content-error", { detail: e, bubbles: true }));
  };
  const ctx: ViewContext = { loadChart: opts.loadChart ?? loadVendoredChart, onChartError: opts.onChartError };
  const extensions = editorExtensions(ctx, opts.placeholder);

  // Validate the initial doc ourselves, so a bad document is reported and the editor starts empty instead of
  // Tiptap's fallback (which strips whatever does not fit and would then be applied back to the slides).
  let content: any = initial ?? EMPTY_DOC;
  if (initial) {
    try {
      checkDoc(getSchema(extensions), initial);
    } catch (error) {
      content = EMPTY_DOC;
      queueMicrotask(() => report({ error: error as Error, source: "initial", rejected: initial }));
    }
  }

  const id = `udm-editor-${++seq}`;
  const host = document.createElement("div");
  host.className = "udm-editor";
  mount.replaceChildren(host);
  const editor = new Editor({
    element: host,
    extensions,
    content,
    editable: opts.editable ?? true,
    enableContentCheck: true,
    // Tiptap's default handler throws; report instead (the content was already validated, so this is a backstop).
    onContentError: ({ error }: any) => report({ error, source: "initial" }),
    editorProps: {
      attributes: {
        id,
        class: "udm-prose",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": opts.label ?? "Document editor",
        ...(opts.describedBy ? { "aria-describedby": opts.describedBy } : {}),
        spellcheck: "true",
      },
    },
  });
  editor.on("update", () => { for (const cb of changeCbs) cb(); });

  const toolbar = createToolbar(toolbarMount, editor);

  // A read-only editor (locked while a page is generated) says so: contenteditable="false" alone leaves a
  // role="textbox" that sounds editable. setEditable() emits "update".
  const syncReadonly = () => {
    if (editor.isDestroyed) return;
    if (editor.isEditable) editor.view.dom.removeAttribute("aria-readonly");
    else editor.view.dom.setAttribute("aria-readonly", "true");
  };
  editor.on("update", syncReadonly);
  editor.on("create", syncReadonly);
  syncReadonly();

  // Keyboard route to the toolbar (the usual editor convention): Alt+F10, or Esc. Esc in the toolbar comes back.
  // Tab keeps its editing meaning inside lists and tables, so this is the way out of the text without a mouse.
  editor.view.dom.addEventListener("keydown", (e: KeyboardEvent) => {
    const toToolbar = (e.key === "F10" && e.altKey) || (e.key === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey);
    if (!toToolbar || e.defaultPrevented) return;
    if (toolbar.focus()) e.preventDefault();
  });

  return {
    get editor() { return editor; },
    getJSON: () => editor.getJSON(),
    setJSON(doc: any) {
      try {
        checkDoc(editor.schema, doc);
      } catch (error) {
        report({ error: error as Error, source: "setJSON", rejected: doc });
        return false;
      }
      // A fresh state (same plugins): the new document starts with an empty undo history, so Undo cannot step back
      // into the previous deck. No update event: setJSON is a load, not an edit.
      const state = editor.state;
      editor.view.updateState(EditorState.create({ schema: state.schema, doc: editor.schema.nodeFromJSON(doc), plugins: state.plugins }));
      toolbar.refresh();
      return true;
    },
    onChange(cb) { changeCbs.add(cb); return () => changeCbs.delete(cb); },
    onContentError(cb) { errorCbs.add(cb); return () => errorCbs.delete(cb); },
    focus() { editor.commands.focus(); },
    destroy() {
      toolbar.destroy();
      changeCbs.clear();
      errorCbs.clear();
      editor.destroy();
      host.remove();
    },
  };
}
