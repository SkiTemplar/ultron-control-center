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
import { eventColors, truncate, deriveNameFromCommand, tildeHome } from "./hooks/constants";
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
  // Ocultar hooks de plugins desactivados (p.ej. los ~28 de ecc@ecc=false):
  // son inertes por diseno y ensuciaban la lista como "disabled" sin serlo
  // el sistema propio. ON por defecto (decidido por el usuario 2026-08-17).
  const [hideDisabledPlugins, setHideDisabledPlugins] = useState<boolean>(true);

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
        `Hook ${res.hook?.enabled ? "activado" : "desactivado"}. Backup: ${res.backup_path ?? "n/d"}. ${res.manifest_sync ?? ""}`,
      );
      await fetchList();
    } catch (e) {
      showFlash(`No se pudo cambiar el estado: ${e}`);
    }
  }

  async function handleDelete(hook: HookRecord) {
    try {
      const res = (await invoke("delete_hook", { id: hook.id })) as HookMutationResult;
      showFlash(`Hook borrado. Backup: ${res.backup_path ?? "n/d"}. ${res.manifest_sync ?? ""}`);
      if (selectedId === hook.id) setSelectedId(null);
      await fetchList();
    } catch (e) {
      showFlash(`No se pudo borrar: ${e}`);
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
      showFlash(`Falló la petición a la IA: ${e}`);
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
      showFlash(`No se pudo poner nombre: ${e}`);
    }
  }

  async function handleAutoNameAll() {
    setNamingBusy(true);
    setNamingProgress("Analizando hooks…");
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
      showFlash(`Nombres nuevos: ${newCount}. Ya estaban en caché: ${results.length - newCount}.`);
    } catch (e) {
      showFlash(`No se pudieron poner los nombres: ${e}`);
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
      if (hideDisabledPlugins && !h.enabled && h.source.startsWith("plugin:")) {
        return false;
      }
      if (!q) return true;
      const displayName = resolveDisplayName(h) ?? h.id;
      const summary = descriptions[h.id]?.summary ?? "";
      const hay = `${displayName} ${summary} ${h.id} ${h.matcher ?? ""} ${h.command} ${h.event}`.toLowerCase();
      return hay.includes(q);
    });
  }, [list, q, namesCache, descriptions, hideDisabledPlugins]);

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
        label: resolveDisplayName(h) ?? h.id,
        data: h,
      })),
    [filtered, namesCache, descriptions],
  );

  // -------------------------------------------------------------------------
  // Main card grid — renders the hook cards for a given list
  // -------------------------------------------------------------------------

  const renderCardGrid = (items: HookRecord[]) => (
    <div
      className="grid gap-3"
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
            {/* Fila superior: etiqueta «Hook» y evento */}
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

            {/* Centro: nombre legible y resumen de una línea (si no, el id) */}
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

            {/* Fila inferior: origen, estado desactivado y último disparo */}
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
                <span style={{ color: "var(--color-text-faint)" }}>desactivado</span>
              )}
              {lastFired[h.id]?.timestamp && (
                <span
                  className="ml-auto truncate"
                  style={{ fontFamily: "var(--font-mono)" }}
                  title={`Último disparo: ${lastFired[h.id].timestamp ?? ""} en ${lastFired[h.id].project ?? "?"}`}
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
      {/* Top toolbar */}
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">Hooks</h2>
          <span
            className="text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {filtered.length} de {list?.hooks.length ?? 0}
            {list?.settings_path && (
              <>
                {" "}·{" "}
                <code
                  className="text-[10.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                  title={list.settings_path}
                >
                  {tildeHome(list.settings_path)}
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
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            <Plus size={12} /> Crear hook
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
            title="Abre una sesión de Claude que redacta el JSON del hook por ti"
          >
            Añadir con IA
          </button>
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
            title="Pone nombres legibles a todos los hooks con el Router de IA (Haiku/Gemini) y, si falla, con heurística"
          >
            {namingBusy ? "Poniendo nombres…" : "Nombrar todos"}
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
            title="Volver a leer settings.json"
          >
            Actualizar
          </button>
        </div>
      </header>

      {flash && (
        <div
          className="rounded-md border px-3 py-1.5 text-[12px]"
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
          className="rounded-md p-2 text-xs"
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
          className="rounded-md border px-3 py-1.5 text-[12px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
          }}
        >
          settings.json todavía no existe. Se creará al añadir el primer hook.
        </div>
      )}

      {/* Aviso sin instrumentación: solo si falta el log */}
      {!loading && fires && !fires.instrumented && (
        <div
          className="rounded-md border px-3 py-1.5 text-[11.5px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-tertiary)",
          }}
        >
          No hay historial de disparos: no se encuentra el log de hook-fires.
        </div>
      )}

      {loading && (
        <div className="py-3 text-[13px]" style={{ color: "var(--color-text-tertiary)" }}>
          Cargando…
        </div>
      )}

      {/* Empty state */}
      {!loading && list && list.hooks.length === 0 && (
        <div>
          <HooksEmptyState onAdd={() => setAddOpen(true)} onAi={() => setAiOpen(true)} />
        </div>
      )}

      {/* Layout estilo Agents: search + navegador de bloques por evento (grid | detail) */}
      {!loading && list && list.hooks.length > 0 && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {/* Search */}
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Buscar hooks por nombre, comando, matcher o evento…"
              className="min-w-0 flex-1 rounded-md px-3 py-2 text-sm outline-none"
              style={{
                border: "1px solid var(--color-border-strong)",
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
              }}
            />
            <label
              className="flex shrink-0 items-center gap-1.5 text-[12px]"
              style={{ color: "var(--color-text-secondary)" }}
              title="Los hooks de un plugin apagado en settings.json son inertes; ocultarlos evita que parezcan hooks propios desactivados"
            >
              <input
                type="checkbox"
                checked={hideDisabledPlugins}
                onChange={(e) => setHideDisabledPlugins(e.target.checked)}
              />
              ocultar plugins apagados
            </label>
          </div>

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
                  topSublabel="Evento"
                  emptyLabel="No hay hooks."
                  topGroupAccent={(g) => eventColors(g).ribbon}
                  renderLeaves={(leaves) => renderCardGrid(leaves.map((l) => l.data))}
                />
              )}
            </div>

          {/* Derecha: panel de detalle */}
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
                    `¿Borrar el hook?\n\nEvento: ${selectedHook.event}\nMatcher: ${selectedHook.matcher ?? "(ninguno)"}\nComando: ${truncate(selectedHook.command, 200)}`,
                    { title: "Borrar hook", kind: "error" },
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
