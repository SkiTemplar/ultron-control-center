// ULTRON Control Center 2.0 — Shared provider labels & tints
//
// Single source of truth for the human-readable label and accent colour of
// each terminal provider. Used by TerminalLeaf (per-pane title), ProjectTerminal
// (auto-naming the upper tab when the first PTY is spawned), and any future
// chrome that wants to show a provider chip.

import type { Provider } from "./layout-types";

export function providerLabel(p: Provider): string {
  if (p === "claude") return "Claude";
  if (p === "codex") return "Codex";
  if (p === "gemini") return "Gemini";
  if (p === "powershell") return "PowerShell";
  if (p === "powershell-admin") return "PowerShell (admin)";
  return p;
}

export function providerTint(p: Provider): string {
  if (p === "claude") return "#cc785c";
  if (p === "codex") return "#10a37f";
  if (p === "gemini") return "#4285f4";
  if (p === "powershell") return "#012456"; // PowerShell blue
  if (p === "powershell-admin") return "#d29922"; // warning amber for elevated
  return "#888";
}
