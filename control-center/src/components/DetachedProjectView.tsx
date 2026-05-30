// ULTRON Control Center — Ventana detached de un proyecto.
//
// Renderizado por main.tsx cuando la URL es /detached/project?id=...
// Muestra solo el workspace del proyecto (sin sidebar ni chrome de la app
// principal). Requiere su propio ProjectsTabsProvider porque ProjectWorkspace
// consume useProjectsTabs() internamente.

import { useEffect } from "react";
import { ProjectsTabsProvider, useProjectsTabs } from "../state/ProjectsTabsContext";
import ProjectWorkspace from "./projects/ProjectWorkspace";
import "@fontsource-variable/inter";
import "../styles.css";

interface DetachedProjectViewProps {
  projectId: string;
}

export function DetachedProjectView({ projectId }: DetachedProjectViewProps) {
  return (
    <ProjectsTabsProvider>
      <DetachedProjectViewInner projectId={projectId} />
    </ProjectsTabsProvider>
  );
}

// Inner component — rendered inside the provider so hooks are available.
function DetachedProjectViewInner({ projectId }: DetachedProjectViewProps) {
  const { open } = useProjectsTabs();

  // Abrir el tab del proyecto al montar para que ProjectWorkspace lo encuentre
  // en el estado del contexto (el provider arranca con solo "home").
  useEffect(() => {
    open({ id: projectId, title: projectId });
  // Solo al montar — projectId es estático en una ventana detached.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100vw",
        background: "var(--color-bg)",
        color: "var(--color-text)",
        overflow: "hidden",
      }}
    >
      <ProjectWorkspace key={projectId} projectId={projectId} />
    </div>
  );
}
