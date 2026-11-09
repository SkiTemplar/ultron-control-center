// Dictado por voz en el chat de la mascota (MascotInputRow): el botón alterna
// el micro, lo transcrito se añade al borrador sin enviarse, cerrar el chat
// apaga el micro y el backend es el mismo comando que usa Sessions.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn(async (..._args: unknown[]) => "desde tauri");
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { MascotInputRow, transcribeViaTauri } from "../MascotInputRow";

/** Nivel del micrófono que devuelve el analizador falso (0 = silencio). */
let level = 0;
let starts = 0;
const trackStop = vi.fn();
let micImpl: () => Promise<MediaStream> = async () => stream;

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
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
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

function Harness(p: { onSend: () => void; onKeyDown?: () => void; transcribe: (b: string, m: string) => Promise<string> }) {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState("hola");
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <output data-testid="draft">{draft}</output>
      <button type="button" onClick={() => setOpen(false)}>cerrar chat</button>
      {open && (
        <MascotInputRow
          inputRef={ref}
          draft={draft}
          setDraft={setDraft}
          placeholder="Escribe"
          canSend
          onSend={p.onSend}
          onKeyDown={p.onKeyDown ?? (() => undefined)}
          transcribe={p.transcribe}
        />
      )}
    </>
  );
}

/** Deja correr las promesas (FileReader, cola de transcripción) con temporizadores reales. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

function setup(transcribe = vi.fn(async () => "texto dictado"), onKeyDown?: () => void) {
  const onSend = vi.fn();
  render(<Harness onSend={onSend} onKeyDown={onKeyDown} transcribe={transcribe} />);
  const mic = screen.getByRole("button", { name: "Voz" });
  return { onSend, transcribe, mic, draft: () => screen.getByTestId("draft").textContent };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  level = 0;
  starts = 0;
  trackStop.mockClear();
  invokeMock.mockClear();
  micImpl = async () => stream;
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(() => micImpl()) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("dictado en el chat de la mascota", () => {
  it("el botón alterna el dictado y lo transcrito se añade al borrador sin enviarse", async () => {
    const { mic, onSend, transcribe, draft } = setup();
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(mic));
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(mic.dataset.state).toBe("listening");
    expect(starts).toBe(1);

    level = 0.5;
    act(() => vi.advanceTimersByTime(300));
    await act(async () => fireEvent.click(mic));
    expect(mic.dataset.state).toBe("off");
    expect(trackStop).toHaveBeenCalledTimes(1);
    await flush();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith(expect.any(String), "audio/webm;codecs=opus");
    expect(draft()).toBe("hola texto dictado");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sin voz no transcribe ni toca el borrador (caso negativo)", async () => {
    const { mic, transcribe, draft } = setup();
    await act(async () => fireEvent.click(mic));
    act(() => vi.advanceTimersByTime(300));
    await act(async () => fireEvent.click(mic));
    await flush();
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(transcribe).not.toHaveBeenCalled();
    expect(draft()).toBe("hola");
  });

  it("cerrar el chat con el micro abierto lo apaga", async () => {
    const { mic } = setup();
    await act(async () => fireEvent.click(mic));
    expect(trackStop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "cerrar chat" }));
    expect(screen.queryByRole("button", { name: "Voz" })).toBeNull();
    expect(trackStop).toHaveBeenCalledTimes(1);
    // Ningún tic huérfano: sin intervalos vivos tras desmontar.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Ctrl+Espacio en el cuadro alterna el micro y el resto de teclas va al chat", async () => {
    const onKeyDown = vi.fn();
    const { mic } = setup(undefined, onKeyDown);
    const box = screen.getByPlaceholderText("Escribe");
    await act(async () => fireEvent.keyDown(box, { code: "Space", key: " ", ctrlKey: true }));
    expect(mic.dataset.state).toBe("listening");
    expect(onKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter", code: "Enter" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.keyDown(box, { code: "Space", key: " ", ctrlKey: true }));
    expect(mic.dataset.state).toBe("off");
  });

  it("micro denegado: aviso concreto en el bocadillo y botón apagado", async () => {
    micImpl = async () => {
      throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    };
    const { mic } = setup();
    await act(async () => fireEvent.click(mic));
    expect(screen.getByRole("alert").textContent).toMatch(/Privacidad y seguridad/);
    expect(mic.dataset.state).toBe("off");
  });

  it("el backend por defecto es el comando de Sessions", async () => {
    await expect(transcribeViaTauri("QUJD", "audio/webm")).resolves.toBe("desde tauri");
    expect(invokeMock).toHaveBeenCalledWith("sesiones_transcribe", { audioB64: "QUJD", mime: "audio/webm" });
  });
});
