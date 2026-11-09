// invoke() con plazo: una carga que no responde termina en error, nunca en un
// spinner eterno.
//
// Motivo (auditoría 2026-10-18): Panel → «Sistema de memoria», Session
// Monitor, Usage y System → Diagnóstico se quedaban en «Cargando…» /
// «Ejecutando…» sin fin. Los cuatro esperaban un invoke() sin plazo; cuando la
// respuesta no llega (comando que tarda o petición IPC encolada detrás de
// otras), el `finally` que apaga el estado de carga no se ejecuta nunca y la
// vista no puede decir nada. Con plazo, la promesa siempre se resuelve o se
// rechaza, y la vista enseña el error con la opción de reintentar.

import { invoke, type InvokeArgs } from "@tauri-apps/api/core";

/** Plazo por defecto: holgado para una lectura de disco normal. */
export const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;

/** Error de plazo: lleva el comando y el plazo para que el mensaje sea accionable. */
export class InvokeTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    const secs = Math.round(timeoutMs / 1000);
    super(
      `El backend no respondió a «${command}» en ${secs} s. ` +
        "Puede estar ocupado con otra carga; pulsa Actualizar para reintentar.",
    );
    this.name = "InvokeTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Igual que `invoke`, pero rechaza con `InvokeTimeoutError` si no hay
 * respuesta en `timeoutMs`. Un error del comando se propaga tal cual.
 */
export function invokeWithTimeout<T>(
  command: string,
  args?: InvokeArgs,
  timeoutMs: number = DEFAULT_INVOKE_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new InvokeTimeoutError(command, timeoutMs)), timeoutMs);
    // Promise.resolve().then(...) también convierte en rechazo un throw síncrono.
    Promise.resolve()
      .then(() => invoke<T>(command, args))
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
  });
}
