// ULTRON Control Center — AI Router: Zone Editor
//
// Permite ver y editar la cadena primary → [fallbacks] de cada zona de routing.
// Aviso visual (warning badge) cuando un provider de la cadena tiene key ausente
// o placeholder — corazón del criterio cat14.4.
//
// Reducer + tipos viven en zoneEditorReducer.ts; las filas/selects en
// ZoneEditorRows.tsx; la tarjeta de zona en ZoneCard.tsx (cat7: < 800 líneas).
//
// Comandos Tauri consumidos:
//   ai_router_list_zones      — lista zonas (EXISTE y registrado en lib.rs)
//   ai_router_save_zone       — persiste una zona editada (EXISTE y registrado en lib.rs)
//   ai_router_list_providers  — catálogo de providers con modelos disponibles (EXISTE)
//   ai_router_validate_keys   — estado real de keys por provider (EXISTE)

import { useCallback, useEffect, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Zone, Provider } from "./types";
import { PROVIDER_CATALOG } from "./types";
import { editorReducer, type KeyValidation } from "./zoneEditorReducer";
import { ZoneCard } from "./ZoneCard";
import { saveZoneDraft } from "./zoneSave";

export function ZoneEditor() {
  const [zones, setZones] = useState<Zone[]>([]);
  const [providers, setProviders] = useState<Provider[]>(PROVIDER_CATALOG);
  const [keyMap, setKeyMap] = useState<Record<string, KeyValidation>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editorState, dispatch] = useReducer(editorReducer, {
    editingId: null,
    drafts: {},
    saving: new Set<string>(),
    saveResults: {},
  });

  const loadData = useCallback(async () => {
    // 1. Providers
    let liveProviders: Provider[] = PROVIDER_CATALOG;
    try {
      const backendProviders = (await invoke("ai_router_list_providers")) as Provider[];
      if (backendProviders.length > 0) liveProviders = backendProviders;
    } catch {
      // Usa el catálogo estático — no es bloqueante
    }
    setProviders(liveProviders);

    // 2. Key validations — para los warning badges
    try {
      const kvList = (await invoke("ai_router_validate_keys")) as KeyValidation[];
      const map: Record<string, KeyValidation> = {};
      for (const kv of kvList) map[kv.provider_id] = kv;
      setKeyMap(map);
    } catch {
      // Sin datos de keys — los badges no se muestran
    }

    // 3. Zonas. Sin backend no hay zonas que enseñar: se enseña el error y
    // un reintento, nunca un catálogo inventado que parezca la configuración.
    try {
      const backendZones = (await invoke("ai_router_list_zones")) as Zone[];
      setZones(backendZones);
      for (const z of backendZones) {
        dispatch({ type: "RESET_DRAFT", zoneId: z.id, original: z });
      }
      setLoadError(null);
    } catch (err) {
      setZones([]);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function handleSave(zoneId: string) {
    const draft = editorState.drafts[zoneId];
    if (!draft) return;

    dispatch({ type: "SET_SAVING", zoneId, saving: true });
    dispatch({ type: "SET_SAVE_RESULT", zoneId, result: undefined as unknown as string });

    // ai_router_save_zone valida en el backend: rechaza con el motivo lo que
    // la carga siguiente revertiría y devuelve la zona persistida.
    const result = await saveZoneDraft(invoke, draft);
    if (result.ok) {
      const saved = result.zone;
      setZones((prev) => prev.map((z) => (z.id === zoneId ? structuredClone(saved) : z)));
      dispatch({ type: "RESET_DRAFT", zoneId, original: saved });
      dispatch({ type: "SET_SAVE_RESULT", zoneId, result: "ok" });
    } else {
      dispatch({ type: "SET_SAVE_RESULT", zoneId, result: result.error });
    }
    dispatch({ type: "SET_SAVING", zoneId, saving: false });
  }

  // Agrupa zonas por category para la presentación
  const byCategory: Record<string, Zone[]> = {};
  for (const z of zones) {
    if (!byCategory[z.category]) byCategory[z.category] = [];
    byCategory[z.category].push(z);
  }
  const categories = Object.keys(byCategory).sort();

  // Cuenta zonas con al menos un provider sin key en su cadena
  const warningCount = zones.filter((z) => {
    const draft = editorState.drafts[z.id] ?? z;
    return (
      (keyMap[draft.primary.provider_id] !== undefined &&
        !keyMap[draft.primary.provider_id].has_key) ||
      draft.fallbacks.some(
        (fb) => keyMap[fb.provider_id] !== undefined && !keyMap[fb.provider_id].has_key,
      )
    );
  }).length;

  return (
    <div className="p-6 space-y-5">
      {/* Backend no disponible: error y reintento, sin zonas */}
      {loadError !== null && (
        <div
          role="alert"
          className="rounded p-3 text-[12px] flex items-start justify-between gap-3"
          style={{
            background: "rgba(248,81,73,0.08)",
            color: "var(--color-danger)",
            border: "1px solid rgba(248,81,73,0.30)",
          }}
        >
          <span>
            <span className="font-semibold">No se han podido cargar las zonas: </span>
            {loadError}
          </span>
          <button
            type="button"
            onClick={() => void loadData()}
            className="rounded px-3 py-1 text-[12px] shrink-0"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
            }}
          >
            Reintentar
          </button>
        </div>
      )}

      {/* Cabecera con resumen */}
      {loadError === null && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <span
              className="text-[13px] font-medium"
              style={{ color: "var(--color-text)" }}
            >
              {zones.length} zonas
            </span>
            {warningCount > 0 && (
              <span
                className="ml-2 rounded px-2 py-0.5 text-[11px] font-semibold"
                style={{
                  background: "rgba(210,153,34,0.15)",
                  color: "var(--color-warn)",
                  border: "1px solid rgba(210,153,34,0.35)",
                }}
              >
                {warningCount} con key incompleta
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void loadData()}
            className="rounded px-3 py-1.5 text-[12px] transition-colors"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
            }}
          >
            Recargar
          </button>
        </div>
      )}

      {/* Zonas agrupadas por categoría */}
      {categories.map((cat) => (
        <div key={cat} className="space-y-2">
          <h2
            className="text-[11px] font-semibold uppercase tracking-widest"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {cat}
          </h2>
          {byCategory[cat].map((zone) => {
            const draft = editorState.drafts[zone.id] ?? zone;
            const isEditing = editorState.editingId === zone.id;
            return (
              <ZoneCard
                key={zone.id}
                zone={zone}
                draft={draft}
                providers={providers}
                keyMap={keyMap}
                editing={isEditing}
                saving={editorState.saving.has(zone.id)}
                saveResult={editorState.saveResults[zone.id]}
                onToggleEdit={() =>
                  dispatch({
                    type: "SET_EDITING",
                    id: isEditing ? null : zone.id,
                  })
                }
                onSave={() => void handleSave(zone.id)}
                onReset={() => dispatch({ type: "RESET_DRAFT", zoneId: zone.id, original: zone })}
                dispatch={dispatch}
              />
            );
          })}
        </div>
      ))}

      {loadError === null && zones.length === 0 && (
        <p className="text-[12px]" style={{ color: "var(--color-text-faint)" }}>
          No hay zonas configuradas.
        </p>
      )}

      {/* Nota de pie */}
      <p className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
        Los cambios llaman a ai_router_save_zone() y se persisten en
        ~/.ultron/cockpit/ai-router/zones.json. El routing activo usa esos
        valores en la siguiente invocación. Una edición que la carga revertiría
        (proveedor retirado o fuera del catálogo, fallback obligatorio del seed)
        no se guarda y se explica el motivo.
      </p>
    </div>
  );
}
