// Dictado: cuándo cortar un trozo de audio para transcribirlo. Se corta en
// las pausas del habla (así el texto entra casi en directo y sin palabras
// partidas), con un tope de duración. Los trozos sin voz se descartan sin
// llamar a Whisper, que sobre silencio se inventa frases. Puro, para probarlo.

/** Silencio tras la voz que cierra un trozo. */
export const PAUSE_MS = 700;
/** Duración máxima de un trozo aunque no haya pausa. */
export const MAX_SEGMENT_MS = 12_000;
/** Un trozo sin voz se reinicia pasado este tiempo (no se envía). */
export const IDLE_SEGMENT_MS = 4_000;
/** Umbral mínimo de RMS que cuenta como voz, aunque la sala sea muy silenciosa. */
export const MIN_VOICE_RMS = 0.012;

export interface SegmentState {
  startedAt: number;
  /** Último instante con voz; `null` si el trozo aún no tiene voz. */
  lastVoiceAt: number | null;
  /** Ruido de fondo estimado (media móvil del RMS sin voz). */
  noiseFloor: number;
}

export type SegmentAction = "keep" | "send" | "discard";

export function newSegment(now: number, noiseFloor: number): SegmentState {
  return { startedAt: now, lastVoiceAt: null, noiseFloor };
}

export function voiceThreshold(noiseFloor: number): number {
  return Math.max(MIN_VOICE_RMS, noiseFloor * 3);
}

/** Avanza el estado con una muestra de RMS y dice qué hacer con el trozo. */
export function step(s: SegmentState, now: number, rms: number): { state: SegmentState; action: SegmentAction } {
  const voiced = rms >= voiceThreshold(s.noiseFloor);
  const state: SegmentState = voiced
    ? { ...s, lastVoiceAt: now }
    : { ...s, noiseFloor: s.noiseFloor * 0.95 + rms * 0.05 };
  const age = now - state.startedAt;
  if (state.lastVoiceAt === null) return { state, action: age >= IDLE_SEGMENT_MS ? "discard" : "keep" };
  if (now - state.lastVoiceAt >= PAUSE_MS || age >= MAX_SEGMENT_MS) return { state, action: "send" };
  return { state, action: "keep" };
}

/** Mensaje concreto para un fallo al abrir el micrófono (`getUserMedia`). */
export function micErrorMessage(e: unknown): string {
  const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Micrófono denegado: permite el acceso al micrófono a las aplicaciones de escritorio en Configuración de Windows → Privacidad y seguridad → Micrófono y vuelve a pulsar Voz.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No hay ningún micrófono disponible: conecta uno o elige otro en Configuración de Windows → Sonido.";
    case "NotReadableError":
    case "AbortError":
      return "El micrófono está ocupado por otra aplicación: ciérrala y vuelve a pulsar Voz.";
    default:
      return `No se pudo abrir el micrófono: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Une el texto dictado al borrador: un espacio entre trozos, sin duplicar. */
export function joinDictated(draft: string, piece: string): string {
  const p = piece.trim();
  if (!p) return draft;
  if (!draft || /\s$/.test(draft)) return draft + p;
  return `${draft} ${p}`;
}

/** El dictado se apaga solo tras este tiempo sin voz… */
export const AUTO_OFF_SILENCE_MS = 120_000;
/** …o con la ventana oculta durante este tiempo. */
export const AUTO_OFF_HIDDEN_MS = 60_000;

export type AutoOffReason = "silence" | "hidden";

/** ¿Toca apagar el dictado? `heardAt`: última voz (o el arranque); `hiddenSince`: desde cuándo está oculta la ventana. */
export function autoOffReason(now: number, heardAt: number, hiddenSince: number | null): AutoOffReason | null {
  if (hiddenSince !== null && now - hiddenSince >= AUTO_OFF_HIDDEN_MS) return "hidden";
  if (now - heardAt >= AUTO_OFF_SILENCE_MS) return "silence";
  return null;
}

/** Aviso visible al apagarse solo. */
export function autoOffMessage(reason: AutoOffReason): string {
  return reason === "hidden"
    ? "Dictado apagado: la ventana lleva más de 1 min oculta. Pulsa Voz para seguir."
    : "Dictado apagado: 2 min sin oír voz. Pulsa Voz para seguir.";
}
