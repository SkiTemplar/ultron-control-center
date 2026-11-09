// Mascota — eventos del MCP de escritorio (bridge.rs → «mascot:drive»).
//
//   * start / act: Pupus lleva el cursor; Rust ya ha puesto la ventana
//     atravesable, así que la webview lo apunta para no desincronizarse.
//   * end: suelta el cursor y cae; durante un momento el hover de ese
//     cursor (que no es tuyo) no cuenta (driveHover.ts).
//   * mascot:passthrough: acción del MCP sin animación; la ventana también
//     se ha vuelto atravesable.

import { useEffect, useRef, type MutableRefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import type { MascotEngine } from "./engine";
import { DriveHoverGuard } from "./driveHover";

type DrivePayload = { phase: "start" } | { phase: "act"; kind: string; x: number; y: number } | { phase: "end" };

const I32_MIN = -2147483648;

interface DriveDeps {
  engineRef: MutableRefObject<MascotEngine | null>;
  /** true mientras el MCP conduce. */
  driveRef: MutableRefObject<boolean>;
  /** Estado de la ventana tal como lo cree la webview. */
  interactiveRef: MutableRefObject<boolean>;
  /** Último cursor conocido (px CSS). */
  cursorRef: MutableRefObject<{ x: number; y: number } | null>;
  /** Cancela una pulsación a medias sobre Pupus. */
  cancelPress: () => void;
  toCss: (px: number, py: number) => { x: number; y: number };
}

function handleDrive(p: DrivePayload, eng: MascotEngine, deps: DriveDeps, guard: DriveHoverGuard) {
  if (p.phase === "end") {
    deps.driveRef.current = false;
    guard.ended(performance.now(), deps.cursorRef.current);
    eng.driveEnd();
    return;
  }
  deps.driveRef.current = true;
  deps.interactiveRef.current = false;
  guard.started();
  if (p.phase === "start") {
    deps.cancelPress();
    eng.driveStart();
    return;
  }
  const at = p.x === I32_MIN ? null : deps.toCss(p.x, p.y);
  eng.driveAction(p.kind, at);
}

/** Escucha la conducción del MCP. Devuelve el filtro de hover. */
export function useMcpDrive(deps: DriveDeps): MutableRefObject<DriveHoverGuard> {
  const guardRef = useRef(new DriveHoverGuard());
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const unlisten: (() => void)[] = [];
    let alive = true;
    const keep = (u: () => void) => (alive ? unlisten.push(u) : u());
    void listen<DrivePayload>("mascot:drive", (e) => {
      const eng = depsRef.current.engineRef.current;
      if (eng) handleDrive(e.payload, eng, depsRef.current, guardRef.current);
    }).then(keep);
    void listen("mascot:passthrough", () => {
      depsRef.current.interactiveRef.current = false;
    }).then(keep);
    return () => {
      alive = false;
      unlisten.forEach((u) => u());
    };
  }, []);

  return guardRef;
}
