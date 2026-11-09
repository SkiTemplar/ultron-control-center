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
//
// 2026-10-18: la línea de detalle solo se pinta si aporta algo. El backend
// rellena `message` con el primer <Data> del evento cuando no hay mensaje
// renderizado («0», un código o el mismo texto genérico en todos los eventos),
// así que se omite si está vacía, es solo un código, repite la descripción o
// se repite tal cual en otro evento de la lista. Por encima de 5 eventos hay
// un «+N más» que lleva a Sistema.

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

export interface EventLogEntry {
  event_id: number;
  source: string;
  log_name: string;
  level: EventLogLevel;
  time_created: string;
  message: string;
}

/** Eventos que se listan en la tarjeta; el resto queda en «+N más». */
export const MAX_CRASH_EVENTS = 5;

// Compact human-readable label per crash-grade Event ID. Kept in sync
// with the richer KNOWN_ERRORS map in components/system/Diagnostics.tsx.
const CRASH_DESCRIPTIONS: Record<number, string> = {
  41: "Kernel-Power: reinicio inesperado o cuelgue",
  1001: "Windows Error Reporting: fallo de una aplicación o un driver",
  6008: "Apagado inesperado: el arranque anterior no se cerró bien",
};

export function shortDescription(evt: EventLogEntry): string {
  return CRASH_DESCRIPTIONS[evt.event_id] ?? (evt.source || `Evento ${evt.event_id}`);
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Detalle que merece pintarse bajo el titular, o `null` si sería ruido:
 * vacío, solo un código (sin letras), igual a la descripción del evento o
 * repetido tal cual en otro evento de la misma lista.
 */
export function usefulDetail(evt: EventLogEntry, all: EventLogEntry[]): string | null {
  const text = (evt.message ?? "").trim();
  if (!text || !/\p{L}{3,}/u.test(text)) return null;
  const key = normalize(text);
  if (key === normalize(shortDescription(evt))) return null;
  const repeats = all.filter((other) => normalize(other.message ?? "") === key).length;
  return repeats > 1 ? null : text;
}

interface CrashEventsCardProps {
  /** Abre Sistema (diagnóstico con el registro de eventos completo). */
  onOpenSystem?: () => void;
}

export function CrashEventsCard({ onOpenSystem }: CrashEventsCardProps = {}) {
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

  const all = events ?? [];
  const top = all.slice(0, MAX_CRASH_EVENTS);
  const hidden = all.length - top.length;
  const hasCrashes = top.length > 0;
  const accent = hasCrashes ? "danger" : "ok";

  return (
    <Card
      title="Eventos de caída"
      subtitle="Kernel-Power, WER y apagados inesperados de Windows"
      accent={accent}
      loading={loading}
      error={error}
      action={
        <SmallButton
          onClick={() => void load()}
          disabled={loading}
          size="md"
          title="Volver a consultar el registro de eventos de Windows"
        >
          {loading ? "…" : "Actualizar"}
        </SmallButton>
      }
    >
      {!hasCrashes ? (
        <div className="space-y-1">
          <div
            className="text-[16px] font-semibold"
            style={{ color: "var(--color-success)" }}
          >
            Todo en orden
          </div>
          <div
            className="text-[12.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            No hay cuelgues de Kernel-Power ni apagados inesperados en el
            registro de eventos reciente de Windows.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <ul className="space-y-2">
            {top.map((evt, idx) => {
              const detail = usefulDetail(evt, all);
              return (
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
                  {detail && (
                    <div
                      className="mt-1 truncate text-[12px]"
                      style={{ color: "var(--color-text-secondary)" }}
                      title={detail}
                    >
                      {detail}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {hidden > 0 && (
            <button
              type="button"
              onClick={onOpenSystem}
              disabled={!onOpenSystem}
              className="text-[11.5px] underline-offset-2 enabled:hover:underline"
              style={{ color: "var(--color-text-tertiary)" }}
              title={onOpenSystem ? "Ver el registro completo en Sistema" : undefined}
            >
              +{hidden} más{onOpenSystem ? " · ver en Sistema" : ""}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
