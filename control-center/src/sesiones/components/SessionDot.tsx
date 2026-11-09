// Punto de estado de una sesión (pestañas y barra superior): distingue el
// hilo principal libre con subagentes o workflows vivos de una sesión acabada.

import { displayStatus, useBackgroundWork } from "../background";
import type { SessionInfo } from "../types";

export function SessionDot({ session }: { session: Pick<SessionInfo, "id" | "status"> }) {
  const status = displayStatus(session.status, useBackgroundWork(session.id));
  return <span className={`dot ${status}`} />;
}
