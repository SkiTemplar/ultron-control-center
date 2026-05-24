// Dashboard "Crash Events" card — surfaces only the most alarming
// Windows event-log entries (kernel-power crashes, unexpected shutdowns,
// WER buckets). Replaces the legacy PcDiagnosticCard which was dropped
// in the v2.x wave-1 dashboard cleanup.
//
// Wired to the same `event_log_recent` backend command the System -
// Diagnostics panel uses, but with scope="crash_only" so the filtering
// happens server-side.
//
// v2.7 redesign:
//   - "Open Event Viewer" button removed (and the per-row click handler
//     that opened it). The dashboard surfaces info inline only.
//   - Bigger card baseline (13px), shows up to 5 crashes, severity pill
//     per row, message preview line below the headline.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, SmallButton, relativeTime } from "./Card";

type EventLogLevel =
  | "critical"
  | "error"
  | "warning"
  | "information"
  | "verbose"
  | "unknown";

interface EventLogEntry {
  event_id: number;
  source: string;
  log_name: string;
  level: EventLogLevel;
  time_created: string;
  message: string;
}

// Compact human-readable label per crash-grade Event ID. Kept in sync
// with the richer KNOWN_ERRORS map in components/system/Diagnostics.tsx.
const CRASH_DESCRIPTIONS: Record<number, string> = {
  41: "Kernel-Power — unexpected reboot / hard crash",
  1001: "Windows Error Reporting — app or driver crash",
  6008: "Unexpected shutdown — previous boot did not exit cleanly",
};

function shortDescription(evt: EventLogEntry): string {
  return CRASH_DESCRIPTIONS[evt.event_id] ?? evt.source ?? `Event ${evt.event_id}`;
}

export function CrashEventsCard() {
  const [events, setEvents] = useState<EventLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await invoke<EventLogEntry[]>("event_log_recent", {
        limit: 25,
        scope: "crash_only",
      });
      setEvents(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await invoke<EventLogEntry[]>("event_log_recent", {
          limit: 25,
          scope: "crash_only",
        });
        if (!cancelled) setEvents(r);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const top = (events ?? []).slice(0, 5);
  const hasCrashes = top.length > 0;
  const accent = hasCrashes ? "danger" : "ok";

  return (
    <Card
      title="Crash events"
      subtitle="Windows kernel-power / WER / unexpected shutdown"
      accent={accent}
      loading={loading}
      error={error}
      action={
        <SmallButton
          onClick={() => void load()}
          disabled={loading}
          size="md"
          title="Re-query the Windows Event Log"
        >
          {loading ? "..." : "Refresh"}
        </SmallButton>
      }
    >
      {!hasCrashes ? (
        <div className="space-y-1">
          <div
            className="text-[16px] font-semibold"
            style={{ color: "var(--color-success)" }}
          >
            All clear
          </div>
          <div
            className="text-[12.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            No kernel-power crashes or unexpected shutdowns in the recent
            Windows event log.
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {top.map((evt, idx) => (
            <li
              key={`${evt.time_created}-${idx}`}
              className="rounded px-2 py-1.5"
              style={{ background: "var(--color-surface-3)" }}
            >
              <div className="flex items-baseline gap-2">
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums uppercase tracking-wide"
                  style={{
                    background: "rgba(248, 81, 73, 0.10)",
                    color: "var(--color-danger)",
                  }}
                >
                  id {evt.event_id}
                </span>
                <span
                  className="truncate text-[13px] font-medium"
                  style={{ color: "var(--color-text)" }}
                >
                  {shortDescription(evt)}
                </span>
                <span
                  className="ml-auto shrink-0 tabular-nums text-[11px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {relativeTime(evt.time_created)}
                </span>
              </div>
              {evt.message && (
                <div
                  className="mt-1 truncate text-[12px]"
                  style={{ color: "var(--color-text-secondary)" }}
                  title={evt.message}
                >
                  {evt.message}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
