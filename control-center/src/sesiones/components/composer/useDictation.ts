// Dictado por voz del composer de Sessions: el núcleo (`useDictationCore`)
// con la transcripción de la API de Sessions (`sesiones_transcribe`, Whisper).
// Comportamiento (pausas, parar/seguir, reentrada, autoapagado y errores de
// micro) documentado en useDictationCore.ts.

import { useCallback, useEffect } from "react";
import { useApi } from "../../context";
import { requestDictationToggle } from "../../ui";
import { useDictationCore, type DictationControls } from "./useDictationCore";

export type { DictationStatus } from "./useDictationCore";

export function useDictation(onText: (text: string) => void, onError: (message: string) => void): DictationControls {
  const api = useApi();
  const transcribe = useCallback((audioB64: string, mime: string) => api.transcribe(audioB64, mime), [api]);
  return useDictationCore(transcribe, onText, onError);
}

/** Atajo de ventana Ctrl+Espacio: alterna el dictado del composer con foco. */
export function useDictationShortcut(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // El composer ya lo atiende en su textarea y llama a preventDefault.
      if (e.defaultPrevented || !e.ctrlKey || e.altKey || e.metaKey || e.code !== "Space") return;
      e.preventDefault();
      requestDictationToggle();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
