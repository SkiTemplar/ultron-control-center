// Control Center 2.0 — Phase 6 history panel.
//
// Lists past diagnostic runs (persisted under
// ~/.ultron/cockpit/diagnostics/<ts>.json). Clicking an entry loads the
// full report into the parent <Diagnostics /> view.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  DiagnosticReport,
  DiagHistoryEntry,
  DiagSeverity,
} from "../../types";

const SEV_BADGE: Record<DiagSeverity, string> = {
  ok: "bg-emerald-500/20 text-emerald-300",
  warn: "bg-amber-500/20 text-amber-300",
  error: "bg-red-500/20 text-red-300",
};

export function DiagnosticHistoryPanel({
  onSelect,
}: {
  onSelect: (r: DiagnosticReport) => void;
}) {
  const [entries, setEntries] = useState<DiagHistoryEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke<DiagHistoryEntry[]>("diagnostic_history_list", { limit: 30 })
      .then(setEntries)
      .catch((e) => setErr(String(e)));
  }, []);

  async function open(e: DiagHistoryEntry) {
    try {
      const r = (await invoke("diagnostic_history_read", {
        timestamp: e.timestamp,
      })) as DiagnosticReport;
      onSelect(r);
    } catch (ex) {
      setErr(String(ex));
    }
  }

  return (
    <div className="rounded border border-white/10 bg-[var(--color-surface-1)] p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <span className="font-mono text-white/60">▤</span> History
      </div>
      {err && <div className="text-xs text-red-300">{err}</div>}
      {entries.length === 0 && !err && (
        <div className="text-xs text-white/40">No past runs yet.</div>
      )}
      <ul className="space-y-1">
        {entries.map((e) => (
          <li key={e.timestamp}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-white/5"
              onClick={() => open(e)}
            >
              <span className={`rounded px-1.5 ${SEV_BADGE[e.max_severity]}`}>
                {e.max_severity}
              </span>
              <span className="font-mono">{e.timestamp}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default DiagnosticHistoryPanel;
