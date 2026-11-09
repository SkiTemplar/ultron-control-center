// `--sesiones-cwd <ruta>` (entrada «ULTRON Sessions aquí» del Explorador): la carpeta
// llega por `?cwd=`, se quita de la URL antes de crear la sesión y manda sobre la
// carpeta del perfil.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeCwdParam, newSessionInFolder, takeCwdParam } from "../abrir-carpeta";
import type { SesionesApi } from "../api";
import { markProfileUsed, reloadProfiles, saveProfile } from "../launch-profiles";
import { store } from "../store";
import type { CreateSessionArgs, SessionInfo } from "../types";

const BASE = "http://tauri.localhost/sesiones.html";

function fakeApi(): { api: SesionesApi; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async (args: CreateSessionArgs): Promise<SessionInfo> =>
    ({ id: "s-1", projectId: args.projectId ?? null, projectName: "x", cwd: args.cwd, title: "t" }) as SessionInfo);
  return { api: { create } as unknown as SesionesApi, create };
}

describe("takeCwdParam", () => {
  it("devuelve la ruta decodificada y la URL sin el parámetro", () => {
    const r = takeCwdParam(`${BASE}?project=p&cwd=C%3A%5CMis%20cosas%5Ca%C3%B1o%2Bb`);
    expect(r.cwd).toBe("C:\\Mis cosas\\año+b");
    expect(r.url).toBe(`${BASE}?project=p`);
  });

  it("sin el parámetro no hay carpeta ni nada que reescribir (negativo)", () => {
    expect(takeCwdParam(`${BASE}?project=p`)).toEqual({ cwd: null, url: null });
  });

  it("un parámetro vacío se quita pero no crea sesión (negativo)", () => {
    expect(takeCwdParam(`${BASE}?cwd=%20%20`)).toEqual({ cwd: null, url: BASE });
  });
});

describe("consumeCwdParam", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("lo consume una sola vez: una recarga ya no lo ve", () => {
    window.history.replaceState(null, "", "/sesiones.html?cwd=C%3A%5Cx&win=a");
    expect(consumeCwdParam()).toBe("C:\\x");
    expect(window.location.search).toBe("?win=a");
    expect(consumeCwdParam()).toBeNull();
  });
});

describe("newSessionInFolder", () => {
  beforeEach(() => {
    window.localStorage.clear();
    reloadProfiles();
    store.dispatch({ type: "sessions", sessions: [] });
  });

  it("crea la sesión en la carpeta pedida, sin proyecto (lo resuelve el backend)", async () => {
    const { api, create } = fakeApi();
    await newSessionInFolder(api, "D:\\trabajo");
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0][0] as CreateSessionArgs;
    expect(args.cwd).toBe("D:\\trabajo");
    expect(args.projectId).toBeUndefined();
    expect(store.getState().sessions.map((s) => s.id)).toEqual(["s-1"]);
  });

  it("la carpeta pedida manda sobre la del último perfil usado", async () => {
    const r = saveProfile({ name: "Web", cwd: "C:\\proyectos\\web", permissionMode: "acceptEdits" });
    if (!r.ok) throw new Error(r.error);
    markProfileUsed(r.profile.id);
    const { api, create } = fakeApi();
    await newSessionInFolder(api, "D:\\trabajo");
    const args = create.mock.calls[0][0] as CreateSessionArgs;
    expect(args.cwd).toBe("D:\\trabajo");
    expect(args.permissionMode).toBe("acceptEdits");
  });
});
