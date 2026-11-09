// Dictado reentrante (motores-ventanas:F5) y errores de micrófono concretos
// (F6): una doble pulsación mientras se abre el micro no deja dos grabadores
// ni el micro encendido, y desmontar durante el arranque lo cierra.

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { micErrorMessage } from "../components/composer/dictation";
import { useDictation } from "../components/composer/useDictation";
import { ApiContext } from "../context";

const api = { transcribe: vi.fn(async () => "") } as unknown as SesionesApi;
const wrapper = ({ children }: { children: ReactNode }) => <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;

let starts = 0;
const trackStop = vi.fn();
let resolveMic: (s: MediaStream) => void = () => undefined;
let rejectMic: (e: unknown) => void = () => undefined;

class FakeRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    starts += 1;
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

class FakeAudioContext {
  createAnalyser() {
    return { fftSize: 0, getFloatTimeDomainData: () => undefined };
  }
  createMediaStreamSource() {
    return { connect: () => undefined };
  }
  close() {
    return Promise.resolve();
  }
}

const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;

beforeEach(() => {
  starts = 0;
  trackStop.mockClear();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(() => new Promise<MediaStream>((res, rej) => {
        resolveMic = res;
        rejectMic = rej;
      })),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("useDictation", () => {
  it("toggle(); toggle(); con el micro aún abriéndose no deja grabador ni micro abiertos", async () => {
    const { result } = renderHook(() => useDictation(() => undefined, () => undefined), { wrapper });
    act(() => result.current.toggle());
    expect(result.current.status).toBe("starting");
    act(() => result.current.toggle());
    expect(result.current.status).toBe("off");
    await act(async () => resolveMic(stream));
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(starts).toBe(0);
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("off");
  });

  it("una sola pulsación arranca un único grabador", async () => {
    const { result } = renderHook(() => useDictation(() => undefined, () => undefined), { wrapper });
    act(() => result.current.toggle());
    await act(async () => resolveMic(stream));
    expect(starts).toBe(1);
    expect(result.current.status).toBe("listening");
    act(() => result.current.toggle());
    expect(trackStop).toHaveBeenCalled();
  });

  it("desmontar antes de que se abra el micro lo cierra al llegar", async () => {
    const { result, unmount } = renderHook(() => useDictation(() => undefined, () => undefined), { wrapper });
    act(() => result.current.toggle());
    unmount();
    await act(async () => resolveMic(stream));
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(starts).toBe(0);
  });

  it("un permiso denegado explica cómo concederlo", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useDictation(() => undefined, onError), { wrapper });
    act(() => result.current.toggle());
    await act(async () => rejectMic(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Privacidad y seguridad"));
    expect(result.current.status).toBe("off");
  });
});

describe("micErrorMessage", () => {
  it("traduce los errores de getUserMedia", () => {
    expect(micErrorMessage({ name: "NotFoundError" })).toMatch(/ningún micrófono/);
    expect(micErrorMessage({ name: "NotReadableError" })).toMatch(/ocupado/);
    expect(micErrorMessage(new Error("raro"))).toBe("No se pudo abrir el micrófono: raro");
  });
});
