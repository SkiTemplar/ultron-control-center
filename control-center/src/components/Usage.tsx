import { useEffect, useRef, useState } from "react";
import { invokeWithTimeout } from "../lib/invoke-timeout";
import { errMsg } from "../lib/errors";
import { ActivityTab } from "./usage/ActivityTab";
import type { UsageReport } from "../types";
import { DailyBars, HourHisto, ModelTable, WindowCard } from "./usage/StatParts";
import { formatInt } from "./usage/format";
import { PlanLimitsCard } from "./usage/PlanLimitsCard";

// 2026-10-17: the manual "Weekly reset" card (day/time typed into
// localStorage) is gone. It disagreed with the server reset shown by the Weekly
// gauge and drew a second weekly bar with another meaning; the elapsed share
// of the week is now a tick on that gauge (PlanLimitsCard).

// ---------------------------------------------------------------------------
// Window card (today / 7d / 30d)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tab "Overview" — Claude usage stats + quota
// ---------------------------------------------------------------------------

type OverviewTabProps = {
  data: UsageReport | null;
  refreshKey: number;
};

function OverviewTab({ data, refreshKey }: OverviewTabProps) {
  return (
    <div>
      <PlanLimitsCard refreshKey={refreshKey} />

      {/* Cache freshness warning */}
      {data && data.cache_age_days !== null && data.cache_age_days > 1 && (
        <div
          className="mb-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(210, 153, 34, 0.05)",
            border: "1px solid rgba(210, 153, 34, 0.18)",
            color: "var(--color-warn)",
          }}
        >
          stats-cache.json se calculó por última vez hace {data.cache_age_days} días (
          {data.last_computed_date}). Claude Code lo actualiza con los eventos de sesión
          y con /usage. Abre <span style={{ fontFamily: "var(--font-mono)" }}>claude /usage</span>{" "}
          en modo interactivo para traer del servidor los últimos límites semanales.
        </div>
      )}

      {data && (
        <>
          {/* All-time summary */}
          <div
            className="mb-4 flex flex-wrap items-baseline gap-4 rounded p-3"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-text-tertiary)" }}>
                Sesiones totales
              </div>
              <div
                className="text-[16px] font-semibold tabular-nums"
                style={{ color: "var(--color-text)" }}
              >
                {formatInt(data.total_sessions)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-text-tertiary)" }}>
                Prompts totales
              </div>
              <div
                className="text-[16px] font-semibold tabular-nums"
                style={{ color: "var(--color-text)" }}
              >
                {formatInt(data.total_messages)}
              </div>
            </div>
            {data.first_session_date && (
              <div>
                <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--color-text-tertiary)" }}>
                  Desde
                </div>
                <div
                  className="text-[12px] tabular-nums"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {data.first_session_date.slice(0, 10)}
                </div>
              </div>
            )}
          </div>

          {/* Window cards */}
          <div className="grid grid-cols-3 gap-3">
            <WindowCard title="Hoy" hint="24 h" w={data.today} />
            <WindowCard title="Esta semana" hint="7 días" w={data.last_7_days} emphasized />
            <WindowCard title="30 días" hint="mes" w={data.last_30_days} />
          </div>

          {/* Daily bars */}
          {data.daily_recent.length > 0 && (
            <section
              className="mt-6 rounded p-4"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-[13px] font-semibold">Tokens por día (14 días)</h2>
                <span
                  className="text-[10px]"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  pasa el ratón por una barra para ver el detalle
                </span>
              </div>
              <DailyBars data={data.daily_recent} />
            </section>
          )}

          {/* Model totals */}
          {data.model_totals.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-2 text-[13px] font-semibold">Totales por modelo (histórico)</h2>
              <ModelTable models={data.model_totals} />
            </section>
          )}

          {/* Hour histogram */}
          {data.hour_counts.some((c) => c > 0) && (
            <section
              className="mt-6 rounded p-4"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-[13px] font-semibold">Sesiones por hora (UTC)</h2>
                <span
                  className="text-[10px]"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  24 h
                </span>
              </div>
              <HourHisto counts={data.hour_counts} />
              <div className="mt-1 flex justify-between text-[9px]" style={{ color: "var(--color-text-faint)" }}>
                <span>00</span>
                <span>06</span>
                <span>12</span>
                <span>18</span>
                <span>23</span>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Plazo de claude_usage: cubre el recorrido en frío de todos los transcripts. */
const USAGE_TIMEOUT_MS = 90_000;

export function Usage() {
  const [data, setData] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Wiring 2026-08-11 (audit 08-09 #43): pestaña Activity con el timeline de
  // actividad de todo el sistema (compute_activity_timeline).
  const [tab, setTab] = useState<"overview" | "activity">("overview");
  // One Refresh button for the whole tab: bumping the key forces a reload of
  // the plan limits (Overview) or of the activity timeline (Activity).
  const [refreshKey, setRefreshKey] = useState(0);

  function refresh() {
    setRefreshKey((k) => k + 1);
    if (tab === "overview") void load();
  }

  async function load() {
    // Una sola carga a la vez: el intervalo de 60 s y cada foco de la ventana
    // lanzaban un recorrido completo nuevo aunque el anterior no hubiera
    // terminado, y se apilaban en el backend.
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      // claude_usage recorre todos los transcripts (~12 s en caliente con
      // 3,2 GB; en frío, bastante más): plazo amplio, pero plazo. Sin él, una
      // respuesta que no llega dejaba el botón en «Cargando…» para siempre.
      const r = await invokeWithTimeout<UsageReport>("claude_usage", undefined, USAGE_TIMEOUT_MS);
      setData(r);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    // Auto-refresh when the window gets focus — typical scenario: the user
    // came back from a Claude /usage terminal tab and expects the panel to
    // reflect whatever the session just wrote into stats-cache.json.
    const onFocus = () => {
      load();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return (
    <div className="px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Uso</h1>
          <p
            className="mt-1 text-[13px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {tab === "overview"
              ? `Consumo de Claude Code · fuente: ${
                  data?.source === "transcripts"
                    ? "~/.claude/projects/**/*.jsonl (subagentes incluidos)"
                    : "~/.claude/stats-cache.json"
                }`
              : "Cronología de actividad del sistema · alertas, routing, kanban"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <nav className="flex gap-1" role="tablist" aria-label="Secciones de Uso">
            {(
              [
                ["overview", "Resumen"],
                ["activity", "Actividad"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className="rounded px-3 py-1.5 text-[12px] transition-colors"
                style={{
                  background: tab === id ? "var(--color-surface-3)" : "transparent",
                  color: tab === id ? "var(--color-text)" : "var(--color-text-secondary)",
                  border: `1px solid ${
                    tab === id ? "var(--color-border-strong)" : "transparent"
                  }`,
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            onClick={refresh}
            disabled={tab === "overview" && loading}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {tab === "overview" && loading ? "Cargando…" : "Actualizar"}
          </button>
        </div>
      </header>

      {error && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {tab === "overview" && (
        <OverviewTab data={data} refreshKey={refreshKey} />
      )}
      {tab === "activity" && <ActivityTab refreshKey={refreshKey} />}
    </div>
  );
}
