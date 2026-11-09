// Perfiles de lanzamiento de «+ Claude» (15-10): persistencia con validación,
// «Normal» fijo, último usado y paso de los campos del perfil a sesiones_create.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Sidebar } from "../components/Sidebar";
import { ProfilesDialog } from "../components/ProfilesDialog";
import { ApiContext } from "../context";
import {
  deleteProfile,
  duplicateProfile,
  lastUsedProfile,
  launchWithProfile,
  markProfileUsed,
  newSessionHere,
  newSessionTitle,
  NORMAL_ID,
  parseProfiles,
  profilesStore,
  reloadProfiles,
  resolveProfile,
  saveProfile,
  STORAGE_KEY,
  type LaunchProfile,
} from "../launch-profiles";
import { createMockApi } from "../mock/api-mock";
import { store } from "../store";
import type { CreateSessionArgs, PastSession, SessionInfo } from "../types";

const VALID = { id: "p-1", name: "Rápido", model: "claude-sonnet-5-5", effort: "low", permissionMode: "acceptEdits", cwd: "C:\\proyectos\\web" };

function fakeApi(fail?: string): { api: SesionesApi; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async (args: CreateSessionArgs): Promise<SessionInfo> => {
    if (fail) throw new Error(fail);
    return { id: `s-${create.mock.calls.length}`, projectId: args.projectId ?? null, projectName: "x", cwd: args.cwd, title: "t" } as SessionInfo;
  });
  return { api: { create } as unknown as SesionesApi, create };
}

function saved(draft: Parameters<typeof saveProfile>[0]): LaunchProfile {
  const r = saveProfile(draft);
  if (!r.ok) throw new Error(r.error);
  return r.profile;
}

beforeEach(() => {
  window.localStorage.clear();
  reloadProfiles();
  store.dispatch({ type: "error", message: null as unknown as string });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lectura y validación", () => {
  it("sin nada guardado solo existe «Normal», sin overrides", () => {
    const s = profilesStore.getState();
    expect(s.profiles).toEqual([{ id: NORMAL_ID, name: "Normal" }]);
    expect(lastUsedProfile().id).toBe(NORMAL_ID);
  });

  it("JSON corrupto en el almacenamiento no rompe: vuelve a «Normal»", () => {
    window.localStorage.setItem(STORAGE_KEY, "{no es json");
    reloadProfiles();
    expect(profilesStore.getState().profiles.map((p) => p.id)).toEqual([NORMAL_ID]);
  });

  it("descarta las entradas corruptas y conserva las válidas (caso negativo por campo)", () => {
    const s = parseProfiles({
      profiles: [
        VALID,
        { ...VALID, id: "m", name: "Modelo raro", model: "gpt-9" },
        { ...VALID, id: "e", name: "Effort raro", effort: "turbo" },
        { ...VALID, id: "pm", name: "Modo raro", permissionMode: "yolo" },
        { ...VALID, id: "rel", name: "Relativa", cwd: "proyectos\\web" },
        { id: "sin-nombre" },
        { ...VALID, name: "Repetido" },
        { ...VALID, id: NORMAL_ID, name: "Normal falso" },
        "texto",
        null,
        42,
      ],
      lastUsed: "no-existe",
    });
    expect(s.profiles.map((p) => p.id)).toEqual([NORMAL_ID, "p-1"]);
    expect(s.profiles[1]).toEqual(VALID);
    expect(s.lastUsed).toBe(NORMAL_ID);
    expect(parseProfiles({ profiles: "x" }).profiles).toHaveLength(1);
    expect(parseProfiles([VALID]).profiles).toHaveLength(1);
  });

  it("guarda y relee lo mismo; el borrador inválido se rechaza con motivo", () => {
    const p = saved({ name: "  Revisión  ", model: "claude-opus-5-5", effort: "max", permissionMode: "plan", cwd: " D:\\repo " });
    expect(p).toMatchObject({ name: "Revisión", cwd: "D:\\repo" });
    reloadProfiles();
    expect(profilesStore.getState().profiles[1]).toEqual(p);

    expect(saveProfile({ name: "" })).toMatchObject({ ok: false });
    expect(saveProfile({ name: "revisión" })).toEqual({ ok: false, error: "Ya hay un perfil llamado «Revisión»." });
    expect(saveProfile({ name: "X", model: "claude-opus-1" })).toMatchObject({ ok: false });
    expect(saveProfile({ name: "X", effort: "turbo" })).toMatchObject({ ok: false });
    expect(saveProfile({ name: "X", permissionMode: "yolo" })).toMatchObject({ ok: false });
    expect(saveProfile({ name: "X", cwd: "relativa\\carpeta" })).toMatchObject({ ok: false });
    expect(profilesStore.getState().profiles).toHaveLength(2);
  });

  it("duplicar crea una copia con nombre libre y otro id", () => {
    const p = saved({ name: "Base", effort: "high" });
    const a = duplicateProfile(p.id);
    const b = duplicateProfile(p.id);
    expect(a.ok && a.profile).toMatchObject({ name: "Base (copia)", effort: "high" });
    expect(b.ok && b.profile.name).toBe("Base (copia 2)");
    expect(a.ok && a.profile.id).not.toBe(p.id);
  });
});

describe("«Normal»", () => {
  it("no se puede borrar ni editar", () => {
    expect(deleteProfile(NORMAL_ID)).toMatchObject({ ok: false });
    expect(saveProfile({ id: NORMAL_ID, name: "Normal", model: "claude-opus-5-5" })).toMatchObject({ ok: false });
    expect(profilesStore.getState().profiles[0]).toEqual({ id: NORMAL_ID, name: "Normal" });
  });

  it("en el diálogo, Editar y Borrar de «Normal» están deshabilitados", () => {
    render(
      <ApiContext.Provider value={createMockApi({ autoplay: false })}>
        <ProfilesDialog onClose={() => undefined} />
      </ApiContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "Borrar Normal" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Editar Normal" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Duplicar Normal" })).toBeEnabled();
  });
});

describe("diálogo de perfiles", () => {
  it("crea un perfil eligiendo el modelo de la lista y muestra el error de un nombre repetido", async () => {
    render(
      <ApiContext.Provider value={createMockApi({ autoplay: false })}>
        <ProfilesDialog onClose={() => undefined} />
      </ApiContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ Perfil nuevo" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Nombre" }), { target: { value: "Normal" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getByRole("alert").textContent).toContain("Ya hay un perfil llamado «Normal»");

    fireEvent.change(screen.getByRole("textbox", { name: "Nombre" }), { target: { value: "Ligero" } });
    // El primer «Como en Ajustes» es el disparador del modelo.
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Como en Ajustes" })[0]));
    await act(async () => fireEvent.click(screen.getByRole("option", { name: /Sonnet 5\.5/ })));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    const p = profilesStore.getState().profiles.find((x) => x.name === "Ligero");
    expect(p).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(p?.effort).toBeUndefined();
    expect(screen.getByRole("button", { name: "Borrar Ligero" })).toBeEnabled();
  });
});

describe("lanzamiento", () => {
  const past = { claudeSessionId: "conv-1", cwd: "C:\\antiguo", projectName: "a", preview: "", lastActivity: "" } as PastSession;

  it("pasa modelo, effort, permisos y carpeta del perfil a la API", async () => {
    const { api, create } = fakeApi();
    const p = saved({ name: "Web", model: "claude-sonnet-5-5", effort: "low", permissionMode: "acceptEdits", cwd: "C:\\proyectos\\web" });
    await launchWithProfile(api, { kind: "project", projectId: "web" }, p);
    expect(create).toHaveBeenCalledWith({ projectId: "web", cwd: "C:\\proyectos\\web", model: "claude-sonnet-5-5", effort: "low", permissionMode: "acceptEdits" });
  });

  it("el modo pulsado en el desplegable manda sobre el del perfil", async () => {
    const { api, create } = fakeApi();
    const p = saved({ name: "Plan", permissionMode: "plan" });
    await launchWithProfile(api, { kind: "project", projectId: "web" }, p, "default");
    expect(create.mock.calls[0][0]).toMatchObject({ permissionMode: "default" });
  });

  it("al retomar se omite la carpeta del perfil (el transcript vive en la suya)", async () => {
    const { api, create } = fakeApi();
    const p = saved({ name: "Otra carpeta", cwd: "D:\\otra", effort: "max" });
    await launchWithProfile(api, { kind: "resume", past }, p);
    expect(create.mock.calls[0][0]).toMatchObject({ cwd: "C:\\antiguo", resume: "conv-1", effort: "max" });
  });

  it("«Normal» no añade overrides", async () => {
    const { api, create } = fakeApi();
    await launchWithProfile(api, { kind: "project", projectId: "web" }, resolveProfile(profilesStore.getState(), NORMAL_ID));
    expect(create).toHaveBeenCalledWith({ projectId: "web", cwd: "" });
  });

  it("recuerda el último perfil usado, también tras releer", async () => {
    const { api } = fakeApi();
    const p = saved({ name: "Rápido", effort: "low" });
    await launchWithProfile(api, { kind: "project", projectId: "web" }, p);
    expect(lastUsedProfile().id).toBe(p.id);
    reloadProfiles();
    expect(lastUsedProfile().id).toBe(p.id);
  });

  it("Ctrl+T y «+» (newSessionHere) lanzan con el último perfil usado", async () => {
    const { api, create } = fakeApi();
    store.dispatch({ type: "sessions", sessions: [{ id: "f", cwd: "C:/aqui", projectId: "aqui", projectName: "aqui", title: "t" } as SessionInfo] });
    const p = saved({ name: "Plan", permissionMode: "plan", effort: "high" });
    markProfileUsed(p.id);
    await newSessionHere(api, "f");
    expect(create.mock.calls[0][0]).toMatchObject({ cwd: "C:/aqui", projectId: "aqui", permissionMode: "plan", effort: "high" });
    expect(newSessionTitle()).toContain("«Plan»");
  });

  it("caso negativo: con «Normal» como último, newSessionHere no añade overrides", async () => {
    const { api, create } = fakeApi();
    store.dispatch({ type: "sessions", sessions: [{ id: "f", cwd: "C:/aqui", projectId: "aqui", projectName: "aqui", title: "t" } as SessionInfo] });
    await newSessionHere(api, "f");
    expect(create).toHaveBeenCalledWith({ cwd: "C:/aqui", projectId: "aqui" });
    expect(newSessionTitle()).toBe("Sesión nueva (Ctrl+T)");
  });

  it("caso negativo: borrar el último usado vuelve a «Normal»", () => {
    const p = saved({ name: "Efímero", effort: "low" });
    markProfileUsed(p.id);
    expect(deleteProfile(p.id)).toMatchObject({ ok: true });
    expect(lastUsedProfile().id).toBe(NORMAL_ID);
    expect(resolveProfile(profilesStore.getState(), p.id).id).toBe(NORMAL_ID);
    markProfileUsed(p.id);
    expect(profilesStore.getState().lastUsed).toBe(NORMAL_ID);
  });

  it("si el backend rechaza el valor, el error se ve (no es un no-op mudo)", async () => {
    const { api } = fakeApi("el directorio de trabajo no existe: 'D:\\no'");
    const p = saved({ name: "Roto", cwd: "D:\\no" });
    await launchWithProfile(api, { kind: "project", projectId: "web" }, p);
    expect(store.getState().error).toContain("el directorio de trabajo no existe");
  });
});

describe("«+ Claude» con perfiles", () => {
  it("propone el último usado y lanza el proyecto con el perfil elegido", async () => {
    const p = saved({ name: "Sonnet", model: "claude-sonnet-5-5", effort: "medium", cwd: "D:\\sub" });
    saved({ name: "Otro", effort: "max" });
    markProfileUsed(p.id);
    const api = createMockApi({ autoplay: false });
    const create = vi.spyOn(api, "create");
    render(
      <ApiContext.Provider value={api}>
        <Sidebar onPicked={() => undefined} />
      </ApiContext.Provider>,
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "+ Claude" })));
    const group = screen.getByRole("radiogroup", { name: "Perfil de lanzamiento" });
    expect(within(group).getByRole("radio", { name: "Sonnet" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
    await act(async () => fireEvent.click(screen.getByRole("option", { name: /Web del club/ })));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ projectId: "web", cwd: "D:\\sub", model: "claude-sonnet-5-5", effort: "medium" });
  });
});
