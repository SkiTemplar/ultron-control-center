// Mascota — tarjetas «¿Le dejo?» del bocadillo.
//
// Tres orígenes, una sola lista:
//   * el freno del chat de Pupus y los permisos de Claude Code en terminal
//     llegan por los eventos `mascot:approve` / `mascot:approve-expired`
//     (approve.rs, permission.rs);
//   * los permisos de ULTRON Sessions se sondean cada 2,5 s en
//     `sesiones_pending_asks` (sessionAsks.ts). Una pregunta contestada en la
//     ventana de Sessions desaparece en la vuelta siguiente.

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Approval, ApprovalDecision } from "./bubble";
import { answerCommand, isSessionApproval, mergeSessionAsks, toApproval, type AskPayload, type AskSession } from "./sessionAsks";
import { SESSIONS_POLL_MS } from "./useSessionsWatch";

export interface Approvals {
  approvals: Approval[];
  /** Para el bucle de fotogramas (¿está preguntando?). */
  approvalsRef: MutableRefObject<Approval[]>;
  /** Quita la tarjeta y devuelve el comando que lleva la respuesta a su origen. */
  take: (a: Approval, decision: ApprovalDecision) => { cmd: string; args: Record<string, unknown> };
}

export function useApprovals(ready: boolean): Approvals {
  const approvalsRef = useRef<Approval[]>([]);
  const [approvals, setState] = useState<Approval[]>([]);
  // Contestadas desde Pupus que el broker de Sessions aún lista.
  const answeredRef = useRef(new Set<string>());

  const set = useCallback((next: Approval[]) => {
    approvalsRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    const unlisten: UnlistenFn[] = [];
    void listen<Approval>("mascot:approve", (e) => set([...approvalsRef.current, e.payload])).then((u) => unlisten.push(u));
    void listen<{ id: string }>("mascot:approve-expired", (e) => {
      set(approvalsRef.current.filter((a) => a.id !== e.payload.id));
    }).then((u) => unlisten.push(u));
    return () => unlisten.forEach((u) => u());
  }, [set]);

  useEffect(() => {
    if (!ready) return;
    let busy = false;
    const poll = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const [asks, sessions] = await Promise.all([
          invoke<AskPayload[]>("sesiones_pending_asks", { id: null }),
          invoke<AskSession[]>("sesiones_list"),
        ]);
        const pending = asks.map((p) => toApproval(p, sessions)).filter((a): a is Approval => a !== null);
        // Lo contestado que el broker ya no lista se olvida.
        const live = new Set(pending.map((a) => a.id));
        answeredRef.current = new Set([...answeredRef.current].filter((id) => live.has(id)));
        const next = mergeSessionAsks(approvalsRef.current, pending, answeredRef.current);
        if (next !== approvalsRef.current) set(next);
      } catch {
        /* Sessions no responde este ciclo: se reintenta en el siguiente */
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, SESSIONS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [ready, set]);

  const take = useCallback(
    (a: Approval, decision: ApprovalDecision) => {
      set(approvalsRef.current.filter((x) => x.id !== a.id));
      if (isSessionApproval(a)) answeredRef.current.add(a.id);
      return answerCommand(a, decision);
    },
    [set],
  );

  return { approvals, approvalsRef, take };
}
