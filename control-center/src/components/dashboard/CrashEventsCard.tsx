// Dashboard "Crash Events" card — surfaces only the most alarming
// Windows event-log entries (kernel-power crashes, unexpected shutdowns,
// WER buckets). Replaces the legacy PcDiagnosticCard which was dropped
// in the v2.x wave-1 dashboard cleanup.
//
// Wired to the same `event_log_recent` backend command the System -
// Diagnostics panel uses, but with scope="crash_only" so the filtering
// happens server-side.

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
// with the richer KNOWN_ERRORS map in components/system/Diagnostics.tsx —
// this card uses a one-liner per row so the card stays the same height
// as siblings.
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

  async function openViewer() {
    try {
      await invoke("open_event_viewer");
    } catch (e) {
      setError(String(e));
    }
  }

  const top = (events ?? []).slice(0, 3);
  const hasCrashes = top.length > 0;
  const accent = hasCrashes ? "danger" : "ok";

  return (
    <Card
      title="Crash events"
      accent={accent}
      loading={loading}
      error={error}
      action={
        <div className="flex items-center gap-1.5">
          <SmallButton
            onClick={() => void load()}
            disabled={loading}
            title="Re-query the Windows Event Log"
          >
            {loading ? "..." : "refresh"}
          </SmallButton>
          {hasCrashes && (
            <SmallButton
              onClick={() => void openViewer()}
              variant="accent"
              title="Launch eventvwr.msc for full event details"
            >
              event viewer
            </SmallButton>
          )}
        </div>
      }
    >
      {!hasCrashes ? (
        <div className="space-y-1">
          <div
            className="text-[12.5px] font-semibold"
            style={{ color: "var(--color-success)" }}
          >
            All clear ✓
          </div>
          <div
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            No kernel-power crashes or unexpected shutdowns in the recent
            Windows event log.
          </div>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {top.map((evt, idx) => (
            <li
              key={`${evt.time_created}-${idx}`}
              className="cursor-pointer rounded px-1.5 py-1 transition-colors hover:bg-white/5"
              onClick={() => void openViewer()}
              title="Click to open Event Viewer"
            >
              <div className="flex items-baseline gap-2">
                <span
                  className="shrink-0 rounded px-1 py-0.5 text-[9.5px] font-medium tabular-nums uppercase tracking-wide"
                  style={{
                    background: "rgba(248, 81, 73, 0.10)",
                    color: "var(--color-danger)",
                  }}
                >
                  id {evt.event_id}
                </span>
                <span
                  className="ml-auto shrink-0 tabular-nums text-[10px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {relativeTime(evt.time_created)}
                </span>
              </div>
              <div
                className="mt-0.5 truncate text-[11.5px] leading-snug"
                style={{ color: "var(--color-text-secondary)" }}
                title={evt.message || shortDescription(evt)}
              >
                {shortDescription(evt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
