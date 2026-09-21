// Botón de micrófono: el interruptor visible de la escucha.
//
// El usuario lo pidió el 2026-09-21: "debería existir un micrófono visible en
// la parte inferior, y el usuario debe poder activar/desactivar manualmente la
// escucha". Antes solo se podía con ctrl+espacio, a ciegas.
//
// Tres estados, que son los tres que existen de verdad:
//
//   apagado    — no se captura audio. Ni palabra clave ni nada.
//   en espera  — el micrófono está abierto SOLO para oír «María».
//   escuchando — escucha activa: lo que digas se transcribe y se envía.
//
// Un clic hace lo que toca en cada uno:
//   apagado    -> enciende la palabra clave
//   en espera  -> empieza a escuchar ya (sin decir «María»)
//   escuchando -> corta y manda lo dicho
//
// Lo que NO puede pasar (y pasaba): que el botón diga "apagado" mientras un
// hilo sigue capturando. Apagar manda `wake_off`, que además cancela la toma
// en curso en el sidecar.

import { invoke } from "@tauri-apps/api/core";
import type { ReactorState } from "./Reactor";

export type EstadoMic = "apagado" | "espera" | "escuchando";

/** Deduce el estado del botón. Pura: se testea sin React. */
export function estadoMic(micOn: boolean, voz: ReactorState): EstadoMic {
  if (!micOn) return "apagado";
  return voz === "listening" ? "escuchando" : "espera";
}

/** Qué hace un clic en cada estado. Pura. */
export function accionMic(estado: EstadoMic): "encender" | "escuchar" | "cortar" {
  switch (estado) {
    case "apagado":
      return "encender";
    case "espera":
      return "escuchar";
    case "escuchando":
      return "cortar";
  }
}

const TITULO: Record<EstadoMic, string> = {
  apagado: "micrófono apagado — clic para encenderlo",
  espera: "esperando «María» — clic para hablar ya",
  escuchando: "te escucho — clic para cortar y enviar",
};

const COLOR: Record<EstadoMic, string> = {
  apagado: "var(--color-text-tertiary)",
  espera: "var(--color-text-secondary)",
  escuchando: "var(--color-accent)",
};

export async function aplicarAccion(estado: EstadoMic): Promise<void> {
  switch (accionMic(estado)) {
    case "encender":
      await invoke("maria_voice_wake", { enabled: true });
      return;
    case "escuchar":
      await invoke("maria_voice_escucha", { activar: true });
      return;
    case "cortar":
      await invoke("maria_voice_escucha", { activar: false });
  }
}

export function BotonMicrofono({
  micOn,
  voz,
  onError,
}: {
  micOn: boolean;
  voz: ReactorState;
  onError?: (msg: string) => void;
}) {
  const estado = estadoMic(micOn, voz);
  const apagado = estado === "apagado";
  const activo = estado === "escuchando";

  return (
    <button
      type="button"
      aria-label={TITULO[estado]}
      aria-pressed={!apagado}
      title={TITULO[estado]}
      onClick={() => {
        void aplicarAccion(estado).catch((e) => onError?.(String(e)));
      }}
      className="hud-panel flex shrink-0 items-center justify-center transition-colors"
      style={{
        width: 38,
        height: 38,
        color: COLOR[estado],
        borderColor: activo ? "var(--color-accent)" : undefined,
        cursor: "pointer",
      }}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3.5a2.6 2.6 0 0 0-2.6 2.6v5.4a2.6 2.6 0 0 0 5.2 0V6.1A2.6 2.6 0 0 0 12 3.5Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M5.8 11a6.2 6.2 0 0 0 12.4 0M12 17.2V21"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        {apagado && (
          /* La barra sobre el icono es lo que hace que "apagado" se lea de un
             vistazo: un gris más claro no basta. */
          <path d="M4 20 20 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        )}
      </svg>
    </button>
  );
}
