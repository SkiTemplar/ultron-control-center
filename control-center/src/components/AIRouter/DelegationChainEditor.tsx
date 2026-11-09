// ULTRON Control Center — AI Router: editor de la cadena de delegación
// (orden de relevo, motores activos, modelos y nivel → motor de entrada).

import { DELEGATION_TIERS, TIER_LABELS, type DelegationConfig } from "./delegationTypes";
import {
  enginesOutsideChain,
  validateDelegationConfig,
  type DelegationAction,
} from "./delegationReducer";
import type { SaveFeedback } from "./useDelegation";
import { DelegationEngineRow } from "./DelegationEngineRow";
import { Banner, DelegationCard, INPUT_STYLE, SmallButton } from "./DelegationUi";

interface DelegationChainEditorProps {
  draft: DelegationConfig;
  dirty: boolean;
  saving: boolean;
  saveFeedback: SaveFeedback | null;
  dispatch: (action: DelegationAction) => void;
  onSave: () => void;
}

export function DelegationChainEditor({
  draft,
  dirty,
  saving,
  saveFeedback,
  dispatch,
  onSave,
}: DelegationChainEditorProps) {
  const issues = validateDelegationConfig(draft);
  const outside = enginesOutsideChain(draft);

  return (
    <DelegationCard
      title="Cadena de relevo"
      hint="El nivel de la tarea elige el motor de entrada; si falla, no tiene cuota o le falta la key, pasa al siguiente y da la vuelta hasta probarlos todos. Si fallan todos, la tarea vuelve a Opus."
      actions={
        <>
          <SmallButton
            onClick={() => dispatch({ type: "RESET" })}
            disabled={!dirty || saving}
            title={dirty ? "Volver a lo guardado" : "No hay cambios que descartar"}
          >
            Descartar cambios
          </SmallButton>
          <SmallButton primary onClick={onSave} disabled={saving}>
            {saving ? "Guardando…" : dirty ? "Guardar" : "Guardar (sin cambios)"}
          </SmallButton>
        </>
      }
    >
      <div className="mb-3 grid gap-3" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        {DELEGATION_TIERS.map((tier) => (
          <label
            key={tier}
            className="flex flex-col gap-1 text-[11px] font-medium"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {TIER_LABELS[tier]}: entra por
            <select
              value={draft.tiers[tier]?.start ?? ""}
              onChange={(e) => dispatch({ type: "SET_TIER_START", tier, engineId: e.target.value })}
              className="rounded px-2 py-1 text-[12px] outline-none"
              style={INPUT_STYLE}
            >
              {!draft.chain.includes(draft.tiers[tier]?.start ?? "") && (
                <option value={draft.tiers[tier]?.start ?? ""}>
                  {draft.tiers[tier]?.start || "(vacío)"} — fuera de la cadena
                </option>
              )}
              {draft.chain.map((id) => (
                <option key={id} value={id}>
                  {id}
                  {draft.engines[id]?.enabled === false ? " (desactivado)" : ""}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <label className="mb-3 flex items-center gap-2 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
        <input
          type="checkbox"
          checked={draft.relayOnCheckFail}
          onChange={(e) => dispatch({ type: "SET_RELAY_ON_CHECK_FAIL", value: e.target.checked })}
        />
        Pasar al siguiente motor también cuando falla la comprobación (tests o build) del resultado
      </label>

      {draft.chain.length === 0 ? (
        <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          La cadena está vacía: toda tarea delegada volvería a Opus. Añade un motor de abajo.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {draft.chain.map((id, i) => (
            <DelegationEngineRow
              key={id}
              engineId={id}
              engine={draft.engines[id]}
              position={i}
              total={draft.chain.length}
              dispatch={dispatch}
            />
          ))}
        </ol>
      )}

      {outside.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Fuera de la cadena:
          {outside.map((id) => (
            <SmallButton
              key={id}
              onClick={() => dispatch({ type: "ADD_TO_CHAIN", engineId: id })}
              title="Añadirlo al final de la cadena"
            >
              + {id}
            </SmallButton>
          ))}
        </div>
      )}

      <Banner kind="error" messages={saveFeedback ? [] : issues.errors} />
      <Banner kind="warn" messages={saveFeedback ? [] : issues.warnings} />
      {saveFeedback && <Banner kind={saveFeedback.kind} messages={saveFeedback.messages} />}
    </DelegationCard>
  );
}
