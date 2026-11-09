// Arrastrar y soltar ficheros en cualquier parte de la ventana de Sessions
// (R23, motores-ventanas:F3). Un arrastre con ficheros se intercepta en toda
// la ventana (WebView2 navegaría al fichero si nadie hace `preventDefault`),
// se pinta una superposición y, al soltar, los ficheros van al composer de la
// sesión del panel sobre el que se suelta (o del panel con foco) por
// `ui.requestAttach`. Si una zona propia (el composer) ya atendió el `drop`,
// no se repite. Un arrastre sin ficheros (texto, pestañas) no se toca.

import { useEffect, useState } from "react";
import type { SessionId } from "./types";

/** ¿El arrastre lleva ficheros? */
export function hasFiles(dt: Pick<DataTransfer, "types"> | null | undefined): boolean {
  return Boolean(dt && Array.from(dt.types ?? []).includes("Files"));
}

/** Índice del panel (`data-pane-index`) que contiene el destino del evento. */
export function paneIndexOf(target: EventTarget | null): number | null {
  const el = target instanceof Element ? target.closest("[data-pane-index]") : null;
  const raw = el?.getAttribute("data-pane-index");
  return raw == null ? null : Number(raw);
}

export interface FileDropOptions {
  /** Sesión destino para un panel (o la del panel con foco si `null`). */
  sessionFor: (paneIndex: number | null) => SessionId | null;
  onFiles: (sessionId: SessionId, files: File[]) => void;
  onNoSession: () => void;
  onActive: (active: boolean) => void;
}

/** Instala los escuchadores en `win`; devuelve la función que los quita. */
export function attachWindowFileDrop(win: Window, opts: FileDropOptions): () => void {
  let depth = 0;
  const setDepth = (n: number) => {
    const was = depth > 0;
    depth = Math.max(0, n);
    if (was !== depth > 0) opts.onActive(depth > 0);
  };
  const onEnter = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDepth(depth + 1);
  };
  const onOver = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };
  const onLeave = (e: DragEvent) => {
    if (hasFiles(e.dataTransfer)) setDepth(depth - 1);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    const handled = e.defaultPrevented;
    e.preventDefault();
    setDepth(0);
    if (handled) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const sessionId = opts.sessionFor(paneIndexOf(e.target));
    if (sessionId) opts.onFiles(sessionId, files);
    else opts.onNoSession();
  };
  win.addEventListener("dragenter", onEnter);
  win.addEventListener("dragover", onOver);
  win.addEventListener("dragleave", onLeave);
  win.addEventListener("drop", onDrop);
  return () => {
    win.removeEventListener("dragenter", onEnter);
    win.removeEventListener("dragover", onOver);
    win.removeEventListener("dragleave", onLeave);
    win.removeEventListener("drop", onDrop);
  };
}

/** Hook de `App.tsx`: devuelve si hay un arrastre de ficheros en curso. */
export function useWindowFileDrop(opts: Omit<FileDropOptions, "onActive">): boolean {
  const [active, setActive] = useState(false);
  const { sessionFor, onFiles, onNoSession } = opts;
  useEffect(
    () => attachWindowFileDrop(window, { sessionFor, onFiles, onNoSession, onActive: setActive }),
    [sessionFor, onFiles, onNoSession],
  );
  return active;
}
