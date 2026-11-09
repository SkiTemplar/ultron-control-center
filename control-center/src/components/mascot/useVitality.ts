// Mascota — la vida de Pupus fuera del motor (vitality.ts):
//
//   * guarda y recupera el ánimo y la memoria de sucesos (localStorage; solo
//     tipo de suceso y hora, nunca títulos ni rutas),
//   * cada 5 s le cuenta lo que estás haciendo: la ventana delante (la que ya
//     vigila useForeground), el tiempo sin tocar teclado ni ratón y si hay
//     una app usando el micrófono (`mascot_presence`, presence.rs).
//
// Con el ajuste «Reacciona a lo que haces» apagado no se pregunta nada a
// Rust y Pupus se queda sin contexto (solo cuenta lo que le haces tú).
// Si el binario aún no tiene `mascot_presence`, la ventana sigue contando y
// el tiempo sin tocar nada queda como desconocido (sin «te vas»/«vuelves»).

import { useEffect, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MascotEngine } from "./engine";
import { classifyForeground, type AmbientSample } from "./ambient";
import { parseMood } from "./mood";
import type { MascotSettings } from "./settings";
import type { ForegroundState } from "./useForeground";

export const MOOD_KEY = "ultron.mascot.mood";
export const VITALITY_KEY = "ultron.mascot.vitality";
const SAVE_MS = 15_000;
const AMBIENT_MS = 5_000;

interface Presence {
  idle_ms: number | null;
  mic: boolean;
}

interface Deps {
  ready: boolean;
  engineRef: MutableRefObject<MascotEngine | null>;
  fgRef: MutableRefObject<ForegroundState | null>;
  quietRef: MutableRefObject<boolean>;
  settingsRef: MutableRefObject<MascotSettings>;
}

function restore(eng: MascotEngine) {
  try {
    const mood = parseMood(window.localStorage.getItem(MOOD_KEY));
    if (mood) eng.mood = mood;
    eng.life.restore(window.localStorage.getItem(VITALITY_KEY));
  } catch {
    /* sin almacenamiento: ánimo y memoria por defecto */
  }
}

function save(eng: MascotEngine | null) {
  if (!eng) return;
  try {
    window.localStorage.setItem(MOOD_KEY, JSON.stringify(eng.mood));
    window.localStorage.setItem(VITALITY_KEY, eng.life.serialize());
  } catch {
    /* sin almacenamiento */
  }
}

/** Muestra de lo que haces; null con el ajuste apagado. */
async function sample(d: Deps): Promise<AmbientSample | null> {
  if (!d.settingsRef.current.ambient_mood) return null;
  const p = await invoke<Presence>("mascot_presence").catch(() => null);
  return { atMs: Date.now(), activity: classifyForeground(d.fgRef.current, p?.mic ?? false), idleMs: p?.idle_ms ?? null };
}

export function useVitality(d: Deps) {
  const { ready, engineRef, fgRef, quietRef, settingsRef } = d;

  useEffect(() => {
    if (!ready) return;
    const deps = { ready, engineRef, fgRef, quietRef, settingsRef };
    if (engineRef.current) restore(engineRef.current);
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const s = await sample(deps);
        const eng = engineRef.current;
        for (const k of eng?.life.setAmbient(s) ?? []) eng?.feel(k, !quietRef.current);
      } finally {
        busy = false;
      }
    };
    void tick();
    const ambientTimer = window.setInterval(() => void tick(), AMBIENT_MS);
    const saveTimer = window.setInterval(() => save(engineRef.current), SAVE_MS);
    const onUnload = () => save(engineRef.current);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.clearInterval(ambientTimer);
      window.clearInterval(saveTimer);
      window.removeEventListener("beforeunload", onUnload);
      save(engineRef.current);
    };
  }, [ready, engineRef, fgRef, quietRef, settingsRef]);
}
