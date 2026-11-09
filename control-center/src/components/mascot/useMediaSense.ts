// Mascota — ¿suena música? (media.rs) para que Pupus baile.
//
// Pregunta cada pocos segundos, y solo con los ajustes «Actividades» y
// «Bailar cuando suena música» encendidos y fuera del silencio de juego.
// Un error (binario sin el comando, WinRT caído) cuenta como «sin música»:
// mejor no bailar que bailar en silencio.

import { useEffect, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MascotEngine } from "./engine";
import type { MascotSettings } from "./settings";

const MEDIA_MS = 4000;

/** ¿Se pregunta por la música con estos ajustes? */
export function wantsMusic(s: MascotSettings, quiet: boolean): boolean {
  return s.activities && s.music_dance && !quiet;
}

export function useMediaSense(
  ready: boolean,
  engineRef: MutableRefObject<MascotEngine | null>,
  settingsRef: MutableRefObject<MascotSettings>,
  quietRef: MutableRefObject<boolean>,
) {
  useEffect(() => {
    if (!ready) return;
    let busy = false;
    const tick = async () => {
      const eng = engineRef.current;
      if (!eng || busy) return;
      if (!wantsMusic(settingsRef.current, quietRef.current)) {
        eng.acts.music = false;
        return;
      }
      busy = true;
      try {
        const m = await invoke<{ music: boolean }>("mascot_media");
        eng.acts.music = !!m?.music;
      } catch {
        eng.acts.music = false;
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => void tick(), MEDIA_MS);
    void tick();
    return () => window.clearInterval(timer);
  }, [ready, engineRef, settingsRef, quietRef]);
}
