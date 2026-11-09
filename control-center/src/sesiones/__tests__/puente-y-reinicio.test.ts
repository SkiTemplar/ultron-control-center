// Auditoría 2026-10-17 (tanda 1, punto 4): `bridgeConnected` tiene consumidor
// (la línea de estado avisa de una sesión sin puente) y un reinicio que choca
// con otro en curso no se anuncia como una interrupción. Casos negativos: con
// puente, «Listo» a secas; una interrupción en curso conserva su texto.

import { describe, expect, it } from "vitest";
import { statusLine } from "../components/chat/status-line";
import { IN_PROGRESS_TEXT, RESTART_IN_PROGRESS_TEXT, recoverNote } from "../components/composer/recover-note";
import type { RecoverOutcome, SessionInfo } from "../types";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const iso = new Date(NOW).toISOString();

const base: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "/p", title: "t", claudeSessionId: "c", status: "idle", model: null,
  startedAt: iso, bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: iso, turnId: null,
  screen: "prompt", permissionMode: "bypassPermissions", launchPermissionMode: "bypassPermissions", exitCode: null, bridgeProtocol: 2,
};

describe("sesión sin puente en la línea de estado", () => {
  it("idle sin puente lo dice y en ámbar", () => {
    const s = statusLine({ ...base, bridgeConnected: false, bridgeProtocol: 0 }, [], [], { now: NOW });
    expect(s.text).toMatch(/^Listo · sin puente/);
    expect(s.tone).toBe("warn");
  });

  it("interrumpido sin puente conserva «Interrumpido» y añade el aviso", () => {
    const s = statusLine({ ...base, bridgeConnected: false }, [], [], { now: NOW, lastTurnAborted: true });
    expect(s.text).toMatch(/^Interrumpido · sin puente/);
  });

  it("caso negativo: con puente, «Listo» a secas", () => {
    const s = statusLine(base, [], [], { now: NOW });
    expect(s.text).toBe("Listo");
    expect(s.tone).toBe("idle");
  });
});

const outcome = (action: RecoverOutcome["action"]): RecoverOutcome => ({ ok: true, action, steps: ["enCurso"], status: "starting" });

describe("nota de un reinicio con otro en curso", () => {
  it("«enCurso» de un reinicio habla del reinicio, no de una interrupción", () => {
    expect(recoverNote(outcome("restart"))).toEqual({ level: "info", text: RESTART_IN_PROGRESS_TEXT });
    expect(RESTART_IN_PROGRESS_TEXT).not.toBe(IN_PROGRESS_TEXT);
  });

  it("caso negativo: «enCurso» de una interrupción mantiene su texto", () => {
    expect(recoverNote(outcome("interrupt"))).toEqual({ level: "info", text: IN_PROGRESS_TEXT });
  });
});
