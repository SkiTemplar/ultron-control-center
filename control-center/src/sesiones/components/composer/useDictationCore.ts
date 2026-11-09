// Núcleo del dictado por voz: micro → trozos cortados en las pausas →
// transcripción (la función que se le pase; en la app, el comando Tauri
// `sesiones_transcribe`, Whisper de Groq) → texto, en orden.
// Se puede parar y seguir cuando se quiera; parar envía el trozo en curso.
// Reentrante: una segunda pulsación mientras se abre el micro cancela el
// arranque (un solo micro y un solo grabador) y desmontar lo cierra todo
// (motores-ventanas:F5). Se apaga solo, con aviso, tras 2 min sin voz o con la
// ventana oculta más de 1 min (`autoOffReason`).
//
// No depende del contexto de Sessions: lo usan el composer de Sessions
// (`useDictation`) y el chat de la mascota (`MascotInputRow`).

import { useCallback, useEffect, useRef, useState } from "react";
import { autoOffMessage, autoOffReason, micErrorMessage, newSegment, step, type SegmentState } from "./dictation";

export type DictationStatus = "off" | "starting" | "listening";

/** Audio en base64 (sin cabecera `data:`) y su tipo MIME → texto transcrito. */
export type TranscribeFn = (audioB64: string, mime: string) => Promise<string>;

export interface DictationControls {
  status: DictationStatus;
  /** Trozos enviados a transcribir que aún no han vuelto. */
  pending: number;
  toggle: () => void;
  stop: () => void;
}

const TICK_MS = 100;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

interface Live {
  stream: MediaStream;
  ctx: AudioContext;
  analyser: AnalyserNode;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  seg: SegmentState;
  timer: number;
  mime: string;
  /** Última voz oída (o el arranque): sin voz durante `AUTO_OFF_SILENCE_MS`, se apaga solo. */
  heardAt: number;
  /** Desde cuándo está oculta la ventana (`null` si está visible). */
  hiddenSince: number | null;
}

function isWindowHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function pickMime(): string {
  return MIME_CANDIDATES.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
}

function rmsOf(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  return Math.sqrt(sum / buf.length);
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("no se pudo leer el audio"));
    r.readAsDataURL(blob);
  });
}

export function useDictationCore(
  transcribe: TranscribeFn,
  onText: (text: string) => void,
  onError: (message: string) => void,
): DictationControls {
  const [status, setStatus] = useState<DictationStatus>("off");
  const [pending, setPending] = useState(0);
  const live = useRef<Live | null>(null);
  /** Generación del arranque en curso (`null` si no hay ninguno). */
  const starting = useRef<number | null>(null);
  const generation = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const cb = useRef({ transcribe, onText, onError });
  cb.current = { transcribe, onText, onError };

  /** Transcribe en orden: un trozo no adelanta al anterior aunque Groq tarde. */
  const send = useCallback((blob: Blob, mime: string) => {
    setPending((n) => n + 1);
    queue.current = queue.current
      .then(async () => {
        const text = await cb.current.transcribe(await toBase64(blob), mime);
        if (text.trim()) cb.current.onText(text);
      })
      .catch((e: unknown) => cb.current.onError(`Dictado: ${String(e)}`))
      .finally(() => setPending((n) => n - 1));
  }, []);

  /** Arranca un trozo nuevo; `flush` decide si el anterior se transcribe. */
  const cut = useCallback((l: Live, flush: boolean, restart: boolean) => {
    // Cada grabador llena su propio array: el último `dataavailable` del
    // anterior llega después de stop() y no debe caer en el trozo nuevo.
    const prev = l.recorder;
    const chunks = l.chunks;
    l.recorder = null;
    if (prev && prev.state !== "inactive") {
      prev.onstop = () => {
        if (flush && chunks.length > 0) send(new Blob(chunks, { type: l.mime }), l.mime);
      };
      prev.stop();
    }
    if (!restart) return;
    const rec = new MediaRecorder(l.stream, l.mime ? { mimeType: l.mime } : undefined);
    const mine: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) mine.push(e.data);
    };
    rec.start();
    l.recorder = rec;
    l.chunks = mine;
    l.seg = newSegment(Date.now(), l.seg.noiseFloor);
  }, [send]);

  const stop = useCallback(() => {
    const l = live.current;
    live.current = null;
    setStatus("off");
    if (!l) return;
    window.clearInterval(l.timer);
    cut(l, l.seg.lastVoiceAt !== null, false);
    l.stream.getTracks().forEach((t) => t.stop());
    void l.ctx.close().catch(() => undefined);
  }, [cut]);

  /** Cancela un arranque en curso: al resolver, el micro se cierra sin grabar. */
  const cancelStart = useCallback(() => {
    starting.current = null;
    setStatus("off");
  }, []);

  /** Un tic del medidor: segmenta por pausas y decide el autoapagado. */
  const tick = useCallback((l: Live, buf: Float32Array<ArrayBuffer>) => {
    const now = Date.now();
    const { state, action } = step(l.seg, now, rmsOf(l.analyser, buf));
    l.seg = state;
    if (state.lastVoiceAt !== null && state.lastVoiceAt > l.heardAt) l.heardAt = state.lastVoiceAt;
    l.hiddenSince = isWindowHidden() ? l.hiddenSince ?? now : null;
    // Autoapagado: encendido toda la noche transcribiría ruido de fondo.
    const reason = autoOffReason(now, l.heardAt, l.hiddenSince);
    if (reason) {
      stop();
      cb.current.onError(autoOffMessage(reason));
      return;
    }
    if (action !== "keep") cut(l, action === "send", true);
  }, [cut, stop]);

  const start = useCallback(async () => {
    if (live.current || starting.current !== null) return;
    const gen = generation.current + 1;
    generation.current = gen;
    starting.current = gen;
    setStatus("starting");
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (starting.current !== gen) {
        // Se canceló (segunda pulsación o desmontaje) mientras se abría el micro.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      starting.current = null;
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const t0 = Date.now();
      const l: Live = { stream, ctx, analyser, recorder: null, chunks: [], seg: newSegment(t0, 0.005), timer: 0, mime: pickMime(), heardAt: t0, hiddenSince: null };
      live.current = l;
      cut(l, false, true);
      l.timer = window.setInterval(() => tick(l, buf), TICK_MS);
      setStatus("listening");
    } catch (e) {
      if (!live.current) stream?.getTracks().forEach((t) => t.stop());
      live.current = null;
      if (starting.current !== gen) return; // cancelado: nadie espera el error
      starting.current = null;
      setStatus("off");
      cb.current.onError(micErrorMessage(e));
    }
  }, [cut, tick]);

  const toggle = useCallback(() => {
    if (live.current) stop();
    else if (starting.current !== null) cancelStart();
    else void start();
  }, [start, stop, cancelStart]);

  useEffect(() => () => {
    starting.current = null;
    stop();
  }, [stop]);

  return { status, pending, toggle, stop };
}
