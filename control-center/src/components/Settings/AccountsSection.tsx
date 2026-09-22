import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Settings > Cuentas y modelos — informe SOLO LECTURA de las CLIs de IA
// instaladas (claude, codex, antigravity): con qué cuenta ha entrado cada
// una, si es suscripción o clave de API, y qué modelos permite esa
// suscripción. No selecciona ningún modelo ni toca el routing: es puramente
// informativo, para no confundir de cuenta o gastar cuota por accidente
// (p.ej. una ANTHROPIC_API_KEY que tapa la suscripción sin avisar).

type AccessKind = "subscription" | "api_key" | "no_access";

interface AccountEntry {
  provider: string;
  label: string;
  account: string;
  account_source: string;
  access: AccessKind;
  key_tail: string;
  plan: string;
  plan_source: string;
  warnings: string[];
}

interface ModelAccess {
  provider: string;
  allowed: string[];
  denied: string[];
  default_model: string;
  source: string;
  at: string;
}

interface AccountsReport {
  accounts: AccountEntry[];
  models: ModelAccess[];
  distinct_emails: string[];
  warnings: string[];
}

const ACCESS_LABEL: Record<AccessKind, string> = {
  subscription: "Suscripción",
  api_key: "Clave de API",
  no_access: "Sin acceso",
};

const ACCESS_COLOR: Record<AccessKind, string> = {
  subscription: "var(--color-success)",
  api_key: "var(--color-warning, #d29922)",
  no_access: "var(--color-text-tertiary)",
};

function AccessBadge({ access }: { access: AccessKind }) {
  return (
    <span
      className="rounded px-1.5 py-px text-[10px] font-medium"
      style={{
        background: "var(--color-surface-1)",
        border: `1px solid ${ACCESS_COLOR[access]}`,
        color: ACCESS_COLOR[access],
      }}
    >
      {ACCESS_LABEL[access]}
    </span>
  );
}

function ModelChips({ ids }: { ids: string[] }) {
  if (ids.length === 0) {
    return (
      <span className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
        (ninguno detectado)
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <span
          key={id}
          className="rounded px-1.5 py-px text-[10.5px]"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border)",
            fontFamily: "var(--font-mono)",
            color: "var(--color-text)",
          }}
        >
          {id}
        </span>
      ))}
    </div>
  );
}

export function AccountsSection() {
  const [report, setReport] = useState<AccountsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await invoke<AccountsReport>("accounts_report");
      setReport(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefreshModels = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const r = await invoke<AccountsReport>("accounts_refresh_models");
      setReport(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const modelsFor = (provider: string): ModelAccess | undefined =>
    report?.models.find((m) => m.provider === provider);

  return (
    <div className="max-w-[720px]">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">Cuentas y modelos</h2>
          <p
            className="mt-1 text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Con qué cuenta ha entrado cada CLI de IA y qué modelos permite su
            suscripción. Solo lectura: no cambia qué modelo se usa. Nunca se
            muestra un token completo, como mucho los últimos 4 caracteres de
            una clave.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleRefreshModels()}
          disabled={refreshing || loading}
          className="shrink-0 rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {refreshing ? "Actualizando…" : "Actualizar modelos"}
        </button>
      </div>

      {error && (
        <div
          className="mb-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {loading && !report ? (
        <div
          className="rounded p-5 text-center text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          Leyendo cuentas…
        </div>
      ) : (
        <>
          {report?.warnings.map((w) => (
            <div
              key={w}
              className="mb-4 rounded p-3 text-[12px]"
              style={{
                background: "rgba(210, 153, 34, 0.08)",
                border: "1px solid rgba(210, 153, 34, 0.28)",
                color: "var(--color-warning, #d29922)",
              }}
            >
              {w}
            </div>
          ))}

          <ul className="flex flex-col gap-3">
            {report?.accounts.map((a) => {
              const models = modelsFor(a.provider);
              return (
                <li
                  key={a.provider}
                  className="rounded p-4"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold">{a.label}</span>
                    <AccessBadge access={a.access} />
                    {a.plan && (
                      <span
                        className="rounded px-1.5 py-px text-[10.5px]"
                        style={{
                          background: "var(--color-surface-1)",
                          border: "1px solid var(--color-border)",
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        {a.plan}
                      </span>
                    )}
                    <span
                      className="ml-auto text-[11.5px]"
                      style={{ fontFamily: "var(--font-mono)", color: "var(--color-text)" }}
                    >
                      {a.account || (
                        <span style={{ color: "var(--color-text-faint)" }}>
                          cuenta no expuesta por la CLI
                        </span>
                      )}
                    </span>
                    {a.key_tail && (
                      <span
                        className="text-[11px]"
                        style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-faint)" }}
                      >
                        clave …{a.key_tail.replace(/^…/, "")}
                      </span>
                    )}
                  </div>

                  {a.warnings.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1">
                      {a.warnings.map((w) => (
                        <li
                          key={w}
                          className="text-[11.5px]"
                          style={{ color: "var(--color-warning, #d29922)" }}
                        >
                          ⚠ {w}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-3">
                    <p
                      className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      Modelos permitidos
                    </p>
                    <ModelChips ids={models?.allowed ?? []} />
                    {models?.denied && models.denied.length > 0 && (
                      <>
                        <p
                          className="mb-1 mt-2 text-[10.5px] font-semibold uppercase tracking-wide"
                          style={{ color: "var(--color-text-tertiary)" }}
                        >
                          Vetados
                        </p>
                        <ModelChips ids={models.denied} />
                      </>
                    )}
                    {models?.default_model && (
                      <p className="mt-2 text-[11px]" style={{ color: "var(--color-text-secondary)" }}>
                        Modelo por defecto:{" "}
                        <span style={{ fontFamily: "var(--font-mono)" }}>{models.default_model}</span>
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
