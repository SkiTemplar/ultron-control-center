// Display helpers and constants for BatchDropdown.

import type { BatchQueueReason } from "./types";

export const REASON_LABEL: Record<BatchQueueReason, string> = {
  rejected: "rechazado",
  ai_cannot_execute: "IA no pudo ejecutar",
  failed: "fallo",
};

export const REASON_COLOR: Record<BatchQueueReason, string> = {
  rejected: "var(--color-danger)",
  ai_cannot_execute: "var(--color-warning, #d29922)",
  failed: "var(--color-warning, #d29922)",
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatAge(epoch: number): string {
  if (!epoch) return "-";
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - epoch);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function clip(s: string, max = 320): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}... (+${trimmed.length - max} chars)`;
}
