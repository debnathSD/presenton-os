// Formatting helpers for the status bar and the inspector.

import type { Loss, Issue } from "../udm/bridge";

export function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

export function lineCount(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function lossSummary(loss: Loss[], issues: Issue[]): string {
  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.length - errors;
  const parts = [plural(loss.length, "loss", "losses")];
  if (warnings) parts.push(plural(warnings, "warning"));
  if (errors) parts.push(plural(errors, "schema error"));
  return parts.join(" · ");
}

export function countBy<T>(list: T[], key: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of list) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
