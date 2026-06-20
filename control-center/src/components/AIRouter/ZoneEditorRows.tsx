// ULTRON Control Center — AI Router: Zone Editor filas y selects
//
// Extraído de ZoneEditor.tsx (cat7: mantener ficheros < 800 líneas). Helpers
// visuales puros: badge de aviso, selects de provider/modelo y la fila de
// assignment (primary o fallback).

import type { Provider, ZoneAssignment } from "./types";
import type { KeyValidation } from "./zoneEditorReducer";

/** Badge de advertencia cuando el provider de un assignment tiene key ausente. */
export function KeyWarningBadge({ warning }: { warning: string }) {
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

export function ProviderSelect({
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

export function ModelSelect({
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

/** Fila de assignment (primary o fallback individual). */
export function AssignmentRow({
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
