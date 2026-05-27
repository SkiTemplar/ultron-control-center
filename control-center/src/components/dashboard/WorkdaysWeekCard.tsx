// WorkdaysWeekCard — Dashboard widget que muestra la actividad de la semana.
//
// Diseño: 7 columnas verticales (lun→dom), cada columna apila barras por
// proyecto con color distintivo. Sin librerías de charts externas — CSS flex
// puro. El día de hoy lleva un dot indicator brillante en el label.
//
// Datos: llama a `list_workdays` filtrando los últimos 7 días.
// Cada workday expone `focus_seconds` (tiempo real de trabajo) y `project_id`
// (proyecto al que pertenece). Cuando `focus_seconds === 0` pero el workday
// está `in_progress`, se usa el tiempo transcurrido desde `start_ts`.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Workday } from "../../types";
import { Card } from "./Card";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Formato ISO-8601 para una fecha local (YYYY-MM-DD). */
function localDateIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Devuelve los últimos 7 días como strings YYYY-MM-DD, de más antiguo a más
 *  reciente (índice 6 = hoy). */
function last7Days(): string[] {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(localDateIso(d));
  }
  return days;
}

/** Etiqueta corta del día de la semana (lun, mar…) en es-ES. */
function shortWeekday(iso: string): string {
  const [y, m, dd] = iso.split("-").map(Number);
  const d = new Date(y, m - 1, dd);
  return d.toLocaleDateString("es-ES", { weekday: "short" }).replace(".", "");
}

/** Segundos de trabajo efectivos de un workday. Si está en_curso y
 *  focus_seconds === 0, estima a partir de start_ts. */
function effectiveSeconds(wd: Workday): number {
  if (wd.focus_seconds > 0) return wd.focus_seconds;
  if (wd.status === "in_progress" && wd.start_ts) {
    // start_ts puede ser "epoch:<secs>" o ISO-8601
    let startMs: number;
    if (wd.start_ts.startsWith("epoch:")) {
      startMs = Number(wd.start_ts.slice(6)) * 1000;
    } else {
      startMs = new Date(wd.start_ts).getTime();
    }
    if (!Number.isNaN(startMs)) {
      return Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    }
  }
  return 0;
}

function formatHours(secs: number): string {
  const h = secs / 3600;
  if (h < 0.1) return "< 6 min";
  if (h < 1) return `${Math.round(h * 60)} min`;
  return `${h.toFixed(1)} h`;
}

// ─── Paleta de colores por proyecto ─────────────────────────────────────────
// Máximo 10 proyectos distintos; el resto usa el slot 9 (gris).

const PROJECT_COLORS = [
  "#4c8bf5", // azul
  "#34a853", // verde
  "#fbbc04", // amarillo
  "#ea4335", // rojo
  "#a142f4", // violeta
  "#24c1e0", // cian
  "#ff7043", // naranja
  "#ec407a", // rosa
  "#8bc34a", // verde claro
  "#78909c", // gris-azulado (fallback)
];

// ─── Tipos internos ──────────────────────────────────────────────────────────

interface DayBar {
  date: string;        // YYYY-MM-DD
  label: string;       // lun, mar…
  isToday: boolean;
  slices: Array<{
    projectId: string | null;
    projectLabel: string;
    seconds: number;
    color: string;
  }>;
  totalSeconds: number;
}

// ─── Componente ─────────────────────────────────────────────────────────────

export function WorkdaysWeekCard() {
  const [workdays, setWorkdays] = useState<Workday[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tooltip, setTooltip] = useState<{
    dayLabel: string;
    projectLabel: string;
    seconds: number;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const days = last7Days();
        const dateFrom = days[0];
        const dateTo = days[6];
        const r = await invoke<Workday[]>("list_workdays", {
          statusFilter: null,
          dateFrom,
          dateTo,
          limit: null,
        });
        if (!cancelled) setWorkdays(r);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  // ── Construir mapa proyecto → color ────────────────────────────────────────

  const projectColorMap = new Map<string, string>();
  let colorIdx = 0;

  function colorForProject(id: string | null): string {
    const key = id ?? "__orphan__";
    if (!projectColorMap.has(key)) {
      projectColorMap.set(key, PROJECT_COLORS[colorIdx % PROJECT_COLORS.length]);
      colorIdx++;
    }
    return projectColorMap.get(key)!;
  }

  // ── Agrupar workdays por día ────────────────────────────────────────────────

  const days = last7Days();
  const todayIso = days[6];

  const dayBars: DayBar[] = days.map((dateIso) => {
    const wds = (workdays ?? []).filter((wd) => wd.planned_date === dateIso);
    const slices = wds.map((wd) => ({
      projectId: wd.project_id ?? null,
      projectLabel: wd.project_id ?? "Sin proyecto",
      seconds: effectiveSeconds(wd),
      color: colorForProject(wd.project_id ?? null),
    })).filter((s) => s.seconds > 0);

    const totalSeconds = slices.reduce((acc, s) => acc + s.seconds, 0);
    return {
      date: dateIso,
      label: shortWeekday(dateIso),
      isToday: dateIso === todayIso,
      slices,
      totalSeconds,
    };
  });

  // ── Métricas del header ────────────────────────────────────────────────────

  const totalSecsWeek = dayBars.reduce((acc, d) => acc + d.totalSeconds, 0);
  const activeDays = dayBars.filter((d) => d.totalSeconds > 0).length;
  const projectSet = new Set(
    (workdays ?? [])
      .filter((wd) => effectiveSeconds(wd) > 0)
      .map((wd) => wd.project_id ?? "__orphan__")
  );
  const totalProjects = projectSet.size;

  const maxSeconds = Math.max(...dayBars.map((d) => d.totalSeconds), 1);

  // ── Altura máxima de la barra (px) ────────────────────────────────────────
  const BAR_MAX_PX = 80;

  function barHeightPx(secs: number): number {
    return Math.max(2, Math.round((secs / maxSeconds) * BAR_MAX_PX));
  }

  // ── Vacío ─────────────────────────────────────────────────────────────────

  const isEmpty = !loading && (workdays ?? []).length === 0;

  return (
    <Card
      title="Semana de trabajo"
      subtitle={
        loading
          ? "Cargando..."
          : isEmpty
          ? "Sin actividad esta semana"
          : `${formatHours(totalSecsWeek)} · ${totalProjects} proyecto${totalProjects !== 1 ? "s" : ""} · ${activeDays} día${activeDays !== 1 ? "s" : ""} activo${activeDays !== 1 ? "s" : ""}`
      }
      accent={activeDays > 0 ? "ok" : "neutral"}
      loading={loading}
      error={error}
      empty={
        isEmpty
          ? "No hay workdays esta semana. Empieza a trabajar para ver tu tiempo registrado."
          : null
      }
    >
      {/* Tooltip flotante */}
      {tooltip && (
        <div
          className="pointer-events-none fixed z-50 rounded px-2.5 py-1.5 text-[11.5px] shadow-lg"
          style={{
            top: tooltip.y - 8,
            left: tooltip.x + 10,
            background: "var(--color-surface-3)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text)",
            transform: "translateY(-100%)",
          }}
        >
          <span className="font-medium">{tooltip.projectLabel}</span>
          <span style={{ color: "var(--color-text-tertiary)" }}>
            {" — "}{formatHours(tooltip.seconds)}
          </span>
          <div style={{ color: "var(--color-text-faint)" }}>{tooltip.dayLabel}</div>
        </div>
      )}

      {/* Gráfico de barras */}
      <div className="flex items-end justify-between gap-1" style={{ height: BAR_MAX_PX + 28 }}>
        {dayBars.map((day) => (
          <div
            key={day.date}
            className="flex flex-1 flex-col items-center gap-1"
            style={{ minWidth: 0 }}
          >
            {/* Columna de barras */}
            <div
              className="relative flex w-full flex-col-reverse items-stretch justify-start overflow-hidden rounded-sm"
              style={{
                height: BAR_MAX_PX,
                background: "var(--color-surface-3)",
              }}
            >
              {day.slices.length === 0 ? (
                // Día sin actividad: barra fantasma muy tenue
                <div
                  className="w-full rounded-sm"
                  style={{
                    height: 2,
                    background: "var(--color-border)",
                  }}
                />
              ) : (
                day.slices.map((slice, i) => {
                  const h = barHeightPx(slice.seconds);
                  return (
                    <div
                      key={i}
                      className="w-full flex-shrink-0 cursor-default transition-opacity hover:opacity-80"
                      style={{
                        height: h,
                        background: slice.color,
                        opacity: day.isToday ? 1 : 0.75,
                      }}
                      onMouseEnter={(e) =>
                        setTooltip({
                          dayLabel: day.label,
                          projectLabel: slice.projectLabel,
                          seconds: slice.seconds,
                          x: e.clientX,
                          y: e.clientY,
                        })
                      }
                      onMouseMove={(e) =>
                        setTooltip((prev) =>
                          prev
                            ? { ...prev, x: e.clientX, y: e.clientY }
                            : null
                        )
                      }
                      onMouseLeave={() => setTooltip(null)}
                      title={`${slice.projectLabel} — ${formatHours(slice.seconds)}`}
                    />
                  );
                })
              )}
            </div>

            {/* Label del día */}
            <div className="flex flex-col items-center gap-0.5">
              <span
                className="text-[10.5px] tabular-nums"
                style={{
                  color: day.isToday
                    ? "var(--color-accent)"
                    : "var(--color-text-tertiary)",
                  fontWeight: day.isToday ? 600 : 400,
                }}
              >
                {day.label}
              </span>
              {/* Dot indicator: hoy con actividad → brillante; hoy sin → gris; resto → oculto */}
              <div
                className="rounded-full"
                style={{
                  width: 5,
                  height: 5,
                  background: day.isToday
                    ? day.totalSeconds > 0
                      ? "var(--color-accent)"
                      : "var(--color-border-strong)"
                    : "transparent",
                  boxShadow:
                    day.isToday && day.totalSeconds > 0
                      ? "0 0 4px var(--color-accent)"
                      : "none",
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
