// Page -> new Presenton deck (content mode), shared by "Create a page from a prompt" and "Page to slides":
// editor JSON -> tiptap deserialize -> UDM -> presenton.slides serialize with layouts chosen by slot capacity.

import { tiptapToUdm, udmToNewDeck } from "../udm/bridge";
import { fmtMs, lossSummary, now, plural } from "./format";
import type { Ctx, ModeId } from "./state";

export async function slidesFromPage(ctx: Ctx, id: ModeId, templateId: string, stage: number): Promise<boolean> {
  const t = await ctx.loadTemplate(templateId);
  const doc = ctx.getDoc(id);
  const t0 = now();
  const a = tiptapToUdm(doc);
  const r = udmToNewDeck(a.udm, t);
  const ms = now() - t0;
  if (!r.deck.slides.length) {
    ctx.patchMode(id, { template: t, deck: null, udm: a.udm, loss: [...a.loss, ...r.loss], issues: r.issues, changed: [], selected: 0 });
    ctx.status("The page has no sections to turn into slides. Add a heading and some text first.", "error");
    return false;
  }
  const loss = [...a.loss, ...r.loss];
  const noSlot = loss.filter((l) => l.code === "no_slot").length;
  ctx.patchMode(id, {
    template: t, deck: r.deck, udm: a.udm, loss, issues: r.issues, errors: [], changed: [], selected: 0, stage,
    op: `Generate slides from page: ${plural(r.deck.slides.length, "slide")} in ${t.name} (${fmtMs(ms)})`,
  });
  ctx.status(`Generated ${plural(r.deck.slides.length, "slide")} in the ${t.name} template in ${fmtMs(ms)} · ${lossSummary(loss, r.issues)}` +
    (noSlot ? ` · ${plural(noSlot, "block")} found no slot (see Loss report)` : ""), "success");
  return true;
}
