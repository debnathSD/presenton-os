// Generic adapter contract. Every module (Presenton slides, Tiptap, Markdown, ...) is one Adapter.
// The core (udm.ts, negotiate, registry, conformance) never imports an adapter.

import type { BlockType, ChartKind, Mark, Udm, Ext } from "./udm.ts";

export interface LossEntry {
  /** Stable code, e.g. "block_degraded", "mark_dropped", "chart_kind_fallback", "no_slot". */
  code: string;
  /** Where: "sec_x", "sec_x/blk_y", "sec_x/blk_y/items/2". */
  path: string;
  detail?: string;
  /** Text that left the document because of this entry (lets conformance prove "no silent text loss"). */
  droppedText?: string;
}

export interface Issue { level: "error" | "warning"; code: string; path: string; message: string }

export interface AdapterManifest {
  id: string;                 // ^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$, also the ext namespace
  version: string;
  displayName: string;
  nativeFormat: string;       // media type of Native
  blocks: BlockType[];
  marks: Mark[];
  chartKinds?: ChartKind[];
  structure: {
    maxHeadingLevel: 0 | 1 | 2 | 3; maxListDepth: number; groups: boolean; roles: boolean;
    orderPreserved: boolean;  // false for layout-driven targets (slides place blocks in the layout's reading order)
  };
  features: {
    notes: boolean; captions: boolean; citations: boolean; staticData: boolean;
    ids: boolean;             // block ids survive serialize -> deserialize
    extPassThrough: boolean;  // foreign ext namespaces survive serialize -> deserialize
    sectionTitles: boolean;
  };
  limits?: { maxSections?: number; maxBlocksPerSection?: number; maxCharsPerBlock?: number };
  applyModes: ("replace" | "insert_at_cursor" | "append" | "patch")[];
  roundTrip: "lossless" | "lossy" | "write-only";
}

export interface SerializeResult<Native> {
  native: Native;
  loss: LossEntry[];
  /** Optional adapter diagnostics (e.g. which native slots were written). Never needed for correctness. */
  trace?: Record<string, unknown>;
}
export interface DeserializeResult { udm: Udm; loss: LossEntry[] }

export interface Adapter<Native = unknown, Opts = Record<string, unknown>> {
  manifest: AdapterManifest;
  /** Pure, deterministic, no I/O. Input is already negotiated against `manifest`. */
  serialize(udm: Udm, opts?: Opts): SerializeResult<Native>;
  /** Pure. Required unless roundTrip == "write-only". */
  deserialize?(native: Native, opts?: Opts): DeserializeResult;
  /** The host's own rules (ProseMirror schema check, Template v2 shape, Markdown re-parse). */
  validateNative(native: Native, opts?: Opts): Issue[];
}

export interface NegotiationResult { udm: Udm; loss: LossEntry[] }

export interface Registry {
  register(adapter: Adapter, aliases?: string[]): void;
  get(id: string): Adapter;
  list(): AdapterManifest[];
  /** negotiate + serialize, losses merged. */
  convert(udm: Udm, targetId: string, opts?: unknown): { native: unknown; loss: LossEntry[] };
}

export type { Ext };
