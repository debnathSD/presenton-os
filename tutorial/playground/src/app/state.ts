// App state (one store, see ./store) and the context object the mode modules share.

import type { Deck, Loss, Issue } from "../udm/bridge";
import type { TemplateData, TemplateSummary } from "../data";
import type { EditorHandle } from "../editor/index";
import type { Store } from "./store";
import type { Toaster } from "./toast";
import type { InspectorTab } from "./inspector";
import type { StepFlow } from "./steps";

export type ModeId = "create" | "deck" | "page";

export const MODES: { id: ModeId; label: string; short: string }[] = [
  { id: "create", label: "Create a page from a prompt", short: "Prompt to page" },
  { id: "deck", label: "Presenton deck to page", short: "Deck to page" },
  { id: "page", label: "Page to slides", short: "Page to slides" },
];

/** Per-mode workspace: what the slides pane, the editor and the inspector show while this mode is active. */
export type ModeState = {
  template: TemplateData | null;
  deck: Deck | null;
  /** Last UDM produced by an operation (the inspector derives a live one from the editor when it is newer). */
  udm: any | null;
  /** Editor document saved while another mode is active. */
  doc: any | null;
  loss: Loss[];
  issues: Issue[];
  errors: string[];
  changed: string[];
  selected: number;
  flow: StepFlow;
  stage: number;
  /** Label and duration of the last operation, for the loss report. */
  op: string;
  /** The editor was edited since the last conversion. */
  dirty: boolean;
  /** Message for the slides pane when there is no deck. */
  emptySlides: string;
};

export type AppState = {
  mode: ModeId;
  busy: string | null;
  inspectorTab: InspectorTab;
  modes: Record<ModeId, ModeState>;
};

export function emptyMode(flow: StepFlow, emptySlides: string): ModeState {
  return { template: null, deck: null, udm: null, doc: null, loss: [], issues: [], errors: [], changed: [], selected: 0,
    flow, stage: 0, op: "", dirty: false, emptySlides };
}

export type StatusKind = "info" | "busy" | "success" | "error";

export type Ctx = {
  root: HTMLElement;
  store: Store<AppState>;
  editor: EditorHandle;
  toast: Toaster;
  index: TemplateSummary[];
  /** The mode state of `id` (default: the active mode). */
  mode(id?: ModeId): ModeState;
  patchMode(id: ModeId, patch: Partial<ModeState>): void;
  /** Load a doc into the editor if `id` is the active mode, else keep it for later. Returns false on a schema error. */
  setDoc(id: ModeId, doc: any): boolean;
  /** The doc of `id`: the live editor doc when it is active. */
  getDoc(id: ModeId): any;
  status(text: string, kind?: StatusKind): void;
  /** Visible error: toast, status bar and the mode's loss report. */
  fail(id: ModeId, what: string, e: unknown): void;
  loadTemplate(id: string): Promise<TemplateData>;
  /** Run `fn` with the busy flag set (buttons disabled); errors go to fail(). */
  run<T>(id: ModeId, label: string, fn: () => Promise<T> | T): Promise<T | undefined>;
  refreshSlides(): Promise<void>;
};

export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
