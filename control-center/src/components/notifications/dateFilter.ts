import type { DateFilter } from "./types";

export const DATE_LABEL: Record<DateFilter, string> = {
  "1h": "Last hour",
  "24h": "Last 24h",
  "7d": "Last 7 days",
  "all": "All",
};

export function passesDateFilter(ts: string, filter: DateFilter): boolean {
  if (filter === "all") return true;
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (isNaN(t)) return false;
  const delta = Date.now() - t;
  switch (filter) {
    case "1h":
      return delta <= 3600_000;
    case "24h":
      return delta <= 86_400_000;
    case "7d":
      return delta <= 7 * 86_400_000;
  }
}
