// ULTRON Control Center — Hooks viewer (v2.8 REDESIGN).
//
// USER's brief: "Hooks me gusta un poco más pero no usa el diseño de
// Cajitas que usa Skills, Agents y Rules." Move to the unified Library card
// pattern:
//
//   - Grid of cards where each card is ONE INDIVIDUAL hook (not a category).
//   - Only the hook id is shown on the card. Amber accent (top ribbon) to
//     distinguish from Skills (cyan), Agents (violet), Rules (lime). The
//     event gets a secondary chip in the card corner using its event colour.
//   - Top toolbar has filter chips by event: All / PreToolUse / PostToolUse
//     / Stop / etc. — clicking filters the grid; the active chip is tinted
//     with that event's colour.
//   - Clicking a card opens a detail pane on the right side (mirrors the
//     Skills/Agents/Rules 2-pane layout). The pane shows id, event, matcher,
//     source, last fired, the full command rendered as a code block, and
//     three action buttons: Test / Edit / Delete.
//   - The "no instrumentation" banner stays. The "+ Create hook" button
//     and "Add with AI" entry point stay. The Add / Edit / Test / AI modals
//     are unchanged from v2.7 — only the listing UI is rebuilt.
//
// Implementation notes:
//
//   - We do NOT use the shared LibraryDetailPane because its action bar
//     (Edit / Edit with AI / Open Externally) doesn't match what a hook
//     needs (Test / Edit / Delete). Instead we keep a hook-shaped detail
//     pane that follows the same visual language — rounded card, ribbon
//     accent, header chip, scrollable body — so the two panes feel like
//     siblings without forcing inappropriate buttons.
//   - The amber accent constants mirror the Skills (cyan) / Agents
//     (violet) / Rules (lime) tokens so the four tabs read as a family.
//   - Modals (HookFormModal / TestModal / AiModal / empty state) are
//     preserved verbatim from v2.7 — they're already in good shape and
//     out of scope for this redesign.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../lib/dialog";
import type { HookLastFired } from "../types";
import { Plus, X } from "./library/icons";

// ---------------------------------------------------------------------------
// Types (mirror src-tauri/src/hooks_admin.rs)
// ---------------------------------------------------------------------------

type HookRecord = {
  id: string;
  event: string;
  matcher: string | null;
  command: string;
  enabled: boolean;
  source: string;
  extra: Record<string, unknown>;
};

type HooksList = {
  hooks: HookRecord[];
  settings_path: string;
  settings_exists: boolean;
};

type HookMutationResult = {
  success: boolean;
  hook: HookRecord | null;
  backup_path: string | null;
};

type HookTestResult = {
  success: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  elapsed_ms: number;
  timed_out: boolean;
};

type HookFire = {
  timestamp: string | null;
  event: string | null;
  hook_id: string | null;
  matcher: string | null;
  exit_code: number | null;
  raw: Record<string, unknown>;
};

type HookFiresReport = {
  fires: HookFire[];
  log_path: string;
  instrumented: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENT_OPTIONS: readonly string[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "Notification",
] as const;

const DEFAULT_PAYLOAD = `{
  "tool_name": "Bash",
  "tool_input": { "command": "echo hello" }
}`;

// v2.8 amber accent — distinguishes hook cards from skills (cyan), agents
// (violet) and rules (lime) at a glance. The ribbon sits on top of every
// card and the detail pane header.
const HOOK_ACCENT = "rgba(251, 191, 36, 0.55)";
const HOOK_ACCENT_SOFT = "rgba(251, 191, 36, 0.16)";
const HOOK_ACCENT_TEXT = "#fcd34d";
const HOOK_ACCENT_BORDER = "rgba(251, 191, 36, 0.45)";

function eventBadgeColor(event: string): { bg: string; fg: string; border: string } {
  switch (event) {
    case "PreToolUse":
      return {
        bg: "rgba(96, 165, 250, 0.18)",
        fg: "#93c5fd",
        border: "rgba(96, 165, 250, 0.45)",
      };
    case "PostToolUse":
      return {
        bg: "rgba(52, 211, 153, 0.18)",
        fg: "#6ee7b7",
        border: "rgba(52, 211, 153, 0.45)",
      };
    case "UserPromptSubmit":
      return {
        bg: "rgba(251, 191, 36, 0.18)",
        fg: "#fcd34d",
        border: "rgba(251, 191, 36, 0.45)",
      };
    case "SessionStart":
    case "SessionEnd":
      return {
        bg: "rgba(167, 139, 250, 0.18)",
        fg: "#c4b5fd",
        border: "rgba(167, 139, 250, 0.45)",
      };
    case "Stop":
    case "SubagentStop":
      return {
        bg: "rgba(248, 113, 113, 0.18)",
        fg: "#fca5a5",
        border: "rgba(248, 113, 113, 0.45)",
      };
    case "PreCompact":
      return {
        bg: "rgba(244, 114, 182, 0.18)",
        fg: "#f9a8d4",
        border: "rgba(244, 114, 182, 0.45)",
      };
    case "Notification":
      return {
        bg: "rgba(45, 212, 191, 0.18)",
        fg: "#5eead4",
        border: "rgba(45, 212, 191, 0.45)",
      };
    default:
      return {
        bg: "var(--color-surface-3)",
        fg: "var(--color-text-secondary)",
        border: "var(--color-border)",
      };
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "...";
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type EventFilter = "all" | string;

export function Hooks() {
  const [list, setList] = useState<HooksList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [filterText, setFilterText] = useState<string>("");

  // v2.8: filter chips replace the v2.7 category cards. Single-select; the
  // active chip is tinted with that event's colour.
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");

  const [addOpen, setAddOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiDescription, setAiDescription] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const [editTarget, setEditTarget] = useState<HookRecord | null>(null);
  const [testTarget, setTestTarget] = useState<HookRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [fires, setFires] = useState<HookFiresReport | null>(null);
  // P7: last-fired entry per hook id (timestamp + project slug).
  const [lastFired, setLastFired] = useState<Record<string, HookLastFired>>({});

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  async function fetchList() {
    try {
      const res = (await invoke("list_hooks")) as HooksList;
      setList(res);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function fetchFires() {
    try {
      const res = (await invoke("recent_hook_fires", { limit: 50 })) as HookFiresReport;
      setFires(res);
    } catch (e) {
      // Non-fatal — instrumentation is optional.
      console.warn("recent_hook_fires failed", e);
    }
  }

  useEffect(() => {
    fetchList();
    fetchFires();
  }, []);

  // P7: refresh per-hook last fired whenever the list changes.
  useEffect(() => {
    const hooks = list?.hooks ?? [];
    if (hooks.length === 0) {
      setLastFired({});
      return;
    }
    let cancelled = false;
    (async () => {
      const map: Record<string, HookLastFired> = {};
      for (const h of hooks) {
        try {
          const r = (await invoke("hooks_last_fired", { id: h.id })) as HookLastFired;
          map[h.id] = r;
        } catch {
          /* skip — hook may have never fired */
        }
      }
      if (!cancelled) setLastFired(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [list]);

  function showFlash(msg: string) {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 4000);
  }

  // -------------------------------------------------------------------------
  // CRUD handlers
  // -------------------------------------------------------------------------

  async function handleToggle(hook: HookRecord) {
    try {
      const res = (await invoke("toggle_hook", { id: hook.id })) as HookMutationResult;
      showFlash(
        `${res.hook?.enabled ? "Enabled" : "Disabled"} hook. Backup: ${res.backup_path ?? "n/a"}`,
      );
      await fetchList();
    } catch (e) {
      showFlash(`Toggle failed: ${e}`);
    }
  }

  async function handleDelete(hook: HookRecord) {
    try {
      const res = (await invoke("delete_hook", { id: hook.id })) as HookMutationResult;
      showFlash(`Deleted hook. Backup: ${res.backup_path ?? "n/a"}`);
      if (selectedId === hook.id) setSelectedId(null);
      await fetchList();
    } catch (e) {
      showFlash(`Delete failed: ${e}`);
    }
  }

  async function submitAi() {
    const desc = aiDescription.trim();
    if (!desc) return;
    setAiBusy(true);
    try {
      const res = (await invoke("request_hook_via_ai", { description: desc })) as string;
      showFlash(res);
      setAiOpen(false);
      setAiDescription("");
    } catch (e) {
      showFlash(`AI request failed: ${e}`);
    } finally {
      setAiBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  // v2.8: filter pipeline = event filter chip → text search.
  const filtered = useMemo(() => {
    if (!list) return [];
    const q = filterText.trim().toLowerCase();
    return list.hooks.filter((h) => {
      if (eventFilter !== "all" && h.event !== eventFilter) return false;
      if (!q) return true;
      const hay = `${h.id} ${h.matcher ?? ""} ${h.command ?? ""} ${h.event ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [list, filterText, eventFilter]);

  // Per-event counts feed the chip labels — keeps users oriented when many
  // categories are empty.
  const eventCounts = useMemo(() => {
    const map = new Map<string, number>();
    map.set("all", list?.hooks.length ?? 0);
    for (const e of EVENT_OPTIONS) map.set(e, 0);
    for (const h of list?.hooks ?? []) {
      map.set(h.event, (map.get(h.event) ?? 0) + 1);
    }
    return map;
  }, [list]);

  const selectedHook = useMemo(
    () => list?.hooks.find((h) => h.id === selectedId) ?? null,
    [list, selectedId],
  );

  const selectedFires = useMemo(() => {
    if (!fires || !selectedHook) return [];
    return fires.fires.filter((f) => f.hook_id === selectedHook.id);
  }, [fires, selectedHook]);

  // -------------------------------------------------------------------------
  // Card grid renderer — mirrors the Skills/Agents/Rules tile shape so the
  // four library tabs share a visual language.
  // -------------------------------------------------------------------------

  const renderCardGrid = (items: HookRecord[]) => (
    <div
      className="grid gap-3"
      style={{
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
      }}
    >
      {items.map((h) => {
        const isActive = selectedId === h.id;
        const evColor = eventBadgeColor(h.event);
        return (
          <button
            key={h.id}
            type="button"
            onClick={() => setSelectedId(isActive ? null : h.id)}
            className="group flex h-[140px] flex-col justify-between rounded-xl p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            style={{
              background: isActive
                ? "var(--color-surface-3)"
                : "var(--color-surface-2)",
              border: `1px solid ${
                isActive ? HOOK_ACCENT : "var(--color-border)"
              }`,
              // Primary amber ribbon on top; secondary event-colour stripe
              // just below it to identify the event at a glance.
              boxShadow: `inset 0 3px 0 ${HOOK_ACCENT}, inset 0 6px 0 ${evColor.border}`,
              opacity: h.enabled ? 1 : 0.55,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = HOOK_ACCENT;
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${HOOK_ACCENT}, inset 0 6px 0 ${evColor.border}, 0 6px 18px rgba(0,0,0,0.28)`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = isActive
                ? HOOK_ACCENT
                : "var(--color-border)";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${HOOK_ACCENT}, inset 0 6px 0 ${evColor.border}`;
            }}
            title={`${h.id}\n${h.command}`}
          >
            <div
              className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              <span style={{ color: HOOK_ACCENT_TEXT }}>Hook</span>
              <span
                className="ml-auto rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
                style={{
                  background: evColor.bg,
                  color: evColor.fg,
                  border: `1px solid ${evColor.border}`,
                }}
              >
                {h.event}
              </span>
            </div>
            <div
              className="line-clamp-3 text-[18px] font-semibold leading-tight tracking-tight"
              style={{
                color: "var(--color-text)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {h.id}
            </div>
            <div
              className="flex items-center gap-1.5 text-[10px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              <span
                className="rounded px-1.5 py-px"
                style={{
                  background: HOOK_ACCENT_SOFT,
                  color: HOOK_ACCENT_TEXT,
                  border: `1px solid ${HOOK_ACCENT_BORDER}`,
                }}
              >
                {h.source}
              </span>
              {!h.enabled && (
                <span style={{ color: "var(--color-text-faint)" }}>
                  disabled
                </span>
              )}
              {lastFired[h.id]?.timestamp && (
                <span
                  className="ml-auto truncate"
                  style={{ fontFamily: "var(--font-mono)" }}
                  title={`Last fired ${lastFired[h.id].timestamp ?? ""} in ${lastFired[h.id].project ?? "?"}`}
                >
                  {(lastFired[h.id].timestamp ?? "").slice(0, 16).replace("T", " ")}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">Hooks</h2>
          <span
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {filtered.length} of {list?.hooks.length ?? 0}
            {list?.settings_path && (
              <>
                {" "}
                ·{" "}
                <code
                  className="text-[11px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {list.settings_path}
                </code>
              </>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fetchList()}
            className="rounded-md border px-3 py-1 text-xs"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
            title="Re-read settings.json"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setAiOpen(true)}
            className="rounded-md border px-3 py-1 text-xs"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
            title="Open a Claude session that drafts the hook JSON for you"
          >
            Add with AI
          </button>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            <Plus size={12} /> Create hook
          </button>
        </div>
      </header>

      {flash && (
        <div
          className="rounded border px-3 py-2 text-[12px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
          }}
        >
          {flash}
        </div>
      )}

      {error && (
        <div
          className="rounded-md p-3 text-xs"
          style={{
            border: "1px solid rgba(248, 81, 73, 0.30)",
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {list && !list.settings_exists && (
        <div
          className="rounded border px-3 py-2 text-[12px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
          }}
        >
          settings.json does not exist yet. Adding the first hook will create
          it.
        </div>
      )}

      {/* v2.8 — Instrumentation banner. Wording preserved verbatim per
          USER's spec so it reads the same here, in the SidePanel and
          anywhere else we surface it. */}
      {!loading && fires && !fires.instrumented && (
        <div
          className="rounded border px-3 py-2 text-[12.5px] leading-relaxed"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
          }}
        >
          No instrumentation set up yet. To track fires, have your hook
          append a JSON line to{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>
            ~/.ultron/.tmp/hook-fires.jsonl
          </code>{" "}
          (keys: timestamp, event, hook_id, matcher, exit_code).
        </div>
      )}

      {/* v2.8 — Event filter chips. Single-select. The active chip is tinted
          with that event's colour so the grid below visually "belongs" to
          the active filter. */}
      {!loading && list && list.hooks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="mr-1 text-[10.5px] uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Event
          </span>
          {(["all", ...EVENT_OPTIONS] as EventFilter[]).map((ev) => {
            const active = eventFilter === ev;
            const count = eventCounts.get(ev) ?? 0;
            const colors =
              ev === "all"
                ? {
                    bg: HOOK_ACCENT_SOFT,
                    fg: HOOK_ACCENT_TEXT,
                    border: HOOK_ACCENT_BORDER,
                  }
                : eventBadgeColor(ev);
            return (
              <button
                key={ev}
                type="button"
                onClick={() => setEventFilter(ev)}
                disabled={ev !== "all" && count === 0}
                className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors disabled:opacity-30"
                style={{
                  borderColor: active ? colors.border : "var(--color-border-strong)",
                  background: active ? colors.bg : "transparent",
                  color: active ? colors.fg : "var(--color-text-secondary)",
                }}
              >
                <span>{ev === "all" ? "All" : ev}</span>
                <span
                  className="tabular-nums text-[10px]"
                  style={{
                    color: active ? colors.fg : "var(--color-text-tertiary)",
                  }}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <input
        type="text"
        value={filterText}
        onChange={(e) => setFilterText(e.target.value)}
        placeholder="Search by id / matcher / command..."
        className="w-full rounded-md px-3 py-2 text-sm outline-none"
        style={{
          border: "1px solid var(--color-border-strong)",
          background: "var(--color-surface-2)",
          color: "var(--color-text)",
        }}
      />

      {loading && (
        <div className="text-[13px]" style={{ color: "var(--color-text-tertiary)" }}>
          Loading...
        </div>
      )}

      {!loading && list && list.hooks.length === 0 && (
        <HooksEmptyState
          onAdd={() => setAddOpen(true)}
          onAi={() => setAiOpen(true)}
        />
      )}

      {/* 2-pane layout: card grid on the left, detail pane on the right
          when a hook is selected. Stacks vertically on narrow viewports. */}
      {!loading && list && list.hooks.length > 0 && (
        <div className="flex flex-1 flex-col gap-3 overflow-hidden lg:flex-row">
          <div
            className={
              selectedHook
                ? "min-w-0 flex-1 overflow-y-auto"
                : "flex-1 overflow-y-auto"
            }
            style={{ minWidth: 0 }}
          >
            {filtered.length === 0 ? (
              <p
                className="text-xs"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Sin hooks para el filtro actual.
              </p>
            ) : (
              renderCardGrid(filtered)
            )}
          </div>

          {selectedHook && (
            <div
              className="overflow-hidden lg:w-[560px] lg:shrink-0"
              style={{ minWidth: 0 }}
            >
              <HookDetailPane
                hook={selectedHook}
                lastFired={lastFired[selectedHook.id]}
                fires={selectedFires}
                firesInstrumented={fires?.instrumented ?? false}
                firesLogPath={fires?.log_path ?? null}
                onTest={() => setTestTarget(selectedHook)}
                onEdit={() => setEditTarget(selectedHook)}
                onToggle={() => void handleToggle(selectedHook)}
                onDelete={async () => {
                  const ok = await confirmDialog(
                    `Delete hook?\n\nEvent: ${selectedHook.event}\nMatcher: ${selectedHook.matcher ?? "(none)"}\nCommand: ${truncate(selectedHook.command, 200)}`,
                    { title: "Delete hook", kind: "error" },
                  );
                  if (ok) await handleDelete(selectedHook);
                }}
                onClose={() => setSelectedId(null)}
              />
            </div>
          )}
        </div>
      )}

      {addOpen && (
        <HookFormModal
          mode="add"
          onClose={() => setAddOpen(false)}
          onSaved={async (msg) => {
            setAddOpen(false);
            showFlash(msg);
            await fetchList();
          }}
        />
      )}

      {editTarget && (
        <HookFormModal
          mode="edit"
          initial={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={async (msg) => {
            setEditTarget(null);
            showFlash(msg);
            await fetchList();
          }}
        />
      )}

      {testTarget && (
        <TestModal hook={testTarget} onClose={() => setTestTarget(null)} />
      )}

      {aiOpen && (
        <AiModal
          description={aiDescription}
          busy={aiBusy}
          onChange={setAiDescription}
          onClose={() => setAiOpen(false)}
          onSubmit={submitAi}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail pane — hook-shaped sibling to LibraryDetailPane. Same visual
// language (rounded card, ribbon accent, header with chip, scrollable body)
// but action buttons appropriate for a hook (Test / Edit / Delete) instead
// of skill-style ones (Edit / Edit with AI / Open Externally).
// ---------------------------------------------------------------------------

function HookDetailPane({
  hook,
  lastFired,
  fires,
  firesInstrumented,
  firesLogPath,
  onTest,
  onEdit,
  onToggle,
  onDelete,
  onClose,
}: {
  hook: HookRecord;
  lastFired: HookLastFired | undefined;
  fires: HookFire[];
  firesInstrumented: boolean;
  firesLogPath: string | null;
  onTest: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const evColor = eventBadgeColor(hook.event);

  return (
    <aside
      className="flex h-full w-full flex-col overflow-hidden rounded-md"
      style={{
        border: "1px solid var(--color-border-strong)",
        background: "var(--color-surface-2)",
        boxShadow: `inset 0 3px 0 ${HOOK_ACCENT}`,
      }}
    >
      {/* Header */}
      <header
        className="flex items-start justify-between gap-2 border-b p-3"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className="truncate text-[13.5px] font-semibold"
              style={{
                color: "var(--color-text)",
                fontFamily: "var(--font-mono)",
              }}
              title={hook.id}
            >
              {hook.id}
            </span>
            <span
              className="ml-1 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide"
              style={{
                background: HOOK_ACCENT_SOFT,
                color: HOOK_ACCENT_TEXT,
                border: `1px solid ${HOOK_ACCENT_BORDER}`,
              }}
            >
              Hook
            </span>
            <span
              className="rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide"
              style={{
                background: evColor.bg,
                color: evColor.fg,
                border: `1px solid ${evColor.border}`,
              }}
            >
              {hook.event}
            </span>
          </div>
          <div
            className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px]"
            style={{
              color: "var(--color-text-tertiary)",
              fontFamily: "var(--font-mono)",
            }}
          >
            <span>matcher: {hook.matcher ?? "(any)"}</span>
            <span>source: {hook.source}</span>
            <span>{hook.enabled ? "enabled" : "disabled"}</span>
            {lastFired?.timestamp && (
              <span title={`in ${lastFired.project ?? "?"}`}>
                last fired {lastFired.timestamp.slice(0, 16).replace("T", " ")}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1"
          style={{
            background: "transparent",
            color: "var(--color-text-tertiary)",
            border: "1px solid var(--color-border)",
          }}
          title="Close detail panel"
          aria-label="Close"
        >
          <X size={12} />
        </button>
      </header>

      {/* Action bar */}
      <div
        className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <button
          type="button"
          onClick={onTest}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
          title="Run this hook against a mock payload in a sandboxed shell"
        >
          Test
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px]"
          style={{
            background: "var(--color-surface-3)",
            borderColor: "var(--color-border-strong)",
            color: "var(--color-text)",
          }}
          title="Edit matcher / command / extra flags"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px]"
          style={{
            background: "transparent",
            borderColor: "var(--color-border-strong)",
            color: hook.enabled
              ? "var(--color-text-secondary)"
              : HOOK_ACCENT_TEXT,
          }}
          title={hook.enabled ? "Disable this hook" : "Enable this hook"}
        >
          {hook.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px]"
          style={{
            background: "transparent",
            borderColor: "rgba(248, 81, 73, 0.30)",
            color: "var(--color-danger, #f88)",
          }}
          title="Delete this hook from settings.json"
        >
          Delete
        </button>
      </div>

      {/* Body — command + extras + recent fires */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-4">
          <div
            className="mb-1 text-[10px] font-medium uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Command
          </div>
          <pre
            className="overflow-auto rounded border p-2 text-[11.5px]"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface-1)",
              color: "var(--color-text)",
              fontFamily: "var(--font-mono)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            <code>{hook.command}</code>
          </pre>
        </div>

        {Object.keys(hook.extra).length > 0 && (
          <div className="mb-4">
            <div
              className="mb-1 text-[10px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Extra flags
            </div>
            <pre
              className="overflow-auto rounded border p-2 text-[11.5px]"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-surface-1)",
                color: "var(--color-text)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <code>{JSON.stringify(hook.extra, null, 2)}</code>
            </pre>
          </div>
        )}

        <div>
          <div
            className="mb-1 text-[10px] font-medium uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Recent fires
          </div>
          {!firesInstrumented && (
            <div
              className="rounded border px-2 py-1.5 text-[11.5px]"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-surface-1)",
                color: "var(--color-text-tertiary)",
              }}
            >
              No instrumentation set up yet. To track fires, have your hook
              append a JSON line to{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>
                ~/.ultron/.tmp/hook-fires.jsonl
              </code>{" "}
              (keys: timestamp, event, hook_id, matcher, exit_code).
            </div>
          )}
          {firesInstrumented && fires.length === 0 && (
            <div
              className="text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              No fires logged for this hook yet.
            </div>
          )}
          {firesInstrumented && fires.length > 0 && (
            <ul className="space-y-1">
              {fires.map((f, i) => (
                <li
                  key={i}
                  className="rounded border px-2 py-1 text-[11.5px]"
                  style={{
                    borderColor: "var(--color-border)",
                    background: "var(--color-surface-1)",
                  }}
                >
                  <div style={{ color: "var(--color-text)" }}>
                    {f.timestamp ?? "(no ts)"} · exit{" "}
                    <span
                      style={{
                        color:
                          f.exit_code === 0
                            ? "var(--color-success)"
                            : "var(--color-warn)",
                      }}
                    >
                      {f.exit_code ?? "?"}
                    </span>
                  </div>
                  <div style={{ color: "var(--color-text-tertiary)" }}>
                    {f.event ?? "?"} / {f.matcher ?? "any"}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {firesLogPath && (
            <div
              className="mt-2 text-[10px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Log:{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>
                {firesLogPath}
              </code>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Empty state — shown when settings.json has no hooks configured. Explains
// what hooks are, what each event fires on, and offers two paths in: the
// raw "Add hook" form or the AI-assisted modal.
// ---------------------------------------------------------------------------

function HooksEmptyState({
  onAdd,
  onAi,
}: {
  onAdd: () => void;
  onAi: () => void;
}) {
  return (
    <div
      className="rounded p-5"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div
        className="mb-1 text-[14px] font-semibold"
        style={{ color: "var(--color-text)" }}
      >
        No hooks configured
      </div>
      <p
        className="mb-4 text-[12px] leading-relaxed"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Hooks are shell commands Claude Code runs around tool calls and session
        lifecycle events. They let you enforce policies (block bad commands),
        log activity, auto-format files, or trigger external systems — all
        without modifying Claude's behaviour. They live in{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>~/.claude/settings.json</code>{" "}
        under the <code style={{ fontFamily: "var(--font-mono)" }}>hooks</code> key.
      </p>
      <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-3">
        <HookEventTile
          name="PreToolUse"
          desc="Before a tool runs. Exit 2 to block. Good for command audits and policy checks."
        />
        <HookEventTile
          name="PostToolUse"
          desc="After a tool succeeds. Good for auto-format, lint, dependency updates."
        />
        <HookEventTile
          name="Stop"
          desc="When Claude finishes responding. Good for end-of-session checks (debug statements, dirty git tree)."
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onAdd}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          Add your first hook
        </button>
        <button
          type="button"
          onClick={onAi}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Describe what you want in plain English; Claude drafts the JSON"
        >
          Add with AI
        </button>
      </div>
    </div>
  );
}

function HookEventTile({ name, desc }: { name: string; desc: string }) {
  const colors = eventBadgeColor(name);
  return (
    <div
      className="rounded p-2.5"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div
        className="mb-1 inline-block rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
        style={{ background: colors.bg, color: colors.fg }}
      >
        {name}
      </div>
      <div
        className="text-[11.5px] leading-snug"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {desc}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / Edit modal
// ---------------------------------------------------------------------------

function HookFormModal({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  initial?: HookRecord;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [event, setEvent] = useState<string>(initial?.event ?? "PreToolUse");
  const [matcher, setMatcher] = useState<string>(initial?.matcher ?? "");
  const [command, setCommand] = useState<string>(initial?.command ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!command.trim()) {
      setErr("Command cannot be empty.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      if (mode === "add") {
        const res = (await invoke("add_hook", {
          event,
          matcher: matcher.trim() || null,
          command,
        })) as HookMutationResult;
        onSaved(`Added hook. Backup: ${res.backup_path ?? "n/a"}`);
      } else if (initial) {
        const res = (await invoke("update_hook", {
          id: initial.id,
          command,
          enabled: null,
          // review audit v15.5.4: match add_hook semantics — empty string
          // matchers (user cleared the input) should be persisted as null
          // so settings.json doesn't end up with an empty "matcher": "" key.
          matcher: matcher.trim() || null,
        })) as HookMutationResult;
        onSaved(`Updated hook. Backup: ${res.backup_path ?? "n/a"}`);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded-md border p-5 shadow-xl"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[15px] font-semibold">
          {mode === "add" ? "Add hook" : "Edit hook"}
        </div>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Event
          </div>
          <select
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            disabled={mode === "edit"}
            className="w-full rounded px-2 py-1"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            {EVENT_OPTIONS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          {mode === "edit" && (
            <div
              className="mt-1 text-[10px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Event is immutable. Delete and re-add to change it.
            </div>
          )}
        </label>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Matcher (optional regex — e.g. "Bash", "Read|Glob|Grep", "mcp__.*")
          </div>
          <input
            type="text"
            value={matcher}
            onChange={(e) => setMatcher(e.target.value)}
            className="w-full rounded px-2 py-1"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
        </label>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Command
          </div>
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            rows={6}
            className="w-full rounded px-2 py-1 font-mono text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
        </label>

        {err && (
          <div
            className="mb-3 rounded border px-2 py-1 text-[11.5px]"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-danger, #f88)",
            }}
          >
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {saving ? "Saving..." : mode === "add" ? "Add hook" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test modal
// ---------------------------------------------------------------------------

function TestModal({
  hook,
  onClose,
}: {
  hook: HookRecord;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState<string>(DEFAULT_PAYLOAD);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<HookTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const res = (await invoke("test_hook", {
        id: hook.id,
        mockPayload: payload,
      })) as HookTestResult;
      setResult(res);
    } catch (e) {
      setErr(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[700px] rounded-md border p-5 shadow-xl"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[15px] font-semibold">Test hook</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[11.5px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Close
          </button>
        </div>

        <div
          className="mb-3 rounded border px-3 py-2 text-[11.5px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-tertiary)",
          }}
        >
          Runs the command in a sandboxed PowerShell with a 5s timeout. The
          payload is exposed via the <code>CLAUDE_HOOK_PAYLOAD</code> env var.
          Hooks that block on stdin will hit the timeout.
        </div>

        <label className="mb-3 block text-[12px]">
          <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
            Mock payload (JSON)
          </div>
          <textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={5}
            className="w-full rounded px-2 py-1 font-mono text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
        </label>

        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {running ? "Running..." : "Run"}
          </button>
        </div>

        {err && (
          <div
            className="mb-3 rounded border px-2 py-1 text-[11.5px]"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-danger, #f88)",
            }}
          >
            {err}
          </div>
        )}

        {result && (
          <div>
            {result.timed_out && (
              <div
                className="mb-2 rounded border px-2 py-1 text-[11.5px] font-semibold"
                style={{
                  borderColor: "var(--color-warn, #f80)",
                  background: "rgba(248,136,0,0.10)",
                  color: "var(--color-warn, #f80)",
                }}
              >
                TIMED OUT after 5s — the command likely blocked on stdin or
                an interactive prompt.
              </div>
            )}
            {!result.timed_out && !result.success && (
              <div
                className="mb-2 rounded border px-2 py-1 text-[11.5px] font-semibold"
                style={{
                  borderColor: "var(--color-danger, #f88)",
                  background: "rgba(248,113,113,0.10)",
                  color: "var(--color-danger, #f88)",
                }}
              >
                FAILED (exit code {result.exit_code ?? "?"})
              </div>
            )}
            {result.success && (
              <div
                className="mb-2 rounded border px-2 py-1 text-[11.5px] font-semibold"
                style={{
                  borderColor: "var(--color-success, #2da)",
                  background: "rgba(45,212,191,0.10)",
                  color: "var(--color-success, #2da)",
                }}
              >
                OK (exit 0) · {result.elapsed_ms}ms
              </div>
            )}
            <div className="mb-2">
              <div
                className="mb-1 text-[10px] uppercase"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                stdout
              </div>
              <pre
                className="max-h-48 overflow-auto rounded border p-2 text-[11.5px]"
                style={{
                  borderColor: "var(--color-border)",
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {result.stdout || "(empty)"}
              </pre>
            </div>
            <div>
              <div
                className="mb-1 text-[10px] uppercase"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                stderr
              </div>
              <pre
                className="max-h-48 overflow-auto rounded border p-2 text-[11.5px]"
                style={{
                  borderColor: "var(--color-border)",
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {result.stderr || "(empty)"}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI modal
// ---------------------------------------------------------------------------

function AiModal({
  description,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  description: string;
  busy: boolean;
  onChange: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-[560px] rounded-md border p-5 shadow-xl"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[15px] font-semibold">Add hook with AI</div>

        <div
          className="mb-3 text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Describe in plain language what the hook should do. Claude opens a
          new session, drafts the JSON, and you paste the result back into
          "Add hook" to confirm and write to settings.json.
        </div>

        <textarea
          value={description}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          placeholder="e.g. Before every Bash tool call, log the command being run to ~/.ultron/.tmp/bash-audit.jsonl"
          className="mb-3 w-full rounded px-2 py-1 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border)",
          }}
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !description.trim()}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {busy ? "Opening..." : "Open Claude"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Hooks;
