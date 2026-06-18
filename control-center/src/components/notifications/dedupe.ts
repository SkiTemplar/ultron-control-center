import type { AlertEntry } from "../../types";
import type { Grouped } from "./types";

export function fingerprint(a: AlertEntry): string {
  const msg = (a.message ?? "").trim().replace(/\s+/g, " ");
  return `${a.source}::${msg.slice(0, 80)}`;
}

export function getTs(a: AlertEntry): string {
  return a.timestamp ?? a.ts ?? "";
}

export function dedupe(alerts: AlertEntry[]): Grouped[] {
  const map = new Map<string, Grouped>();
  for (const a of (alerts ?? [])) {
    if (!a || typeof a !== "object") continue;
    const fp = fingerprint(a);
    const ts = getTs(a);
    const ex = map.get(fp);
    if (ex) {
      ex.count = (ex.count ?? 0) + 1;
      if (ts && (!ex.last_ts || ts > ex.last_ts)) ex.last_ts = ts;
      if (ts && (!ex.first_ts || ts < ex.first_ts)) ex.first_ts = ts;
    } else {
      map.set(fp, {
        source: a.source ?? "",
        message: a.message ?? "",
        severity: a.severity ?? "info",
        count: 1,
        first_ts: ts,
        last_ts: ts,
      });
    }
  }
  return Array.from(map.values());
}
