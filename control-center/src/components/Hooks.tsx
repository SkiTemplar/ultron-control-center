// ULTRON Control Center — Hooks viewer (v2.9 REDESIGN).
//
// the user's brief (v2.9 sprint):
//   1. Mismas categorías colapsables que Skills / Agents / Rules — sidebar
//      izquierdo con grupos por evento (PreToolUse, PostToolUse, Stop, …).
//   2. Quitar el color amarillo global. Cada categoría usa su propio color de
//      evento; el ribbon del card viene del color del evento, no amber fijo.
//   3. Auto-naming: nuevo command `analyze_hook_name` que invoca AI Router
//      (Haiku / Gemini) para dar nombre legible en kebab-case. Botón
//      "Auto-name all" en header para procesar en bulk.
//
// Implementation notes:
//   - La barra lateral izquierda lista eventos como grupos colapsables
//     (mismo patrón que TreeView en Skills). Al hacer click en un grupo se
//     expande la lista de hooks de ese evento.
//   - Clicking a card opens HookDetailPane on the right side (unchanged).
//   - El card muestra el nombre legible (del cache) si está disponible;
//     si no, el id raw con estilo `font-mono` de menor tamaño para indicar
//     que aún no se ha nombrado.
//   - Los modals (HookFormModal / TestModal / AiModal) se conservan intactos.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../lib/dialog";
import type { HookLastFired } from "../types";
import { Plus } from "./library/icons";
import { BlocksView, type BlocksItem } from "./library/BlocksView";
import { eventColors, truncate, deriveNameFromCommand } from "./hooks/constants";
import type { HookRecord, HooksList, HookMutationResult, HookFiresReport, HookNameResult, HookDescription } from "./hooks/types";
import { HookDetailPane } from "./hooks/HookDetailPane";
import { HooksEmptyState } from "./hooks/HooksEmptyState";
import { HookFormModal } from "./hooks/HookFormModal";
import { TestModal } from "./hooks/TestModal";
import { AiModal } from "./hooks/AiModal";

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Hooks() {
  const [list, setList] = useState<HooksList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [filterText, setFilterText] = useState<string>("");

  // Selected hook id drives the detail pane
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiDescription, setAiDescription] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const [editTarget, setEditTarget] = useState<HookRecord | null>(null);
  const [testTarget, setTestTarget] = useState<HookRecord | null>(null);

  const [fires, setFires] = useState<HookFiresReport | null>(null);
  const [lastFired, setLastFired] = useState<Record<string, HookLastFired>>({});

  // Auto-naming state
  const [namesCache, setNamesCache] = useState<Record<string, { name: string; strategy: string }>>({});
  const [namingBusy, setNamingBusy] = useState(false);
  const [namingProgress, setNamingProgress] = useState<string | null>(null);

  // Readable title + summary per hook (analysed from the script, no AI).
  const [descriptions, setDescriptions] = useState<Record<string, HookDescription>>({});

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  const fetchList = useCallback(async () => {
    try {
      const res = (await invoke("list_hooks")) as HooksList;
      setList(res);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  async function fetchFires() {
    try {
      const res = (await invoke("recent_hook_fires", { limit: 50 })) as HookFiresReport;
      setFires(res);
    } catch (e) {
      // Non-fatal
    }
  }

  async function fetchNamesCache() {
    try {
      const raw = (await invoke("get_hook_names_cache")) as Record<string, { name: string; strategy: string }>;
      setNamesCache(raw ?? {});
    } catch {
      // Non-fatal
    }
  }

  async function fetchDescriptions() {
    try {
      const list = (await invoke("get_hook_descriptions")) as HookDescription[];
      const map: Record<string, HookDescription> = {};
      for (const d of list) map[d.id] = d;
      setDescriptions(map);
    } catch {
      // Non-fatal — cards fall back to the raw id.
    }
  }

  useEffect(() => {
    fetchList();
    fetchFires();
    fetchNamesCache();
    fetchDescriptions();
  }, [fetchList]);

  // Refresh per-hook last-fired whenever the list changes
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
          // skip
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
  // Auto-naming handlers
  // -------------------------------------------------------------------------

  async function handleAutoNameSingle(hookId: string) {
    try {
      const res = (await invoke("analyze_hook_name", { id: hookId })) as HookNameResult;
      setNamesCache((prev) => ({
        ...prev,
        [res.id]: { name: res.name, strategy: res.strategy },
      }));
    } catch (e) {
      showFlash(`Naming failed: ${e}`);
    }
  }

  async function handleAutoNameAll() {
    setNamingBusy(true);
    setNamingProgress("Analyzing hooks...");
    try {
      const results = (await invoke("bulk_analyze_hook_names")) as HookNameResult[];
      const updates: Record<string, { name: string; strategy: string }> = {};
      let newCount = 0;
      for (const r of results) {
        updates[r.id] = { name: r.name, strategy: r.strategy };
        if (!r.cached) newCount++;
      }
      setNamesCache((prev) => ({ ...prev, ...updates }));
      setNamingProgress(null);
      showFlash(`Named ${newCount} hook(s). ${results.length - newCount} already cached.`);
    } catch (e) {
      showFlash(`Auto-name failed: ${e}`);
      setNamingProgress(null);
    } finally {
      setNamingBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Derived: grouping by event for sidebar
  // -------------------------------------------------------------------------

  const q = filterText.trim().toLowerCase();

  /** Resolve the best available human-readable label for a hook, in priority order:
   *  1. analysed title from get_hook_descriptions (readable name of what it does)
   *  2. description field from settings.json (if the group declares one)
   *  3. AI-assigned name from namesCache (kebab-case)
   *  4. name derived locally from the command/script basename (no AI, no cache)
   *  5. undefined (caller renders raw id in monospace)
   */
  function resolveDisplayName(h: HookRecord): string | undefined {
    const title = descriptions[h.id]?.title;
    if (title) return title;
    if (h.description) return h.description;
    const cached = namesCache[h.id]?.name;
    if (cached) return cached;
    return deriveNameFromCommand(h.command);
  }

  const filtered = useMemo(() => {
    if (!list) return [];
    return list.hooks.filter((h) => {
      if (!q) return true;
      const displayName = resolveDisplayName(h) ?? h.id;
      const summary = descriptions[h.id]?.summary ?? "";
      const hay = `${displayName} ${summary} ${h.id} ${h.matcher ?? ""} ${h.command} ${h.event}`.toLowerCase();
      return hay.includes(q);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, q, namesCache, descriptions]);

  const selectedHook = useMemo(
    () => list?.hooks.find((h) => h.id === selectedId) ?? null,
    [list, selectedId],
  );

  const selectedFires = useMemo(() => {
    if (!fires || !selectedHook) return [];
    return fires.fires.filter((f) => f.hook_id === selectedHook.id);
  }, [fires, selectedHook]);

  // -------------------------------------------------------------------------
  // Blocks navigator (estilo Agents/Skills) — tarjetas de categoría (evento)
  // que al hacer click revelan los hooks de ese evento. NO pills arriba.
  // -------------------------------------------------------------------------

  const blockItems: BlocksItem<HookRecord>[] = useMemo(
    () =>
      filtered.map((h) => ({
        key: h.id,
        topGroup: h.event,
        subGroup: null,
        data: h,
      })),
    [filtered],
  );

  // -------------------------------------------------------------------------
  // Main card grid — renders the hook cards for a given list
  // -------------------------------------------------------------------------

  const renderCardGrid = (items: HookRecord[]) => (
    <div
      className="grid gap-3 p-4"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
    >
      {items.map((h) => {
        const isActive = selectedId === h.id;
        const colors = eventColors(h.event);
        const title = resolveDisplayName(h);
        const summary = descriptions[h.id]?.summary;
        return (
          <button
            key={h.id}
            type="button"
            onClick={() => setSelectedId(isActive ? null : h.id)}
            className="group flex h-[156px] flex-col justify-between rounded-xl p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            style={{
              background: isActive ? "var(--color-surface-3)" : "var(--color-surface-2)",
              border: `1px solid ${isActive ? colors.ribbonBorder : "var(--color-border)"}`,
              // Ribbon comes purely from the event color — no amber overlay
              boxShadow: `inset 0 3px 0 ${colors.ribbon}`,
              opacity: h.enabled ? 1 : 0.55,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = colors.ribbonBorder;
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${colors.ribbon}, 0 6px 18px rgba(0,0,0,0.28)`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = isActive ? colors.ribbonBorder : "var(--color-border)";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${colors.ribbon}`;
            }}
            title={`${h.id}\n${h.command}`}
          >
            {/* Top row: "Hook" label + event badge */}
            <div
              className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.08em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              <span style={{ color: colors.chipFg }}>Hook</span>
              <span
                className="ml-auto rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
                style={{
                  background: colors.chipBg,
                  color: colors.chipFg,
                  border: `1px solid ${colors.chipBorder}`,
                }}
              >
                {h.event}
              </span>
            </div>

            {/* Center: readable name + one-line summary (fallback: raw id) */}
            <div className="flex min-h-0 flex-1 flex-col justify-center gap-1 py-1">
              {title ? (
                <div
                  className="line-clamp-2 text-[15px] font-semibold leading-tight tracking-tight"
                  style={{ color: "var(--color-text)" }}
                >
                  {title}
                </div>
              ) : (
                <div
                  className="line-clamp-2 text-[12.5px] font-medium leading-tight"
                  style={{ color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}
                >
                  {h.id}
                </div>
              )}
              {summary && (
                <div
                  className="line-clamp-2 text-[11px] leading-snug"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {summary}
                </div>
              )}
            </div>

            {/* Bottom row: source, disabled badge, last fired */}
            <div
              className="flex items-center gap-1.5 text-[10px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              <span
                className="rounded px-1.5 py-px"
                style={{
                  background: colors.chipBg,
                  color: colors.chipFg,
                  border: `1px solid ${colors.chipBorder}`,
                }}
              >
                {h.source}
              </span>
              {!h.enabled && (
                <span style={{ color: "var(--color-text-faint)" }}>disabled</span>
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
    <div className="flex h-full flex-col gap-0">
      {/* Top toolbar */}
      <header
        className="flex items-center justify-between gap-2 border-b px-4 py-2"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-1)" }}
      >
        <div className="flex items-baseline gap-2">
          <h2 className="text-[14px] font-semibold">Hooks</h2>
          <span
            className="text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {filtered.length} of {list?.hooks.length ?? 0}
            {list?.settings_path && (
              <>
                {" "}·{" "}
                <code className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                  {list.settings_path}
                </code>
              </>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {namingProgress && (
            <span
              className="text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {namingProgress}
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleAutoNameAll()}
            disabled={namingBusy || loading}
            className="rounded-md border px-3 py-1 text-xs disabled:opacity-50"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
            title="Assign readable names to all hooks using AI Router (Haiku/Gemini) with heuristic fallback"
          >
            {namingBusy ? "Naming…" : "Auto-name all"}
          </button>
          <button
            type="button"
            onClick={() => void fetchList()}
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
          className="border-b px-4 py-1.5 text-[12px]"
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
          className="mx-4 mt-2 rounded-md p-2 text-xs"
          style={{
            border: "1px solid rgba(248, 81, 73, 0.30)",
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* No-settings banner */}
      {list && !list.settings_exists && (
        <div
          className="border-b px-4 py-1.5 text-[12px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
          }}
        >
          settings.json does not exist yet. Adding the first hook will create it.
        </div>
      )}

      {/* No-instrumentation notice — shown only when the log file is absent */}
      {!loading && fires && !fires.instrumented && (
        <div
          className="border-b px-4 py-1.5 text-[11.5px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-tertiary)",
          }}
        >
          Fire history not available — no hook-fires log found.
        </div>
      )}

      {loading && (
        <div className="px-4 py-3 text-[13px]" style={{ color: "var(--color-text-tertiary)" }}>
          Loading…
        </div>
      )}

      {/* Empty state */}
      {!loading && list && list.hooks.length === 0 && (
        <div className="p-4">
          <HooksEmptyState onAdd={() => setAddOpen(true)} onAi={() => setAiOpen(true)} />
        </div>
      )}

      {/* Layout estilo Agents: search + navegador de bloques por evento (grid | detail) */}
      {!loading && list && list.hooks.length > 0 && (
        <div className="flex h-full flex-col gap-3 p-4">
          {/* Search */}
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Search hooks by name, command, matcher or event…"
            className="w-full rounded-md px-3 py-2 text-sm outline-none"
            style={{
              border: "1px solid var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
          />

          {/* Navegador de bloques | detail pane */}
          <div className="flex flex-1 gap-3 overflow-hidden">
            <div
              className={selectedHook ? "min-w-0 flex-1 overflow-y-auto" : "flex-1 overflow-y-auto"}
              style={{ minWidth: 0 }}
            >
              {q ? (
                // Con búsqueda activa mostramos un grid plano de coincidencias.
                filtered.length === 0 ? (
                  <div
                    className="px-2 py-4 text-xs"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Ningún hook coincide con la búsqueda.
                  </div>
                ) : (
                  renderCardGrid(filtered)
                )
              ) : (
                // Sin búsqueda: tarjetas de categoría (evento) → click revela los hooks.
                <BlocksView<HookRecord>
                  items={blockItems}
                  noun="hook"
                  emptyLabel="No hay hooks."
                  topGroupAccent={(g) => eventColors(g).ribbon}
                  renderLeaves={(leaves) => renderCardGrid(leaves.map((l) => l.data))}
                />
              )}
            </div>

          {/* Right: detail pane */}
          {selectedHook && (
            <div
              className="overflow-hidden"
              style={{ width: 520, minWidth: 300, borderLeft: "1px solid var(--color-border)" }}
            >
              <HookDetailPane
                hook={selectedHook}
                displayName={resolveDisplayName(selectedHook)}
                lastFired={lastFired[selectedHook.id]}
                fires={selectedFires}
                firesInstrumented={fires?.instrumented ?? false}
                firesLogPath={fires?.log_path ?? null}
                onTest={() => setTestTarget(selectedHook)}
                onEdit={() => setEditTarget(selectedHook)}
                onToggle={() => void handleToggle(selectedHook)}
                onNameThis={() => void handleAutoNameSingle(selectedHook.id)}
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

export default Hooks;
