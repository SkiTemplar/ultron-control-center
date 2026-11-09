// Auditoría de estabilidad nocturna, hallazgo 8: el dictado se apaga solo tras
// 2 min sin voz o con la ventana oculta más de 1 min, con aviso visible (si se
// queda encendido de noche transcribe ruido de fondo sin parar).

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { AUTO_OFF_HIDDEN_MS, AUTO_OFF_SILENCE_MS, autoOffReason } from "../components/composer/dictation";
import { useDictation } from "../components/composer/useDictation";
import { ApiContext } from "../context";

const api = { transcribe: vi.fn(async () => "") } as unknown as SesionesApi;
const wrapper = ({ children }: { children: ReactNode }) => <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;

/** Nivel del micrófono que devuelve el analizador falso (0 = silencio). */
let level = 0;
let visibility: DocumentVisibilityState = "visible";
const trackStop = vi.fn();

class FakeRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

class FakeAudioContext {
  createAnalyser() {
    return { fftSize: 32, getFloatTimeDomainData: (buf: Float32Array) => buf.fill(level) };
  }
  createMediaStreamSource() {
    return { connect: () => undefined };
  }
  close() {
    return Promise.resolve();
  }
}

const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;

async function listening(onError: (m: string) => void) {
  const hook = renderHook(() => useDictation(() => undefined, onError), { wrapper });
  await act(async () => hook.result.current.toggle());
  expect(hook.result.current.status).toBe("listening");
  return hook;
}

beforeEach(() => {
  vi.useFakeTimers();
  level = 0;
  visibility = "visible";
  trackStop.mockClear();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("autoapagado del dictado", () => {
  it("regla pura: oculta 1 min o 2 min sin voz", () => {
    expect(autoOffReason(AUTO_OFF_SILENCE_MS - 1, 0, null)).toBeNull();
    expect(autoOffReason(AUTO_OFF_SILENCE_MS, 0, null)).toBe("silence");
    expect(autoOffReason(1000 + AUTO_OFF_HIDDEN_MS, 1000, 1000)).toBe("hidden");
    expect(autoOffReason(1000 + AUTO_OFF_HIDDEN_MS - 1, 1000, 1000)).toBeNull();
  });

  it("2 min sin voz: se apaga, cierra el micro y lo avisa", async () => {
    const onError = vi.fn();
    const { result } = await listening(onError);
    act(() => vi.advanceTimersByTime(AUTO_OFF_SILENCE_MS - 1000));
    expect(result.current.status).toBe("listening");
    act(() => vi.advanceTimersByTime(1100));
    expect(result.current.status).toBe("off");
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/Dictado apagado: 2 min sin oír voz/));
  });

  it("hablando de vez en cuando no se apaga (caso negativo)", async () => {
    const onError = vi.fn();
    const { result } = await listening(onError);
    for (let i = 0; i < 4; i += 1) {
      act(() => vi.advanceTimersByTime(AUTO_OFF_SILENCE_MS - 20_000));
      level = 0.5;
      act(() => vi.advanceTimersByTime(300));
      level = 0;
    }
    expect(result.current.status).toBe("listening");
    expect(onError).not.toHaveBeenCalled();
    act(() => result.current.stop());
  });

  it("ventana oculta más de 1 min: se apaga aunque haya voz", async () => {
    const onError = vi.fn();
    const { result } = await listening(onError);
    level = 0.5;
    visibility = "hidden";
    act(() => vi.advanceTimersByTime(AUTO_OFF_HIDDEN_MS - 1000));
    expect(result.current.status).toBe("listening");
    act(() => vi.advanceTimersByTime(1200));
    expect(result.current.status).toBe("off");
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/ventana lleva más de 1 min oculta/));
  });

  it("oculta menos de 1 min y vuelve: el plazo empieza de cero (caso negativo)", async () => {
    const onError = vi.fn();
    const { result } = await listening(onError);
    level = 0.5;
    visibility = "hidden";
    act(() => vi.advanceTimersByTime(AUTO_OFF_HIDDEN_MS - 5000));
    visibility = "visible";
    act(() => vi.advanceTimersByTime(500));
    visibility = "hidden";
    act(() => vi.advanceTimersByTime(AUTO_OFF_HIDDEN_MS - 5000));
    expect(result.current.status).toBe("listening");
    act(() => result.current.stop());
  });
});
