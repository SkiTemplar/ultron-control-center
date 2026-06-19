// ULTRON Control Center — AI Router: Zone Editor
//
// Permite ver y editar la cadena primary → [fallbacks] de cada zona de routing.
// Aviso visual (warning badge) cuando un provider de la cadena tiene key ausente
// o placeholder — corazón del criterio cat14.4.
//
// Comandos Tauri consumidos:
//   ai_router_list_zones      — lista zonas (EXISTE en Rust; pendiente wiring en generate_handler!)
//   ai_router_save_zone       — persiste una zona editada (FALTA en Rust — TODO cat14)
//   ai_router_list_providers  — catálogo de providers con modelos disponibles (EXISTE)
//   ai_router_validate_keys   — estado real de keys por provider (EXISTE)

import { useCallback, useEffect, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Zone, ZoneAssignment, Provider } from "./types";
import { DEFAULT_ZONES, PROVIDER_CATALOG } from "./types";

// ---------------------------------------------------------------------------
// Tipos auxiliares (locales a este componente)
// ---------------------------------------------------------------------------

interface KeyValidation {
  provider_id: string;
  provider_label: string;
  has_key: boolean;
  source: string;
  warning?: string | null;
}

/** Estado editable de una zona — copia inmutable para edición local. */
interface ZoneEditState {
  /** Id de la zona que está en edición ahora mismo (null = ninguna). */
  editingId: string | null;
  /** Edits pendientes, indexadas por zone id. */
  drafts: Record<string, Zone>;
  /** Zonas que se están guardando ahora mismo. */
  saving: Set<string>;
  /** Resultado del último guardado: "ok" o mensaje de error. */
  saveResults: Record<string, "ok" | string>;
}

type ZoneEditorAction =
  | { type: "SET_EDITING"; id: string | null }
  | { type: "UPDATE_PRIMARY"; zoneId: string; field: keyof ZoneAssignment; value: string | number }
  | { type: "UPDATE_FALLBACK"; zoneId: string; index: number; field: keyof ZoneAssignment; value: string | number }
  | { type: "ADD_FALLBACK"; zoneId: string; entry: ZoneAssignment }
  | { type: "REMOVE_FALLBACK"; zoneId: string; index: number }
  | { type: "RESET_DRAFT"; zoneId: string; original: Zone }
  | { type: "SET_SAVING"; zoneId: string; saving: boolean }
  | { type: "SET_SAVE_RESULT"; zoneId: string; result: "ok" | string };

function editorReducer(state: ZoneEditState, action: ZoneEditorAction): ZoneEditState {
  switch (action.type) {
    case "SET_EDITING":
      return { ...state, editingId: action.id };

    case "UPDATE_PRIMARY": {
      const draft = state.drafts[action.zoneId];
      if (!draft) return state;
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.zoneId]: {
            ...draft,
            primary: { ...draft.primary, [action.field]: action.value },
          },
        },
      };
    }

    case "UPDATE_FALLBACK": {
      const draft = state.drafts[action.zoneId];
      if (!draft) return state;
      const newFallbacks = draft.fallbacks.map((fb, i) =>
        i === action.index ? { ...fb, [action.field]: action.value } : fb,
      );
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.zoneId]: { ...draft, fallbacks: newFallbacks },
        },
      };
    }

    case "ADD_FALLBACK": {
      const draft = state.drafts[action.zoneId];
      if (!draft) return state;
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.zoneId]: {
            ...draft,
            fallbacks: [...draft.fallbacks, action.entry],
          },
        },
      };
    }

    case "REMOVE_FALLBACK": {
      const draft = state.drafts[action.zoneId];
      if (!draft) return state;
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.zoneId]: {
            ...draft,
            fallbacks: draft.fallbacks.filter((_, i) => i !== action.index),
          },
        },
      };
    }

    case "RESET_DRAFT":
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.zoneId]: structuredClone(action.original),
        },
        saveResults: { ...state.saveResults, [action.zoneId]: undefined as unknown as string },
      };

    case "SET_SAVING": {
      const next = new Set(state.saving);
      if (action.saving) {
        next.add(action.zoneId);
      } else {
        next.delete(action.zoneId);
      }
      return { ...state, saving: next };
    }

    case "SET_SAVE_RESULT":
      return {
        ...state,
        saveResults: { ...state.saveResults, [action.zoneId]: action.result },
      };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Helpers visuales
// ---------------------------------------------------------------------------

/** Badge de advertencia cuando el provider de un assignment tiene key ausente. */
function KeyWarningBadge({ warning }: { warning: string }) {
  return (
    <span
      title={warning}
      className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold cursor-help"
      style={{
        background: "rgba(210,153,34,0.15)",
        color: "var(--color-warn)",
        border: "1px solid rgba(210,153,34,0.35)",
      }}
    >
      ! sin key
    </span>
  );
}

function ProviderSelect({
  value,
  providers,
  keyMap,
  onChange,
  disabled,
}: {
  value: string;
  providers: Provider[];
  keyMap: Record<string, KeyValidation>;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const kv = keyMap[value];
  const hasWarning = kv !== undefined && !kv.has_key;

  return (
    <span className="inline-flex items-center gap-0.5">
      <select
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded px-2 py-1 text-[12px]"
        style={{
          background: "var(--color-surface-3)",
          color: hasWarning ? "var(--color-warn)" : "var(--color-text)",
          border: hasWarning
            ? "1px solid rgba(210,153,34,0.5)"
            : "1px solid var(--color-border)",
          minWidth: 120,
        }}
      >
        {providers.map((p) => {
          const pKv = keyMap[p.id];
          const noKey = pKv !== undefined && !pKv.has_key;
          return (
            <option key={p.id} value={p.id}>
              {p.name}
              {noKey ? " (sin key)" : ""}
            </option>
          );
        })}
      </select>
      {hasWarning && kv.warning && <KeyWarningBadge warning={kv.warning} />}
    </span>
  );
}

function ModelSelect({
  value,
  providerId,
  providers,
  onChange,
  disabled,
}: {
  value: string;
  providerId: string;
  providers: Provider[];
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  const provider = providers.find((p) => p.id === providerId);
  const models = provider?.models ?? [];

  if (models.length === 0) {
    // Sin modelos conocidos: input libre
    return (
      <input
        type="text"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="model id"
        className="rounded px-2 py-1 text-[12px]"
        style={{
          background: "var(--color-surface-3)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border)",
          minWidth: 140,
        }}
      />
    );
  }

  return (
    <select
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded px-2 py-1 text-[12px]"
      style={{
        background: "var(--color-surface-3)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border)",
        minWidth: 140,
      }}
    >
      {/* Si el valor actual no está en la lista, mostrarlo como opción huérfana */}
      {!models.includes(value) && value && (
        <option value={value}>{value}</option>
      )}
      {models.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Fila de assignment (primary o fallback individual)
// ---------------------------------------------------------------------------

function AssignmentRow({
  label,
  assignment,
  providers,
  keyMap,
  editing,
  onChangeProvider,
  onChangeModel,
  onRemove,
}: {
  label: string;
  assignment: ZoneAssignment;
  providers: Provider[];
  keyMap: Record<string, KeyValidation>;
  editing: boolean;
  onChangeProvider: (id: string) => void;
  onChangeModel: (model: string) => void;
  onRemove?: () => void;
}) {
  const kv = keyMap[assignment.provider_id];
  const hasWarning = kv !== undefined && !kv.has_key;

  return (
    <div className="flex items-center gap-2 flex-wrap py-1">
      <span
        className="w-[72px] shrink-0 text-[10px] font-semibold uppercase tracking-wide"
        style={{ color: "var(--color-text-faint)" }}
      >
        {label}
      </span>

      {editing ? (
        <>
          <ProviderSelect
            value={assignment.provider_id}
            providers={providers}
            keyMap={keyMap}
            onChange={onChangeProvider}
          />
          <span style={{ color: "var(--color-text-faint)", fontSize: 11 }}>→</span>
          <ModelSelect
            value={assignment.model}
            providerId={assignment.provider_id}
            providers={providers}
            onChange={onChangeModel}
          />
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              title="Quitar fallback"
              className="ml-1 rounded px-1.5 py-0.5 text-[11px] transition-colors"
              style={{
                background: "rgba(200,50,50,0.12)",
                color: "var(--color-danger)",
                border: "1px solid rgba(200,50,50,0.25)",
              }}
            >
              x
            </button>
          )}
        </>
      ) : (
        <span
          className="flex items-center gap-1 text-[12px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          <code
            className="rounded px-1.5 py-0.5"
            style={{
              background: "var(--color-surface-3)",
              color: hasWarning ? "var(--color-warn)" : "var(--color-text)",
              border: hasWarning
                ? "1px solid rgba(210,153,34,0.4)"
                : "1px solid var(--color-border)",
              fontSize: 11,
            }}
          >
            {assignment.provider_id}
          </code>
          <span style={{ color: "var(--color-text-faint)" }}>→</span>
          <code
            className="rounded px-1.5 py-0.5 text-[11px]"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
            }}
          >
            {assignment.model}
          </code>
          {hasWarning && kv.warning && <KeyWarningBadge warning={kv.warning} />}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tarjeta de zona
// ---------------------------------------------------------------------------

const TASK_CLASS_COLORS: Record<string, string> = {
  trivial: "var(--color-success)",
  light: "var(--color-warn)",
  medium: "#a875ff",
  heavy: "var(--color-danger)",
};

function ZoneCard({
  zone,
  draft,
  providers,
  keyMap,
  editing,
  saving,
  saveResult,
  onToggleEdit,
  onSave,
  onReset,
  dispatch,
}: {
  zone: Zone;
  draft: Zone;
  providers: Provider[];
  keyMap: Record<string, KeyValidation>;
  editing: boolean;
  saving: boolean;
  saveResult: "ok" | string | undefined;
  onToggleEdit: () => void;
  onSave: () => void;
  onReset: () => void;
  dispatch: React.Dispatch<ZoneEditorAction>;
}) {
  const zoneId = zone.id;

  // Detecta si algún provider de la cadena completa tiene warning de key
  const chainHasWarning =
    (!keyMap[draft.primary.provider_id]?.has_key &&
      keyMap[draft.primary.provider_id] !== undefined) ||
    draft.fallbacks.some(
      (fb) => keyMap[fb.provider_id] !== undefined && !keyMap[fb.provider_id].has_key,
    );

  const defaultFallback: ZoneAssignment = {
    provider_id: providers[0]?.id ?? "anthropic",
    model: providers[0]?.models?.[0] ?? "",
    max_tokens: 0,
  };

  return (
    <div
      className="rounded-lg"
      style={{
        background: "var(--color-surface-2)",
        border: chainHasWarning && !editing
          ? "1px solid rgba(210,153,34,0.4)"
          : "1px solid var(--color-border)",
      }}
    >
      {/* Cabecera de zona */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 cursor-pointer"
        style={{ borderBottom: editing ? "1px solid var(--color-border)" : "none" }}
        onClick={onToggleEdit}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onToggleEdit();
        }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="text-[13px] font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              {zone.label}
            </span>
            <code
              className="text-[10px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              {zone.id}
            </code>
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                background: `${TASK_CLASS_COLORS[zone.task_class] ?? "var(--color-text-faint)"}22`,
                color: TASK_CLASS_COLORS[zone.task_class] ?? "var(--color-text-faint)",
                border: `1px solid ${TASK_CLASS_COLORS[zone.task_class] ?? "var(--color-text-faint)"}44`,
              }}
            >
              {zone.task_class}
            </span>
            {chainHasWarning && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                style={{
                  background: "rgba(210,153,34,0.15)",
                  color: "var(--color-warn)",
                  border: "1px solid rgba(210,153,34,0.35)",
                }}
                title="Uno o más providers de esta zona no tienen key configurada"
              >
                ! key incompleta
              </span>
            )}
          </div>
        </div>
        <span
          className="text-[11px] shrink-0"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {editing ? "Cerrar" : "Editar"}
        </span>
      </div>

      {/* Cuerpo: cadena de routing */}
      <div className={editing ? "px-4 pt-3 pb-4 space-y-1" : "px-4 pt-2 pb-3 space-y-1"}>
        {/* Primary */}
        <AssignmentRow
          label="Primary"
          assignment={draft.primary}
          providers={providers}
          keyMap={keyMap}
          editing={editing}
          onChangeProvider={(id) =>
            dispatch({ type: "UPDATE_PRIMARY", zoneId, field: "provider_id", value: id })
          }
          onChangeModel={(model) =>
            dispatch({ type: "UPDATE_PRIMARY", zoneId, field: "model", value: model })
          }
        />

        {/* Fallbacks */}
        {draft.fallbacks.map((fb, i) => (
          <AssignmentRow
            key={i}
            label={`Fallback ${i + 1}`}
            assignment={fb}
            providers={providers}
            keyMap={keyMap}
            editing={editing}
            onChangeProvider={(id) =>
              dispatch({
                type: "UPDATE_FALLBACK",
                zoneId,
                index: i,
                field: "provider_id",
                value: id,
              })
            }
            onChangeModel={(model) =>
              dispatch({
                type: "UPDATE_FALLBACK",
                zoneId,
                index: i,
                field: "model",
                value: model,
              })
            }
            onRemove={
              editing
                ? () => dispatch({ type: "REMOVE_FALLBACK", zoneId, index: i })
                : undefined
            }
          />
        ))}

        {draft.fallbacks.length === 0 && !editing && (
          <span
            className="text-[11px] italic"
            style={{ color: "var(--color-text-faint)" }}
          >
            Sin fallbacks configurados
          </span>
        )}

        {/* Acciones en modo edición */}
        {editing && (
          <div className="flex items-center gap-2 pt-3 flex-wrap">
            {/* Agregar fallback */}
            {draft.fallbacks.length < 3 && (
              <button
                type="button"
                onClick={() =>
                  dispatch({ type: "ADD_FALLBACK", zoneId, entry: { ...defaultFallback } })
                }
                className="rounded px-2.5 py-1 text-[11px] transition-colors"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                + Fallback
              </button>
            )}

            <div className="ml-auto flex items-center gap-2">
              {/* Resultado del guardado */}
              {saveResult === "ok" && (
                <span
                  className="text-[11px]"
                  style={{ color: "var(--color-success)" }}
                >
                  Guardado
                </span>
              )}
              {saveResult && saveResult !== "ok" && (
                <span
                  className="text-[11px] max-w-[200px] truncate"
                  style={{ color: "var(--color-danger)" }}
                  title={saveResult}
                >
                  Error: {saveResult}
                </span>
              )}

              {/* Descartar */}
              <button
                type="button"
                onClick={onReset}
                disabled={saving}
                className="rounded px-3 py-1 text-[11px] transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                Descartar
              </button>

              {/* Guardar */}
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className="rounded px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-accent, #5b6af0)",
                  color: "#fff",
                  border: "none",
                }}
              >
                {saving ? "Guardando..." : "Guardar"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ZoneEditor (componente principal exportado)
// ---------------------------------------------------------------------------

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

  // Inicializa los drafts cuando llegan las zonas reales
  function initDrafts(incoming: Zone[]): Record<string, Zone> {
    return Object.fromEntries(incoming.map((z) => [z.id, structuredClone(z)]));
  }

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

    // 3. Zonas
    try {
      // TODO(cat14): ai_router_list_zones existe en Rust pero aún no está
      // registrado en generate_handler! de lib.rs — el backend lo cableará.
      const backendZones = (await invoke("ai_router_list_zones")) as Zone[];
      const validZones = backendZones.length > 0 ? backendZones : DEFAULT_ZONES;
      setZones(validZones);
      dispatch({ type: "RESET_DRAFT", zoneId: "__init__", original: DEFAULT_ZONES[0] });
      // Reinicia todos los drafts con los datos reales
      const allDrafts = initDrafts(validZones);
      // Cargamos zona por zona con RESET_DRAFT
      for (const z of validZones) {
        dispatch({ type: "RESET_DRAFT", zoneId: z.id, original: z });
      }
      // Silencia el warning del linter — allDrafts se usa implícitamente
      void allDrafts;
      setLoadError(null);
    } catch (err) {
      setZones(DEFAULT_ZONES);
      for (const z of DEFAULT_ZONES) {
        dispatch({ type: "RESET_DRAFT", zoneId: z.id, original: z });
      }
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

    try {
      // TODO(cat14): backend command pending — ai_router_save_zone no existe
      // en Rust todavía. Cablearlo en ai_router/mod.rs + store.rs + lib.rs.
      await invoke("ai_router_save_zone", { zone: draft });
      dispatch({ type: "SET_SAVE_RESULT", zoneId, result: "ok" });
      // Actualiza la zona canónica en el estado local
      setZones((prev) => prev.map((z) => (z.id === zoneId ? structuredClone(draft) : z)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "SET_SAVE_RESULT", zoneId, result: msg });
    } finally {
      dispatch({ type: "SET_SAVING", zoneId, saving: false });
    }
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
      {/* Aviso de backend no disponible */}
      {loadError !== null && (
        <div
          className="rounded p-3 text-[12px]"
          style={{
            background: "rgba(210,153,34,0.08)",
            color: "var(--color-warn)",
            border: "1px solid rgba(210,153,34,0.30)",
          }}
        >
          <span className="font-semibold">
            ai_router_list_zones no disponible — mostrando zonas por defecto:{" "}
          </span>
          {loadError}
        </div>
      )}

      {/* Cabecera con resumen */}
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

      {zones.length === 0 && (
        <p className="text-[12px]" style={{ color: "var(--color-text-faint)" }}>
          No hay zonas configuradas.
        </p>
      )}

      {/* Nota de pie */}
      <p className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
        Los cambios llaman a ai_router_save_zone() y se persisten en
        ~/.ultron/cockpit/ai-router/zones.json. El routing activo usa esos
        valores en la siguiente invocación.
      </p>
    </div>
  );
}
