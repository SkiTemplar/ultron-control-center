// ULTRON Control Center — Settings > API Keys
//
// Collapsible groups (contrato plans/2026-10-26, §5):
//   Suscripciones (CLI) — Codex, Antigravity, claude -p: sin key, solo estado.
//   De pago / Gratuitas — `set_env_vars_keys` (setx, User scope) + «Probar».
//   Investigación       — buscador de papers del TFG.
//   Personalizadas      — ULTRON_KEY_<SLUG> + ai_router_upsert_custom_provider.
// Más el token de GitHub — persisted via `set_github_token` (~/.ultron/.env).
//
// SECURITY: values are masked by default. Never logged or serialised outside
// the invoke call to the backend.
//
// Composicion fina: datos en api-keys/key-catalog.ts, validacion en
// api-keys/validation.ts, estado + invoke en api-keys/useApiKeys.ts, y un
// componente por pieza visual bajo api-keys/.

import { useState } from "react";
import { CustomProvidersGroup } from "./api-keys/CustomProvidersGroup";
import { GithubTokenCard } from "./api-keys/GithubTokenCard";
import { KeyGroupSection } from "./api-keys/KeyGroupSection";
import { keysOfGroup, RESEARCH_KEYS, SUBSCRIPTION_CLIS } from "./api-keys/key-catalog";
import { ProviderKeysGroup } from "./api-keys/ProviderKeysGroup";
import { ResearchKeysGroup } from "./api-keys/ResearchKeysGroup";
import { SubscriptionClisGroup } from "./api-keys/SubscriptionClisGroup";
import type { EnvKeyStatus, ProviderKeyDef } from "./api-keys/types";
import { useApiKeys } from "./api-keys/useApiKeys";
import { useCustomProviders } from "./api-keys/useCustomProviders";
import { useModelProbe } from "./api-keys/useModelProbe";

const PAID_KEYS = keysOfGroup("paid");
const FREE_KEYS = keysOfGroup("free");

function configuredSummary(defs: ProviderKeyDef[], statuses: Record<string, EnvKeyStatus>): string {
  const n = defs.filter((d) => statuses[d.envVar]?.configured).length;
  return `${n}/${defs.length} configuradas`;
}

export function ApiKeysSection() {
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
    handleRemove,
    handleSave,
    handleValidate,
  } = useApiKeys();
  const { probes, probeByEnv, probeById } = useModelProbe();
  const custom = useCustomProviders();
  const [subscriptionsOpened, setSubscriptionsOpened] = useState(false);
  const keyGroupProps = {
    fields,
    statuses,
    probes,
    onChange: handleChange,
    onToggleVisible: toggleVisible,
    onRemove: (envVar: string) => void handleRemove(envVar),
    onProbe: (envVar: string, configured: boolean | undefined) => void probeByEnv(envVar, configured),
  };

  return (
    <div>
      {/* Section header */}
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold">Claves API</h2>
        <p
          className="mt-1 text-[12.5px] leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Las claves se guardan como variables de entorno de usuario de Windows vía{" "}
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

      <KeyGroupSection
        title="Suscripciones (CLI)"
        summary={`${SUBSCRIPTION_CLIS.length} motores`}
        description="Motores que usan la sesión de su CLI y no una key. Solo informativo: el estado sale de delegate.mjs status."
        onToggle={(open) => open && setSubscriptionsOpened(true)}
      >
        <SubscriptionClisGroup active={subscriptionsOpened} />
      </KeyGroupSection>

      <KeyGroupSection
        title="De pago"
        summary={configuredSummary(PAID_KEYS, statuses)}
        description="Proveedores con crédito o método de pago por delante. «Probar» pide la lista de modelos con la key guardada."
      >
        <ProviderKeysGroup defs={PAID_KEYS} {...keyGroupProps} />
      </KeyGroupSection>

      <KeyGroupSection
        title="Gratuitas o con capa gratuita"
        summary={configuredSummary(FREE_KEYS, statuses)}
        description="Proveedores con plan gratuito o capa gratuita con límites. Las nuevas solo se usan si las pones en la cadena de delegación o en una zona."
      >
        <ProviderKeysGroup defs={FREE_KEYS} {...keyGroupProps} />
      </KeyGroupSection>

      <KeyGroupSection
        title="Investigación"
        summary={configuredSummary(RESEARCH_KEYS, statuses)}
        description={
          <>
            Claves y emails de contacto que usa el buscador de papers del TFG (
            <code style={{ fontFamily: "var(--font-mono)" }}>hooks/scripts/lib/research/</code>
            ). Los dos emails no son secretos: se guardan y se muestran completos.
          </>
        }
      >
        <ResearchKeysGroup
          fields={fields}
          statuses={statuses}
          onChange={handleChange}
          onToggleVisible={toggleVisible}
          onRemove={(envVar) => void handleRemove(envVar)}
        />
      </KeyGroupSection>

      <KeyGroupSection
        title="Personalizadas"
        summary={`${custom.customs.length} proveedores`}
        description="Cualquier API OpenAI-compatible, Anthropic o Gemini. La key va a la variable de usuario ULTRON_KEY_<ID>; se guarda al añadir el proveedor, no con «Guardar todas»."
      >
        <CustomProvidersGroup custom={custom} probes={probes} onProbe={(id) => void probeById(id)} />
      </KeyGroupSection>

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
          {saving ? "Guardando…" : "Guardar todas"}
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
          title="Comprueba cada proveedor del router: clave presente o CLI instalada"
        >
          {validating ? "Validando…" : "Validar claves del router"}
        </button>
        <span
          className="text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
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
            Proveedores del router ({validations.filter((v) => v.has_key).length}/
            {validations.length} OK)
          </p>
          <ul className="flex flex-col gap-1">
            {validations.map((v) => (
              <li key={v.provider_id} className="flex items-center gap-2 text-[12px]">
                <span style={{ color: v.has_key ? "var(--color-success)" : "var(--color-danger)" }}>
                  {v.has_key ? "●" : "○"}
                </span>
                <span style={{ fontFamily: "var(--font-mono)" }}>{v.provider_id}</span>
                <span className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
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
                ? `1 clave guardada: ${result.saved[0]}`
                : `${savedCount} claves guardadas: ${result.saved.join(", ")}`}
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
            ~/.ultron/batches/set-api-keys.ps1
          </code>{" "}
          desde la pestaña Projects &rsaquo; Run batch.
        </p>
      </div>

      {/* GitHub token subsection */}
      <GithubTokenCard />
    </div>
  );
}
