import { useState } from "react";
import { Diagnostics } from "./system/Diagnostics";
import { type SystemSubTab } from "./system/system-tab/types";
import { SystemHeader } from "./system/system-tab/SystemHeader";
import { TasksPanel } from "./system/system-tab/TasksPanel";

// Sistema: diagnóstico del equipo y tareas programadas. El inventario de
// aplicaciones instaladas y el apagado programado se retiraron en 2026-09-21:
// Windows ya hace ambas cosas y no son trabajo de un asistente.

export function System() {
  const [subTab, setSubTab] = useState<SystemSubTab>("diagnostics");

  return (
    <div className="pb-8">
      <SystemHeader subTab={subTab} setSubTab={setSubTab} />
      <div className="px-10">
        {subTab === "diagnostics" && <Diagnostics />}
        {subTab === "tasks" && <TasksPanel />}
      </div>
    </div>
  );
}
