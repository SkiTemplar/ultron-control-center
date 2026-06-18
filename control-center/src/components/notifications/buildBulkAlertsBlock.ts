import type { Grouped } from "./types";
import { severityStyle } from "./severity";

// Build the variable block the prompt template (key `notif.fix_one`) splices
// in as `{alert_block}`. The full prompt now lives in the central catalog so
// Settings → Button prompts can tune the wording without recompiling.
export function buildFixAlertBlock(g: Grouped): string {
  return [
    `Source: ${g.source}`,
    `Severity: ${g.severity}`,
    `Count: ${g.count} occurrence(s)`,
    `First seen: ${g.first_ts}`,
    `Last seen: ${g.last_ts}`,
    "",
    "Message:",
    g.message,
  ].join("\n");
}

// Bulk version of buildFixAlertBlock: consolidates every actionable group
// (critical+warn) into a single mega-prompt. Pure function so it can be
// unit-tested without React. Truncation policy: if the rendered prompt
// exceeds MAX_PROMPT_CHARS, we keep the head (header + most-recent items)
// and drop the oldest entries, replacing them with a one-line marker so
// the LLM knows the list was cropped (instead of silently lying).
const MAX_PROMPT_CHARS = 30_000;

export function buildBulkAlertsBlock(groups: Grouped[]): string {
  // Split by severity bucket. Critical/blocking first, warn second.
  // Info is intentionally excluded — those are not worth a spawn.
  const critical: Grouped[] = [];
  const warn: Grouped[] = [];
  for (const g of groups) {
    const w = severityStyle(g.severity).weight;
    if (w === 2) critical.push(g);
    else if (w === 1) warn.push(g);
  }
  // Newest-first inside each bucket so truncation drops the oldest.
  const byLastDesc = (a: Grouped, b: Grouped) =>
    (b.last_ts || "").localeCompare(a.last_ts || "");
  critical.sort(byLastDesc);
  warn.sort(byLastDesc);

  const fmt = (g: Grouped, i: number) => {
    const head =
      g.count > 1
        ? `${i + 1}. [source: ${g.source}] (×${g.count}, last ${g.last_ts || "?"})`
        : `${i + 1}. [source: ${g.source}] (${g.last_ts || "?"})`;
    // Single-line message preview keeps the block compact; the LLM gets
    // the full text via the alerts.jsonl pointer in the footer.
    const msg = (g.message ?? "").replace(/\s+/g, " ").trim();
    return `${head}\n   ${msg}`;
  };

  const buildFrom = (
    critSlice: Grouped[],
    warnSlice: Grouped[],
    omittedCrit: number,
    omittedWarn: number,
  ): string => {
    const parts: string[] = [];
    if (critSlice.length > 0) {
      parts.push(`=== CRITICAL (${critSlice.length}${omittedCrit ? ` of ${critSlice.length + omittedCrit}` : ""}) ===`);
      critSlice.forEach((g, i) => parts.push(fmt(g, i)));
      if (omittedCrit > 0) {
        parts.push(`[... ${omittedCrit} more older critical alerts omitted ...]`);
      }
      parts.push("");
    }
    if (warnSlice.length > 0) {
      parts.push(`=== WARN (${warnSlice.length}${omittedWarn ? ` of ${warnSlice.length + omittedWarn}` : ""}) ===`);
      warnSlice.forEach((g, i) => parts.push(fmt(g, i)));
      if (omittedWarn > 0) {
        parts.push(`[... ${omittedWarn} more older warn alerts omitted ...]`);
      }
    }
    return parts.join("\n");
  };

  // Optimistic full render first.
  let critSlice = critical;
  let warnSlice = warn;
  let omittedCrit = 0;
  let omittedWarn = 0;
  let out = buildFrom(critSlice, warnSlice, omittedCrit, omittedWarn);
  // Drop oldest warn entries first (they are lower priority), then oldest
  // critical entries. Iterative shrink — each pass re-renders so the
  // truncation footer is accounted for in the size check.
  while (out.length > MAX_PROMPT_CHARS && warnSlice.length > 0) {
    warnSlice = warnSlice.slice(0, -1);
    omittedWarn += 1;
    out = buildFrom(critSlice, warnSlice, omittedCrit, omittedWarn);
  }
  while (out.length > MAX_PROMPT_CHARS && critSlice.length > 1) {
    critSlice = critSlice.slice(0, -1);
    omittedCrit += 1;
    out = buildFrom(critSlice, warnSlice, omittedCrit, omittedWarn);
  }
  return out;
}
