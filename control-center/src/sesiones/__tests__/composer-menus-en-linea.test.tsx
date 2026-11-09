// Composer: menús en línea de los comandos de Sessions (`/exportar`, `/segunda-opinion`),
// Enter en la paleta y botón «Comandos». Casos negativos: un argumento inválido no
// cambia nada ni deja incidente, un comando con argumentos obligatorios no se
// ejecuta con Enter, un alias exacto no se cambia por el resaltado y con destino
// Codex no se ofrecen comandos de Claude.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { isAutoReviewOn, setAutoReview } from "../auto-review";
import { reviewKey } from "../auto-review-core";
import { Composer } from "../components/composer/Composer";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import { saveDraft } from "../components/composer/drafts";
import { argChoices, bareArgCommand, findArgTrigger, parseEngineModel, parseOnOff, ARG_MENU_COMMANDS } from "../components/composer/session-commands";
import { routeSlash } from "../components/composer/route";
import { ApiContext } from "../context";
import { store } from "../store";
import type { CommandDef, SessionInfo } from "../types";

const base: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: "claude-opus-5-5",
  startedAt: "", bridgeConnected: true, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "default", launchPermissionMode: "default", exitCode: null, bridgeProtocol: 2,
};

const DEFAULTS: Record<string, unknown> = {
  promptHistory: [], listFiles: [], commands: FALLBACK_COMMANDS, queueEnqueue: [], engineModels: [],
  send: { clientId: "x", disposition: "written" }, runCommand: { disposition: "written" },
  exportConversation: { path: "C:/p/x.md", messages: 1 },
};

function fakeApi(): SesionesApi & Record<string, ReturnType<typeof vi.fn>> {
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({ isMock: true }, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      if (!fns.has(prop)) fns.set(prop, prop === "gitSnapshot" ? vi.fn().mockRejectedValue(new Error("sin git")) : vi.fn().mockResolvedValue(DEFAULTS[prop]));
      return fns.get(prop);
    },
  }) as SesionesApi & Record<string, ReturnType<typeof vi.fn>>;
}

function setup(commands: readonly CommandDef[] = FALLBACK_COMMANDS) {
  const api = fakeApi();
  act(() => {
    store.dispatch({ type: "sessions", sessions: [base] });
    store.dispatch({ type: "commands", id: "s1", items: [...commands] });
  });
  render(<ApiContext.Provider value={api}><Composer sessionId="s1" /></ApiContext.Provider>);
  return { api, box: screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement };
}

async function type(box: HTMLElement, text: string, key: string | null = "Enter") {
  fireEvent.change(box, { target: { value: text, selectionStart: text.length } });
  if (!key) return;
  await act(async () => {
    fireEvent.keyDown(box, { key, code: key });
    await Promise.resolve();
  });
}

const notes = () => store.getState().bySession.s1?.notes ?? [];

beforeEach(() => {
  store.dispatch({ type: "reset", id: "s1" });
  setAutoReview(reviewKey(base), false);
});

describe("menús en línea de los comandos de Sessions", () => {
  it("/exportar sin argumento abre el menú de formatos sin nota; Enter exporta el resaltado", async () => {
    const { api, box } = setup();
    await type(box, "/exportar");
    expect(screen.getByRole("listbox", { name: "Argumentos de /exportar" })).toBeTruthy();
    expect(box.value).toBe("/exportar ");
    expect(notes()).toHaveLength(0);
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
      await Promise.resolve();
    });
    expect(api.exportConversation).toHaveBeenCalledWith({ id: "s1", format: "md" });
  });

  it("/segunda-opinion on enciende el mismo interruptor que la casilla de Motores", async () => {
    const { box } = setup();
    await type(box, "/segunda-opinion on");
    expect(isAutoReviewOn(reviewKey(base))).toBe(true);
    expect(notes().slice(-1)[0]?.text).toMatch(/activada/);
  });

  it("caso negativo: un argumento que no es on/off no cambia nada y deja una nota informativa", async () => {
    const { box } = setup();
    await type(box, "/segunda-opinion quizá");
    expect(isAutoReviewOn(reviewKey(base))).toBe(false);
    expect(notes().slice(-1)[0]).toMatchObject({ level: "info" });
  });
});

describe("paleta y Enter", () => {
  it("Enter sobre un comando sin argumentos lo ejecuta en vez de solo completarlo", async () => {
    const { api, box } = setup();
    await type(box, "/cos");
    expect(api.runCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "cost", args: "" }));
  });

  it("caso negativo: un comando con argumentos obligatorios solo se completa", async () => {
    const { api, box } = setup();
    await type(box, "/mejo");
    expect(api.runCommand).not.toHaveBeenCalled();
    expect(box.value).toBe("/mejorar ");
  });

  it("caso negativo: un alias exacto no se cambia por el comando resaltado", async () => {
    const extra: CommandDef = { name: "newsletter", description: "x", source: "user", kind: "prompt", needsArgs: false, immediate: false };
    const { api, box } = setup([...FALLBACK_COMMANDS, extra]);
    await type(box, "/new");
    expect(api.runCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "clear" }));
  });

  it("«Comandos» con texto pone la barra delante y lo escrito queda como argumento", async () => {
    const { box } = setup();
    await type(box, "resume lo hablado", null);
    fireEvent.click(screen.getByRole("button", { name: /Comandos/ }));
    expect(box.value).toBe("/ resume lo hablado");
    expect(screen.getByRole("listbox", { name: "Comandos" })).toBeTruthy();
  });

  it("caso negativo: con destino Codex no hay paleta de Claude ni botón «Comandos»", async () => {
    saveDraft("s1", { text: "", attachments: [], target: "codexLocal", delegate: false });
    const { box } = setup();
    await type(box, "/co", null);
    expect(screen.queryByRole("listbox", { name: "Comandos" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Comandos/ })).toBeNull();
    saveDraft("s1", { text: "", attachments: [], target: "claude", delegate: false });
  });
});

describe("session-commands (puro)", () => {
  it("parsea on/off, motor y modelo; rechaza lo que no encaja", () => {
    expect(parseOnOff("Sí")).toBe(true);
    expect(parseOnOff("off")).toBe(false);
    expect(parseOnOff("quizá")).toBeNull();
    expect(parseEngineModel("codex gpt-x")).toEqual({ engine: "codex", model: "gpt-x" });
    expect(parseEngineModel("gemini predeterminado")).toEqual({ engine: "gemini", model: "" });
    expect(parseEngineModel("claude x")).toBeNull();
    expect(parseEngineModel("codex")).toBeNull();
  });

  it("el disparador de argumentos solo abre con comandos de menú y el cursor al final", () => {
    expect(findArgTrigger("/exportar h", 11, ARG_MENU_COMMANDS)).toMatchObject({ command: "exportar", query: "h", start: 10 });
    expect(findArgTrigger("/compact h", 10, ARG_MENU_COMMANDS)).toBeNull();
    expect(findArgTrigger("/exportar h tail", 11, ARG_MENU_COMMANDS)).toBeNull();
    expect(bareArgCommand("/perfil ", ARG_MENU_COMMANDS)).toBe("perfil");
    expect(bareArgCommand("/perfil Web", ARG_MENU_COMMANDS)).toBeNull();
  });

  it("enruta los comandos propios sin mandarlos a la CLI", () => {
    expect(routeSlash("/segunda-opinion off", FALLBACK_COMMANDS, true)).toEqual({ type: "autoReview", command: "segunda-opinion", on: false });
    expect(routeSlash("/perfil Web", FALLBACK_COMMANDS, true)).toEqual({ type: "profile", command: "perfil", name: "Web" });
    expect(routeSlash("/motor-modelo codex m1", FALLBACK_COMMANDS, true)).toMatchObject({ type: "engineModel", choice: { engine: "codex", model: "m1" } });
    const choices = argChoices("motor-modelo", { autoReviewOn: false, profiles: [], engineModels: { codex: [{ id: "m1", label: "M1" }], gemini: null, opencode: [{ id: "deepseek/deepseek-flash", label: "Flash" }] } });
    expect(choices?.map((c) => c.value)).toEqual(["codex predeterminado", "codex m1", "gemini predeterminado", "opencode predeterminado", "opencode deepseek/deepseek-flash"]);
    expect(routeSlash("/motor-modelo opencode groq/llama-3.3", FALLBACK_COMMANDS, true)).toMatchObject({ choice: { engine: "opencode", model: "groq/llama-3.3" } });
  });
});
