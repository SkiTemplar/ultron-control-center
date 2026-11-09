// Hallazgo 30: el Esc del composer no puede fallar en silencio. Un `ok: false`
// deja una nota en el hilo (error si una tecla no se pudo escribir; aviso si Claude
// sigue) salvo que el aviso ya lo dé la máquina, y una interrupción ya en marcha,
// una informativa.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Composer } from "../components/composer/Composer";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import { STILL_WORKING_TEXT, subagentResumeStore } from "../components/composer/recover-note";
import { TASK_RESUME_TEXT } from "../components/chat/status-line";
import { ApiContext } from "../context";
import { store } from "../store";
import type { RecoverOutcome, SessionInfo } from "../types";

const base: SessionInfo = {
  id: "e1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "working", model: null,
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};

const DEFAULTS: Record<string, unknown> = { promptHistory: [], listFiles: [], commands: FALLBACK_COMMANDS, engineModels: [] };

function fakeApi(recover: RecoverOutcome): SesionesApi {
  const fns = new Map<string, unknown>();
  return new Proxy({ isMock: true }, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      if (prop === "then") return undefined;
      if (!fns.has(prop)) {
        const value = prop === "recover" ? recover : DEFAULTS[prop];
        fns.set(prop, prop === "gitSnapshot" ? vi.fn().mockRejectedValue(new Error("sin git")) : vi.fn().mockResolvedValue(value));
      }
      return fns.get(prop);
    },
  }) as SesionesApi;
}

async function escape(recover: RecoverOutcome) {
  act(() => store.dispatch({ type: "sessions", sessions: [base] }));
  render(<ApiContext.Provider value={fakeApi(recover)}><Composer sessionId="e1" /></ApiContext.Provider>);
  const box = screen.getByRole("textbox", { name: "Mensaje" });
  await act(async () => {
    fireEvent.keyDown(box, { key: "Escape", code: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
  });
}

const notes = () => store.getState().bySession.e1?.notes ?? [];

afterEach(() => {
  cleanup();
  subagentResumeStore.dispatch({ id: "e1", resumed: false });
});

describe("Esc del composer con resultado", () => {
  it("ok:false con una tecla que no se pudo escribir deja una nota de error con los pasos", async () => {
    await escape({ ok: false, action: "interrupt", steps: ["esc: el PTY no acepta escritura", "sigueTrabajando"], status: "working" });
    const last = notes()[notes().length - 1];
    expect(last?.level).toBe("error");
    expect(last?.text).toContain("esc: el PTY no acepta escritura");
  });

  it("2026-10-15: un turno que sigue tras interrumpir no es un error, sino un aviso para volver a pulsar Esc", async () => {
    await escape({ ok: false, action: "interrupt", steps: ["esc", "ctrlC", "sigueTrabajando"], status: "working" });
    const last = notes()[notes().length - 1];
    expect(last?.level).toBe("warn");
    expect(last?.text).toBe(STILL_WORKING_TEXT);
  });

  it("una interrupción en curso deja una nota informativa", async () => {
    const before = notes().length;
    await escape({ ok: true, action: "interrupt", steps: ["enCurso"], status: "working" });
    const last = notes()[notes().length - 1];
    expect(notes().length).toBe(before + 1);
    expect(last?.level).toBe("info");
    expect(last?.text).toMatch(/Interrupción en curso/);
  });

  it.each([["retomaPorSubagente"], ["retomaPorTarea"], ["turnoNuevo"]])(
    "#30: con %s el aviso lo da la máquina (sin nota repetida) y la línea de estado lo recuerda",
    async (step) => {
      const before = notes().length;
      await escape({ ok: false, action: "interrupt", steps: ["turn.abort", step, "sigueTrabajando"], status: "working" });
      expect(notes().length).toBe(before);
      expect(subagentResumeStore.getState().has("e1")).toBe(true);
      expect(screen.getByTestId("chat-status").textContent).toBe(TASK_RESUME_TEXT);
      expect(screen.queryByTestId("status-interrupt")).toBeNull();
      expect(screen.getByTestId("interrupt")).toBeTruthy();
    },
  );

  it("sin respuesta de la CLI la ventana no repite el error de la máquina", async () => {
    const before = notes().length;
    await escape({ ok: false, action: "interrupt", steps: ["esc", "ctrlC", "sigueTrabajando", "sinRespuesta"], status: "working" });
    expect(notes().length).toBe(before);
  });

  it("caso negativo: una interrupción que funciona no deja nota", async () => {
    const before = notes().length;
    await escape({ ok: true, action: "interrupt", steps: ["turn.abort"], status: "idle" });
    expect(notes().length).toBe(before);
  });
});
