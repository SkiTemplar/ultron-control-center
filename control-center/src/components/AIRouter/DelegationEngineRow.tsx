// ULTRON Control Center — AI Router: una fila de la cadena de delegación
// (orden, activar, modelo base y por nivel, tope de gasto del runner claude).

import { DELEGATION_TIERS, TIER_LABELS, type DelegationEngine } from "./delegationTypes";
import type { DelegationAction } from "./delegationReducer";
import { INPUT_STYLE, Pill, SmallButton } from "./DelegationUi";

interface DelegationEngineRowProps {
  engineId: string;
  engine: DelegationEngine | undefined;
  position: number;
  total: number;
  dispatch: (action: DelegationAction) => void;
}

function parseBudget(raw: string): number | null {
  if (raw.trim() === "") return null;
  return Number(raw);
}

export function DelegationEngineRow({ engineId, engine, position, total, dispatch }: DelegationEngineRowProps) {
  const isFirst = position === 0;
  const isLast = position === total - 1;

  return (
    <li
      className="rounded p-3"
      style={{
        background: "var(--color-bg)",
        border: "1px solid var(--color-border)",
        opacity: engine?.enabled === false ? 0.7 : 1,
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-5 text-right text-[11px] tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
          {position + 1}.
        </span>
        <span className="text-[13px] font-semibold" style={{ fontFamily: "var(--font-mono)", color: "var(--color-text)" }}>
          {engineId}
        </span>
        {engine ? (
          <Pill ok={null}>runner {engine.runner}</Pill>
        ) : (
          <Pill ok={false}>no definido en engines</Pill>
        )}
        {engine?.keyEnv && (
          <span className="text-[10.5px]" style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-tertiary)" }}>
            key: {engine.keyEnv}
          </span>
        )}
        <span className="flex-1" />
        {engine && (
          <label className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
            <input
              type="checkbox"
              checked={engine.enabled}
              onChange={() => dispatch({ type: "TOGGLE_ENABLED", engineId })}
            />
            Activo
          </label>
        )}
        <SmallButton
          onClick={() => dispatch({ type: "MOVE", engineId, delta: -1 })}
          disabled={isFirst}
          title={isFirst ? "Ya es el primero de la cadena" : "Subir un puesto"}
        >
          ▲
        </SmallButton>
        <SmallButton
          onClick={() => dispatch({ type: "MOVE", engineId, delta: 1 })}
          disabled={isLast}
          title={isLast ? "Ya es el último de la cadena" : "Bajar un puesto"}
        >
          ▼
        </SmallButton>
        <SmallButton
          onClick={() => dispatch({ type: "REMOVE_FROM_CHAIN", engineId })}
          title="Sacarlo de la cadena (su definición se conserva y puedes volver a añadirlo)"
        >
          Quitar
        </SmallButton>
      </div>

      {engine && (
        <div className="mt-2.5 grid gap-2 pl-7" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          <ModelField
            label="Modelo base"
            value={engine.model}
            placeholder="obligatorio"
            onChange={(model) => dispatch({ type: "SET_MODEL", engineId, tier: null, model })}
          />
          {DELEGATION_TIERS.map((tier) => (
            <ModelField
              key={tier}
              label={`Nivel ${TIER_LABELS[tier]}`}
              value={engine.tierModels?.[tier] ?? ""}
              placeholder={`= ${engine.model || "base"}`}
              onChange={(model) => dispatch({ type: "SET_MODEL", engineId, tier, model })}
            />
          ))}
          {engine.runner === "claude" && (
            <label className="flex flex-col gap-1 text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              Tope por intento (USD)
              <input
                type="number"
                min={0}
                step={0.5}
                value={engine.maxBudgetUsd === undefined || Number.isNaN(engine.maxBudgetUsd) ? "" : engine.maxBudgetUsd}
                placeholder="sin tope propio"
                onChange={(e) => dispatch({ type: "SET_MAX_BUDGET", engineId, value: parseBudget(e.target.value) })}
                className="rounded px-2 py-1 text-[12px] outline-none"
                style={INPUT_STYLE}
              />
            </label>
          )}
        </div>
      )}
    </li>
  );
}

function ModelField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
      {label}
      <input
        type="text"
        spellCheck={false}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded px-2 py-1 text-[12px] outline-none"
        style={INPUT_STYLE}
      />
    </label>
  );
}
