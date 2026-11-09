// ULTRON Control Center — AI Router: sección «Delegación».
//
// Configura la cadena del delegador multi-motor (scripts/delegate.mjs):
// orden de relevo, motores activos, modelo por motor y nivel, y nivel →
// motor de entrada. Enseña además el estado de cada motor y el historial.
// Estado e invoke en useDelegation.ts; lógica pura en delegationReducer.ts y
// delegationLedger.ts (contrato plans/2026-10-26-delegador-multi-motor.md).

import { DelegationChainEditor } from "./DelegationChainEditor";
import { DelegationLedger } from "./DelegationLedger";
import { DelegationStatusTable } from "./DelegationStatusTable";
import { Banner, DelegationCard, SmallButton } from "./DelegationUi";
import { LEDGER_LIMIT, useDelegation } from "./useDelegation";

export function DelegationPanel() {
  const d = useDelegation();
  const draft = d.edit.draft;

  return (
    <div className="flex flex-col gap-4 p-6">
      {draft ? (
        <DelegationChainEditor
          draft={draft}
          dirty={d.dirty}
          saving={d.saving}
          saveFeedback={d.saveFeedback}
          dispatch={d.dispatch}
          onSave={() => void d.save()}
        />
      ) : (
        <DelegationCard
          title="Cadena de relevo"
          actions={
            <SmallButton onClick={() => void d.reloadConfig()} disabled={d.configLoading}>
              {d.configLoading ? "Cargando…" : "Reintentar"}
            </SmallButton>
          }
        >
          {d.configError ? (
            <Banner kind="error" messages={[`No se pudo leer la configuración de delegación: ${d.configError}`]} />
          ) : (
            <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              Cargando configuración…
            </p>
          )}
        </DelegationCard>
      )}
      {draft && d.configError && (
        <Banner kind="error" messages={[`Última recarga fallida: ${d.configError}`]} />
      )}

      <DelegationStatusTable
        status={d.status.data}
        loading={d.status.loading}
        error={d.status.error}
        onRefresh={() => void d.refreshStatus()}
      />

      <DelegationLedger
        entries={d.ledger.data}
        loading={d.ledger.loading}
        error={d.ledger.error}
        limit={LEDGER_LIMIT}
        onRefresh={() => void d.refreshLedger()}
      />
    </div>
  );
}
