import { useEffect, useMemo, useState } from "react";
import type { AlertEntry } from "../types";

type Props = { alerts: AlertEntry[] };

// ---------------------------------------------------------------------------
// Severity styling
// ---------------------------------------------------------------------------

type SevWeight = 0 | 1 | 2;
type SevKey = "info" | "warn" | "critical";

type SevStyle = {
  color: string;
  bg: string;
  ring: string;
  label: string;
  key: SevKey;
  weight: SevWeight;
};

function severityStyle(sev: string): SevStyle {
  switch (sev) {
    case "critical":
    case "blocking":
      return {
        color: "var(--color-danger)",
        bg: "rgba(248, 81, 73, 0.06)",
        ring: "rgba(248, 81, 73, 0.20)",
        label: "critical",
        key: "critical",
        weight: 2,
      };
    case "warn":
      return {
        color: "var(--color-warn)",
        bg: "rgba(210, 153, 34, 0.05)",
        ring: "rgba(210, 153, 34, 0.18)",
        label: "warn",
        key: "warn",
        weight: 1,
      };
    case "info":
    default:
      return {
        color: "var(--color-text-tertiary)",
        bg: "transparent",
        ring: "var(--color-border)",
        label: "info",
        key: "info",
        weight: 0,
      };
  }
}

// ---------------------------------------------------------------------------
// Date filters
// ---------------------------------------------------------------------------

type DateFilter = "1h" | "24h" | "7d" | "all";

const DATE_LABEL: Record<DateFilter, string> = {
  "1h": "Last hour",
  "24h": "Last 24h",
  "7d": "Last 7 days",
  "all": "All",
};

function passesDateFilter(ts: string, filter: DateFilter): boolean {
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

// ---------------------------------------------------------------------------
// Dedupe: collapse identical alerts into a single row with count.
// ---------------------------------------------------------------------------

type Grouped = {
  source: string;
  message: string;
  severity: string;
  count: number;
  first_ts: string;
  last_ts: string;
};

function fingerprint(a: AlertEntry): string {
  const msg = (a.message ?? "").trim().replace(/\s+/g, " ");
  return `${a.source}::${msg.slice(0, 80)}`;
}

function getTs(a: AlertEntry): string {
  return a.timestamp ?? a.ts ?? "";
}

function dedupe(alerts: AlertEntry[]): Grouped[] {
  const map = new Map<string, Grouped>();
  for (const a of alerts) {
    const fp = fingerprint(a);
    const ts = getTs(a);
    const ex = map.get(fp);
    if (ex) {
      ex.count += 1;
      if (ts && (!ex.last_ts || ts > ex.last_ts)) ex.last_ts = ts;
      if (ts && (!ex.first_ts || ts < ex.first_ts)) ex.first_ts = ts;
    } else {
      map.set(fp, {
        source: a.source,
        message: a.message,
        severity: a.severity,
        count: 1,
        first_ts: ts,
        last_ts: ts,
      });
    }
  }
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const MUTE_KEY = "ultron.cc.muted_sources.v1";
const DISMISSED_KEY = "ultron.cc.dismissed_fingerprints.v1";

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}
function saveDismissed(d: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(d)));
  } catch {}
}
const SEV_KEY = "ultron.cc.sev_filters.v1";
const DATE_KEY = "ultron.cc.date_filter.v1";

function loadMutes(): Set<string> {
  try {
    const raw = localStorage.getItem(MUTE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}
function saveMutes(m: Set<string>) {
  try { localStorage.setItem(MUTE_KEY, JSON.stringify(Array.from(m))); } catch {}
}

function loadSevFilters(): Set<SevKey> {
  try {
    const raw = localStorage.getItem(SEV_KEY);
    if (!raw) return new Set(["info", "warn", "critical"]);
    return new Set(JSON.parse(raw));
  } catch {
    return new Set(["info", "warn", "critical"]);
  }
}
function saveSevFilters(s: Set<SevKey>) {
  try { localStorage.setItem(SEV_KEY, JSON.stringify(Array.from(s))); } catch {}
}

function loadDateFilter(): DateFilter {
  try {
    const raw = localStorage.getItem(DATE_KEY) as DateFilter | null;
    if (raw && ["1h", "24h", "7d", "all"].includes(raw)) return raw;
  } catch {}
  return "all";
}
function saveDateFilter(d: DateFilter) {
  try { localStorage.setItem(DATE_KEY, d); } catch {}
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function Row({ g }: { g: Grouped }) {
  const s = severityStyle(g.severity);
  const subtle = s.weight === 0;
  return (
    <div
      className="flex items-start gap-3 rounded p-3"
      style={{
        background: s.bg,
        border: `1px solid ${s.ring}`,
      }}
    >
      <span
        className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: s.color }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: s.color }}
          >
            {s.label}
          </span>
          <span
            className="text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {g.source}
          </span>
          {g.count > 1 && (
            <span
              className="rounded px-1.5 py-px text-[10px] font-medium tabular-nums"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-secondary)",
              }}
            >
              ×{g.count}
            </span>
          )}
          {g.last_ts && (
            <span
              className="ml-auto text-[10.5px] tabular-nums"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {g.last_ts.slice(0, 16).replace("T", " ")}
            </span>
          )}
        </div>
        <div
          className="mt-1 text-[12.5px] leading-snug"
          style={{
            color: subtle ? "var(--color-text-secondary)" : "var(--color-text)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
          title={g.message}
        >
          {g.message}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter pill
// ---------------------------------------------------------------------------

function Pill({
  active,
  label,
  count,
  onClick,
  color,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[11.5px] transition-colors"
      style={{
        background: active ? "var(--color-surface-3)" : "transparent",
        color: active ? "var(--color-text)" : "var(--color-text-tertiary)",
        border: `1px solid ${active ? "var(--color-border-strong)" : "var(--color-border)"}`,
      }}
    >
      {color && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: color, opacity: active ? 1 : 0.4 }}
        />
      )}
      <span>{label}</span>
      {typeof count === "number" && (
        <span
          className="tabular-nums"
          style={{ color: active ? "var(--color-text-secondary)" : "var(--color-text-faint)" }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function Notifications({ alerts }: Props) {
  const [mutes, setMutes] = useState<Set<string>>(() => loadMutes());
  const [sevFilters, setSevFilters] = useState<Set<SevKey>>(() => loadSevFilters());
  const [dateFilter, setDateFilter] = useState<DateFilter>(() => loadDateFilter());
  const [showMuteList, setShowMuteList] = useState(false);
  // Client-side "I've already seen this" set. Dismissed alerts disappear
  // from view until a new alert with a different fingerprint shows up. This
  // is non-destructive — alerts.jsonl on disk is untouched, so we can also
  // offer an "Undo dismiss" affordance.
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  useEffect(() => saveMutes(mutes), [mutes]);
  useEffect(() => saveSevFilters(sevFilters), [sevFilters]);
  useEffect(() => saveDateFilter(dateFilter), [dateFilter]);
  useEffect(() => saveDismissed(dismissed), [dismissed]);

  // Stats per severity (after date filter, before dedupe — counts raw alerts)
  const dateFiltered = useMemo(
    () => alerts.filter((a) => passesDateFilter(getTs(a), dateFilter)),
    [alerts, dateFilter],
  );

  const sevCounts = useMemo(() => {
    let info = 0,
      warn = 0,
      crit = 0;
    for (const a of dateFiltered) {
      const w = severityStyle(a.severity).weight;
      if (w === 0) info++;
      else if (w === 1) warn++;
      else crit++;
    }
    return { info, warn, critical: crit };
  }, [dateFiltered]);

  const allGroups = useMemo(() => dedupe(dateFiltered), [dateFiltered]);

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const g of allGroups) set.add(g.source);
    return Array.from(set).sort();
  }, [allGroups]);

  // Compute group fingerprint the same way dedupe does so dismissed-set
  // lookups line up.
  const groupKey = (g: { source: string; message: string }) =>
    `${g.source}::${(g.message ?? "").trim().replace(/\s+/g, " ").slice(0, 80)}`;

  const visibleGroups = useMemo(
    () =>
      allGroups
        .filter((g) => sevFilters.has(severityStyle(g.severity).key))
        .filter((g) => !mutes.has(g.source))
        .filter((g) => !dismissed.has(groupKey(g)))
        .sort(
          (a, b) =>
            severityStyle(b.severity).weight - severityStyle(a.severity).weight ||
            b.count - a.count,
        ),
    [allGroups, sevFilters, mutes, dismissed],
  );

  const visibleTotal = visibleGroups.reduce((acc, g) => acc + g.count, 0);

  function toggleSev(key: SevKey) {
    const next = new Set(sevFilters);
    if (next.has(key)) {
      if (next.size > 1) next.delete(key);
    } else {
      next.add(key);
    }
    setSevFilters(next);
  }
  function toggleMute(src: string) {
    const next = new Set(mutes);
    if (next.has(src)) next.delete(src);
    else next.add(src);
    setMutes(next);
  }

  const dateFilters: DateFilter[] = ["1h", "24h", "7d", "all"];

  return (
    <div className="px-10 py-8">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold leading-tight">Notifications</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
          {visibleGroups.length} unique · {visibleTotal} total {DATE_LABEL[dateFilter].toLowerCase()}
        </p>
      </header>

      {/* Severity filters */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Pill
          label="Critical"
          color="var(--color-danger)"
          active={sevFilters.has("critical")}
          count={sevCounts.critical}
          onClick={() => toggleSev("critical")}
        />
        <Pill
          label="Warn"
          color="var(--color-warn)"
          active={sevFilters.has("warn")}
          count={sevCounts.warn}
          onClick={() => toggleSev("warn")}
        />
        <Pill
          label="Info"
          color="var(--color-text-tertiary)"
          active={sevFilters.has("info")}
          count={sevCounts.info}
          onClick={() => toggleSev("info")}
        />

        <div className="mx-2 h-4 w-px" style={{ background: "var(--color-border-strong)" }} />

        {/* Date filters */}
        {dateFilters.map((d) => (
          <Pill
            key={d}
            label={DATE_LABEL[d]}
            active={dateFilter === d}
            onClick={() => setDateFilter(d)}
          />
        ))}

        <div className="ml-auto flex items-center gap-2">
          {(() => {
            const infoVisible = visibleGroups.filter(
              (g) => severityStyle(g.severity).key === "info",
            );
            return (
              <button
                type="button"
                onClick={() => {
                  if (infoVisible.length === 0) return;
                  const next = new Set(dismissed);
                  for (const g of infoVisible) next.add(groupKey(g));
                  setDismissed(next);
                }}
                disabled={infoVisible.length === 0}
                title="Marca como vistas las notificaciones info actualmente visibles"
                className="text-[11px] transition-colors disabled:opacity-30"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Clear info ({infoVisible.length})
              </button>
            );
          })()}
          {dismissed.size > 0 && (
            <button
              type="button"
              onClick={() => setDismissed(new Set())}
              title="Restaura todas las notificaciones descartadas"
              className="text-[11px] transition-colors"
              style={{ color: "var(--color-text-faint)" }}
            >
              Undo ({dismissed.size})
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowMuteList(!showMuteList)}
            className="text-[11px] transition-colors"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {showMuteList ? "Hide mute list" : `Mute sources (${mutes.size})`}
          </button>
        </div>
      </div>

      {/* Mute list panel */}
      {showMuteList && sources.length > 0 && (
        <div
          className="mb-6 rounded p-3"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div
            className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Mute by source
          </div>
          <div className="flex flex-wrap gap-1.5">
            {sources.map((src) => {
              const muted = mutes.has(src);
              return (
                <button
                  key={src}
                  type="button"
                  onClick={() => toggleMute(src)}
                  className="rounded px-2 py-0.5 text-[11px] transition-colors"
                  style={{
                    background: muted ? "transparent" : "var(--color-surface-3)",
                    color: muted ? "var(--color-text-faint)" : "var(--color-text-secondary)",
                    border: `1px solid ${muted ? "var(--color-border)" : "var(--color-border-strong)"}`,
                    textDecoration: muted ? "line-through" : "none",
                  }}
                >
                  {src}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {visibleGroups.length === 0 && (
        <div
          className="rounded p-6 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          {alerts.length === 0
            ? "No notifications. System is quiet."
            : "No notifications match the current filters."}
        </div>
      )}

      <div className="space-y-2">
        {visibleGroups.map((g, i) => (
          <Row key={`${g.source}-${i}`} g={g} />
        ))}
      </div>
    </div>
  );
}
