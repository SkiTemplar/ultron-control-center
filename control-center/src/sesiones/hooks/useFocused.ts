// Sesión del panel con foco: la que gobierna barra superior e inspector.

import { useSessionInfo } from "../store";
import type { SessionInfo } from "../types";
import { useWorkspace, type Pane } from "../workspace";

export function useFocused(): { pane: Pane | null; index: number; session: SessionInfo | null } {
  const ws = useWorkspace();
  const pane = ws.panes[ws.focused] ?? null;
  const session = useSessionInfo(pane?.sessionId ?? null);
  return { pane, index: ws.focused, session };
}
