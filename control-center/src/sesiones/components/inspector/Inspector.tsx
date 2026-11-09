// Inspector derecho con pestañas (E10): Agentes, Git, Contexto, Uso, Adjuntos,
// Bitácora y Motores, en una o dos filas. ←/→ cambian de pestaña. Kanban, Mods y Hooks se
// retiraron el 2026-10-14: duplicaban el Control Center.

import { useEffect } from "react";
import { useFocused } from "../../hooks/useFocused";
import { setUi, useUi, type InspectorTab } from "../../ui";
import { ErrorBoundary } from "../ErrorBoundary";
import { Adjuntos } from "./Adjuntos";
import { Agentes } from "./Agentes";
import { Bitacora } from "./Bitacora";
import { Contexto } from "./Contexto";
import { Git } from "./Git";
import { Motores } from "./Motores";
import { Uso } from "./Uso";

const TABS: { id: InspectorTab; label: string }[] = [
  { id: "agentes", label: "Agentes" },
  { id: "git", label: "Git" },
  { id: "contexto", label: "Contexto" },
  { id: "uso", label: "Uso" },
  { id: "adjuntos", label: "Adjuntos" },
  { id: "bitacora", label: "Bitácora" },
  { id: "motores", label: "Motores" },
];

/** Peticiones de otros paquetes (paneles `git`, `agentes`, `uso` y `engines`). */
function useInspectorRequests(): void {
  const tabRequest = useUi((s) => s.inspectorTabRequest);
  const engineRequest = useUi((s) => s.engineTaskRequest);
  useEffect(() => {
    if (tabRequest) setUi((s) => ({ ...s, inspectorTab: tabRequest.tab }));
  }, [tabRequest]);
  useEffect(() => {
    if (engineRequest) setUi((s) => ({ ...s, inspectorTab: "motores", engineFocusTick: s.engineFocusTick + 1 }));
  }, [engineRequest]);
}

export function Inspector() {
  const tab = useUi((s) => s.inspectorTab);
  const { session, pane } = useFocused();
  useInspectorRequests();

  function onKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    setUi((s) => ({ ...s, inspectorTab: next.id }));
    window.requestAnimationFrame(() => document.getElementById(`itab-${next.id}`)?.focus());
  }

  return (
    <aside className="insp" aria-label="Inspector">
      <div className="itabs" role="tablist" aria-label="Inspector" onKeyDown={onKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`itab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="ipanel"
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setUi((s) => ({ ...s, inspectorTab: t.id }))}
          >
            {t.label}
          </button>
        ))}
      </div>
      <section className="ipane" id="ipanel" role="tabpanel" aria-labelledby={`itab-${tab}`}>
        <ErrorBoundary scope="esta pestaña" resetKey={`${tab}:${session?.id ?? ""}`}>
          {tab === "agentes" && <Agentes session={session} currentAgent={pane?.agentId ?? null} />}
          {/* La clave descarta el mensaje de commit y el resultado al cambiar de repositorio. */}
          {tab === "git" && <Git key={session?.cwd ?? ""} cwd={session?.cwd ?? null} />}
          {tab === "contexto" && <Contexto sessionId={session?.id ?? null} />}
          {tab === "uso" && <Uso sessionId={session?.id ?? null} />}
          {tab === "adjuntos" && <Adjuntos sessionId={session?.id ?? null} cwd={session?.cwd} />}
          {tab === "motores" && <Motores session={session} />}
          {tab === "bitacora" && <Bitacora session={session} />}
        </ErrorBoundary>
      </section>
    </aside>
  );
}

export function NoSession() {
  return <p className="note">Sin sesión.</p>;
}
