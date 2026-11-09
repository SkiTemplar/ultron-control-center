// ULTRON Control Center — AI Router: historial de delegaciones (ledger §2)
// con resumen por motor: intentos, % de éxito, saltados y coste.

import type { LedgerEntry } from "./delegationTypes";
import { TIER_LABELS, type DelegationTier } from "./delegationTypes";
import {
  buildLedgerRows,
  formatDuration,
  formatUsd,
  summarizeLedger,
  type LedgerRow,
} from "./delegationHistory";
import { Banner, DelegationCard, Pill, SmallButton } from "./DelegationUi";

interface DelegationLedgerProps {
  entries: LedgerEntry[] | null;
  loading: boolean;
  error: string | null;
  limit: number;
  onRefresh: () => void;
}

const TH = "px-2 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-wide";
const TD = "px-2 py-1.5";

const FINAL_LABELS: Record<string, string> = { merged: "fusionada", discarded: "descartada" };

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
}

function tierLabel(tier: string): string {
  return TIER_LABELS[tier as DelegationTier] ?? tier;
}

function outcomeCell(row: LedgerRow) {
  if (row.outcome === "skipped") {
    return <Pill ok={null}>saltado{row.skipReason ? ` · ${row.skipReason}` : ""}</Pill>;
  }
  // `isolation-suspect` no es un fallo: acompaña a un verde que conviene revisar.
  const why = row.reason && row.reason !== "isolation-suspect" ? ` · ${row.reason}` : "";
  return (
    <>
      <Pill ok={row.outcome === "ok"}>
        {row.outcome}
        {why}
      </Pill>
      {row.isolationSuspect > 0 && (
        <span
          className="ml-1.5 text-[11px]"
          style={{ color: "var(--color-warn)" }}
          title="El checkout principal cambió durante el intento y no se puede atribuir al motor: revisa el resumen antes de fusionar."
        >
          sospecha de aislamiento ({row.isolationSuspect})
        </span>
      )}
    </>
  );
}

export function DelegationLedger({ entries, loading, error, limit, onRefresh }: DelegationLedgerProps) {
  const rows = entries ? buildLedgerRows(entries) : [];
  const summary = entries ? summarizeLedger(entries) : [];

  return (
    <DelegationCard
      title="Historial"
      hint={`Últimas ${limit} líneas de cockpit/delegations.jsonl: un intento por fila, con el desenlace de su delegación.`}
      actions={
        <SmallButton onClick={onRefresh} disabled={loading}>
          {loading ? "Cargando…" : "Refrescar"}
        </SmallButton>
      }
    >
      {error && <Banner kind="error" messages={[`No se pudo leer el historial: ${error}`]} />}
      {entries && rows.length === 0 && (
        <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
          Todavía no hay delegaciones registradas.
        </p>
      )}

      {summary.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {summary.map((s) => (
            <div
              key={s.engine}
              className="rounded px-2.5 py-1.5 text-[11.5px]"
              style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
            >
              <span className="font-semibold" style={{ fontFamily: "var(--font-mono)" }}>
                {s.engine}
              </span>
              <span className="ml-2" style={{ color: "var(--color-text-secondary)" }}>
                {s.attempts} intentos · {s.successPct === null ? "—" : `${s.successPct} % éxito`}
                {s.skipped > 0 ? ` · ${s.skipped} saltados` : ""}
                {s.costUsd !== null ? ` · ${formatUsd(s.costUsd)}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead style={{ color: "var(--color-text-tertiary)" }}>
              <tr>
                <th className={TH}>Fecha</th>
                <th className={TH}>Título</th>
                <th className={TH}>Nivel</th>
                <th className={TH}>Motor</th>
                <th className={TH}>Resultado</th>
                <th className={TH}>Duración</th>
                <th className={TH}>Coste</th>
                <th className={TH}>Desenlace</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} style={{ borderTop: "1px solid var(--color-border)" }}>
                  <td className={`${TD} whitespace-nowrap tabular-nums`} style={{ color: "var(--color-text-secondary)" }}>
                    {formatTs(r.ts)}
                  </td>
                  <td className={`${TD} max-w-[280px] truncate`} title={r.title}>
                    {r.title}
                  </td>
                  <td className={TD}>{tierLabel(r.tier)}</td>
                  <td className={TD} style={{ fontFamily: "var(--font-mono)" }} title={r.model}>
                    {r.engine}
                  </td>
                  <td className={TD}>{outcomeCell(r)}</td>
                  <td className={`${TD} tabular-nums`}>{formatDuration(r.durationS)}</td>
                  <td className={`${TD} tabular-nums`}>{formatUsd(r.costUsd)}</td>
                  <td className={TD}>
                    {r.final ? (
                      <Pill ok={r.final === "merged"}>{FINAL_LABELS[r.final] ?? r.final}</Pill>
                    ) : (
                      <span style={{ color: "var(--color-text-tertiary)" }}>pendiente</span>
                    )}
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
