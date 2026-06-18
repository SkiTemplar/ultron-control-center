import type { Card } from "../../../types";

// v2.6.2 — column name matchers for the "Investigar fused into Backlog" feature.
// Per the user's request, the Investigar column lives inside the Backlog column,
// split into two sub-sections. The Backlog column hosts two visually-separated sub-sections:
// the regular Backlog cards, and an Investigar sub-section. We support two data
// shapes:
//   1. A dedicated "Investigar"/"Research" column exists — we hide it from the
//      regular column row and render its cards inside the Backlog column's
//      Investigar sub-section. Drag-drop targets either column id naturally.
//   2. No dedicated column — cards in the Backlog column whose tags include
//      `investigar` or `research` move to the Investigar sub-section. Drag-drop
//      between sub-sections toggles the tag on/off (card column_id stays as
//      Backlog).
export function isBacklogColumn(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("backlog") || n === "todo" || n === "to do";
}
export function isInvestigarColumn(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes("investig") || // investigar / investigate
    n === "research" ||
    n.includes("research") ||
    n === "explore"
  );
}
export const INVESTIGAR_TAGS = ["investigar", "research", "investigate"] as const;
export function hasInvestigarTag(card: Card): boolean {
  return card.tags.some((t) => INVESTIGAR_TAGS.includes(t.toLowerCase() as typeof INVESTIGAR_TAGS[number]));
}

/** Lookup an accent colour per well-known column name. Falls back to muted. */
export function columnAccent(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("backlog") || n.includes("todo") || n.includes("to do"))
    return "#6e7681";
  if (n.includes("progress") || n.includes("doing")) return "#58a6ff";
  if (n.includes("review")) return "#d29922";
  if (n.includes("done") || n.includes("complete")) return "#3fb950";
  if (n.includes("block")) return "#f85149";
  return "var(--color-accent)";
}
