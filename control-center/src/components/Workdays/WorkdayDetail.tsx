// WorkdayDetail - vista del workday seleccionado con secciones accordion.
//
// Tauri commands consumidos:
//   get_workday_detail(id) -> Workday
//   start_workday(id, energy_before) -> Workday
//   pause_workday(id, break_seconds_delta) -> Workday
//   resume_workday(id) -> Workday
//   complete_workday(id, ...retro fields) -> Workday
//   archive_workday(id) -> Workday
//   update_goal(workday_id, goal_id, status, text?) -> Workday
//   workday_append_context(workday_id, kind, text, source) -> Workday
//
// v2.9: cada seccion es un accordion expandible con estado persistido en
// localStorage por workday id. Animacion CSS max-height transition.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type {
  GoalStatus,
  GoalSource,
  Workday,
  WorkdayContextEntry,
  WorkdayGoal,
} from "./types";
import { getHomeDir, joinPath } from "../../lib/paths";
import { WorkdayDaySummary } from "./WorkdayDaySummary";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface WorkdayDetailProps {
  workdayId: string;
  refreshKey: number | string;
  onChanged: (wd: Workday) => void;
}

type SectionKey =
  | "goals"
  | "sessions"
  | "ctx_notes"
  | "ctx_decisions"
  | "ctx_file_changes"
  | "ctx_agent_messages"
  | "retro";

// Secciones abiertas por defecto cuando no hay estado guardado.
const DEFAULT_OPEN: SectionKey[] = ["goals"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTs(s?: string): string {
  if (!s) return "-";
  const m = s.match(/^epoch:(\d+)$/);
  if (!m) return s;
  const d = new Date(Number(m[1]) * 1000);
  return d.toLocaleString();
}

function storageKey(workdayId: string): string {
  return `wd-accordion-${workdayId}`;
}

function loadOpenSections(workdayId: string): Set<SectionKey> {
  try {
    const raw = localStorage.getItem(storageKey(workdayId));
    if (raw) {
      const parsed = JSON.parse(raw) as SectionKey[];
      if (Array.isArray(parsed)) return new Set(parsed);
    }
  } catch (_) {
    // localStorage puede fallar en contextos restringidos; ignorar.
  }
  return new Set(DEFAULT_OPEN);
}

function saveOpenSections(workdayId: string, open: Set<SectionKey>): void {
  try {
    localStorage.setItem(storageKey(workdayId), JSON.stringify([...open]));
  } catch (_) {
    // ignorar
  }
}

// ---------------------------------------------------------------------------
// Accordion primitivo
// ---------------------------------------------------------------------------

interface AccordionSectionProps {
  id: SectionKey;
  label: string;
  count?: number;
  lastTs?: string;
  open: boolean;
  onToggle: (id: SectionKey) => void;
  children: React.ReactNode;
}

function AccordionSection({
  id,
  label,
  count,
  lastTs,
  open,
  onToggle,
  children,
}: AccordionSectionProps) {
  const bodyId = `acc-body-${id}`;

  return (
    <div
      style={{
        borderTop: "1px solid var(--color-border)",
      }}
    >
      {/* Header clickable */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onToggle(id)}
        className="flex w-full items-center gap-2 px-6 py-3 text-left"
        style={{
          background: "var(--color-surface-1)",
          cursor: "pointer",
        }}
      >
        {/* Chevron */}
        <span
          style={{
            display: "inline-block",
            fontSize: "10px",
            color: "var(--color-text-tertiary)",
            transition: "transform 180ms ease",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            lineHeight: 1,
            userSelect: "none",
          }}
        >
          ▸
        </span>

        {/* Titulo */}
        <span
          className="flex-1 text-[13px] font-semibold"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {label}
        </span>

        {/* Badge count */}
        {count !== undefined && count > 0 && (
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-tertiary)",
            }}
          >
            {count}
          </span>
        )}

        {/* Timestamp ultima entrada */}
        {lastTs && (
          <span
            className="text-[10px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            {lastTs}
          </span>
        )}
      </button>

      {/* Body con animacion max-height */}
      <AccordionBody id={bodyId} open={open}>
        {children}
      </AccordionBody>
    </div>
  );
}

interface AccordionBodyProps {
  id: string;
  open: boolean;
  children: React.ReactNode;
}

function AccordionBody({ id, open, children }: AccordionBodyProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState<string>(open ? "none" : "0px");
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (open) {
      // Medir altura real y animar hacia ella, luego soltar a "none".
      setVisible(true);
      const scrollH = el.scrollHeight;
      setMaxH(`${scrollH}px`);
      const tid = window.setTimeout(() => setMaxH("none"), 220);
      return () => window.clearTimeout(tid);
    } else {
      // Fijar max-height al valor actual para que la transicion de cierre
      // tenga un punto de partida concreto, luego colapsar a 0.
      const scrollH = el.scrollHeight;
      setMaxH(`${scrollH}px`);
      // Un frame de espera garantiza que el browser vea el valor fijado
      // antes de cambiar a 0.
      const raf = window.requestAnimationFrame(() => {
        setMaxH("0px");
      });
      const tid = window.setTimeout(() => setVisible(false), 220);
      return () => {
        window.cancelAnimationFrame(raf);
        window.clearTimeout(tid);
      };
    }
  }, [open]);

  return (
    <div
      id={id}
      ref={ref}
      style={{
        maxHeight: maxH,
        overflow: "hidden",
        transition: "max-height 200ms ease",
        visibility: visible ? "visible" : "hidden",
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export function WorkdayDetail({
  workdayId,
  refreshKey,
  onChanged,
}: WorkdayDetailProps) {
  const [wd, setWd] = useState<Workday | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Guard anti-loop para la auto-regeneracion del resumen IA: clave
  // `${workdayId}::${generated_at}` del ultimo disparo. Como runCmd hace
  // setWd(next) tras generar, el effect se re-evalua; el guard impide que
  // vuelva a disparar para el mismo (workday, generated_at).
  const autoSummaryFiredRef = useRef<string>("");

  // Retro form (solo al transicionar a completed)
  const [retroGood, setRetroGood] = useState("");
  const [retroBad, setRetroBad] = useState("");
  const [retroLearned, setRetroLearned] = useState("");
  const [showCompleteForm, setShowCompleteForm] = useState(false);

  // Estado de secciones abiertas — se inicializa al cargar el workday.
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(
    () => new Set(DEFAULT_OPEN),
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<Workday>("get_workday_detail", { id: workdayId })
      .then((row) => {
        if (cancelled) return;
        setWd(row);
        setRetroGood(row.retro_good ?? "");
        setRetroBad(row.retro_bad ?? "");
        setRetroLearned(row.retro_learned ?? "");
        // Restaurar secciones abiertas desde localStorage para este workday.
        setOpenSections(loadOpenSections(workdayId));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workdayId, refreshKey]);

  // ---------------------------------------------------------------------------
  // Auto-regeneracion del resumen IA al cargar el workday activo (2026-05-30).
  // Cierra el paso 5 del rework sin depender del scheduler (que no puede
  // invocar el backend). El resumen solo se ve aqui, asi que generarlo al
  // abrir el workday es lo mas fresco posible. Dispara SOLO si:
  //   (a) workday in_progress y planned_date == hoy (fecha LOCAL, no UTC),
  //   (b) ai_summary ausente o generated_at > 15 min,
  //   (c) no se disparo ya para este (workdayId, generated_at) — ref guard,
  //   (d) no hay otra operacion en curso (busy).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!wd) return;

    // Fecha LOCAL en formato YYYY-MM-DD (fr-CA siempre da ISO en zona local).
    // No usar toISOString().slice(0,10): devuelve UTC y planned_date se genera
    // con chrono::Local en el backend -> desajuste cerca de medianoche.
    const todayStr = new Intl.DateTimeFormat("fr-CA").format(new Date());
    if (wd.status !== "in_progress" || wd.planned_date !== todayStr) return;

    const FIFTEEN_MIN_S = 15 * 60;
    const nowEpoch = Math.floor(Date.now() / 1000);
    if (wd.ai_summary?.generated_at) {
      const m = wd.ai_summary.generated_at.match(/^epoch:(\d+)$/);
      if (m && nowEpoch - Number(m[1]) < FIFTEEN_MIN_S) return; // resumen fresco
    }

    const guardKey = `${workdayId}::${wd.ai_summary?.generated_at ?? ""}`;
    if (autoSummaryFiredRef.current === guardKey) return;
    autoSummaryFiredRef.current = guardKey;

    if (busy) return;
    void runCmd("workday_ai_summary_generate", { workdayId });
  }, [wd, workdayId, busy]);

  function toggleSection(id: SectionKey) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      saveOpenSections(workdayId, next);
      return next;
    });
  }

  async function runCmd(cmd: string, args: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<Workday>(cmd, args);
      setWd(next);
      onChanged(next);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleStart() {
    await runCmd("start_workday", { id: workdayId, energyBefore: null });
  }
  async function handlePause() {
    await runCmd("pause_workday", { id: workdayId, breakSecondsDelta: null });
  }
  async function handleResume() {
    await runCmd("resume_workday", { id: workdayId });
  }
  async function handleArchive() {
    await runCmd("archive_workday", { id: workdayId });
  }
  async function handleComplete() {
    await runCmd("complete_workday", {
      id: workdayId,
      focusSeconds: null,
      energyAfter: null,
      moodNote: null,
      retroGood: retroGood.trim() || null,
      retroBad: retroBad.trim() || null,
      retroLearned: retroLearned.trim() || null,
    });
    setShowCompleteForm(false);
  }

  async function toggleGoal(goal: WorkdayGoal) {
    const next: GoalStatus = goal.status === "done" ? "pending" : "done";
    await runCmd("workday_goals_update", {
      workdayId,
      goalId: goal.id,
      status: next,
      text: null,
    });
  }

  async function deleteGoal(goalId: string) {
    await runCmd("workday_goals_delete", { workdayId, goalId });
  }

  async function renameGoal(goalId: string, text: string) {
    if (!text.trim()) return;
    await runCmd("workday_goals_update", {
      workdayId,
      goalId,
      status: wd!.goals.find((g) => g.id === goalId)?.status ?? "pending",
      text: text.trim(),
    });
  }

  // ---------------------------------------------------------------------------
  // Estados de carga / error
  // ---------------------------------------------------------------------------

  if (loading && !wd) {
    return (
      <div
        className="flex h-full items-center justify-center text-[12px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Loading workday...
      </div>
    );
  }
  if (error && !wd) {
    return (
      <div
        className="flex h-full items-center justify-center text-[12px]"
        style={{ color: "var(--color-danger, #ef4444)" }}
      >
        {error}
      </div>
    );
  }
  if (!wd) return null;

  const canStart = wd.status === "planned";
  const canPause = wd.status === "in_progress";
  const canResume = wd.status === "paused";
  const canComplete = wd.status === "in_progress" || wd.status === "paused";
  const canArchive = wd.status === "completed";

  // Helpers para timestamps de ultima entrada en cada seccion.
  function lastEntryTs(entries: { created_at: string }[]): string | undefined {
    if (!entries.length) return undefined;
    return fmtTs(entries[entries.length - 1].created_at);
  }

  const hasRetro =
    !!wd.retro_good || !!wd.retro_bad || !!wd.retro_learned;

  return (
    <div
      className="flex h-full flex-col overflow-auto"
      style={{ background: "var(--color-bg)" }}
    >
      {/* ------------------------------------------------------------------ */}
      {/* Header — titulo + status + meta + acciones                          */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="flex flex-col gap-2 border-b px-6 py-4"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
      >
        <div className="flex items-center gap-3">
          <h2
            className="text-[18px] font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            {wd.title}
          </h2>
          <span
            className="rounded px-2 py-0.5 text-[11px] font-medium uppercase"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              letterSpacing: "0.04em",
            }}
          >
            {wd.status}
          </span>
        </div>

        <div
          className="flex flex-wrap gap-4 text-[12px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <span>Planned: {wd.planned_date}</span>
          <span>Start: {fmtTs(wd.start_ts)}</span>
          <span>End: {fmtTs(wd.end_ts)}</span>
          <span>Focus: {Math.round(wd.focus_seconds / 60)}m</span>
          <span>Break: {Math.round(wd.break_seconds / 60)}m</span>
        </div>

        {/* Acciones */}
        <div className="mt-2 flex flex-wrap gap-2">
          {canStart && (
            <ActionBtn
              label="Start"
              onClick={handleStart}
              disabled={busy}
              kind="primary"
            />
          )}
          {canPause && (
            <ActionBtn label="Pause" onClick={handlePause} disabled={busy} />
          )}
          {canResume && (
            <ActionBtn
              label="Resume"
              onClick={handleResume}
              disabled={busy}
              kind="primary"
            />
          )}
          {canComplete && (
            <ActionBtn
              label="Complete..."
              onClick={() => setShowCompleteForm((v) => !v)}
              disabled={busy}
              kind="primary"
            />
          )}
          {canArchive && (
            <ActionBtn
              label="Archive"
              onClick={handleArchive}
              disabled={busy}
            />
          )}
        </div>

        {error && (
          <div
            className="mt-2 text-[12px]"
            style={{ color: "var(--color-danger, #ef4444)" }}
          >
            {error}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Complete form (inline, no accordion)                                */}
      {/* ------------------------------------------------------------------ */}
      {showCompleteForm && (
        <div
          className="flex flex-col gap-2 border-b px-6 py-4"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
          }}
        >
          <span
            className="text-[12px] font-semibold"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Retrospective
          </span>
          <RetroField
            label="What went well"
            value={retroGood}
            onChange={setRetroGood}
          />
          <RetroField
            label="What went badly"
            value={retroBad}
            onChange={setRetroBad}
          />
          <RetroField
            label="What I learned"
            value={retroLearned}
            onChange={setRetroLearned}
          />
          <div className="flex gap-2">
            <ActionBtn
              label="Confirm complete"
              onClick={handleComplete}
              disabled={busy}
              kind="primary"
            />
            <ActionBtn
              label="Cancel"
              onClick={() => setShowCompleteForm(false)}
              disabled={busy}
            />
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Resumen del día — 5 cards                                           */}
      {/* ------------------------------------------------------------------ */}
      <WorkdayDaySummary wd={wd} />

      {/* ------------------------------------------------------------------ */}
      {/* Resumen IA automático (2026-05-30) — auto-contexto de la jornada    */}
      {/* ------------------------------------------------------------------ */}
      <div
        className="mx-4 mt-3 rounded-lg p-3"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span
            className="text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Resumen IA
            {wd.ai_summary?.generated_at && (
              <span className="ml-2 normal-case" style={{ color: "var(--color-text-faint)" }}>
                · {fmtTs(wd.ai_summary.generated_at)}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => void runCmd("workday_ai_summary_generate", { workdayId })}
            disabled={busy}
            className="rounded px-2 py-0.5 text-[11px] transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Regenerar el resumen de la jornada con IA (route utility)"
          >
            {busy ? "…" : "Regenerar"}
          </button>
        </div>
        {wd.ai_summary?.text ? (
          <div
            className="whitespace-pre-wrap text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {wd.ai_summary.text}
          </div>
        ) : (
          <div className="text-[12px]" style={{ color: "var(--color-text-faint)" }}>
            Se genera al acumular actividad (o pulsa «Regenerar»).
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Secciones accordion                                                  */}
      {/* ------------------------------------------------------------------ */}

      {/* Goals — H31: Add + Auto-fill + inline edit + delete */}
      <AccordionSection
        id="goals"
        label="Goals"
        count={wd.goals.length}
        open={openSections.has("goals")}
        onToggle={toggleSection}
      >
        <div className="px-6 pb-4 pt-2">
          <GoalsSection
            workdayId={workdayId}
            goals={wd.goals}
            busy={busy}
            onToggle={toggleGoal}
            onDelete={deleteGoal}
            onRename={renameGoal}
            onUpdated={(next) => { setWd(next); onChanged(next); }}
          />
        </div>
      </AccordionSection>

      {/* Linked Sessions */}
      <AccordionSection
        id="sessions"
        label="Linked Sessions"
        count={wd.linked_sessions.length}
        open={openSections.has("sessions")}
        onToggle={toggleSection}
      >
        <div className="px-6 pb-4 pt-2">
          <LinkedSessionsContent sessionIds={wd.linked_sessions} />
        </div>
      </AccordionSection>

      {/* Context > Notes */}
      <AccordionSection
        id="ctx_notes"
        label="Context — Notes"
        count={wd.context.notes.length}
        lastTs={lastEntryTs(wd.context.notes)}
        open={openSections.has("ctx_notes")}
        onToggle={toggleSection}
      >
        <div className="px-6 pb-4 pt-2">
          <ContextEntryList entries={wd.context.notes} emptyLabel="No notes." />
        </div>
      </AccordionSection>

      {/* Context > Decisions */}
      <AccordionSection
        id="ctx_decisions"
        label="Context — Decisions"
        count={wd.context.decisions.length}
        lastTs={lastEntryTs(wd.context.decisions)}
        open={openSections.has("ctx_decisions")}
        onToggle={toggleSection}
      >
        <div className="px-6 pb-4 pt-2">
          <ContextEntryList
            entries={wd.context.decisions}
            emptyLabel="No decisions."
          />
        </div>
      </AccordionSection>

      {/* Context > File Changes */}
      <AccordionSection
        id="ctx_file_changes"
        label="Context — File Changes"
        count={wd.context.file_changes.length}
        lastTs={lastEntryTs(wd.context.file_changes)}
        open={openSections.has("ctx_file_changes")}
        onToggle={toggleSection}
      >
        <div className="px-6 pb-4 pt-2">
          <ContextEntryList
            entries={wd.context.file_changes}
            emptyLabel="No file changes."
          />
        </div>
      </AccordionSection>

      {/* Context > Agent Messages */}
      <AccordionSection
        id="ctx_agent_messages"
        label="Context — Agent Messages"
        count={wd.context.agent_messages.length}
        lastTs={lastEntryTs(wd.context.agent_messages)}
        open={openSections.has("ctx_agent_messages")}
        onToggle={toggleSection}
      >
        <div className="px-6 pb-4 pt-2">
          <ContextEntryList
            entries={wd.context.agent_messages}
            emptyLabel="No agent messages."
          />
        </div>
      </AccordionSection>

      {/* Append context — siempre visible debajo de los accordions de contexto */}
      <AppendContextForm
        workdayId={workdayId}
        busy={busy}
        onAppended={(next) => setWd(next)}
      />

      {/* Retro — collapsed por defecto, solo si hay datos */}
      {hasRetro && (
        <AccordionSection
          id="retro"
          label="Retrospective"
          open={openSections.has("retro")}
          onToggle={toggleSection}
        >
          <div className="px-6 pb-4 pt-2">
            <RetroLine label="Good" value={wd.retro_good} />
            <RetroLine label="Bad" value={wd.retro_bad} />
            <RetroLine label="Learned" value={wd.retro_learned} />
          </div>
        </AccordionSection>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componentes internos
// ---------------------------------------------------------------------------

interface ActionBtnProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary";
}
function ActionBtn({
  label,
  onClick,
  disabled,
  kind = "secondary",
}: ActionBtnProps) {
  const primary = kind === "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
      style={{
        background: primary ? "var(--color-accent, #2563eb)" : "transparent",
        color: primary ? "var(--color-accent-text, #000)" : "var(--color-text-secondary)",
        border: primary
          ? "1px solid transparent"
          : "1px solid var(--color-border-strong)",
      }}
    >
      {label}
    </button>
  );
}

interface RetroFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
}
function RetroField({ label, value, onChange }: RetroFieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span
        className="text-[11px] font-medium"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        className="rounded px-2 py-1 text-[12px]"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
          color: "var(--color-text)",
          resize: "vertical",
        }}
      />
    </label>
  );
}

// Contenido de linked sessions (extraido del accordion wrapper)
interface LinkedSessionsContentProps {
  sessionIds: string[];
}
function LinkedSessionsContent({ sessionIds }: LinkedSessionsContentProps) {
  const [openErr, setOpenErr] = useState<string | null>(null);

  async function openTranscript(sessionId: string) {
    setOpenErr(null);
    try {
      const home = await getHomeDir();
      const candidates = [
        joinPath(home, ".claude", "session-data", `${sessionId}-session.tmp`),
        joinPath(home, ".claude", "data", "sessions", `${sessionId}.jsonl`),
        joinPath(home, ".claude", "observer", "sessions", `${sessionId}.jsonl`),
      ];
      for (const p of candidates) {
        try {
          await openPath(p);
          return;
        } catch (_) {
          // probar siguiente
        }
      }
      setOpenErr(`No transcript found for ${sessionId}`);
    } catch (e) {
      setOpenErr(String(e));
    }
  }

  if (!sessionIds || sessionIds.length === 0) {
    return (
      <div
        className="text-[12px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        No linked sessions.
      </div>
    );
  }

  return (
    <>
      {openErr && (
        <div
          className="mb-2 text-[11px]"
          style={{ color: "var(--color-danger, #ef4444)" }}
        >
          {openErr}
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {sessionIds.map((sid) => (
          <li
            key={sid}
            className="flex items-center justify-between rounded px-2 py-1.5"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <span
              className="font-mono text-[12px]"
              style={{ color: "var(--color-text)" }}
            >
              {sid}
            </span>
            <button
              type="button"
              onClick={() => void openTranscript(sid)}
              className="rounded px-2 py-0.5 text-[11px]"
              style={{
                background: "transparent",
                color: "var(--color-text-secondary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              Open transcript
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

// Lista de entradas de contexto
interface ContextEntryListProps {
  entries: WorkdayContextEntry[];
  emptyLabel: string;
}
function ContextEntryList({ entries, emptyLabel }: ContextEntryListProps) {
  if (!entries || entries.length === 0) {
    return (
      <div
        className="text-[12px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {emptyLabel}
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {entries.map((e) => (
        <li
          key={e.id}
          className="rounded px-2 py-1.5 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
          }}
        >
          <div className="flex items-start gap-2">
            <span
              className="rounded px-1.5 py-0.5 text-[9px] uppercase"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-secondary)",
              }}
            >
              {e.kind}
            </span>
            <span className="flex-1 whitespace-pre-wrap">{e.text}</span>
          </div>
          {e.source && (
            <div
              className="mt-1 text-[10px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              source: {e.source}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// Formulario de append context — siempre visible, fuera de accordion.
interface AppendContextFormProps {
  workdayId: string;
  busy: boolean;
  onAppended: (wd: Workday) => void;
}
function AppendContextForm({
  workdayId,
  busy,
  onAppended,
}: AppendContextFormProps) {
  const [kind, setKind] = useState<string>("note");
  const [text, setText] = useState<string>("");
  const [appending, setAppending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleAppend() {
    if (!text.trim()) return;
    setAppending(true);
    setErr(null);
    try {
      const next = await invoke<Workday>("workday_append_context", {
        workdayId,
        kind,
        text: text.trim(),
        source: "ui",
      });
      onAppended(next);
      setText("");
    } catch (e: unknown) {
      setErr(String(e));
    } finally {
      setAppending(false);
    }
  }

  return (
    <div
      className="border-t px-6 py-3"
      style={{ borderColor: "var(--color-border)" }}
    >
      <div className="flex gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          disabled={appending || busy}
          className="rounded px-2 py-1 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text)",
          }}
        >
          <option value="note">Note</option>
          <option value="decision">Decision</option>
          <option value="file_change">File change</option>
          <option value="agent_message">Agent message</option>
        </select>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add to shared context..."
          disabled={appending || busy}
          className="flex-1 rounded px-2 py-1 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text)",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleAppend();
          }}
        />
        <button
          type="button"
          onClick={() => void handleAppend()}
          disabled={appending || busy || !text.trim()}
          className="rounded px-3 py-1 text-[12px] font-medium disabled:opacity-50"
          style={{
            background: "var(--color-accent, #ffffff)",
            color: "var(--color-accent-text, #000000)",
          }}
        >
          {appending ? "..." : "Append"}
        </button>
      </div>
      {err && (
        <div
          className="mt-1 text-[11px]"
          style={{ color: "var(--color-danger, #ef4444)" }}
        >
          {err}
        </div>
      )}
    </div>
  );
}

function RetroLine({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="mb-2">
      <div
        className="text-[11px] font-medium uppercase"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </div>
      <div
        className="whitespace-pre-wrap text-[13px]"
        style={{ color: "var(--color-text)" }}
      >
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// H31 — GoalsSection: lista rica con Add, Auto-fill, inline edit, delete
// ---------------------------------------------------------------------------

const SOURCE_BADGE: Record<GoalSource, string> = {
  manual: "",
  ai_inferred: "AI",
  kanban: "kanban",
};

interface GoalsSectionProps {
  workdayId: string;
  goals: WorkdayGoal[];
  busy: boolean;
  onToggle: (goal: WorkdayGoal) => void;
  onDelete: (goalId: string) => void;
  onRename: (goalId: string, text: string) => void;
  onUpdated: (wd: Workday) => void;
}

function GoalsSection({
  workdayId,
  goals,
  busy,
  onToggle,
  onDelete,
  onRename,
  onUpdated,
}: GoalsSectionProps) {
  const [newText, setNewText] = useState("");
  const [adding, setAdding] = useState(false);
  const [filling, setFilling] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  // goalId -> current edit text (undefined = not editing)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  async function handleAdd() {
    if (!newText.trim()) return;
    setAdding(true);
    setAddErr(null);
    try {
      const next = await invoke<Workday>("workday_goals_add", {
        workdayId,
        text: newText.trim(),
      });
      onUpdated(next);
      setNewText("");
    } catch (e: unknown) {
      setAddErr(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function handleAutoFill() {
    setFilling(true);
    setAddErr(null);
    try {
      const next = await invoke<Workday>("workday_goals_auto_fill", {
        workdayId,
      });
      onUpdated(next);
    } catch (e: unknown) {
      setAddErr(String(e));
    } finally {
      setFilling(false);
    }
  }

  function startEdit(goal: WorkdayGoal) {
    setEditingId(goal.id);
    setEditText(goal.text);
  }

  function commitEdit(goalId: string) {
    if (editText.trim() && editText.trim() !== goals.find((g) => g.id === goalId)?.text) {
      onRename(goalId, editText.trim());
    }
    setEditingId(null);
    setEditText("");
  }

  const isIdle = !busy && !adding && !filling;

  return (
    <div className="flex flex-col gap-2">
      {/* Goal list */}
      {goals.length === 0 ? (
        <div
          className="text-[12px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          No goals yet. Add one below or use Auto-fill.
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {goals.map((g) => (
            <li
              key={g.id}
              className="flex items-center gap-2 rounded px-2 py-1.5"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              {/* Checkbox */}
              <input
                type="checkbox"
                checked={g.status === "done"}
                disabled={!isIdle}
                onChange={() => onToggle(g)}
                className="shrink-0"
                aria-label={`Mark "${g.text}" as ${g.status === "done" ? "pending" : "done"}`}
              />

              {/* Text — inline edit on double-click */}
              {editingId === g.id ? (
                <input
                  autoFocus
                  type="text"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={() => commitEdit(g.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitEdit(g.id);
                    if (e.key === "Escape") { setEditingId(null); setEditText(""); }
                  }}
                  className="flex-1 rounded px-1 py-0.5 text-[13px]"
                  style={{
                    background: "var(--color-surface-3)",
                    border: "1px solid var(--color-border-strong)",
                    color: "var(--color-text)",
                  }}
                />
              ) : (
                <span
                  className="flex-1 cursor-text text-[13px]"
                  style={{
                    color: "var(--color-text)",
                    textDecoration: g.status === "done" ? "line-through" : "none",
                    opacity: g.status === "done" ? 0.55 : 1,
                  }}
                  onDoubleClick={() => isIdle && startEdit(g)}
                  title="Double-click to edit"
                >
                  {g.text}
                </span>
              )}

              {/* Source badge — only for non-manual */}
              {SOURCE_BADGE[g.source] && (
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-tertiary)",
                  }}
                >
                  {SOURCE_BADGE[g.source]}
                </span>
              )}

              {/* Status chip */}
              <span
                className="shrink-0 text-[10px] uppercase"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {g.status}
              </span>

              {/* Delete */}
              <button
                type="button"
                onClick={() => onDelete(g.id)}
                disabled={!isIdle}
                aria-label={`Delete goal "${g.text}"`}
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] disabled:opacity-40"
                style={{
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Add + Auto-fill row */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          placeholder="New goal..."
          disabled={!isIdle}
          onKeyDown={(e) => { if (e.key === "Enter") void handleAdd(); }}
          className="flex-1 rounded px-2 py-1 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text)",
          }}
        />
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={!isIdle || !newText.trim()}
          className="rounded px-3 py-1 text-[12px] font-medium disabled:opacity-50"
          style={{
            background: "var(--color-accent, #2563eb)",
            color: "var(--color-accent-text, #fff)",
            border: "none",
          }}
        >
          {adding ? "..." : "+ Add goal"}
        </button>
        <button
          type="button"
          onClick={() => void handleAutoFill()}
          disabled={!isIdle}
          className="rounded px-3 py-1 text-[12px] font-medium disabled:opacity-50"
          style={{
            background: "transparent",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Scan kanban In Progress cards and generate goals via AI"
        >
          {filling ? "Scanning..." : "Auto-fill from In Progress"}
        </button>
      </div>

      {addErr && (
        <div
          className="text-[11px]"
          style={{ color: "var(--color-danger, #ef4444)" }}
        >
          {addErr}
        </div>
      )}
    </div>
  );
}
