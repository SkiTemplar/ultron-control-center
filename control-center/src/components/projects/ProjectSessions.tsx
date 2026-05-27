// ULTRON Control Center 2.0 — Per-project Work Sessions sub-tab
//
// Replaces the old AI-sessions list with a proper work-sessions workflow:
//   - Active session banner with live running counter (poll every 10s)
//   - Start session bar (shown only when no session is active)
//   - History list: collapsible cards with AI sessions / cards / files detail
//   - Horizontal timeline of last 10 sessions (colour-coded by status)
//
// Backend commands used:
//   project_work_session_active(projectId) → WorkSession | null
//   project_work_session_start(projectId, workdayId) → WorkSession
//   project_work_session_end(projectId, sessionId, notes) → WorkSession
//   project_work_sessions_list(projectId) → WorkSession[]
//   list_workdays(statusFilter, dateFrom, dateTo, limit) → Workday[]

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Clock,
  ChevronDown,
  ChevronRight,
  Play,
  RefreshCw,
  Plus,
  X,
} from "./icons";
import type { Workday } from "../Workdays/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WorkSessionStatus = "active" | "completed";

interface WorkSession {
  id: string;
  project_id: string;
  workday_id: string;
  started_at: string;        // "epoch:<secs>"
  ended_at: string | null;
  duration_seconds: number;
  status: WorkSessionStatus;
  ai_session_ids: string[];
  cards_touched: string[];
  files_changed: string[];
  notes: string | null;
}

type Props = {
  projectId: string;
  projectPath: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parses "epoch:<seconds>" into a Date. Falls back to new Date() on failure. */
function parseEpoch(s: string): Date {
  const m = s.match(/^epoch:(\d+(?:\.\d+)?)$/);
  if (m) return new Date(parseFloat(m[1]) * 1000);
  // Attempt direct ISO parse as a fallback.
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}

/** Formats a Date as "dd/mm hh:mm" — compact for list cards. */
function formatDateTime(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${min}`;
}

/** Formats seconds as "h:mm:ss". Works for 0 up to many hours. */
function formatDuration(totalSecs: number): string {
  const secs = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return `${h}:${mm}:${ss}`;
}

/** Today's date as "yyyy-mm-dd" in local time. */
function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Badge chip — small pill for counts. Shows nothing when count is 0. */
function CountBadge({
  label,
  count,
  tint,
}: {
  label: string;
  count: number;
  tint: string;
}) {
  if (count === 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-px text-[10px] font-medium"
      style={{
        background: "var(--color-surface-2)",
        color: tint,
        border: "1px solid var(--color-border)",
      }}
    >
      {count} {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Horizontal timeline (last 10 sessions)
// ---------------------------------------------------------------------------

function SessionTimeline({ sessions }: { sessions: WorkSession[] }) {
  const slice = sessions.slice(0, 10).reverse(); // oldest left → newest right
  if (slice.length === 0) return null;

  return (
    <div
      className="flex items-end gap-1.5 overflow-x-auto px-3 py-2 border-b"
      style={{ borderColor: "var(--color-border)", minHeight: 44 }}
      role="list"
      aria-label="Recent work sessions timeline"
    >
      {slice.map((s) => {
        const isActive = s.status === "active";
        const tint = isActive ? "#f59e0b" : "#22c55e";
        const startDate = parseEpoch(s.started_at);
        const durationLabel = formatDuration(s.duration_seconds);
        const label = `${formatDateTime(startDate)} · ${durationLabel}`;
        return (
          <div
            key={s.id}
            role="listitem"
            title={`${label}${s.notes ? "\n" + s.notes : ""}`}
            className="relative flex shrink-0 cursor-default flex-col items-center"
            style={{ width: 28 }}
          >
            <div
              className="w-full rounded-sm"
              style={{
                height: Math.max(6, Math.min(28, 4 + (s.duration_seconds / 3600) * 24)),
                background: tint,
                opacity: isActive ? 1 : 0.75,
                boxShadow: isActive ? `0 0 6px ${tint}80` : "none",
              }}
            />
            <span
              className="mt-0.5 truncate text-center font-mono text-[8.5px]"
              style={{ color: "var(--color-text-faint)", maxWidth: 28 }}
            >
              {String(startDate.getDate()).padStart(2, "0")}/
              {String(startDate.getMonth() + 1).padStart(2, "0")}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EndSessionModal
// ---------------------------------------------------------------------------

interface EndSessionModalProps {
  sessionId: string;
  projectId: string;
  onDone: () => void;
  onCancel: () => void;
}

function EndSessionModal({ sessionId, projectId, onDone, onCancel }: EndSessionModalProps) {
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleEnd = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await invoke("project_work_session_end", {
        projectId,
        sessionId,
        notes: notes.trim() || null,
      });
      onDone();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [projectId, sessionId, notes, onDone]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.65)" }}
      role="dialog"
      aria-modal="true"
      aria-label="End work session"
    >
      <div
        className="flex w-96 flex-col gap-3 rounded-lg border p-5 shadow-2xl"
        style={{
          background: "var(--color-surface-1)",
          borderColor: "var(--color-border)",
        }}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
            End work session
          </h3>
          <button
            onClick={onCancel}
            className="rounded p-1 hover:bg-[var(--color-surface-2)]"
            aria-label="Cancel"
          >
            <X size={13} />
          </button>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
            Session notes (optional)
          </span>
          <textarea
            ref={textareaRef}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="What did you accomplish? Any blockers?"
            className="w-full resize-none rounded border p-2 text-[12px] outline-none focus:ring-1"
            style={{
              background: "var(--color-surface-2)",
              borderColor: "var(--color-border)",
              color: "var(--color-text)",
            }}
          />
        </label>

        {error && (
          <p className="text-[11px]" style={{ color: "var(--color-danger, #ef4444)" }}>
            {error}
          </p>
        )}

        <div className="flex items-center gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={saving}
            className="rounded border px-3 py-1.5 text-[11px] hover:bg-[var(--color-surface-2)] disabled:opacity-40"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
          >
            Cancel
          </button>
          <button
            onClick={() => void handleEnd()}
            disabled={saving}
            className="rounded border px-3 py-1.5 text-[11px] font-medium disabled:opacity-40"
            style={{
              background: "var(--color-danger, #ef4444)",
              borderColor: "transparent",
              color: "#fff",
            }}
          >
            {saving ? "Ending…" : "End session"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActiveSessionBanner
// ---------------------------------------------------------------------------

interface ActiveBannerProps {
  session: WorkSession;
  onEndRequest: () => void;
  /** Elapsed seconds since started_at. Provided by parent via polling. */
  elapsedSecs: number;
}

function ActiveSessionBanner({ session, onEndRequest, elapsedSecs }: ActiveBannerProps) {
  const startDate = parseEpoch(session.started_at);

  return (
    <div
      className="flex items-center gap-3 border-b px-3 py-2"
      style={{
        background: "rgba(245,158,11,0.08)",
        borderColor: "rgba(245,158,11,0.30)",
      }}
      role="status"
      aria-label="Active work session"
    >
      {/* Pulse dot */}
      <span
        className="relative flex h-2.5 w-2.5 shrink-0"
        aria-hidden="true"
      >
        <span
          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
          style={{ background: "#f59e0b" }}
        />
        <span
          className="relative inline-flex h-2.5 w-2.5 rounded-full"
          style={{ background: "#f59e0b" }}
        />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12px] font-semibold" style={{ color: "#f59e0b" }}>
          Session active
        </span>
        <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
          Started {formatDateTime(startDate)} · workday{" "}
          <span className="font-mono text-[10px]">{session.workday_id}</span>
        </span>
      </div>

      {/* Running clock */}
      <div
        className="flex items-center gap-1 font-mono text-[13px] font-semibold tabular-nums"
        style={{ color: "#f59e0b" }}
        aria-live="off"
      >
        <Clock size={12} />
        {formatDuration(elapsedSecs)}
      </div>

      <button
        onClick={onEndRequest}
        className="ml-1 rounded border px-2.5 py-1 text-[11px] font-medium transition-colors hover:opacity-80"
        style={{
          background: "rgba(239,68,68,0.15)",
          borderColor: "rgba(239,68,68,0.40)",
          color: "#ef4444",
        }}
      >
        End session
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StartSessionBar
// ---------------------------------------------------------------------------

interface StartBarProps {
  projectId: string;
  onStarted: () => void;
}

function StartSessionBar({ projectId, onStarted }: StartBarProps) {
  const [workdays, setWorkdays] = useState<Workday[]>([]);
  const [selectedId, setSelectedId] = useState<string>("today-default");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<Workday[]>("list_workdays", {
      statusFilter: null,
      dateFrom: null,
      dateTo: null,
      limit: 30,
    })
      .then((rows) => {
        if (!cancelled) {
          // Sort: today's workdays first, then rest by date desc.
          const today = todayISO();
          const sorted = [...rows].sort((a, b) => {
            const aToday = a.planned_date === today ? 0 : 1;
            const bToday = b.planned_date === today ? 0 : 1;
            if (aToday !== bToday) return aToday - bToday;
            return b.planned_date.localeCompare(a.planned_date);
          });
          setWorkdays(sorted);
          // Pre-select today's active/in_progress workday if present.
          const todayActive = sorted.find(
            (w) =>
              w.planned_date === today &&
              (w.status === "in_progress" || w.status === "planned"),
          );
          if (todayActive) setSelectedId(todayActive.id);
        }
      })
      .catch(() => {
        // silently ignore — user can still proceed with today-default
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleStart = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      // "today-default" resolves to null on the backend, which auto-picks or
      // auto-creates today's workday.
      const workdayId = selectedId === "today-default" ? null : selectedId;
      await invoke("project_work_session_start", {
        projectId,
        workdayId,
      });
      onStarted();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }, [projectId, selectedId, onStarted]);

  return (
    <div
      className="flex items-center gap-2 border-b px-3 py-2"
      style={{ borderColor: "var(--color-border)" }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="min-w-0 flex-1 rounded border py-1 pl-2 pr-6 text-[11px] outline-none"
          style={{
            background: "var(--color-surface-2)",
            borderColor: "var(--color-border)",
            color: "var(--color-text-muted)",
            maxWidth: 260,
          }}
          aria-label="Select workday for this session"
        >
          <option value="today-default">Today (auto)</option>
          {workdays.map((w) => (
            <option key={w.id} value={w.id}>
              {w.planned_date === todayISO() ? "Today — " : `${w.planned_date} — `}
              {w.title}
              {w.status === "in_progress" ? " (active)" : ""}
            </option>
          ))}
        </select>

        <button
          onClick={() => void handleStart()}
          disabled={starting}
          className="flex shrink-0 items-center gap-1.5 rounded border px-3 py-1 text-[11px] font-medium disabled:opacity-40"
          style={{
            background: "rgba(34,197,94,0.12)",
            borderColor: "rgba(34,197,94,0.35)",
            color: "#22c55e",
          }}
        >
          <Plus size={11} />
          {starting ? "Starting…" : "Start work session"}
        </button>
      </div>

      {error && (
        <p className="shrink-0 text-[11px]" style={{ color: "var(--color-danger, #ef4444)" }}>
          {error}
        </p>
      )}

      <p className="shrink-0 text-[10px]" style={{ color: "var(--color-text-faint, rgba(255,255,255,0.25))" }}>
        Tip: AI sessions you start while a work-session is active will be auto-linked.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionHistoryCard — collapsible entry in the history list
// ---------------------------------------------------------------------------

interface HistoryCardProps {
  session: WorkSession;
}

function SessionHistoryCard({ session }: HistoryCardProps) {
  const [expanded, setExpanded] = useState(false);

  const startDate = parseEpoch(session.started_at);
  const endDate = session.ended_at ? parseEpoch(session.ended_at) : null;

  const isActive = session.status === "active";
  const statusTint = isActive ? "#f59e0b" : "#22c55e";
  const statusLabel = isActive ? "active" : "completed";

  const aiCount = session.ai_session_ids.length;
  const cardCount = session.cards_touched.length;
  const fileCount = session.files_changed.length;

  const hasDetail = aiCount > 0 || cardCount > 0 || fileCount > 0;

  return (
    <li
      className="rounded-md border"
      style={{
        background: "var(--color-surface-1)",
        borderColor: isActive ? "rgba(245,158,11,0.30)" : "var(--color-border)",
      }}
    >
      {/* Header row */}
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((p) => !p)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        style={{ cursor: hasDetail ? "pointer" : "default" }}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        {/* Expand chevron */}
        {hasDetail ? (
          expanded ? (
            <ChevronDown size={11} className="shrink-0 text-[var(--color-text-faint)]" />
          ) : (
            <ChevronRight size={11} className="shrink-0 text-[var(--color-text-faint)]" />
          )
        ) : (
          <span className="w-[11px] shrink-0" />
        )}

        {/* Time range */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium tabular-nums" style={{ color: "var(--color-text)" }}>
              {formatDateTime(startDate)}
            </span>
            {endDate && (
              <>
                <span style={{ color: "var(--color-text-faint)" }}>→</span>
                <span className="text-[12px] tabular-nums" style={{ color: "var(--color-text-muted)" }}>
                  {formatDateTime(endDate)}
                </span>
              </>
            )}
          </div>
          {/* Collapsed badges row */}
          {!expanded && (aiCount > 0 || cardCount > 0 || fileCount > 0) && (
            <div className="flex flex-wrap items-center gap-1 mt-0.5">
              <CountBadge label="AI sessions" count={aiCount} tint="#58a6ff" />
              <CountBadge label="cards" count={cardCount} tint="#a875ff" />
              <CountBadge label="files" count={fileCount} tint="#d29922" />
            </div>
          )}
        </div>

        {/* Status chip + duration */}
        <div className="flex shrink-0 items-center gap-2">
          <span
            className="rounded-full px-2 py-px text-[9.5px] font-medium uppercase tracking-wide"
            style={{
              background: `${statusTint}18`,
              color: statusTint,
              border: `1px solid ${statusTint}40`,
            }}
          >
            {statusLabel}
          </span>
          <span
            className="font-mono text-[11px] tabular-nums"
            style={{ color: "var(--color-text-muted)" }}
          >
            {formatDuration(session.duration_seconds)}
          </span>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div
          className="border-t px-4 pb-3 pt-2"
          style={{ borderColor: "var(--color-border)" }}
        >
          {aiCount > 0 && (
            <DetailSection
              title={`AI sessions linked (${aiCount})`}
              tint="#58a6ff"
              items={session.ai_session_ids}
              mono
            />
          )}
          {cardCount > 0 && (
            <DetailSection
              title={`Cards touched (${cardCount})`}
              tint="#a875ff"
              items={session.cards_touched}
            />
          )}
          {fileCount > 0 && (
            <DetailSection
              title={`Files changed (${fileCount})`}
              tint="#d29922"
              items={session.files_changed}
              mono
            />
          )}
          {aiCount === 0 && cardCount === 0 && fileCount === 0 && (
            <p className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
              No linked data recorded for this session.
            </p>
          )}
          {session.notes && (
            <div
              className="mt-2 rounded border-l-2 pl-3 text-[11px] leading-snug"
              style={{
                borderColor: statusTint,
                color: "var(--color-text-muted)",
              }}
            >
              {session.notes}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

interface DetailSectionProps {
  title: string;
  tint: string;
  items: string[];
  mono?: boolean;
}

function DetailSection({ title, tint, items, mono = false }: DetailSectionProps) {
  return (
    <div className="mb-2.5">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: tint }}>
        {title}
      </p>
      <ul
        className="max-h-28 overflow-y-auto space-y-0.5 rounded border p-1.5"
        style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border)" }}
      >
        {items.map((item, i) => (
          <li
            key={`${item}-${i}`}
            className={`truncate text-[10.5px] ${mono ? "font-mono" : ""}`}
            style={{ color: "var(--color-text-muted)" }}
            title={item}
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ProjectSessions({ projectId }: Props) {
  const [active, setActive] = useState<WorkSession | null>(null);
  const [history, setHistory] = useState<WorkSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEndModal, setShowEndModal] = useState(false);

  // Live elapsed seconds for the active session's banner clock.
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const elapsedRef = useRef(0);

  // ----- Data fetching -----

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [activeResult, historyResult] = await Promise.all([
        invoke<WorkSession | null>("project_work_session_active", { projectId }),
        invoke<WorkSession[]>("project_work_sessions_list", { projectId }),
      ]);
      setActive(activeResult);
      setHistory(historyResult);

      // Reset elapsed clock when active session changes or loads.
      if (activeResult) {
        const startDate = parseEpoch(activeResult.started_at);
        const secs = Math.floor((Date.now() - startDate.getTime()) / 1000);
        elapsedRef.current = secs;
        setElapsedSecs(secs);
      }
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Initial load + polling every 10s for active-session awareness.
  useEffect(() => {
    void loadAll();
    const pollId = window.setInterval(() => { void loadAll(); }, 10_000);
    return () => window.clearInterval(pollId);
  }, [loadAll]);

  // Second-by-second clock ticker for the active session banner.
  // Runs every second but does NOT re-fetch from the backend — that's the
  // polling interval's job. This just increments the local counter.
  useEffect(() => {
    if (!active) return;
    const tickId = window.setInterval(() => {
      elapsedRef.current += 1;
      setElapsedSecs(elapsedRef.current);
    }, 1_000);
    return () => window.clearInterval(tickId);
  }, [active]);

  // ----- End session flow -----

  const handleEndDone = useCallback(async () => {
    setShowEndModal(false);
    await loadAll();
  }, [loadAll]);

  // ----- Render -----

  // For the history list: exclude the active session (it's shown in the banner).
  const completedHistory = history.filter((s) => s.status !== "active");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Top bar */}
      <div
        className="flex items-center justify-between border-b px-3 py-1.5 text-xs"
        style={{
          background: "var(--color-surface-1)",
          borderColor: "var(--color-border)",
        }}
      >
        <div className="flex items-center gap-2" style={{ color: "var(--color-text-muted)" }}>
          <Play size={11} />
          <span className="font-semibold">Work Sessions</span>
          <span style={{ color: "var(--color-text-faint)" }}>·</span>
          <span>{history.length} total</span>
        </div>
        <button
          onClick={() => void loadAll()}
          disabled={loading}
          className="rounded p-1 hover:bg-[var(--color-surface-2)] disabled:opacity-40"
          aria-label="Refresh sessions"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="flex items-center justify-between border-b px-3 py-1 text-[11px]"
          style={{
            background: "rgba(239,68,68,0.08)",
            borderColor: "rgba(239,68,68,0.30)",
            color: "#ef4444",
          }}
        >
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss error">
            <X size={11} />
          </button>
        </div>
      )}

      {/* Active session banner — only when a session is running */}
      {active && (
        <ActiveSessionBanner
          session={active}
          onEndRequest={() => setShowEndModal(true)}
          elapsedSecs={elapsedSecs}
        />
      )}

      {/* Start session bar — only when no session is active */}
      {!active && (
        <StartSessionBar projectId={projectId} onStarted={() => void loadAll()} />
      )}

      {/* Horizontal timeline */}
      {history.length > 0 && <SessionTimeline sessions={history} />}

      {/* History list */}
      <div className="flex-1 overflow-y-auto p-2">
        {!loading && completedHistory.length === 0 && (
          <div
            className="mt-6 rounded border border-dashed p-5 text-center text-[12px]"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-text-muted)",
            }}
          >
            <p className="font-medium" style={{ color: "var(--color-text-secondary)" }}>
              No completed sessions yet
            </p>
            <p className="mt-1">
              Start a work session above to begin tracking your workflow.
            </p>
          </div>
        )}

        <ul className="space-y-1.5">
          {completedHistory.map((s) => (
            <SessionHistoryCard key={s.id} session={s} />
          ))}
        </ul>
      </div>

      {/* End session modal */}
      {showEndModal && active && (
        <EndSessionModal
          sessionId={active.id}
          projectId={projectId}
          onDone={() => void handleEndDone()}
          onCancel={() => setShowEndModal(false)}
        />
      )}
    </div>
  );
}
