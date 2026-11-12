// Lazy PPTX export: src/pptx (pptxgenjs) is only fetched when someone downloads a PPTX.

import type { Deck } from "../udm/bridge";
import type { TemplateData } from "../data";

export async function exportDeckPptx(deck: Deck, t: TemplateData, fileName: string): Promise<void> {
  const mod: any = await import("../pptx/index");
  await mod.exportPptx(deck, t, fileName);
}
