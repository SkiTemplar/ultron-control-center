// WorkdayDetail - vista del workday seleccionado.
//
// Tauri commands consumidos:
//   get_workday_detail(id) -> Workday
//   start_workday(id, energy_before) -> Workday
//   pause_workday(id, break_seconds_delta) -> Workday
//   resume_workday(id) -> Workday
//   complete_workday(id, ...retro fields) -> Workday
//   archive_workday(id) -> Workday
//   update_goal(workday_id, goal_id, status, text?) -> Workday

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type {
  GoalStatus,
  Workday,
  WorkdayContext,
  WorkdayContextEntry,
  WorkdayGoal,
} from "./types";
import { getHomeDir, joinPath } from "../../lib/paths";

interface WorkdayDetailProps {
  workdayId: string;
  refreshKey: number | string;
  onChanged: (wd: Workday) => void;
}

function fmtTs(s?: string): string {
  if (!s) return "-";
  // backend escribe "epoch:1234567890"
  const m = s.match(/^epoch:(\d+)$/);
  if (!m) return s;
  const d = new Date(Number(m[1]) * 1000);
  return d.toLocaleString();
}

export function WorkdayDetail({
  workdayId,
  refreshKey,
  onChanged,
}: WorkdayDetailProps) {
  const [wd, setWd] = useState<Workday | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // retro form (only used when transitioning to completed)
  const [retroGood, setRetroGood] = useState("");
  const [retroBad, setRetroBad] = useState("");
  const [retroLearned, setRetroLearned] = useState("");
  const [showCompleteForm, setShowCompleteForm] = useState(false);

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
    await runCmd("update_goal", {
      workdayId,
      goalId: goal.id,
      status: next,
      text: null,
    });
  }

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
  const canComplete =
    wd.status === "in_progress" || wd.status === "paused";
  const canArchive = wd.status === "completed";

  return (
    <div className="flex h-full flex-col overflow-auto">
      {/* Header */}
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

        {/* Actions */}
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

      {/* Complete form */}
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

      {/* Goals */}
      <div className="px-6 py-4">
        <h3
          className="mb-2 text-[13px] font-semibold"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Goals ({wd.goals.length})
        </h3>
        {wd.goals.length === 0 && (
          <div
            className="text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            No goals yet.
          </div>
        )}
        <ul className="flex flex-col gap-1">
          {wd.goals.map((g) => (
            <li
              key={g.id}
              className="flex items-start gap-2 rounded px-2 py-1.5"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border)",
              }}
            >
              <input
                type="checkbox"
                checked={g.status === "done"}
                disabled={busy}
                onChange={() => toggleGoal(g)}
                className="mt-1"
              />
              <span
                className="flex-1 text-[13px]"
                style={{
                  color: "var(--color-text)",
                  textDecoration:
                    g.status === "done" ? "line-through" : "none",
                  opacity: g.status === "done" ? 0.6 : 1,
                }}
              >
                {g.text}
              </span>
              <span
                className="text-[10px] uppercase"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {g.status}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Linked sessions (T2 — auto-link drainer) */}
      <LinkedSessionsBlock sessionIds={wd.linked_sessions} />

      {/* Shared context (v2.8 — automatic surface) */}
      <ContextBlock
        workdayId={workdayId}
        context={wd.context}
        onAppended={(next) => setWd(next)}
        busy={busy}
      />

      {/* Existing retro display */}
      {(wd.retro_good || wd.retro_bad || wd.retro_learned) && (
        <div
          className="border-t px-6 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <h3
            className="mb-2 text-[13px] font-semibold"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Retrospective
          </h3>
          <RetroLine label="Good" value={wd.retro_good} />
          <RetroLine label="Bad" value={wd.retro_bad} />
          <RetroLine label="Learned" value={wd.retro_learned} />
        </div>
      )}
    </div>
  );
}

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
        color: primary ? "white" : "var(--color-text-secondary)",
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
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
          color: "var(--color-text)",
          resize: "vertical",
        }}
      />
    </label>
  );
}

interface LinkedSessionsBlockProps {
  sessionIds: string[];
}
function LinkedSessionsBlock({ sessionIds }: LinkedSessionsBlockProps) {
  const [openErr, setOpenErr] = useState<string | null>(null);

  async function openTranscript(sessionId: string) {
    setOpenErr(null);
    try {
      const home = await getHomeDir();
      // The Claude Code session transcripts live in a per-project dir under
      // ~/.claude/projects/<slug>/<session_id>.jsonl. We don't know the slug
      // here so try the well-known fallbacks in order.
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
          // try next
        }
      }
      setOpenErr(`No transcript found for ${sessionId}`);
    } catch (e) {
      setOpenErr(String(e));
    }
  }

  if (!sessionIds || sessionIds.length === 0) return null;
  return (
    <div
      className="border-t px-6 py-4"
      style={{ borderColor: "var(--color-border)" }}
    >
      <h3
        className="mb-2 text-[13px] font-semibold"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Linked sessions ({sessionIds.length})
      </h3>
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
              background: "var(--color-surface-1)",
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
    </div>
  );
}

interface ContextBlockProps {
  workdayId: string;
  context: WorkdayContext;
  onAppended: (wd: Workday) => void;
  busy: boolean;
}
function ContextBlock({
  workdayId,
  context,
  onAppended,
  busy,
}: ContextBlockProps) {
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

  const total =
    context.notes.length +
    context.decisions.length +
    context.file_changes.length +
    context.agent_messages.length;

  return (
    <div
      className="border-t px-6 py-4"
      style={{ borderColor: "var(--color-border)" }}
    >
      <h3
        className="mb-2 text-[13px] font-semibold"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Shared context ({total})
      </h3>
      <div className="mb-3 flex flex-col gap-2">
        <div className="flex gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            disabled={appending || busy}
            className="rounded px-2 py-1 text-[12px]"
            style={{
              background: "var(--color-surface-1)",
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
              background: "var(--color-surface-1)",
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
              background: "var(--color-accent, #2563eb)",
              color: "white",
            }}
          >
            {appending ? "..." : "Append"}
          </button>
        </div>
        {err && (
          <div
            className="text-[11px]"
            style={{ color: "var(--color-danger, #ef4444)" }}
          >
            {err}
          </div>
        )}
      </div>
      <ContextList title="Decisions" entries={context.decisions} />
      <ContextList title="Notes" entries={context.notes} />
      <ContextList title="File changes" entries={context.file_changes} />
      <ContextList title="Agent messages" entries={context.agent_messages} />
    </div>
  );
}

interface ContextListProps {
  title: string;
  entries: WorkdayContextEntry[];
}
function ContextList({ title, entries }: ContextListProps) {
  if (!entries || entries.length === 0) return null;
  return (
    <div className="mb-3">
      <div
        className="mb-1 text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {title}
      </div>
      <ul className="flex flex-col gap-1">
        {entries.map((e) => (
          <li
            key={e.id}
            className="rounded px-2 py-1.5 text-[12px]"
            style={{
              background: "var(--color-surface-1)",
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
