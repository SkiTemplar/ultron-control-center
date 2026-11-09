// Bloque de Codex y agy de la pestaña Uso: validación de la respuesta en la
// frontera, textos (ventana reiniciada, actividad sin límite) y el componente
// (Actualizar fuerza, gana la última respuesta, un fallo se dice).

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Uso } from "../components/inspector/Uso";
import { UsoMotores } from "../components/inspector/UsoMotores";
import { engineHeader, engineWindowText, normalizeEngines } from "../components/inspector/uso-motores";
import { resetPlanState } from "../components/inspector/uso-state";
import { ApiContext } from "../context";
import type { EnginePlanUsage, EnginesPlanUsage } from "../types";

const NOW = Date.parse("2026-10-19T00:00:00Z");
const H = 3600000;

function fakeApi(overrides: Partial<Record<keyof SesionesApi, unknown>>): SesionesApi {
  return new Proxy({} as SesionesApi, {
    get(_t, key: string) {
      if (key in overrides) return overrides[key as keyof SesionesApi];
      return () => Promise.reject(new Error(`${key}: no implementado en el test`));
    },
  });
}

const withApi = (api: SesionesApi, node: ReactNode) => <ApiContext.Provider value={api}>{node}</ApiContext.Provider>;

const codex = (five: number | null, expired = false): EnginePlanUsage => ({
  id: "codex", label: "Codex", status: "ok", source: "rollout", readAtMs: NOW - 4 * 60000, plan: "plus", activity: null, note: null,
  windows: [
    { kind: "five_hour", group: null, usedPct: five, resetsAtMs: NOW + 2 * H, expired },
    { kind: "seven_day", group: null, usedPct: 2, resetsAtMs: NOW + 100 * H, expired: false },
  ],
});

const agyActivity: EnginePlanUsage = {
  id: "agy", label: "agy (Gemini)", status: "ok", source: "activity", readAtMs: NOW, plan: null, windows: [],
  activity: { fiveHour: { turns: 1, tokens: 1200 }, sevenDay: { turns: 3, tokens: 45000 } },
  note: "actividad sin límite conocido (agy /usage no trae cuota)",
};

const payload = (...engines: EnginePlanUsage[]): EnginesPlanUsage => ({ generatedAtMs: NOW, engines });

afterEach(() => resetPlanState());

describe("normalizeEngines", () => {
  it("rechaza una respuesta sin engines", () => {
    expect(() => normalizeEngines({})).toThrow(/engines/);
    expect(() => normalizeEngines(null)).toThrow();
  });

  it("descarta motores y ventanas con forma inesperada y conserva lo válido", () => {
    const out = normalizeEngines({
      generatedAtMs: NOW,
      engines: [
        { id: "codex", status: "ok", source: "rollout", windows: [{ kind: "five_hour", usedPct: 6, resetsAtMs: NOW + H }, { usedPct: 9 }, "x"] },
        { id: "raro", status: "quizá" },
        "basura",
      ],
    });
    expect(out.engines.map((e) => e.id)).toEqual(["codex"]);
    expect(out.engines[0].windows).toEqual([{ kind: "five_hour", group: null, usedPct: 6, resetsAtMs: NOW + H, expired: false }]);
    expect(out.engines[0].label).toBe("codex");
  });
});

describe("textos", () => {
  it("una ventana reiniciada tras la lectura no enseña el porcentaje viejo", () => {
    const w = { kind: "five_hour", group: null, usedPct: 80, resetsAtMs: NOW - 60000, expired: true };
    expect(engineWindowText(w, NOW)).toMatch(/uso desconocido/);
    expect(engineWindowText(w, NOW)).not.toMatch(/80/);
  });

  it("la cabecera lleva el plan y la antigüedad de la lectura", () => {
    expect(engineHeader(codex(6), NOW)).toBe("Codex · plus · hace 4 min");
  });
});

describe("UsoMotores", () => {
  it("pinta la cuota de Codex con barra y la actividad de agy sin porcentaje", async () => {
    const enginesUsage = vi.fn(async () => payload(codex(6), agyActivity));
    render(withApi(fakeApi({ enginesUsage }), <UsoMotores forceKey={0} now={NOW} />));
    const cx = await screen.findByTestId("uso-motor-codex");
    expect(within(cx).getByRole("progressbar", { name: "Codex 5 h" }).getAttribute("aria-valuenow")).toBe("6");
    expect(within(cx).getByText(/^6 % · reinicia en 2 h 0 min$/)).toBeTruthy();
    const agy = screen.getByTestId("uso-motor-agy");
    expect(within(agy).queryByRole("progressbar")).toBeNull();
    expect(within(agy).getByText(/actividad sin límite conocido/)).toBeTruthy();
    expect(within(agy).getByText("5 h: 1 turno · 1k tokens")).toBeTruthy();
    expect(within(agy).queryByText(/%/)).toBeNull();
    expect(enginesUsage).toHaveBeenCalledWith(undefined);
  });

  it("motor sin dato o con error lo dice, y un fallo de la API también", async () => {
    const none: EnginePlanUsage = { ...agyActivity, status: "error", source: null, activity: null, note: "no se encontró 'agy' en el PATH" };
    const { unmount } = render(withApi(fakeApi({ enginesUsage: async () => payload(none) }), <UsoMotores forceKey={0} now={NOW} />));
    expect(await screen.findByText("no se pudo leer: no se encontró 'agy' en el PATH")).toBeTruthy();
    unmount();
    render(withApi(fakeApi({ enginesUsage: () => Promise.reject(new Error("node no está")) }), <UsoMotores forceKey={0} now={NOW} />));
    expect(await screen.findByText(/No se pudo leer el uso de Codex y agy: node no está/)).toBeTruthy();
  });

  it("gana la última respuesta: una anterior que llega tarde se descarta", async () => {
    let releaseFirst: (v: EnginesPlanUsage) => void = () => undefined;
    const enginesUsage = vi
      .fn()
      .mockImplementationOnce(() => new Promise<EnginesPlanUsage>((r) => { releaseFirst = r; }))
      .mockImplementationOnce(async () => payload(codex(40)));
    const api = fakeApi({ enginesUsage });
    const { rerender } = render(withApi(api, <UsoMotores forceKey={0} now={NOW} />));
    rerender(withApi(api, <UsoMotores forceKey={1} now={NOW} />));
    expect(await screen.findByText(/^40 %/)).toBeTruthy();
    expect(enginesUsage).toHaveBeenLastCalledWith({ force: true });
    await act(async () => releaseFirst(payload(codex(5))));
    expect(screen.queryByText(/^5 %/)).toBeNull();
    expect(screen.getByText(/^40 %/)).toBeTruthy();
  });
});

describe("Uso con motores", () => {
  it("Actualizar también fuerza el uso de Codex y agy, y el fallo de Claude no lo tapa", async () => {
    const enginesUsage = vi.fn(async () => payload(codex(6)));
    const api = fakeApi({
      usage: () => Promise.reject(new Error("sin red")),
      usagePace: () => Promise.reject(new Error("sin red")),
      enginesUsage,
    });
    render(withApi(api, <Uso sessionId={null} />));
    expect(await screen.findByTestId("uso-motor-codex")).toBeTruthy();
    const button = await screen.findByRole("button", { name: "Actualizar" });
    await act(async () => fireEvent.click(button));
    await waitFor(() => expect(enginesUsage).toHaveBeenLastCalledWith({ force: true }));
  });
});
