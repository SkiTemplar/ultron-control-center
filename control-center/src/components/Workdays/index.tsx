// ULTRON Control Center - Workdays tab (barrel + root container)
//
// Orquesta WorkdaysList (panel izquierdo) + WorkdayDetail (panel derecho).
// Estado local: workday seleccionado + refreshKey para forzar reload tras
// mutaciones (start/pause/complete/etc).
//
// Backend: src-tauri/src/workdays.rs + commands/workdays.rs (15 commands).

import { useState } from "react";
import { WorkdaysList } from "./WorkdaysList";
import { WorkdayDetail } from "./WorkdayDetail";
import type { Workday } from "./types";

export type {
  Workday,
  WorkdayGoal,
  WorkdayMetrics,
  WorkdayStatus,
  WorkdayTemplate,
  GoalStatus,
} from "./types";

export function Workdays() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listRefresh, setListRefresh] = useState(0);
  const [detailRefresh, setDetailRefresh] = useState(0);

  function handleCreated(wd: Workday) {
    setSelectedId(wd.id);
    setListRefresh((k) => k + 1);
  }

  function handleChanged(_wd: Workday) {
    // detail ya tiene el row actualizado; sólo refrescamos la lista para
    // reflejar status/goals.
    setListRefresh((k) => k + 1);
  }

  return (
    <div
      className="flex h-full flex-col"
      style={{ background: "var(--color-bg)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between border-b px-6 py-4"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-1)",
        }}
      >
        <div>
          <h1
            className="text-[17px] font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            Workdays
          </h1>
          <p
            className="mt-0.5 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Plan, execute and retrospect each working session
          </p>
        </div>
      </div>

      {/* Body: split list/detail */}
      <div className="flex flex-1 overflow-hidden">
        <div
          className="border-r"
          style={{ borderColor: "var(--color-border)" }}
        >
          <WorkdaysList
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setDetailRefresh((k) => k + 1);
            }}
            refreshKey={listRefresh}
            onCreated={handleCreated}
          />
        </div>
        <div className="flex-1 overflow-hidden">
          {selectedId ? (
            <WorkdayDetail
              workdayId={selectedId}
              refreshKey={detailRefresh}
              onChanged={handleChanged}
            />
          ) : (
            <div
              className="flex h-full items-center justify-center text-[13px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Select a workday or create a new one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
