import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DetachedProjectView } from "./components/DetachedProjectView";
import { InboxModal } from "./components/InboxModal";
import "@fontsource-variable/inter";
import "./styles.css";

// ---------------------------------------------------------------------------
// Router mínimo — sin dependencia de react-router.
// El backend (detach.rs) construye la URL como:
//   /detached/project?id=<urlencoded_project_id>
// Si la URL coincide renderizamos la vista enfocada del proyecto.
// En cualquier otro caso renderizamos la App completa (ventana principal).
// ---------------------------------------------------------------------------

function resolveRoot(): React.ReactNode {
  const { pathname, search } = window.location;

  if (pathname === "/detached/project") {
    const params = new URLSearchParams(search);
    const projectId = params.get("id");
    if (projectId) {
      return <DetachedProjectView projectId={projectId} />;
    }
    // id ausente o vacío — caer en la app principal para no dejar pantalla en blanco.
  }

  return (
    <>
      <App />
      <InboxModal />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{resolveRoot()}</React.StrictMode>,
);
