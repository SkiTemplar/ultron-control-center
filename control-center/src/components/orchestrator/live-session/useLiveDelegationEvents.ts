// ULTRON Control Center — hook de eventos en vivo de delegación de agentes.
// Escucha workflow:delegating/delegated (eventos ligeros del backend) y
// mantiene una lista acotada (MAX_LIVE_EVENTS) con prepend, más reciente primero.

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { MAX_LIVE_EVENTS, type DelegatedPayload, type DelegatingPayload, type LiveEvent } from "./types";

export function useLiveDelegationEvents(): LiveEvent[] {
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const seqRef = useRef(0);

  useEffect(() => {
    const unlisten: Array<() => void> = [];
    let active = true;

    const pushEvent = (ev: Omit<LiveEvent, "seq">) => {
      const withSeq: LiveEvent = { ...ev, seq: seqRef.current++ };
      setLiveEvents((prev) => [withSeq, ...prev].slice(0, MAX_LIVE_EVENTS));
    };

    void (async () => {
      const u1 = await listen<DelegatingPayload>("workflow:delegating", (e) => {
        pushEvent({
          agent: e.payload.agent,
          status: "delegating",
          preview: e.payload.task_preview ?? "",
          provider: e.payload.provider,
          at: e.payload.started_at ?? new Date().toISOString(),
        });
      });
      const u2 = await listen<DelegatedPayload>("workflow:delegated", (e) => {
        pushEvent({
          agent: e.payload.agent,
          status: e.payload.status ?? "done",
          preview: e.payload.task_preview ?? "",
          at: new Date().toISOString(),
        });
      });
      if (active) {
        unlisten.push(u1, u2);
      } else {
        u1();
        u2();
      }
    })();

    return () => {
      active = false;
      for (const u of unlisten) u();
    };
  }, []);

  return liveEvents;
}
