// Bitácora del proyecto — el historial de sesiones resumidas.
//
// `session-summarize-previous.js` escribe un summary.md por sesión desde el
// 2026-09-11, pero hasta ahora sólo lo leía el hook de SessionStart: el dato
// existía y no había forma de verlo. Esta vista lo saca a la GUI para
// responder de un vistazo a "¿qué fue lo último que trabajé aquí?".
//
// El listado llega sin cuerpos (una entrada son ~200 bytes); el markdown
// completo se pide al desplegar una tarjeta.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionLogEntry } from "../../types";

function formatDuration(min: number | null): string | null {
  if (min === null || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

/// "hoy", "ayer", "hace 5 d", o la fecha cuando ya no dice nada un relativo.
function formatWhen(iso: string | null, mtimeSecs: number): string {
  const ms = iso ? Date.parse(iso) : mtimeSecs * 1000;
  if (Number.isNaN(ms)) return "fecha desconocida";
  const d = new Date(ms);
  const today = new Date();
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(today) - dayStart(d)) / 86_400_000);
  if (days === 0) return "hoy";
  if (days === 1) return "ayer";
  if (days < 7) return `hace ${days} d`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function EntryCard({
  entry,
  projectId,
}: {
  entry: SessionLogEntry;
  projectId: string;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || body !== null) return;
    try {
      const md = (await invoke("project_session_entry", {
        projectId,
        sessionId: entry.session_id,
      })) as string;
      setBody(md);
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    }
  }

  const duration = formatDuration(entry.duration_min);
  const when = formatWhen(entry.started_at, entry.file_mtime);

  return (
    <div
      className="rounded"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        className="flex w-full flex-col items-start gap-1 p-3 text-left transition-colors"
      >
        <div
          className="flex flex-wrap items-baseline gap-x-2 text-[10.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <span>{when}</span>
          {duration && <span>· {duration}</span>}
          {entry.model && <span>· {entry.model}</span>}
          {entry.degraded && (
            <span style={{ color: "var(--color-warning, #ffb224)" }}>· sin cabecera</span>
          )}
        </div>
        <div className="text-[13px] font-medium leading-snug">
          {entry.headline ?? (
            <span style={{ color: "var(--color-text-tertiary)" }}>Resumen sin temas</span>
          )}
        </div>
        {entry.pending_count > 0 && (
          <div className="text-[11px]" style={{ color: "var(--color-text-secondary)" }}>
            {entry.pending_count} pendiente{entry.pending_count === 1 ? "" : "s"}
          </div>
        )}
      </button>

      {open && (
        <div className="border-t px-3 py-2" style={{ borderColor: "var(--color-border)" }}>
          {loadError && (
            <p className="text-[12px]" style={{ color: "var(--color-danger, #e5484d)" }}>
              {loadError}
            </p>
          )}
          {!loadError && body === null && (
            <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              Cargando…
            </p>
          )}
          {body !== null && (
            <pre
              className="max-h-[420px] overflow-auto whitespace-pre-wrap text-[11.5px] leading-relaxed"
              style={{ color: "var(--color-text-secondary)", fontFamily: "inherit" }}
            >
              {body}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function SessionLogModal({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<SessionLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = (await invoke("project_session_log", { projectId })) as SessionLogEntry[];
      setEntries(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-8"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-full w-full max-w-2xl flex-col rounded"
        style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border)" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Bitácora de ${projectName}`}
      >
        <header
          className="flex shrink-0 items-baseline justify-between gap-4 border-b px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div>
            <h2 className="text-[14px] font-semibold">Bitácora</h2>
            <p className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              {projectName}
              {entries && entries.length > 0 && ` · ${entries.length} sesiones`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-[12px]"
            style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)" }}
          >
            Cerrar
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-2 overflow-auto p-5">
          {error && (
            <p className="text-[12px]" style={{ color: "var(--color-danger, #e5484d)" }}>
              {error}
            </p>
          )}

          {!error && entries === null && (
            <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              Cargando…
            </p>
          )}

          {/* Un proyecto sin resúmenes es el estado normal de uno que no se ha
              abierto desde que existe el generador: se dice, no se deja el
              panel en blanco. */}
          {entries !== null && entries.length === 0 && (
            <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              Todavía no hay resúmenes de este proyecto. Se genera uno por sesión al abrir la
              siguiente sesión de Claude Code aquí.
            </p>
          )}

          {entries?.map((e) => (
            <EntryCard key={e.session_id} entry={e} projectId={projectId} />
          ))}
        </div>
      </div>
    </div>
  );
}
