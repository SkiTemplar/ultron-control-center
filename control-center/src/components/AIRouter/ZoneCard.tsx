// ULTRON Control Center — AI Router: tarjeta de zona
//
// Extraído de ZoneEditor.tsx (cat7: mantener ficheros < 800 líneas). Renderiza
// una zona de routing (cabecera + cadena primary → fallbacks) con su modo de
// edición. Estado y persistencia viven en el componente padre (ZoneEditor).

import type { Dispatch } from "react";
import type { Zone, ZoneAssignment, Provider } from "./types";
import type { KeyValidation, ZoneEditorAction } from "./zoneEditorReducer";
import { AssignmentRow } from "./ZoneEditorRows";


export function ZoneCard({
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
  dispatch: Dispatch<ZoneEditorAction>;
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
