import type { AlertEntry } from "../../types";

export type Props = {
  alerts: AlertEntry[];
  /** Parent should re-`invoke("read_alerts", ...)` and update its state.
   *  Called after a successful destructive op (delete from alerts.jsonl).
   *  If omitted, the component falls back to `window.location.reload()`
   *  so the UI never lies about the disk state. */
  onDeleted?: () => void | Promise<void>;
};

export type SevWeight = 0 | 1 | 2;
export type SevKey = "info" | "warn" | "critical";

export type SevStyle = {
  color: string;
  bg: string;
  ring: string;
  label: string;
  key: SevKey;
  weight: SevWeight;
};

export type DateFilter = "1h" | "24h" | "7d" | "all";

export type Grouped = {
  source: string;
  message: string;
  severity: string;
  count: number;
  first_ts: string;
  last_ts: string;
};

// Only Claude is wired now — the redundant Codex Fix variants were removed.
export type FixProvider = "claude";

// Callback type for the per-row dismiss action (lifted to parent so the
// dismissed set lives in one place and filters visibleGroups consistently).
export type OnDismissRow = (fp: string) => void;
