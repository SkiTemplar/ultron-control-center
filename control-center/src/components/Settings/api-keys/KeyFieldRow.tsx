// Settings/api-keys/KeyFieldRow.tsx — fila compartida, una por <li>. La usan
// tanto la lista de providers de IA como la de investigacion (buscador de
// papers). `isEmail` quita el toggle mostrar/ocultar (nada que ocultar en un
// email) y nunca enmascara el valor actual.

import type { ReactNode } from "react";
import { handleExternalClick } from "../../../lib/openExternal";
import { EyeIcon } from "./EyeIcon";
import { TutorialDisclosure } from "./TutorialDisclosure";
import type { EnvKeyStatus, FieldState, ProviderKeyDef } from "./types";

interface KeyFieldRowProps {
  def: ProviderKeyDef;
  state: FieldState;
  status: EnvKeyStatus | undefined;
  isEmail?: boolean;
  onChange: (envVar: string, value: string) => void;
  onToggleVisible: (envVar: string) => void;
  extra?: ReactNode;
}

export function KeyFieldRow({
  def,
  state,
  status,
  isEmail = false,
  onChange,
  onToggleVisible,
  extra,
}: KeyFieldRowProps) {
  const st = status;
  return (
    <li>
      <label
        className="mb-1 flex items-center justify-between text-[12px] font-medium"
        htmlFor={`apikey-${def.envVar}`}
      >
        <span className="flex items-center gap-2">
          {def.label}
          {st?.configured ? (
            <span
              className="rounded px-1.5 py-px text-[10px] font-medium tabular-nums"
              style={{
                fontFamily: "var(--font-mono)",
                background: st.active
                  ? "rgba(63, 185, 80, 0.10)"
                  : "rgba(248, 140, 0, 0.10)",
                color: st.active
                  ? "var(--color-success)"
                  : "var(--color-warning, #f8a000)",
                border: `1px solid ${st.active ? "rgba(63,185,80,0.30)" : "rgba(248,140,0,0.30)"}`,
              }}
              title={
                st.active
                  ? "Configurada y activa en esta sesión"
                  : "Configurada — reinicia la app para activarla"
              }
            >
              {st.active ? "configurada" : "configurada · reinicia"}
            </span>
          ) : (
            <span
              className="rounded px-1.5 py-px text-[10px]"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border)",
              }}
            >
              sin configurar
            </span>
          )}
        </span>
        <a
          href={def.docsUrl}
          target="_blank"
          onClick={handleExternalClick}
          rel="noopener noreferrer"
          className="text-[10.5px] transition-colors"
          style={{ color: "var(--color-accent)" }}
          tabIndex={-1}
        >
          Obtener key ↗
        </a>
      </label>
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1" style={{ fontFamily: "var(--font-mono)" }}>
          <input
            id={`apikey-${def.envVar}`}
            type={isEmail ? "text" : state.visible ? "text" : "password"}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={state.value}
            onChange={(e) => onChange(def.envVar, e.target.value)}
            placeholder={
              st?.configured
                ? isEmail
                  ? `ya configurado (${st.masked}) — escribe para reemplazar`
                  : "ya configurada — escribe para reemplazar"
                : def.placeholder
            }
            className="w-full rounded px-2.5 py-1.5 text-[12px] outline-none transition-colors"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text)",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--color-accent)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--color-border-strong)";
            }}
          />
        </div>
        {!isEmail && (
          <button
            type="button"
            onClick={() => onToggleVisible(def.envVar)}
            title={state.visible ? "Ocultar" : "Mostrar"}
            className="flex shrink-0 items-center justify-center rounded p-1.5 transition-colors"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text-secondary)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--color-text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--color-text-secondary)";
            }}
          >
            <EyeIcon crossed={state.visible} />
          </button>
        )}
        {/* Env var name badge */}
        <span
          className="shrink-0 rounded px-1.5 py-px text-[10px] tabular-nums"
          style={{
            fontFamily: "var(--font-mono)",
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          {def.envVar}
        </span>
      </div>
      <TutorialDisclosure tutorial={def.tutorial} />
      {extra}
    </li>
  );
}
