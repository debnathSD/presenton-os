// Unified Document Model (UDM) = Artifact Spec `gck.artifact/1`, protocol 1.3 "UDM profile".
//
// Target-agnostic by construction: no type, field or enum value below names a target.
// Anything a single target needs lives in `ext[<adapter-id>]` (opaque to the core).
// Geometry, styling and theme never enter the UDM; they stay in the host.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** Namespace = an adapter id, e.g. "presenton.slides", "tiptap". */
export type Namespace = string; // ^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$
export type Ext = Record<Namespace, JsonValue>;

// ---------- Content: rich text ----------

export type Mark = "bold" | "italic" | "underline" | "strike" | "code" | "link" | "math";

export interface TextSegment {
  /** "\n" inside text is a hard line break. Empty string only for tokens. */
  text: string;
  marks?: Mark[];
  href?: string; // with "link"
  /** Live value placeholder; text is "" when persisted (Part IX 2.2). */
  token?: { bindingId: string; field: string; format?: string };
  /** Citation ids into Udm.sources. */
  cite?: string[];
}
export type RichText = TextSegment[];

/** Flat item or nested item. Readers without nesting flatten. */
export type ListItem = RichText | { text: RichText; children: ListItem[] };

// ---------- Content: blocks ----------

export type BlockRole = "subtitle" | "takeaway" | "kpi" | "caption" | "citation" | "label";

interface BlockBase {
  id: string; // blk_...
  role?: BlockRole;
  /** Same value = one visual region (a card, a metric grid cell). */
  group?: string;
  ext?: Ext;
}

export type ChartKind =
  | "bar" | "horizontal_bar" | "stacked_bar" | "horizontal_stacked_bar"
  | "line" | "area" | "pie" | "donut" | "polar_area" | "scatter" | "radar" | "bubble";

/** Neutral diagram vocabulary (a renderer picks the visual). */
export type DiagramKind =
  | "progress" | "gauge" | "timeline" | "process" | "steps" | "funnel" | "pyramid"
  | "cycle" | "matrix" | "hierarchy" | "comparison" | "other";

export interface DiagramItem {
  id?: string; parentId?: string;
  heading?: string; description?: string; label?: string; focus?: string; value?: number;
}

export type Block =
  | (BlockBase & { type: "heading"; level: 1 | 2 | 3; text: RichText })
  | (BlockBase & { type: "paragraph"; text: RichText })
  | (BlockBase & { type: "list"; ordered: boolean; items: ListItem[] })
  | (BlockBase & { type: "callout"; tone: "info" | "warning" | "success"; text: RichText })
  | (BlockBase & { type: "quote"; text: RichText; attribution?: string })
  | (BlockBase & { type: "divider" })
  | (BlockBase & { type: "code"; language?: string; code: string })
  | (BlockBase & { type: "math"; latex: string })
  | (BlockBase & { type: "chart"; bindingId: string; chartType: ChartKind; title?: string;
                   axes?: { x?: string; y?: string }; caption?: RichText })
  | (BlockBase & { type: "metric"; bindingId: string; label: string })
  | (BlockBase & { type: "table"; bindingId: string; caption?: RichText })
  | (BlockBase & { type: "image"; url?: string; prompt?: string; alt: string;
                   kind?: "photo" | "icon" | "illustration" | "logo"; caption?: RichText; assetId?: string })
  | (BlockBase & { type: "diagram"; diagramKind: DiagramKind; items?: DiagramItem[];
                   range?: { min: number; max: number; value: number }; caption?: RichText })
  | (BlockBase & { type: "embed"; bindingId: string; title?: string });

export type BlockType = Block["type"]; // runtime list: core/udm-runtime.mjs BLOCK_TYPES

// ---------- Data (definitions only; values of live sources stay in the binding store) ----------

export interface ChartData { categories: string[]; series: { name: string; values: number[] }[] }
export interface TableData { columns: string[]; rows: string[][] }
export interface MetricData { value: number; previous?: number }

export type DataSource =
  | { type: "static"; origin: "imported" | "user"; data: ChartData | TableData | MetricData }
  | { type: string; [k: string]: JsonValue }; // live providers, e.g. "superset_chart"

export interface DataBinding { kind: "chart" | "table" | "metric" | "embed"; source: DataSource }

// ---------- Sections, structure, semantics ----------

export type SectionRole = "title" | "agenda" | "content" | "summary" | "closing" | "appendix";

export interface Section {
  id: string; // sec_...
  role?: SectionRole;
  level?: 1 | 2 | 3;
  title?: string;
  summary?: string;
  /** Non-body annotation: speaker notes, a doc aside. */
  notes?: RichText;
  blocks: Block[];
  ext?: Ext;
}

// ---------- Media and metadata ----------

export interface Asset {
  mime: string; url: string; sha256?: string; width?: number; height?: number;
  attribution?: { author?: string; source?: string; license?: string }; generated?: boolean;
}

export interface Provenance {
  origin: "generated" | "imported" | "edited";
  runId?: string; model?: string; prompt?: string; createdAt?: string;
  importedFrom?: { adapter: string; adapterVersion: string; nativeRef?: string };
}

export interface Meta {
  description?: string; tags?: string[]; authors?: { ref: string; name?: string }[];
  createdAt?: string; updatedAt?: string; revision?: number; classification?: string; audience?: string;
}

export interface Udm {
  version: "gck.artifact/1";
  profile: "udm/1.3";
  id: string; // art_...
  title?: string;
  language?: string;
  /** Hint only; a UDM is not bound to a target. */
  plannedFor?: string;
  meta?: Meta;
  provenance: Provenance;
  sections: Section[];
  bindings: Record<string, DataBinding>; // key ^b_[a-z0-9_]{1,48}$
  assets?: Record<string, Asset>;
  sources?: { id: string; title: string; url?: string }[];
  ext?: Ext;
}
