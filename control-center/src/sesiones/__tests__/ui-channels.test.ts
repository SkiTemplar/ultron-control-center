import { beforeEach, describe, expect, it } from "vitest";
import {
  requestAttach,
  requestDictationToggle,
  requestEngineTask,
  requestInspectorTab,
  requestSessionSettings,
  uiStore,
} from "../ui";

const reset = () =>
  uiStore.dispatch((s) => ({
    ...s,
    attachRequest: null,
    dictationToggleTick: 0,
    inspectorTabRequest: null,
    engineTaskRequest: null,
    sessionSettingsRequest: null,
  }));

describe("canales de ui.ts entre paquetes (fase 0b)", () => {
  beforeEach(reset);

  it("requestAttach entrega los ficheros a la sesión pedida", () => {
    const file = new File(["x"], "captura.png", { type: "image/png" });
    requestAttach("s1", [file]);
    const req = uiStore.getState().attachRequest;
    expect(req?.sessionId).toBe("s1");
    expect(req?.files).toEqual([file]);
    expect(req?.tick).toBe(1);
  });

  it("requestAttach copia la lista: mutar la original no altera la petición", () => {
    const files = [new File(["a"], "a.txt")];
    requestAttach("s1", files);
    files.push(new File(["b"], "b.txt"));
    expect(uiStore.getState().attachRequest?.files).toHaveLength(1);
  });

  it("dos peticiones iguales seguidas tienen tick distinto (el consumidor reacciona dos veces)", () => {
    requestInspectorTab("s1", "git");
    const first = uiStore.getState().inspectorTabRequest;
    requestInspectorTab("s1", "git");
    const second = uiStore.getState().inspectorTabRequest;
    expect(second?.tick).toBe((first?.tick ?? 0) + 1);
    expect(second).not.toBe(first);
  });

  it("requestDictationToggle solo avanza su contador y no toca los demás canales", () => {
    const before = uiStore.getState();
    requestDictationToggle();
    requestDictationToggle();
    const after = uiStore.getState();
    expect(after.dictationToggleTick).toBe(2);
    expect(after.attachRequest).toBe(before.attachRequest);
    expect(after.sessionSettingsRequest).toBeNull();
  });

  it("requestEngineTask y requestSessionSettings llevan la sesión y el motor", () => {
    requestEngineTask("s2", "codex");
    requestSessionSettings("s2");
    const s = uiStore.getState();
    expect(s.engineTaskRequest).toMatchObject({ sessionId: "s2", engine: "codex", tick: 1 });
    expect(s.sessionSettingsRequest).toMatchObject({ sessionId: "s2", tick: 1 });
  });
});
