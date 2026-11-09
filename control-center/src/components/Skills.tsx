// ULTRON Control Center: visor de skills con pestañas Activadas/Desactivadas/Todas.
//
//   - Tres pestañas de filtro, cada una con su contador.
//   - Interruptor en cada tarjeta global (UI optimista: cambia al instante,
//     llama a skill_toggle y revierte con aviso si falla).
//   - Tras el primer cambio de la sesión sale el aviso de reiniciar Claude
//     Code (los cambios no se aplican en caliente).
//   - Las skills desactivadas se pintan atenuadas para distinguirlas de un vistazo.
//   - El botón del panel de detalle se mantiene como acción secundaria.

import { CreateSkillModal } from "./library/CreateSkillModal";
import { Plus } from "./library/icons";
import { TreeView } from "./library/TreeView";
import { BlocksView } from "./library/BlocksView";
import { ViewToggle } from "./library/ViewToggle";
import { LibraryDetailPane } from "./library/LibraryDetailPane";
import { EnableTabs } from "./skills/EnableTabs";
import { RestartBanner } from "./skills/RestartBanner";
import { SkillCardGrid } from "./skills/SkillCardGrid";
import { useSkillsState } from "./skills/useSkillsState";
import { SCOPES, SKILL_ACCENT, SKILL_ACCENT_SOFT } from "./skills/constants";
import { deriveCategory, skillOriginLabel, skillWorkspace } from "./skills/helpers";
import type { SkillEntry } from "../types";

const NO_CATEGORY = "sin categoría";

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Skills() {
  const {
    scope,
    setScope,
    enableFilter,
    setEnableFilter,
    category,
    setCategory,
    query,
    setQuery,
    loading,
    error,
    createOpen,
    setCreateOpen,
    projects,
    view,
    setView,
    selected,
    setSelected,
    toggleBusy,
    toast,
    hasToggled,
    selectMode,
    setSelectMode,
    checked,
    setChecked,
    bulkBusy,
    categories,
    activeCount,
    disabledCount,
    filtered,
    treeOrigins,
    blockItems,
    reload,
    isEnabled,
    handleToggle,
    toggleChecked,
    handleBulk,
    buildOnSave,
  } = useSkillsState();

  // ---------------------------------------------------------------------------
  // Card grid renderer — delegates to SkillCardGrid
  // ---------------------------------------------------------------------------

  const renderCardGrid = (items: SkillEntry[]) => (
    <SkillCardGrid
      items={items}
      selected={selected}
      selectMode={selectMode}
      checked={checked}
      toggleBusy={toggleBusy}
      isEnabled={isEnabled}
      onSelect={setSelected}
      onToggleChecked={toggleChecked}
      onToggle={(s) => void handleToggle(s)}
    />
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Page header */}
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">Skills</h2>
          <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            {/* Mismo denominador que la pestaña «Todas»: el total del ámbito activo. */}
            {filtered.length} de {activeCount + disabledCount}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle mode={view} onChange={setView} />
          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            <Plus size={12} /> Nueva skill
          </button>
          <button
            onClick={() => {
              setSelectMode((v) => !v);
              setChecked(new Set());
            }}
            className="rounded-md border px-3 py-1 text-xs"
            style={{
              borderColor: selectMode ? SKILL_ACCENT : "var(--color-border-strong)",
              background: selectMode ? SKILL_ACCENT_SOFT : "var(--color-surface-2)",
              color: selectMode ? "#67e8f9" : "var(--color-text)",
            }}
            title="Activa o sale de la selección múltiple para activar o desactivar skills globales en bloque"
          >
            {selectMode ? "Terminar selección" : "Seleccionar"}
          </button>
          <button
            onClick={reload}
            className="rounded-md border px-3 py-1 text-xs"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
          >
            Actualizar
          </button>
        </div>
      </header>

      {/* Restart banner */}
      <RestartBanner visible={hasToggled} />

      {/* Bulk action bar — visible in select mode */}
      {selectMode && (
        <div
          className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-xs"
          style={{
            background: SKILL_ACCENT_SOFT,
            border: `1px solid ${SKILL_ACCENT}`,
            color: "var(--color-text)",
          }}
        >
          <span style={{ color: "var(--color-text-secondary)" }}>
            {checked.size} seleccionada{checked.size === 1 ? "" : "s"} (solo globales)
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleBulk(true)}
              disabled={bulkBusy || checked.size === 0}
              className="rounded-md border px-3 py-1 font-medium disabled:opacity-40"
              style={{
                borderColor: "var(--color-success)",
                background: "transparent",
                color: "var(--color-success)",
              }}
            >
              {bulkBusy ? "Aplicando…" : "Activar seleccionadas"}
            </button>
            <button
              type="button"
              onClick={() => void handleBulk(false)}
              disabled={bulkBusy || checked.size === 0}
              className="rounded-md border px-3 py-1 font-medium disabled:opacity-40"
              style={{
                borderColor: "var(--color-danger)",
                background: "transparent",
                color: "var(--color-danger)",
              }}
            >
              {bulkBusy ? "Aplicando…" : "Desactivar seleccionadas"}
            </button>
          </div>
        </div>
      )}

      {/* Enable-state tabs */}
      <EnableTabs
        value={enableFilter}
        onChange={setEnableFilter}
        activeCount={activeCount}
        disabledCount={disabledCount}
      />

      {/* Scope chips */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {SCOPES.map((s) => {
            const isActive = scope === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setScope(s.id)}
                className="rounded-full border px-3 py-1 text-xs transition-colors"
                style={{
                  borderColor: isActive ? "var(--color-accent)" : "var(--color-border-strong)",
                  background: isActive ? "var(--color-accent)" : "transparent",
                  color: isActive ? "var(--color-accent-text)" : "var(--color-text-secondary)",
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {/* Por qué el conteo de "activas" cambia tanto entre scopes. */}
        {scope === "all" && (
          <p className="text-[11px] leading-snug" style={{ color: "var(--color-text-tertiary)" }}>
            En <b>Todas</b> el conteo de «activadas» incluye las skills de los plugins
            de terceros (vienen activadas de fábrica). Tus skills propias de ULTRON
            (el núcleo lazy que tú gestionas) están en el ámbito <b>Global</b>.
          </p>
        )}

        {view !== "blocks" && categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="text-[10.5px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Categoría
            </span>
            <button
              onClick={() => setCategory("all")}
              className="rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors"
              style={{
                borderColor: category === "all" ? "var(--color-text)" : "var(--color-border-strong)",
                background: category === "all" ? "var(--color-surface-4)" : "transparent",
                color: category === "all" ? "var(--color-text)" : "var(--color-text-secondary)",
              }}
            >
              Todas
            </button>
            {categories.map((c) => {
              const active = c === category;
              return (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className="rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors"
                  style={{
                    borderColor: active ? "var(--color-text)" : "var(--color-border-strong)",
                    background: active ? "var(--color-surface-4)" : "transparent",
                    color: active ? "var(--color-text)" : "var(--color-text-secondary)",
                  }}
                >
                  {c}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Search */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar skills (aproximada y con sinónimos, ordenada por relevancia)…"
        className="w-full rounded-md px-3 py-2 text-sm outline-none"
        style={{
          border: "1px solid var(--color-border-strong)",
          background: "var(--color-surface-2)",
          color: "var(--color-text)",
        }}
      />

      {/* Error */}
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

      {/* Toast */}
      {toast && (
        <div
          className="rounded-md p-3 text-xs"
          style={{
            border: "1px solid rgba(248, 81, 73, 0.30)",
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
          }}
        >
          {toast}
        </div>
      )}

      {/* 2-pane: list + detail */}
      <div className="flex flex-1 flex-col gap-3 overflow-hidden lg:flex-row">
        <div
          className={selected ? "min-w-0 flex-1 overflow-y-auto" : "flex-1 overflow-y-auto"}
          style={{ minWidth: 0 }}
        >
          {loading ? (
            <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
              Cargando…
            </p>
          ) : filtered.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center gap-2 rounded-xl py-12 text-center"
              style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
            >
              <p className="text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>
                {enableFilter === "disabled"
                  ? "No hay skills desactivadas con los filtros actuales."
                  : enableFilter === "active"
                    ? "No hay skills activadas con los filtros actuales."
                    : "No se ha encontrado ninguna skill."}
              </p>
              {enableFilter !== "all" && (
                <button
                  onClick={() => setEnableFilter("all")}
                  className="text-xs underline-offset-2 hover:underline"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  Mostrar todas
                </button>
              )}
            </div>
          ) : view === "blocks" ? (
            <BlocksView<SkillEntry>
              items={blockItems}
              noun="skill"
              emptyLabel="No hay skills con el filtro actual."
              topGroupAccent={() => SKILL_ACCENT}
              renderLeaves={(items) => renderCardGrid(items.map((it) => it.data))}
            />
          ) : view === "tree" ? (
            <TreeView<SkillEntry>
              origins={treeOrigins}
              selectedKey={selected ? `${selected.origin}-${selected.path}` : null}
              onSelect={(leaf) => setSelected(leaf.data)}
              query={query}
            />
          ) : (
            renderCardGrid(filtered)
          )}
        </div>

        {selected && (
          <div className="overflow-hidden lg:w-[560px] lg:shrink-0" style={{ minWidth: 0 }}>
            {(() => {
              const ws = skillWorkspace(selected);
              const subtitleParts: string[] = [skillOriginLabel(selected.origin)];
              const cat = deriveCategory(selected);
              if (cat !== NO_CATEGORY) subtitleParts.push(cat);
              if (selected.origin === "global") {
                subtitleParts.push(isEnabled(selected) ? "activada" : "desactivada");
              }
              return (
                <div className="flex h-full flex-col gap-2">
                  <LibraryDetailPane
                    kind="skill"
                    name={selected.name}
                    subtitle={subtitleParts.join(" · ")}
                    filePath={ws.file}
                    folderPath={ws.folder}
                    onSave={buildOnSave(selected)}
                    onClose={() => setSelected(null)}
                  />
                  {selected.origin === "global" && (
                    <button
                      type="button"
                      onClick={() => void handleToggle(selected)}
                      disabled={toggleBusy.has(selected.path)}
                      className="rounded-md border px-3 py-1.5 text-[11.5px] disabled:opacity-50"
                      style={{
                        borderColor: isEnabled(selected)
                          ? "var(--color-border-strong)"
                          : "var(--color-accent)",
                        background: isEnabled(selected)
                          ? "var(--color-surface-2)"
                          : "var(--color-accent)",
                        color: isEnabled(selected)
                          ? "var(--color-text)"
                          : "var(--color-accent-text)",
                      }}
                    >
                      {toggleBusy.has(selected.path)
                        ? "Guardando…"
                        : isEnabled(selected)
                          ? "Desactivar la skill"
                          : "Activar la skill"}
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {createOpen && (
        <CreateSkillModal
          projects={projects}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}
