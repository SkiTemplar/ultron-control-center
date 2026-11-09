// ULTRON Control Center — AI Router: estado de cada motor de delegación
// según `node scripts/delegate.mjs status --json` (contrato §3).

import type { DelegationStatus, EngineStatus } from "./delegationTypes";
import { Banner, DelegationCard, Pill, SmallButton } from "./DelegationUi";

interface DelegationStatusTableProps {
  status: DelegationStatus | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

function quotaText(engine: EngineStatus): string {
  const parts: string[] = [];
  if (engine.quota) parts.push(`${Math.round(engine.quota.usedPct)} % usado (${engine.quota.window})`);
  if (engine.balance) {
    const b = engine.balance;
    parts.push(`saldo ${b.total} ${b.currency}${b.available ? "" : " · no disponible"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function keyPill(engine: EngineStatus) {
  if (engine.keyPresent === null) return <Pill ok={null}>no usa</Pill>;
  return <Pill ok={engine.keyPresent}>{engine.keyPresent ? "presente" : "falta"}</Pill>;
}

const TH = "px-2 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-wide";

export function DelegationStatusTable({ status, loading, error, onRefresh }: DelegationStatusTableProps) {
  return (
    <DelegationCard
      title="Estado de los motores"
      hint="Instalación, key, cuota o saldo y disponibilidad real, de la misma fuente que consulta Opus antes de delegar."
      actions={
        <SmallButton onClick={onRefresh} disabled={loading} title="Vuelve a lanzar delegate.mjs status --json">
          {loading ? "Comprobando…" : "Refrescar"}
        </SmallButton>
      }
    >
      {error && <Banner kind="error" messages={[`No se pudo leer el estado: ${error}`]} />}
      {status?.configSource === "default" && (
        <Banner
          kind="warn"
          messages={[
            "cockpit/ai-router/delegation.json falta o no parsea: delegate.mjs está usando la configuración por defecto.",
          ]}
        />
      )}
      {!status && !error && (
        <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          {loading ? "Comprobando motores…" : "Sin datos todavía."}
        </p>
      )}
      {status && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead style={{ color: "var(--color-text-tertiary)" }}>
              <tr>
                <th className={TH}>Motor</th>
                <th className={TH}>Runner · modelo</th>
                <th className={TH}>Instalado</th>
                <th className={TH}>Key</th>
                <th className={TH}>Cuota o saldo</th>
                <th className={TH}>Disponible</th>
                <th className={TH}>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {status.engines.map((e) => (
                <tr key={e.id} style={{ borderTop: "1px solid var(--color-border)", opacity: e.enabled ? 1 : 0.65 }}>
                  <td className="px-2 py-1.5 font-medium" style={{ fontFamily: "var(--font-mono)" }}>
                    {e.id}
                    {!e.enabled && (
                      <span className="ml-1 text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                        (desactivado)
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5" style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>
                    {e.runner} · {e.model}
                  </td>
                  <td className="px-2 py-1.5">
                    <Pill ok={e.installed}>{e.installed ? "sí" : "no"}</Pill>
                  </td>
                  <td className="px-2 py-1.5">{keyPill(e)}</td>
                  <td className="px-2 py-1.5" style={{ color: "var(--color-text-secondary)" }}>
                    {quotaText(e)}
                  </td>
                  <td className="px-2 py-1.5">
                    <Pill ok={e.available}>{e.available ? "sí" : "no"}</Pill>
                  </td>
                  <td className="px-2 py-1.5" style={{ color: "var(--color-text-tertiary)" }}>
                    {e.reason ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DelegationCard>
  );
}
