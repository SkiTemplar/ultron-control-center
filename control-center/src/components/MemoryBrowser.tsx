// Control Center — Memory Browser (FRENTE 5, MEMORY KERNEL).
//
// Read/curate surface over the governed memory store (`brain.db`). Where the
// Inbox handles candidates awaiting validation, the Browser lists items that are
// already memories and lets the user curate them (pin/unpin, deprecate, forget)
// plus a bulk "deprecate all of a type" to purge bloat (e.g. codebase_fact).
//
// Backend (control-center/src-tauri/src/commands/memory/inbox.rs):
//   - memory_items_list({ status, item_type, search, pinned_only, offset, limit })
//                                              -> MemoryItemsPage { items, total, offset, limit }
//   - memory_item_pin({ id })   / memory_item_unpin({ id })    -> MemoryItem
//   - memory_item_deprecate({ id, reason })                    -> MemoryItem
//   - memory_forget({ id, reason })                            -> ()  (PERMANENT)
//   - memory_items_deprecate_by_type({ item_type, reason })    -> BulkDeprecateResult
//
// Design contract (matches MemoryInbox / the rest of the Control Center):
//   - Black, minimal, hard-edge. Colours 100% from var(--color-*); no hex.
//   - No emojis. Monochrome with neutral/warn/danger accents only.
//   - Refresh the list after every mutation; handle empty + error states.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, SmallButton } from "./dashboard/Card";

// ---------------------------------------------------------------------------
// Types (mirror the Rust serde shapes — snake_case keys; `kind` -> `type`)
// ---------------------------------------------------------------------------

interface MemoryItem {
  id: string;
  type: string;
  scope: string;
  title: string | null;
  summary: string | null;
  tags: string[];
  status: string;
  confidence: number;
  importance: number;
  pinned: boolean;
  updated_at: number;
}

interface MemoryItemsPage {
  items: MemoryItem[];
  total: number;
  offset: number;
  limit: number;
}

interface BulkDeprecateResult {
  kind: string;
  matched: number;
  deprecated: number;
  dry_run: boolean;
  project: string | null;
  failed: [string, string][];
}

// Controlled vocab — mirrors memory/model.rs (str_enum! MemoryType / Status).
const TYPE_OPTIONS = [
  "preference",
  "fact",
  "decision",
  "constraint",
  "task",
  "codebase_fact",
  "skill",
  "agent_note",
  "session_summary",
  "error_resolution",
  "architecture",
  "user_profile",
] as const;

// "archived" retirado 2026-07-04: 0 filas en brain.db y 0 productores en el
// write-path — era un filtro a un conjunto siempre-vacio (mand.12). La
// variante Status::Archived se retiro del enum Rust en el mismo commit.
const STATUS_OPTIONS = [
  "active",
  "pending",
  "stale",
  "deprecated",
  "quarantined",
  "rejected",
] as const;

const PAGE_SIZE = 50;

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

// ---------------------------------------------------------------------------
// Item row — metadata + curate actions (pin/unpin, deprecate, forget).
// ---------------------------------------------------------------------------

interface RowProps {
  item: MemoryItem;
  busy: boolean;
  confirmingForget: boolean;
  onPin: (id: string, pinned: boolean) => void;
  onDeprecate: (id: string) => void;
  onForget: (id: string) => void;
}

function ItemRow({
  item: it,
  busy,
  confirmingForget,
  onPin,
  onDeprecate,
  onForget,
}: RowProps) {
  const isDeprecated = it.status === "deprecated" || it.status === "rejected";
  const accentBorder = it.pinned
    ? "var(--color-accent)"
    : isDeprecated
      ? "var(--color-warn)"
      : "var(--color-border-strong)";

  return (
    <div
      className="flex flex-col gap-2 p-3"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        borderLeft: `3px solid ${accentBorder}`,
        opacity: isDeprecated ? 0.7 : 1,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[13.5px] font-semibold"
            style={{ color: "var(--color-text)" }}
            title={it.title ?? undefined}
          >
            {it.title || it.summary || "(untitled memory)"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip>{it.type}</Chip>
            <Chip>{it.scope}</Chip>
            <Chip tone={isDeprecated ? "warn" : "neutral"}>{it.status}</Chip>
            {it.pinned && <Chip tone="warn">pinned</Chip>}
            <span
              className="text-[11px] tabular-nums"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              imp {pct(it.importance)} · conf {pct(it.confidence)} · {relTime(it.updated_at)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <SmallButton
            onClick={() => onPin(it.id, !it.pinned)}
            disabled={busy}
            title={it.pinned ? "Unpin this memory" : "Pin — always surfaced in recall"}
          >
            {it.pinned ? "Unpin" : "Pin"}
          </SmallButton>
          {!isDeprecated && (
            <SmallButton
              onClick={() => onDeprecate(it.id)}
              disabled={busy}
              title="Deprecate — held out of recall (reversible)"
            >
              Deprecate
            </SmallButton>
          )}
          <SmallButton
            variant={confirmingForget ? "accent" : "neutral"}
            onClick={() => onForget(it.id)}
            disabled={busy}
            title="Forget — PERMANENT hard delete from brain.db + index"
          >
            {confirmingForget ? "Confirm forget?" : "Forget"}
          </SmallButton>
        </div>
      </div>

      {it.summary && it.title && (
        <div
          className="text-[12px] leading-snug"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {it.summary}
        </div>
      )}

      {it.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {it.tags.map((t) => (
            <span
              key={t}
              className="px-1 py-px text-[10px]"
              style={{
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border)",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MemoryBrowser — the Browser sub-tab body.
// ---------------------------------------------------------------------------

export function MemoryBrowser() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  // Per-row in-flight guard.
  const [busyId, setBusyId] = useState<string | null>(null);
  // Two-phase confirm for the destructive "Forget" (window.confirm is ACL-blocked).
  const [confirmForgetId, setConfirmForgetId] = useState<string | null>(null);
  // Bulk deprecate-by-type confirm + in-flight.
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = (await invoke("memory_items_list", {
        status: statusFilter || null,
        itemType: typeFilter || null,
        search: search || null,
        pinnedOnly,
        offset,
        limit: PAGE_SIZE,
      })) as MemoryItemsPage;
      setItems(page.items ?? []);
      setTotal(page.total ?? 0);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter, search, pinnedOnly, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reset to the first page whenever a filter changes.
  const onFilterChange = useCallback((fn: () => void) => {
    fn();
    setOffset(0);
  }, []);

  const runAction = useCallback(
    async (id: string, fn: () => Promise<unknown>) => {
      setBusyId(id);
      try {
        await fn();
        await load();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const onPin = useCallback(
    (id: string, pinned: boolean) =>
      void runAction(id, () => invoke(pinned ? "memory_item_pin" : "memory_item_unpin", { id })),
    [runAction],
  );

  const onDeprecate = useCallback(
    (id: string) =>
      void runAction(id, () =>
        invoke("memory_item_deprecate", { id, reason: "user: deprecated from browser" }),
      ),
    [runAction],
  );

  // Two-phase confirm: first click arms (4s window), second click within it
  // executes the PERMANENT forget. Mirrors the inbox "Approve all" pattern since
  // window.confirm maps to the ACL-blocked Tauri dialog plugin.
  const onForget = useCallback(
    (id: string) => {
      if (confirmForgetId !== id) {
        setConfirmForgetId(id);
        window.setTimeout(() => {
          setConfirmForgetId((cur) => (cur === id ? null : cur));
        }, 4000);
        return;
      }
      setConfirmForgetId(null);
      void runAction(id, () =>
        invoke("memory_forget", { id, reason: "user: forgotten from browser" }),
      );
    },
    [confirmForgetId, runAction],
  );

  // Bulk "Deprecate all of type" — only enabled when a single type is selected.
  const onBulkDeprecate = useCallback(async () => {
    if (!typeFilter) return;
    if (!confirmBulk) {
      setConfirmBulk(true);
      window.setTimeout(() => setConfirmBulk(false), 4000);
      return;
    }
    setConfirmBulk(false);
    setBulkBusy(true);
    setBulkMsg(null);
    setError(null);
    try {
      const res = (await invoke("memory_items_deprecate_by_type", {
        itemType: typeFilter,
        reason: "user: bulk deprecate from browser",
      })) as BulkDeprecateResult;
      await load();
      setBulkMsg(
        `${res.deprecated} de ${res.matched} '${res.kind}' deprecadas${
          res.failed.length > 0 ? ` (${res.failed.length} fallaron)` : ""
        }.`,
      );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBulkBusy(false);
    }
  }, [typeFilter, confirmBulk, load]);

  const submitSearch = useCallback(() => {
    onFilterChange(() => setSearch(searchInput.trim()));
  }, [searchInput, onFilterChange]);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  const selectStyle = {
    background: "var(--color-surface-3)",
    color: "var(--color-text)",
    border: "1px solid var(--color-border-strong)",
  } as const;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold" style={{ color: "var(--color-text)" }}>
            Memory Browser
          </h1>
          <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            {total > 0
              ? `${total} memor${total === 1 ? "y" : "ies"} match — page ${page}/${pageCount}`
              : "Browse and curate the governed memory store"}
          </p>
        </div>
        <SmallButton onClick={() => void load()} disabled={loading || bulkBusy}>
          {loading ? "Refreshing..." : "Refresh"}
        </SmallButton>
      </div>

      {/* Filters */}
      <div
        className="flex flex-wrap items-end gap-3 px-3 py-3"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
      >
        <label className="flex flex-col gap-1">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Type
          </span>
          <select
            value={typeFilter}
            onChange={(e) => onFilterChange(() => setTypeFilter(e.target.value))}
            className="px-2 py-1 text-[12px] outline-none"
            style={selectStyle}
          >
            <option value="">All types</option>
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Status
          </span>
          <select
            value={statusFilter}
            onChange={(e) => onFilterChange(() => setStatusFilter(e.target.value))}
            className="px-2 py-1 text-[12px] outline-none"
            style={selectStyle}
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 pb-1.5">
          <input
            type="checkbox"
            checked={pinnedOnly}
            onChange={(e) => onFilterChange(() => setPinnedOnly(e.target.checked))}
          />
          <span className="text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
            Pinned only
          </span>
        </label>

        <label className="flex min-w-[180px] flex-1 flex-col gap-1">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Search (title / summary)
          </span>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitSearch();
              }}
              placeholder="substring..."
              className="min-w-0 flex-1 px-2 py-1 text-[12px] outline-none"
              style={selectStyle}
            />
            <SmallButton onClick={submitSearch} disabled={loading}>
              Search
            </SmallButton>
            {search && (
              <SmallButton
                onClick={() => {
                  setSearchInput("");
                  onFilterChange(() => setSearch(""));
                }}
                disabled={loading}
              >
                Clear
              </SmallButton>
            )}
          </div>
        </label>
      </div>

      {/* Bulk action — only meaningful when a single type is selected */}
      {typeFilter && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <span className="text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
            Bulk: deprecate every active <strong>{typeFilter}</strong> memory (reversible, removes
            them from recall).
          </span>
          <SmallButton
            variant={confirmBulk ? "accent" : "neutral"}
            onClick={() => void onBulkDeprecate()}
            disabled={loading || bulkBusy}
            title="Deprecate all active items of this type"
          >
            {bulkBusy
              ? "Deprecating..."
              : confirmBulk
                ? `Confirm: deprecate all ${typeFilter}?`
                : `Deprecate all of type`}
          </SmallButton>
        </div>
      )}
      {bulkMsg && (
        <div
          className="px-3 py-2 text-[11.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          {bulkMsg}
        </div>
      )}

      {/* Results */}
      <Card
        title="Memories"
        subtitle="Pin to always surface, deprecate to hold out of recall, forget to hard-delete"
        loading={loading}
        error={error}
        empty={
          !loading && items.length === 0 ? "No memories match the current filters." : null
        }
      >
        <div className="flex flex-col gap-2">
          {items.map((it) => (
            <ItemRow
              key={it.id}
              item={it}
              busy={busyId === it.id}
              confirmingForget={confirmForgetId === it.id}
              onPin={onPin}
              onDeprecate={onDeprecate}
              onForget={onForget}
            />
          ))}
        </div>
      </Card>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <SmallButton
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            disabled={!canPrev || loading}
          >
            Previous
          </SmallButton>
          <span className="text-[11.5px] tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <SmallButton
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
            disabled={!canNext || loading}
          >
            Next
          </SmallButton>
        </div>
      )}
    </div>
  );
}
