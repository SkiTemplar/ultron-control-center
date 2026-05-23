// Control Center 2.0 — Phase 6 schedule panel.
//
// Toggle + time picker for the daily diagnostic Windows scheduled task
// (registered via schtasks.exe by the backend; see commands/diagnostics_native).
// On non-Windows the toggle still saves the config but the OS task is
// not registered (backend returns an error).

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DiagScheduleConfig } from "../../types";

const HHMM_RE = /^\d{2}:\d{2}$/;

export function DiagnosticSchedulePanel() {
  const [cfg, setCfg] = useState<DiagScheduleConfig>({
    enabled: false,
    time_hhmm: "08:30",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke<DiagScheduleConfig>("diagnostic_schedule_get")
      .then(setCfg)
      .catch((e) => setErr(String(e)));
  }, []);

  async function save(next: DiagScheduleConfig) {
    if (!HHMM_RE.test(next.time_hhmm)) {
      setErr("Time must be HH:MM");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = (await invoke("diagnostic_schedule_set", {
        enabled: next.enabled,
        timeHhmm: next.time_hhmm,
      })) as DiagScheduleConfig;
      setCfg(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-white/10 bg-[var(--color-surface-1)] p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <span className="font-mono text-white/60">⏱</span> Daily diagnostic
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={cfg.enabled}
            disabled={busy}
            onChange={(e) => save({ ...cfg, enabled: e.target.checked })}
          />
          Run daily at
        </label>
        <input
          type="time"
          value={cfg.time_hhmm}
          disabled={busy || !cfg.enabled}
          onChange={(e) => setCfg({ ...cfg, time_hhmm: e.target.value })}
          onBlur={() => save(cfg)}
          className="rounded bg-black/30 px-2 py-1 text-xs border border-white/10"
        />
        {busy && <span className="text-xs text-white/40">saving...</span>}
      </div>
      {err && <div className="mt-2 text-xs text-red-300">{err}</div>}
    </div>
  );
}

export default DiagnosticSchedulePanel;
