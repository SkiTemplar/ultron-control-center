// Control Center — Memory tab: candidate inbox + memory health (MEMORY KERNEL).
//
// Human-in-the-loop control surface over the candidate/governance pipeline.
// The backend (control-center/src-tauri/src/commands/memory/inbox.rs) exposes:
//   - memory_inbox_list({ limit })           -> MemoryCandidate[]   (pending only)
//   - memory_candidate_approve({ id })        -> MemoryItem          (promote to ACTIVE)
//   - memory_candidate_reject({ id, reason }) -> ()
//   - memory_candidate_edit({ id, summary, content, importance, confidence })
//                                             -> MemoryCandidate     (updated draft)
//   - memory_stats()                          -> MemoryStats         (health counts)
//
// Design contract (matches the rest of the Control Center):
//   - Black, minimal, hard-edge. Colours 100% from var(--color-*); no hex.
//   - No emojis. Monochrome with neutral/warn/danger accents only.
//   - Refresh the list after every action; handle empty + error states.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, SmallButton } from "./dashboard/Card";

// ---------------------------------------------------------------------------
// Types (mirror the Rust serde shapes — snake_case keys)
// ---------------------------------------------------------------------------

interface MemoryCandidate {
  id: string;
  proposed_type: string;
  proposed_scope: string;
  proposed_title: string | null;
  proposed_summary: string | null;
  proposed_content: string | null;
  proposed_tags: string[];
  confidence: number;
  importance: number;
  risk_level: string;
  duplicate_candidates: string[];
  contradiction_candidates: string[];
  recommended_action: string;
  status: string;
  created_at: number;
}

interface MemoryStats {
  active: number;
  pending: number;
  rejected: number;
  deprecated: number;
  stale: number;
  candidates_pending: number;
}

interface ApproveFailure {
  id: string;
  error: string;
}

interface ApproveAllResult {
  approved: number;
  failed: ApproveFailure[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unexpected error";
}

function pct(value: number): string {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function relTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// A tiny inline chip used for type/scope/risk metadata.
function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "warn" | "danger";
}) {
  const color =
    tone === "danger"
      ? "var(--color-danger)"
      : tone === "warn"
        ? "var(--color-warn)"
        : "var(--color-text-tertiary)";
  const border =
    tone === "danger"
      ? "var(--color-danger)"
      : tone === "warn"
        ? "var(--color-warn)"
        : "var(--color-border-strong)";
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.06em]"
      style={{ color, border: `1px solid ${border}`, lineHeight: 1.2 }}
    >
      {children}
    </span>
  );
}

// A hard-edge, monochrome on/off switch (no emojis). Reuses the Control Center
// var(--color-*) tokens; the knob slides and the track turns accent when ON.
function ToggleSwitch({
  on,
  disabled,
  onClick,
  label,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="relative inline-flex h-[18px] w-[32px] shrink-0 items-center transition-colors"
      style={{
        background: on ? "var(--color-accent)" : "var(--color-surface-3, var(--color-surface-2))",
        border: `1px solid ${on ? "var(--color-accent)" : "var(--color-border-strong)"}`,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        className="block h-[12px] w-[12px] transition-transform"
        style={{
          background: on ? "var(--color-bg, #000)" : "var(--color-text-tertiary)",
          transform: on ? "translateX(15px)" : "translateX(2px)",
        }}
      />
    </button>
  );
}

// The auto-approve control: a labelled switch + a short safety subtitle. Lives in
// the Memory header so the policy is always visible alongside the inbox.
function AutoApproveControl({
  on,
  busy,
  onToggle,
}: {
  on: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="flex items-start gap-2.5 px-3 py-2"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      <ToggleSwitch on={on} disabled={busy} onClick={onToggle} label="Auto-aprobar candidatos" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div
            className="text-[12px] font-medium leading-tight"
            style={{ color: "var(--color-text)" }}
          >
            Auto-aprobar candidatos
          </div>
          {/* Live status badge so it's obvious whether the policy is active */}
          <span
            className="rounded px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide"
            style={{
              background: on
                ? "rgba(88,166,255,0.12)"
                : "var(--color-surface-3, var(--color-surface-1))",
              color: on ? "var(--color-accent, #58a6ff)" : "var(--color-text-tertiary)",
              border: `1px solid ${on ? "rgba(88,166,255,0.35)" : "var(--color-border-strong)"}`,
            }}
          >
            {busy ? "aplicando…" : on ? "activo" : "inactivo"}
          </span>
        </div>
        <div
          className="mt-0.5 text-[10.5px] leading-snug"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {busy
            ? "Aplicando cambio y aprobando candidatos limpios existentes…"
            : on
              ? "Confianza >= 85%: aprobacion automatica. Secretos y contradicciones siempre requieren tu OK."
              : "Todos los candidatos pasan por la bandeja. Activa para aprobar automaticamente los limpios de alta confianza."}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health strip — one figure per status so the user SEES the brain working.
// ---------------------------------------------------------------------------

function HealthStrip({ stats }: { stats: MemoryStats | null }) {
  const cells: { label: string; value: number | string; tone?: "warn" | "danger" }[] = [
    { label: "Active", value: stats?.active ?? "—" },
    { label: "Pending", value: stats?.candidates_pending ?? "—", tone: "warn" },
    { label: "Stale", value: stats?.stale ?? "—", tone: "warn" },
    { label: "Deprecated", value: stats?.deprecated ?? "—" },
    { label: "Rejected", value: stats?.rejected ?? "—" },
  ];
  return (
    <div
      className="grid gap-px"
      style={{
        gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))`,
        background: "var(--color-border)",
        border: "1px solid var(--color-border)",
      }}
    >
      {cells.map((c) => {
        const color =
          c.tone === "danger"
            ? "var(--color-danger)"
            : c.tone === "warn"
              ? "var(--color-warn)"
              : "var(--color-text)";
        return (
          <div
            key={c.label}
            className="flex flex-col gap-0.5 px-3 py-2.5"
            style={{ background: "var(--color-surface-2)" }}
          >
            <span
              className="text-[10.5px] font-medium uppercase tracking-[0.07em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {c.label}
            </span>
            <span
              className="text-[18px] font-semibold tabular-nums leading-none"
              style={{ color }}
            >
              {c.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Candidate row — collapsed metadata + Approve / Reject / Edit actions.
// ---------------------------------------------------------------------------

interface RowProps {
  candidate: MemoryCandidate;
  busy: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onEdit: (
    id: string,
    patch: { summary: string; content: string; importance: number; confidence: number },
  ) => void;
}

function CandidateRow({ candidate: c, busy, onApprove, onReject, onEdit }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(c.proposed_summary ?? "");
  const [content, setContent] = useState(c.proposed_content ?? "");
  const [importance, setImportance] = useState(c.importance);
  const [confidence, setConfidence] = useState(c.confidence);

  const hasDuplicates = c.duplicate_candidates.length > 0;
  const hasContradiction = c.contradiction_candidates.length > 0;
  const isSecret = c.risk_level?.toLowerCase() === "secret";

  function startEdit() {
    setSummary(c.proposed_summary ?? "");
    setContent(c.proposed_content ?? "");
    setImportance(c.importance);
    setConfidence(c.confidence);
    setEditing(true);
  }

  function saveEdit() {
    onEdit(c.id, { summary, content, importance, confidence });
    setEditing(false);
  }

  return (
    <div
      className="flex flex-col gap-2 p-3"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        borderLeft: `3px solid ${
          hasContradiction
            ? "var(--color-danger)"
            : hasDuplicates || isSecret
              ? "var(--color-warn)"
              : "var(--color-border-strong)"
        }`,
      }}
    >
      {/* Header: title + metadata chips */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[13.5px] font-semibold"
            style={{ color: "var(--color-text)" }}
            title={c.proposed_title ?? undefined}
          >
            {c.proposed_title || c.proposed_summary || "(untitled candidate)"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip>{c.proposed_type}</Chip>
            <Chip>{c.proposed_scope}</Chip>
            {isSecret && <Chip tone="danger">secret</Chip>}
            <span
              className="text-[11px] tabular-nums"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              imp {pct(c.importance)} · conf {pct(c.confidence)} · {relTime(c.created_at)}
            </span>
          </div>
        </div>
        {!editing && (
          <div className="flex shrink-0 items-center gap-1.5">
            <SmallButton
              variant="accent"
              onClick={() => onApprove(c.id)}
              disabled={busy}
              title="Promote to an ACTIVE, user-validated memory"
            >
              Approve
            </SmallButton>
            <SmallButton
              onClick={() => onReject(c.id)}
              disabled={busy}
              title="Reject this candidate — it never becomes a memory"
            >
              Reject
            </SmallButton>
            <SmallButton
              onClick={startEdit}
              disabled={busy}
              title="Edit the proposed fields before approving"
            >
              Edit
            </SmallButton>
          </div>
        )}
      </div>

      {/* Duplicate / contradiction warnings — informational only, do not block Approve */}
      {(hasDuplicates || hasContradiction) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {hasContradiction && (
            <Chip tone="danger">
              contradicts {c.contradiction_candidates.length} active — revisar antes de aprobar
            </Chip>
          )}
          {hasDuplicates && (
            <Chip tone="warn">
              {c.duplicate_candidates.length} possible duplicate
              {c.duplicate_candidates.length === 1 ? "" : "s"} — se puede aprobar igualmente
            </Chip>
          )}
        </div>
      )}

      {/* Collapsed summary preview when not editing */}
      {!editing && c.proposed_summary && c.proposed_title && (
        <div
          className="text-[12px] leading-snug"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {c.proposed_summary}
        </div>
      )}

      {/* Inline editor */}
      {editing && (
        <div className="flex flex-col gap-2">
          <label
            className="text-[10.5px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Summary
          </label>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={2}
            className="w-full resize-y bg-transparent px-2 py-1.5 text-[12.5px] outline-none"
            style={{
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              fontFamily: "var(--font-mono, ui-monospace)",
            }}
          />
          <label
            className="text-[10.5px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Content
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            className="w-full resize-y bg-transparent px-2 py-1.5 text-[12.5px] outline-none"
            style={{
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              fontFamily: "var(--font-mono, ui-monospace)",
            }}
          />
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span
                className="text-[11px] uppercase tracking-[0.06em]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Importance {pct(importance)}
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={importance}
                onChange={(e) => setImportance(Number(e.target.value))}
              />
            </div>
            <div className="flex items-center gap-2">
              <span
                className="text-[11px] uppercase tracking-[0.06em]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Confidence {pct(confidence)}
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={confidence}
                onChange={(e) => setConfidence(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <SmallButton variant="accent" onClick={saveEdit} disabled={busy}>
              Save changes
            </SmallButton>
            <SmallButton onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </SmallButton>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MemoryInbox — the Memory tab body.
// ---------------------------------------------------------------------------

export function MemoryInbox() {
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // Per-row in-flight guard so the user can't double-fire an action.
  const [busyId, setBusyId] = useState<string | null>(null);
  // Bulk approve-all in-flight guard (blocks the whole inbox while running).
  const [approvingAll, setApprovingAll] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  // Auto-approve policy: persisted toggle. When ON, future CLEAN candidates skip
  // the inbox; secrets / contradictions always stay here for human review.
  const [autoApprove, setAutoApprove] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const loadStats = useCallback(async () => {
    try {
      const s = (await invoke("memory_stats")) as MemoryStats;
      setStats(s);
      setStatsError(null);
    } catch (e) {
      setStatsError(errMsg(e));
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const list = (await invoke("memory_inbox_list", { limit: 200 })) as MemoryCandidate[];
      setCandidates(list ?? []);
      setListError(null);
    } catch (e) {
      setListError(errMsg(e));
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAuto = useCallback(async () => {
    try {
      const on = (await invoke("memory_auto_approve_get")) as boolean;
      setAutoApprove(!!on);
    } catch {
      // Fail-safe: treat an unreadable setting as OFF.
      setAutoApprove(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadList(), loadStats()]);
  }, [loadList, loadStats]);

  useEffect(() => {
    void refreshAll();
    void loadAuto();
  }, [refreshAll, loadAuto]);

  // Run a mutation, then refresh both the list and the health counts so the
  // UI always reflects the SoT after an action.
  const runAction = useCallback(
    async (id: string, fn: () => Promise<unknown>) => {
      setBusyId(id);
      try {
        await fn();
        await refreshAll();
      } catch (e) {
        setListError(errMsg(e));
      } finally {
        setBusyId(null);
      }
    },
    [refreshAll],
  );

  const onApprove = useCallback(
    (id: string) => void runAction(id, () => invoke("memory_candidate_approve", { id })),
    [runAction],
  );

  const onReject = useCallback(
    (id: string) =>
      void runAction(id, () =>
        invoke("memory_candidate_reject", { id, reason: "user: rejected from inbox" }),
      ),
    [runAction],
  );

  const onEdit = useCallback(
    (
      id: string,
      patch: { summary: string; content: string; importance: number; confidence: number },
    ) =>
      void runAction(id, () =>
        invoke("memory_candidate_edit", {
          id,
          summary: patch.summary,
          content: patch.content,
          importance: patch.importance,
          confidence: patch.confidence,
        }),
      ),
    [runAction],
  );

  // Bulk approve every pending candidate. Confirm first (this is destructive in
  // bulk), then promote all via the single backend command and refresh the SoT.
  const onApproveAll = useCallback(async () => {
    const n = candidates.length;
    if (n === 0) return;
    // Two-phase confirm: window.confirm is mapped to the Tauri dialog plugin,
    // which the capabilities ACL blocks. First click arms, second click within
    // 4s executes. Same pattern as BatchDropdown "Clear all".
    if (!confirmingAll) {
      setConfirmingAll(true);
      window.setTimeout(() => setConfirmingAll(false), 4000);
      return;
    }
    setConfirmingAll(false);
    setApprovingAll(true);
    setListError(null);
    try {
      const res = (await invoke("memory_inbox_approve_all")) as ApproveAllResult;
      await refreshAll();
      if (res.failed.length > 0) {
        setListError(
          `${res.approved} aprobados, ${res.failed.length} fallaron: ${res.failed
            .map((f) => f.id)
            .join(", ")}`,
        );
      }
    } catch (e) {
      setListError(errMsg(e));
    } finally {
      setApprovingAll(false);
    }
  }, [candidates.length, confirmingAll, refreshAll]);

  // Flip the auto-approve policy. On ENABLE we also offer to clear the existing
  // backlog of CLEAN pending candidates in one shot (the backend command applies
  // the same secret/contradiction safeguard, so flagged ones are left behind).
  const onToggleAuto = useCallback(async () => {
    const next = !autoApprove;
    setAutoBusy(true);
    setListError(null);
    try {
      const stored = (await invoke("memory_auto_approve_set", { enabled: next })) as boolean;
      setAutoApprove(!!stored);
      if (stored) {
        const res = (await invoke("memory_inbox_approve_clean")) as ApproveAllResult;
        await refreshAll();
        if (res.failed.length > 0) {
          setListError(
            `Auto-aprobar activado. ${res.approved} limpios aprobados, ${res.failed.length} fallaron.`,
          );
        }
      }
    } catch (e) {
      setListError(errMsg(e));
      // Re-sync the toggle with whatever actually persisted.
      void loadAuto();
    } finally {
      setAutoBusy(false);
    }
  }, [autoApprove, refreshAll, loadAuto]);

  const pendingCount = candidates.length;
  const flagged = useMemo(
    () =>
      candidates.filter(
        (c) => c.contradiction_candidates.length > 0 || c.duplicate_candidates.length > 0,
      ).length,
    [candidates],
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold" style={{ color: "var(--color-text)" }}>
            Memory
          </h1>
          <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            {pendingCount > 0
              ? `${pendingCount} candidate${pendingCount === 1 ? "" : "s"} awaiting validation${
                  flagged > 0 ? ` · ${flagged} flagged` : ""
                }`
              : "Human-in-the-loop validation of the memory kernel"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {pendingCount > 0 && (
            <SmallButton
              variant="accent"
              onClick={() => void onApproveAll()}
              disabled={loading || approvingAll || busyId !== null}
              title="Aprobar todos los candidatos pendientes y promoverlos a memorias ACTIVAS"
            >
              {approvingAll
                ? "Aprobando..."
                : confirmingAll
                  ? `Confirmar: aprobar ${pendingCount}?`
                  : `Aceptar todos (${pendingCount})`}
            </SmallButton>
          )}
          <SmallButton onClick={() => void refreshAll()} disabled={loading || approvingAll}>
            {loading ? "Refreshing..." : "Refresh"}
          </SmallButton>
        </div>
      </div>
      {/* Auto-approve policy toggle */}
      <AutoApproveControl
        on={autoApprove}
        busy={autoBusy || approvingAll}
        onToggle={() => void onToggleAuto()}
      />

      {/* Memory Trace / health */}
      <Card
        title="Memory Trace"
        subtitle="Live brain.db health — what is stored and what is awaiting review"
        error={statsError}
      >
        <HealthStrip stats={stats} />
      </Card>

      {/* Inbox */}
      <Card
        title="Candidate Inbox"
        subtitle="Approve, reject, or edit captured candidates before they enter recall"
        accent={pendingCount > 0 ? "warn" : "neutral"}
        loading={loading}
        error={listError}
        empty={!loading && pendingCount === 0 ? "Inbox empty — no candidates pending validation." : null}
      >
        <div className="flex flex-col gap-2">
          {candidates.map((c) => (
            <CandidateRow
              key={c.id}
              candidate={c}
              busy={busyId === c.id}
              onApprove={onApprove}
              onReject={onReject}
              onEdit={onEdit}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}
