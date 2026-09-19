// mar.ia — Settings > API Keys
//
// Two subsections:
//   1. AI provider keys  — persisted via `set_env_vars_keys` (setx, User scope).
//   2. GitHub token      — persisted via `set_github_token` (~/.maria/.env).
//
// SECURITY: values are masked by default. Never logged or serialised outside
// the invoke call to the backend.
//
// Composicion fina: datos en api-keys/key-catalog.ts, validacion en
// api-keys/validation.ts, estado + invoke en api-keys/useApiKeys.ts, y un
// componente por pieza visual bajo api-keys/.

import { useState } from "react";
import { GithubTokenCard } from "./api-keys/GithubTokenCard";
import { ProviderKeysGroup } from "./api-keys/ProviderKeysGroup";
import { ResearchKeysGroup } from "./api-keys/ResearchKeysGroup";
import { useApiKeys } from "./api-keys/useApiKeys";
import type { ProviderKeyDef } from "./api-keys/types";
import { Confirmar } from "./Confirmar";
import { EMAIL_ENV_VARS } from "./api-keys/key-catalog";

export function ApiKeysSection() {
  // Clave pendiente de confirmar. Se guarda la definicion entera porque el
  // dialogo ensena la etiqueta legible, no solo el nombre de la variable.
  const [aBorrar, setABorrar] = useState<ProviderKeyDef | null>(null);
  const {
    fields,
    statuses,
    saving,
    result,
    error,
    validations,
    validating,
    savedCount,
    errorCount,
    handleChange,
    toggleVisible,
    handleSave,
    handleValidate,
    handleDelete,
    borrando,
    borrado,
  } = useApiKeys();

  return (
    <div className="max-w-[560px]">
      {/* Section header */}
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold">API Keys</h2>
        <p
          className="mt-1 text-[12.5px] leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Las keys se guardan como variables de entorno de usuario Windows via{" "}
          <code
            className="rounded px-1 py-px text-[11px]"
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border)",
            }}
          >
            setx
          </code>
          . Se activan al instante en esta sesión (y quedan guardadas para las
          futuras). Los campos vacíos se omiten.
        </p>
      </div>

      <ProviderKeysGroup
        fields={fields}
        statuses={statuses}
        onChange={handleChange}
        onToggleVisible={toggleVisible}
        onDelete={setABorrar}
        borrando={borrando}
      />

      <ResearchKeysGroup
        fields={fields}
        statuses={statuses}
        onChange={handleChange}
        onToggleVisible={toggleVisible}
        onDelete={setABorrar}
        borrando={borrando}
      />

      {/* Actions */}
      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded px-4 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {saving ? "Guardando…" : "Save all"}
        </button>
        <button
          type="button"
          onClick={() => void handleValidate()}
          disabled={validating}
          className="rounded px-4 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text-secondary)",
          }}
          title="Comprueba cada provider del router: key presente / CLI instalada"
        >
          {validating ? "Validando…" : "Validar keys del router"}
        </button>
        <span
          className="text-[11.5px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          Solo se envían los campos con valor.
        </span>
      </div>

      {/* cat14.5: resultado de la validacion por provider del router */}
      {validations && (
        <div
          className="mt-4 rounded p-3"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border)",
          }}
        >
          <p
            className="mb-2 text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Providers del router ({validations.filter((v) => v.has_key).length}/
            {validations.length} OK)
          </p>
          <ul className="flex flex-col gap-1">
            {validations.map((v) => (
              <li key={v.provider_id} className="flex items-center gap-2 text-[12px]">
                <span style={{ color: v.has_key ? "var(--color-success)" : "var(--color-danger)" }}>
                  {v.has_key ? "●" : "○"}
                </span>
                <span style={{ fontFamily: "var(--font-mono)" }}>{v.provider_id}</span>
                <span className="text-[10.5px]" style={{ color: "var(--color-text-faint)" }}>
                  {v.source}
                </span>
                {v.warning && (
                  <span
                    className="min-w-0 flex-1 truncate text-[10.5px]"
                    style={{ color: "var(--color-warning, #f8a000)" }}
                    title={v.warning}
                  >
                    {v.warning}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Confirmacion de borrado. El usuario lo pidio asi (2026-09-19): boton
          de eliminar Y confirmacion, "para no darle por si acaso". */}
      {aBorrar && (
        <Confirmar
          titulo={`Eliminar ${aBorrar.label}`}
          detalle={
            `Se quita ${aBorrar.envVar} del .env de mar.ia y de las variables de ` +
            `usuario de Windows. ` +
            (EMAIL_ENV_VARS.has(aBorrar.envVar)
              ? "Tendrás que volver a escribirlo si lo quieres de vuelta."
              : "La clave en sí no se puede recuperar: habrá que volver a copiarla del proveedor.") +
            " Los programas ya abiertos seguirán viéndola hasta que se reinicien."
          }
          accion="Eliminar"
          onCancelar={() => setABorrar(null)}
          onConfirmar={() => {
            const def = aBorrar;
            setABorrar(null);
            void handleDelete(def.envVar);
          }}
        />
      )}

      {/* Resultado del borrado */}
      {borrado && (
        <div
          className="mt-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63,185,80,0.22)",
            color: "var(--color-success)",
          }}
        >
          {borrado}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div
          className="mt-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Success / partial result banner */}
      {result && (
        <div
          className="mt-4 rounded p-3 text-[12px]"
          style={{
            background:
              errorCount > 0
                ? "rgba(248, 140, 0, 0.06)"
                : "rgba(63, 185, 80, 0.06)",
            border: `1px solid ${errorCount > 0 ? "rgba(248,140,0,0.30)" : "rgba(63,185,80,0.22)"}`,
            color:
              errorCount > 0
                ? "var(--color-warning, #f8a000)"
                : "var(--color-success)",
          }}
        >
          {savedCount > 0 && (
            <p>
              {savedCount === 1
                ? `1 key guardada: ${result.saved[0]}`
                : `${savedCount} keys guardadas: ${result.saved.join(", ")}`}
            </p>
          )}
          {errorCount > 0 && (
            <p className="mt-1">
              Errores:{" "}
              {Object.entries(result.errors)
                .map(([k, v]) => `${k} — ${v}`)
                .join("; ")}
            </p>
          )}
          {savedCount > 0 && errorCount === 0 && (
            <p className="mt-1 text-[11px] opacity-80">
              Listo — activas al instante. El proxy free-tier las usará al
              activarlo en AI Router → Proxy.
            </p>
          )}
        </div>
      )}

      {/* Alternative note */}
      <div
        className="mt-6 border-t pt-4"
        style={{ borderColor: "var(--color-border)" }}
      >
        <p
          className="text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Alternativa: ejecuta{" "}
          <code
            className="rounded px-1 py-px"
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border)",
              fontSize: 11,
            }}
          >
            ~/.maria/batches/set-api-keys.ps1
          </code>{" "}
          desde la pestaña Projects &rsaquo; Run batch.
        </p>
      </div>

      {/* GitHub token subsection */}
      <GithubTokenCard />
    </div>
  );
}
