// ULTRON Control Center — Monitor de sesiones activas: tarjeta individual.
//
// Muestra el estado en vivo de una sesión Claude Code:
//   - Badge de estado con color semántico
//   - Modelo + branch
//   - Barra de context% (verde < 70, ámbar 70-90, rojo > 90)
//   - Contadores de tokens (context / cache / output)
//   - last_activity_summary y last_prompt recortado
//   - "hace X min" desde age_seconds
//   - Botón "Abrir en Projects" (solo si matched_project_id != null)
//   - Badge "subagente" cuando is_subagent = true

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionInfo } from "./sessionTypes";

// ---------------------------------------------------------------------------
// Cache de resúmenes reales por session_id.
// A nivel de módulo: sobrevive re-renders Y unmount/remount del componente
// (p.ej. cuando la sesión pasa a "dead" y se oculta/muestra de nuevo).
// ---------------------------------------------------------------------------
const realSummaryCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helpers de presentación
// ---------------------------------------------------------------------------

/** Formatea age_seconds como "hace X s" / "hace X min" / "hace X h". */
function formatAge(seconds: number): string {
  if (seconds < 60) return `hace ${seconds}s`;
  if (seconds < 3600) return `hace ${Math.floor(seconds / 60)}min`;
  return `hace ${Math.floor(seconds / 3600)}h`;
}

/** Recorta un string a maxLen caracteres añadiendo "…" si es necesario. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

/** Extrae solo el nombre del modelo sin el prefijo del proveedor. */
function shortModel(model: string | null): string {
  if (!model) return "—";
  // p.ej. "claude-sonnet-4-5" → "sonnet-4-5"
  const parts = model.split("-");
  if (parts.length > 1 && parts[0] === "claude") {
    return parts.slice(1).join("-");
  }
  return model;
}

// ---------------------------------------------------------------------------
// Badge de estado
// ---------------------------------------------------------------------------

type StatusBadgeProps = { status: SessionInfo["status"] };

function StatusBadge({ status }: StatusBadgeProps) {
  const map: Record<
    SessionInfo["status"],
    { label: string; bg: string; color: string; dot: string }
  > = {
    working: {
      label: "working",
      bg: "rgba(63,185,80,0.12)",
      color: "var(--color-success, #3fb950)",
      dot: "var(--color-success, #3fb950)",
    },
    waiting: {
      label: "waiting",
      bg: "rgba(59,130,246,0.12)",
      color: "#3b82f6",
      dot: "#3b82f6",
    },
    idle: {
      label: "idle",
      bg: "rgba(210,153,34,0.12)",
      color: "var(--color-warn, #d2991f)",
      dot: "var(--color-warn, #d2991f)",
    },
    dead: {
      label: "dead",
      bg: "rgba(120,120,120,0.12)",
      color: "var(--color-text-tertiary)",
      dot: "var(--color-text-faint)",
    },
  };

  const cfg = map[status] ?? map.idle;

  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.bg}` }}
    >
      {/* Punto de estado */}
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: cfg.dot,
          flexShrink: 0,
        }}
      />
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Barra de contexto
// ---------------------------------------------------------------------------

type ContextBarProps = { pct: number };

function ContextBar({ pct }: ContextBarProps) {
  const clamped = Math.max(0, Math.min(100, pct));

  let color: string;
  if (clamped < 70) {
    color = "var(--color-success, #3fb950)";
  } else if (clamped < 90) {
    color = "var(--color-warn, #d2991f)";
  } else {
    color = "var(--color-danger, #ef4444)";
  }

  return (
    <div className="flex items-center gap-2">
      <div
        className="relative flex-1 rounded-full overflow-hidden"
        style={{ height: 4, background: "var(--color-surface-3)" }}
        title={`Contexto: ${clamped.toFixed(1)}%`}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Uso de contexto ${clamped.toFixed(1)}%`}
      >
        <div
          style={{
            width: `${clamped}%`,
            height: "100%",
            background: color,
            borderRadius: "inherit",
            transition: "width 0.3s ease",
          }}
        />
      </div>
      <span
        className="shrink-0 text-[10px] tabular-nums"
        style={{ color, minWidth: 36, textAlign: "right" }}
      >
        {clamped.toFixed(1)}%
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props del card
// ---------------------------------------------------------------------------

interface SessionCardProps {
  session: SessionInfo;
  onOpenProject?: (projectId: string) => void;
}

// ---------------------------------------------------------------------------
// SessionCard — componente principal
// ---------------------------------------------------------------------------

export function SessionCard({ session, onOpenProject }: SessionCardProps) {
  const {
    session_id,
    project_name,
    git_branch,
    model,
    context_tokens,
    context_limit,
    context_pct,
    cache_read_tokens,
    output_tokens,
    status,
    age_seconds,
    last_prompt,
    last_activity_summary,
    matched_project_id,
    is_subagent,
  } = session;

  // ── Resumen real (lazy, cacheado) ────────────────────────────────────────
  // Muestra last_activity_summary (truncado crudo) como placeholder inmediato.
  // Invoca summarize_session_activity UNA VEZ por session_id y reemplaza cuando
  // resuelve. Si rechaza, mantiene el placeholder sin ruido en UI.
  const [realSummary, setRealSummary] = useState<string | null>(
    () => realSummaryCache.get(session_id) ?? null,
  );
  const [summaryFetching, setSummaryFetching] = useState(false);

  useEffect(() => {
    // Acierto de caché — no re-invocar (cubre el caso de remount)
    if (realSummaryCache.has(session_id)) {
      setRealSummary(realSummaryCache.get(session_id) ?? null);
      return;
    }

    setSummaryFetching(true);
    invoke<string>("summarize_session_activity", { sessionId: session_id })
      .then((summary) => {
        realSummaryCache.set(session_id, summary);
        setRealSummary(summary);
      })
      .catch((e: unknown) => {
        console.debug("[SessionCard] summarize_session_activity rejected:", e);
      })
      .finally(() => {
        setSummaryFetching(false);
      });
  }, [session_id]);
  // ─────────────────────────────────────────────────────────────────────────

  const canOpenProject = matched_project_id !== null;

  const handleOpenProject = () => {
    if (canOpenProject && onOpenProject) {
      onOpenProject(matched_project_id);
    }
  };

  // Formatea números de tokens de forma compacta
  const fmtTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
    return String(n);
  };

  return (
    <div
      className="flex flex-col gap-2.5 rounded-md p-3"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      {/* ── Fila 1: estado + modelo + branch + subagente badge ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={status} />

        {is_subagent && (
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              background: "rgba(168,85,247,0.12)",
              color: "#a855f7",
              border: "1px solid rgba(168,85,247,0.25)",
            }}
          >
            subagente
          </span>
        )}

        <span
          className="ml-auto text-[10px] tabular-nums"
          style={{ color: "var(--color-text-tertiary)" }}
          title={`Session ID: ${session_id}`}
        >
          {formatAge(age_seconds)}
        </span>
      </div>

      {/* ── Fila 2: modelo + branch ── */}
      <div className="flex flex-wrap items-center gap-3">
        {model && (
          <span
            className="text-[11px] font-medium"
            style={{
              color: "var(--color-text-secondary)",
              fontFamily: "var(--font-mono)",
            }}
            title={model}
          >
            {shortModel(model)}
          </span>
        )}
        {git_branch && (
          <span
            className="flex items-center gap-1 text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {/* Icono de branch SVG inline */}
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden
              style={{ flexShrink: 0 }}
            >
              <path d="M5.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-1.5.75a2.25 2.25 0 1 1 2.894 2.165v.585a2.25 2.25 0 0 1-2.25 2.25h-2a.75.75 0 0 1 0-1.5h2a.75.75 0 0 0 .75-.75v-.585A2.25 2.25 0 0 1 4.25 3.25zm7.5 1.25a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM10 5.414V7.75a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 0 0 1.5h1.75v2.086a2.25 2.25 0 1 0 1.5 0V9.25a.75.75 0 0 0-.75-.75H8.5V7.75A2.25 2.25 0 0 0 6.25 5.5H4.5a.75.75 0 0 0 0 1.5h1.75a.75.75 0 0 1 .75.75v.414A2.25 2.25 0 0 0 10 5.414zm1.5 7.586a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z" />
            </svg>
            <span style={{ fontFamily: "var(--font-mono)" }}>{git_branch}</span>
          </span>
        )}
      </div>

      {/* ── Fila 3: barra de contexto ── */}
      <ContextBar pct={context_pct} />

      {/* ── Fila 4: contadores de tokens ── */}
      <div className="flex flex-wrap gap-3">
        <TokenStat
          label="ctx"
          value={`${fmtTokens(context_tokens)}/${fmtTokens(context_limit)}`}
        />
        <TokenStat label="cache" value={fmtTokens(cache_read_tokens)} />
        <TokenStat label="out" value={fmtTokens(output_tokens)} />
      </div>

      {/* ── Fila 5: resumen real (AI) / placeholder crudo ── */}
      {(realSummary !== null || last_activity_summary !== null) && (
        <p
          className="text-[11px] leading-snug"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {realSummary === null && summaryFetching && (
            <span
              className="mr-1 text-[9.5px]"
              style={{ color: "var(--color-text-faint)" }}
              aria-hidden
            >
              ···
            </span>
          )}
          {truncate(realSummary ?? last_activity_summary ?? "", 120)}
        </p>
      )}

      {/* ── Fila 6: último prompt recortado ── */}
      {last_prompt && (
        <p
          className="text-[10.5px] leading-snug"
          style={{
            color: "var(--color-text-tertiary)",
            fontFamily: "var(--font-mono)",
            wordBreak: "break-word",
          }}
          title={last_prompt}
        >
          {truncate(last_prompt, 100)}
        </p>
      )}

      {/* ── Fila 7: botón "Abrir en Projects" ── */}
      <div className="pt-0.5">
        <button
          type="button"
          onClick={handleOpenProject}
          disabled={!canOpenProject}
          title={
            canOpenProject
              ? `Abrir proyecto ${project_name} en Projects`
              : "Proyecto no registrado en ULTRON — registralo desde la pestaña Projects"
          }
          className="rounded px-2 py-1 text-[10.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            background: canOpenProject
              ? "rgba(59,130,246,0.10)"
              : "var(--color-surface-3)",
            color: canOpenProject
              ? "#3b82f6"
              : "var(--color-text-tertiary)",
            border: canOpenProject
              ? "1px solid rgba(59,130,246,0.30)"
              : "1px solid var(--color-border)",
          }}
          onMouseEnter={(e) => {
            if (!canOpenProject) return;
            e.currentTarget.style.background = "rgba(59,130,246,0.18)";
          }}
          onMouseLeave={(e) => {
            if (!canOpenProject) return;
            e.currentTarget.style.background = "rgba(59,130,246,0.10)";
          }}
        >
          Abrir en Projects
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TokenStat — mini stat inline
// ---------------------------------------------------------------------------

interface TokenStatProps {
  label: string;
  value: string;
}

function TokenStat({ label, value }: TokenStatProps) {
  return (
    <div className="flex items-baseline gap-1">
      <span
        className="text-[9.5px] uppercase tracking-wider"
        style={{ color: "var(--color-text-faint)" }}
      >
        {label}
      </span>
      <span
        className="text-[11px] font-medium tabular-nums"
        style={{
          color: "var(--color-text-secondary)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {value}
      </span>
    </div>
  );
}
