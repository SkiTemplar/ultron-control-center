// Diagnostics — Event Log Panel (collapsible)

import type { EventLogEntry, Fix } from "./types";
import { FIX_CATALOG, KNOWN_ERRORS, GENERIC_FIXES } from "./catalogs";
import { levelBadge } from "./helpers";

function EventLogRow({ evt, runFix, fixBusy }: { evt: EventLogEntry; runFix: (fix: Fix) => void | Promise<void>; fixBusy: string | null }) {
  const known = KNOWN_ERRORS[evt.event_id];
  const badge = levelBadge(evt.level);
  const fixKinds = known ? known.fixes : GENERIC_FIXES;

  return (
    <li className="px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide"
          style={{ background: badge.bg, color: badge.fg }}>
          {badge.label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]" style={{ color: "var(--color-text)" }}>
            <span className="font-semibold tabular-nums">id {evt.event_id}</span>
            <span className="truncate" style={{ color: "var(--color-text-secondary)" }} title={evt.source}>{evt.source || "—"}</span>
            <span className="ml-auto shrink-0 tabular-nums text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>{evt.time_created}</span>
          </div>
          {known ? (
            <div className="mt-1 text-[12.5px] leading-snug" style={{ color: "var(--color-text-secondary)" }}>{known.description}</div>
          ) : (
            evt.message && (
              <div className="mt-1 line-clamp-2 text-[12px] leading-snug"
                style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono, ui-monospace)" }}
                title={evt.message}>
                {evt.message}
              </div>
            )
          )}
          {fixKinds.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {fixKinds.map((k) => FIX_CATALOG[k]).filter((f): f is Fix => !!f).map((f) => {
                const busy = fixBusy === f.kind;
                return (
                  <button key={f.kind} type="button" onClick={() => void runFix(f)} disabled={fixBusy !== null}
                    title={f.detail}
                    className="rounded border px-2 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
                    style={{
                      borderColor: "var(--color-border-strong)",
                      background: busy ? "var(--color-accent)" : "var(--color-surface-3)",
                      color: busy ? "var(--color-accent-text)" : "var(--color-text)",
                    }}>
                    {busy ? "Running..." : f.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export function EventLogPanel({
  open,
  onToggle,
  events,
  loading,
  error,
  runFix,
  fixBusy,
  onRefresh,
}: {
  open: boolean;
  onToggle: () => void;
  events: EventLogEntry[];
  loading: boolean;
  error: string | null;
  runFix: (fix: Fix) => void | Promise<void>;
  fixBusy: string | null;
  onRefresh: () => void;
}) {
  const visible = events.slice(0, 25);

  return (
    <section className="rounded" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}>
      <header
        className="flex cursor-pointer items-center justify-between px-3 py-2"
        style={{ background: "var(--color-surface-1)", borderBottom: open ? "1px solid var(--color-border)" : "none" }}
        onClick={onToggle}
      >
        <div>
          <div className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
            Windows Event Log
            {events.length > 0 && (
              <span className="ml-2 rounded px-1.5 py-px text-[10px] font-medium"
                style={{ background: "rgba(248,81,73,0.15)", color: "var(--color-danger)" }}>
                {events.length} events
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            Errores recientes del Event Log de Windows (Critical + Error) con fixes sugeridos por ID.
          </div>
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRefresh(); }}
            disabled={loading}
            className="rounded px-2.5 py-0.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
            style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}
          >
            {loading ? "..." : "Refresh"}
          </button>
          <span className="font-mono text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            {open ? "▾" : "▸"}
          </span>
        </div>
      </header>

      {open && (
        <>
          {error && (
            <div className="m-3 rounded p-2 text-[12px]"
              style={{ background: "rgba(248,81,73,0.06)", border: "1px solid rgba(248,81,73,0.22)", color: "var(--color-danger)", fontFamily: "var(--font-mono, ui-monospace)" }}>
              {error}
            </div>
          )}
          {!loading && !error && events.length === 0 && (
            <div className="px-3 py-6 text-center text-[13px]" style={{ color: "var(--color-text-tertiary)" }}>
              No critical or error events found.
            </div>
          )}
          {visible.length > 0 && (
            <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
              {visible.map((evt, idx) => (
                <EventLogRow key={`${evt.time_created}-${idx}`} evt={evt} runFix={runFix} fixBusy={fixBusy} />
              ))}
            </ul>
          )}
          {events.length > visible.length && (
            <div className="px-3 py-2 text-[11px]" style={{ color: "var(--color-text-faint)" }}>
              ... {events.length - visible.length} more — open Event Viewer for the full list.
            </div>
          )}
        </>
      )}
    </section>
  );
}
