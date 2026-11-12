// Bring-your-own-key store. The key lives in this module's memory. Only when the visitor ticks "remember in this tab"
// is it also written to sessionStorage (cleared when the tab closes). Nothing here logs or displays the full key.

const STORAGE_KEY = "udm-playground.anthropic-api-key";
let memoryKey: string | null = null;

function storage(): Storage | null {
  try { return (globalThis as any).sessionStorage ?? null; } catch { return null; }
}

export function setApiKey(key: string, opts: { remember?: boolean } = {}): void {
  const k = String(key ?? "").trim();
  memoryKey = k || null;
  const s = storage();
  try {
    if (s && opts.remember && memoryKey) s.setItem(STORAGE_KEY, memoryKey);
    else s?.removeItem(STORAGE_KEY);
  } catch { /* storage blocked: memory only */ }
}

/** The key in memory, else one remembered in this tab's sessionStorage (if the visitor opted in earlier). */
export function getApiKey(): string | null {
  if (memoryKey) return memoryKey;
  try { memoryKey = storage()?.getItem(STORAGE_KEY) || null; } catch { /* blocked */ }
  return memoryKey;
}

export function isKeyRemembered(): boolean {
  try { return Boolean(storage()?.getItem(STORAGE_KEY)); } catch { return false; }
}

export function clearApiKey(): void {
  memoryKey = null;
  try { storage()?.removeItem(STORAGE_KEY); } catch { /* blocked */ }
}

/** For display only: "sk-ant-…1a2b". */
export function maskKey(key: string | null | undefined): string {
  const k = String(key ?? "");
  if (!k) return "";
  return k.length <= 12 ? "…" : `${k.slice(0, 7)}…${k.slice(-4)}`;
}
