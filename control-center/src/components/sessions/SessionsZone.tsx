// ULTRON Control Center — Zona Sesiones.
//
// Envuelve las dos vistas de sesiones bajo la pestaña "Sessions" sin tocar el
// componente de lanzamiento existente:
//   - "Monitor" (por defecto): gestor multi-sesión en vivo (SessionsPane) que
//     lee TODAS las sesiones de Claude Code en disco (estado/modelo/context%).
//   - "Lanzar": el gestor de spawn/workspaces existente (Sessions).
//
// Read-only en Monitor: solo VER. La acción "Abrir en Projects" se delega a la
// prop onOpenProject (cableada en App.tsx a la navegación de Projects).

import { useState } from "react";
import { SessionsPane } from "./SessionsPane";
import { Sessions } from "../Sessions";

type SubView = "monitor" | "launcher";

const SUBVIEWS: ReadonlyArray<readonly [SubView, string]> = [
  ["monitor", "Monitor"],
  ["launcher", "Lanzar"],
];

export function SessionsZone({
  onOpenProject,
}: {
  onOpenProject?: (projectId: string) => void;
}) {
  const [view, setView] = useState<SubView>("monitor");

  return (
    <div className="flex h-full flex-col">
      {/* Barra de sub-pestañas */}
      <div
        className="flex items-center gap-1 px-6 pt-4"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        {SUBVIEWS.map(([id, label]) => {
          const activeView = view === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className="rounded-t px-3 py-2 text-[13px] transition-colors"
              style={{
                color: activeView ? "var(--color-text)" : "var(--color-text-secondary)",
                borderBottom: activeView
                  ? "2px solid var(--color-accent, #5b6af0)"
                  : "2px solid transparent",
                fontWeight: activeView ? 600 : 400,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {view === "monitor" ? (
          <SessionsPane onOpenProject={onOpenProject} />
        ) : (
          <Sessions />
        )}
      </div>
    </div>
  );
}
