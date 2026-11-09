// Motores (14-10): solo las tareas de la sesión, «Limpiar», Tribunal con
// «Contrastar en Claude», plantillas, tokens de Codex, aviso de la CLI de
// Gemini y la parte pura de la segunda opinión automática.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { editedFiles, hasRunningReview, isCleanReview, MAX_REMEMBERED, mergeFiles, rememberBounded, reviewKey, reviewPrompt, sanitizeKeys, visibleInChat } from "../auto-review-core";
import { Motores, tasksOfSession } from "../components/inspector/Motores";
import { ApiContext } from "../context";
import { applyTemplate, ENGINE_TEMPLATES } from "../engine-templates";
import { canContrast, formatUsage, groupTribunals, resetEngineModelsCache, runTribunal } from "../engines";
import { SESSIONS } from "../mock/data";
import { store } from "../store";
import type { ChatMessage, EngineRunArgs, EngineStatus, EngineTask } from "../types";

const S = SESSIONS[0];
const now = new Date().toISOString();

function task(over: Partial<EngineTask>): EngineTask {
  return { id: "t", engine: "codex", kind: "task", mode: "local", cwd: "C:/p", prompt: "x", status: "done", startedAt: now, events: [], sessionId: S.id, ...over };
}

/** API de prueba: lo que no se pasa rechaza con un error explícito. */
function fakeApi(overrides: Partial<Record<keyof SesionesApi, unknown>>): SesionesApi {
  return new Proxy({ isMock: true } as unknown as SesionesApi, {
    get(target, key: string) {
      if (key in overrides) return overrides[key as keyof SesionesApi];
      if (key in target) return (target as unknown as Record<string, unknown>)[key];
      return () => Promise.reject(new Error(`${key}: no implementado en el test`));
    },
  });
}

const withApi = (api: SesionesApi, node: ReactNode) => <ApiContext.Provider value={api}>{node}</ApiContext.Provider>;
const READY: EngineStatus[] = [
  { id: "codex", available: true, version: "codex 0.154" },
  { id: "gemini", available: true, version: "agy 1.2", note: "Se usa gemini-cli de npm porque no está agy" },
];

beforeEach(() => {
  resetEngineModelsCache();
  store.dispatch({ type: "engineList", tasks: [] });
});

describe("lista de tareas de Motores", () => {
  it("solo enseña las tareas de la sesión (caso negativo: otra sesión no aparece)", () => {
    const mia = task({ id: "a" });
    const ajena = task({ id: "b", sessionId: "otra" });
    const huerfana = task({ id: "c", sessionId: undefined });
    expect(tasksOfSession([mia, ajena, huerfana], S).map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("sin sesión no enseña tareas de otras sesiones", () => {
    store.dispatch({ type: "engineList", tasks: [task({ id: "vieja", prompt: "de otra sesión" })] });
    expect(tasksOfSession([task({ id: "a" })], null)).toEqual([]);
    render(withApi(fakeApi({ engines: async () => READY }), <Motores session={null} />));
    expect(screen.queryByText("de otra sesión")).toBeNull();
    expect(screen.getByText(/Elige una sesión para ver sus intervenciones/)).toBeTruthy();
  });

  it("«Limpiar» pide al backend borrar las terminadas y pinta lo que queda", async () => {
    const viva = task({ id: "viva", status: "running" });
    store.dispatch({ type: "engineList", tasks: [task({ id: "vieja", prompt: "tarea vieja" }), viva] });
    const engineClear = vi.fn(async () => [viva]);
    render(withApi(fakeApi({ engineClear, engines: async () => READY }), <Motores session={S} />));
    expect(screen.getByText("tarea vieja")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Limpiar" })));
    expect(engineClear).toHaveBeenCalledWith(S.id);
    await waitFor(() => expect(screen.queryByText("tarea vieja")).toBeNull());
  });

  it("enseña los tokens de Codex y el aviso de la CLI de Gemini", async () => {
    store.dispatch({ type: "engineList", tasks: [task({ id: "u", usage: { inputTokens: 18400, cachedInputTokens: 12000, outputTokens: 640 } })] });
    render(withApi(fakeApi({ engines: async () => READY }), <Motores session={S} />));
    expect(screen.getByText(/18,4k → 640 tokens/)).toBeTruthy();
    expect(await screen.findByTestId("engine-note-gemini")).toBeTruthy();
  });
});

describe("Tribunal", () => {
  it("lanza Codex y Gemini con el mismo grupo", async () => {
    const engineRun = vi.fn(async (a: EngineRunArgs) => task({ id: a.engine, engine: a.engine, group: a.group, status: "running" }));
    const tasks = await runTribunal(fakeApi({ engineRun, engineModels: async () => [] }), { sessionId: S.id, prompt: "¿bug?", includeContext: true });
    expect(tasks).toHaveLength(2);
    const [a, b] = engineRun.mock.calls.map((c) => c[0]);
    expect([a.engine, b.engine].sort()).toEqual(["codex", "gemini"]);
    expect(a.group).toBeTruthy();
    expect(a.group).toBe(b.group);
  });

  it("agrupa las tareas del tribunal y solo deja contrastar con las dos terminadas", () => {
    const c = task({ id: "c", group: "g" });
    const g = task({ id: "g", engine: "gemini", group: "g", status: "running" });
    const sola = task({ id: "s" });
    const grupos = groupTribunals([c, sola, g]);
    expect(grupos).toEqual([[c, g], sola]);
    expect(canContrast([c, g])).toBe(false);
    expect(canContrast([c, { ...g, status: "done" }])).toBe(true);
    expect(canContrast([c, { ...g, status: "done", broughtAt: now }])).toBe(false);
  });

  it("«Contrastar en Claude» manda el grupo a la sesión", async () => {
    store.dispatch({ type: "engineList", tasks: [task({ id: "c", group: "g1", prompt: "revisa" }), task({ id: "g", engine: "gemini", group: "g1", prompt: "revisa" })] });
    const engineContrast = vi.fn(async () => undefined);
    render(withApi(fakeApi({ engineContrast, engines: async () => READY }), <Motores session={S} />));
    const card = screen.getByTestId("engine-tribunal");
    expect(within(card).getAllByTestId("engine-task")).toHaveLength(2);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Contrastar en Claude" })));
    expect(engineContrast).toHaveBeenCalledWith({ group: "g1", sessionId: S.id });
  });
});

describe("plantillas y tokens", () => {
  it("una plantilla sustituye el borrador vacío o lo completa", () => {
    const bug = ENGINE_TEMPLATES.find((t) => t.id === "bug");
    const diff = ENGINE_TEMPLATES.find((t) => t.id === "diff");
    if (!bug || !diff) throw new Error("faltan plantillas");
    expect(applyTemplate("  ", diff)).toBe(diff.text);
    expect(applyTemplate("el login falla", bug)).toBe(`${bug.text}el login falla`);
    expect(applyTemplate("ojo con api.ts", diff)).toBe(`${diff.text}\n\nojo con api.ts`);
  });

  it("sin uso no hay texto de tokens (Gemini por agy)", () => {
    expect(formatUsage(task({ engine: "gemini" }))).toBeNull();
    expect(formatUsage(task({ usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 12 } }))).toBe("900 → 12 tokens");
  });
});

describe("segunda opinión automática (parte pura)", () => {
  const msg = (ts: string, name: string, input: unknown): ChatMessage => ({
    uuid: `${ts}-${name}`, role: "assistant", timestamp: ts, agentId: null,
    blocks: [{ kind: "toolUse", id: "x", name, input, summary: "" }],
  });

  it("cuenta los ficheros distintos editados desde el inicio del turno", () => {
    const antes = msg("2026-10-14T10:00:00Z", "Edit", { file_path: "a.ts" });
    const list = [
      antes,
      msg("2026-10-14T10:05:00Z", "Edit", { file_path: "b.ts" }),
      msg("2026-10-14T10:05:01Z", "Write", { file_path: "b.ts" }),
      msg("2026-10-14T10:05:02Z", "NotebookEdit", { notebook_path: "n.ipynb" }),
      msg("2026-10-14T10:05:03Z", "Read", { file_path: "c.ts" }),
    ];
    expect(editedFiles(list, "2026-10-14T10:01:00Z")).toEqual(["b.ts", "n.ipynb"]);
    expect(mergeFiles(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(reviewPrompt(["b.ts"])).toContain("- b.ts");
  });

  it("una revisión limpia no sale en el chat; una con hallazgos o fallida, sí", () => {
    expect(isCleanReview("**SIN HALLAZGOS.**")).toBe(true);
    expect(isCleanReview("Sin hallazgos graves, pero api.ts:12 pierde el error")).toBe(false);
    expect(visibleInChat(task({ kind: "review", summary: "SIN HALLAZGOS" }))).toBe(false);
    expect(visibleInChat(task({ kind: "review", status: "running" }))).toBe(false);
    expect(visibleInChat(task({ kind: "review", summary: "api.ts:12 pierde el error" }))).toBe(true);
    expect(visibleInChat(task({ kind: "review", status: "error" }))).toBe(true);
    expect(visibleInChat(task({ kind: "task", summary: "SIN HALLAZGOS" }))).toBe(true);
  });

  it("la clave del interruptor es la conversación y lo guardado se sanea", () => {
    expect(reviewKey({ id: "s", claudeSessionId: "c" })).toBe("c");
    expect(reviewKey({ id: "s", claudeSessionId: null })).toBe("s");
    expect(sanitizeKeys(["a", "a", 3, "", "b"])).toEqual(["a", "b"]);
    expect(sanitizeKeys("basura")).toEqual([]);
  });
});

describe("segunda opinión automática (disparo)", () => {
  const edits = (n: number): ChatMessage[] => Array.from({ length: n }, (_, i) => ({
    uuid: `e${i}`, role: "assistant", timestamp: "2026-10-14T10:05:00Z", agentId: null,
    blocks: [{ kind: "toolUse", id: `t${i}`, name: "Edit", input: { file_path: `f${i}.ts` }, summary: "" }],
  }));
  const turn = (turnId: string) => ({ id: S.id, turnId, startedAt: "2026-10-14T10:00:00Z", endedAt: "2026-10-14T10:06:00Z", durationMs: 1, reason: "answer" as const });

  it("con el interruptor apagado no lanza nada; encendido y 5 ficheros, revisa con Codex", async () => {
    const { maybeAutoReview, setAutoReview } = await import("../auto-review");
    store.dispatch({ type: "sessions", sessions: [S] });
    store.dispatch({ type: "messages", id: S.id, messages: edits(5) });
    store.dispatch({ type: "engineStatus", engines: READY });
    const engineRun = vi.fn(async (a: EngineRunArgs) => task({ id: "r", kind: a.kind, status: "running" }));
    const api = fakeApi({ engineRun, engineModels: async () => [] });
    setAutoReview(reviewKey(S), false);
    expect(await maybeAutoReview(api, turn("t-off"), 0)).toBeNull();
    expect(engineRun).not.toHaveBeenCalled();
    setAutoReview(reviewKey(S), true);
    await maybeAutoReview(api, turn("t-on"), 0);
    expect(engineRun).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex", kind: "review" }));
    expect(await maybeAutoReview(api, turn("t-on"), 0)).toBeNull();
    expect(engineRun).toHaveBeenCalledTimes(1);
    setAutoReview(reviewKey(S), false);
  });

  it("manda el turno como clave idempotente y omite si ya hay una revisión en curso en la sesión", async () => {
    const { maybeAutoReview, setAutoReview } = await import("../auto-review");
    store.dispatch({ type: "sessions", sessions: [S] });
    store.dispatch({ type: "messages", id: S.id, messages: edits(5) });
    store.dispatch({ type: "engineStatus", engines: READY });
    const engineRun = vi.fn(async (a: EngineRunArgs) => task({ id: "r2", kind: a.kind, status: "running" }));
    const api = fakeApi({ engineRun, engineModels: async () => [] });
    setAutoReview(reviewKey(S), true);
    await maybeAutoReview(api, turn("t-clave"), 0);
    expect(engineRun).toHaveBeenCalledWith(expect.objectContaining({ kind: "review", turnId: "t-clave" }));
    // La revisión anterior sigue en curso: el turno siguiente no lanza otra.
    expect(await maybeAutoReview(api, turn("t-siguiente"), 0)).toBeNull();
    expect(engineRun).toHaveBeenCalledTimes(1);
    store.dispatch({ type: "engine", task: task({ id: "r2", kind: "review", status: "done" }) });
    await maybeAutoReview(api, turn("t-despues"), 0);
    expect(engineRun).toHaveBeenCalledTimes(2);
    setAutoReview(reviewKey(S), false);
  });

  it("apagar el interruptor en otra ventana (evento storage) lo apaga en esta", async () => {
    const { isAutoReviewOn, maybeAutoReview, setAutoReview, STORAGE_KEY } = await import("../auto-review");
    store.dispatch({ type: "sessions", sessions: [S] });
    store.dispatch({ type: "messages", id: S.id, messages: edits(5) });
    store.dispatch({ type: "engineStatus", engines: READY });
    setAutoReview(reviewKey(S), true);
    expect(isAutoReviewOn(reviewKey(S))).toBe(true);
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: JSON.stringify([]) }));
    expect(isAutoReviewOn(reviewKey(S))).toBe(false);
    const engineRun = vi.fn();
    expect(await maybeAutoReview(fakeApi({ engineRun }), turn("t-otra-ventana"), 0)).toBeNull();
    expect(engineRun).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: JSON.stringify([reviewKey(S)]) }));
    expect(isAutoReviewOn(reviewKey(S))).toBe(true);
    // Caso negativo: otra clave de localStorage no toca el interruptor.
    window.dispatchEvent(new StorageEvent("storage", { key: "otra", newValue: "[]" }));
    expect(isAutoReviewOn(reviewKey(S))).toBe(true);
    setAutoReview(reviewKey(S), false);
  });

  it("los turnos recordados tienen tope y descartan los más antiguos", () => {
    const set = new Set<string>();
    for (let i = 0; i < 510; i++) rememberBounded(set, `t${i}`);
    expect(set.size).toBe(MAX_REMEMBERED);
    expect(set.has("t0")).toBe(false);
    expect(set.has("t509")).toBe(true);
    expect(hasRunningReview([task({ kind: "review", status: "running" })], S.id)).toBe(true);
    expect(hasRunningReview([task({ kind: "review", status: "running", sessionId: "otra" })], S.id)).toBe(false);
    expect(hasRunningReview([task({ kind: "task", status: "running" })], S.id)).toBe(false);
  });

  it("cuenta los ficheros del transcript aunque la ventana haya podado los mensajes", async () => {
    const { maybeAutoReview, setAutoReview } = await import("../auto-review");
    const S3 = { ...S, id: "s-podada", claudeSessionId: null };
    store.dispatch({ type: "sessions", sessions: [S3] });
    store.dispatch({ type: "engineStatus", engines: READY });
    // La ventana solo conserva dos ediciones; el transcript tiene seis (una repetida).
    store.dispatch({ type: "messages", id: S3.id, messages: edits(2) });
    const turnEdits = vi.fn(async () => ["f0.ts", "a.ts", "b.ts", "c.ts", "d.ts"]);
    const engineRun = vi.fn(async (a: EngineRunArgs) => task({ id: "r3", kind: a.kind, status: "running", sessionId: S3.id }));
    setAutoReview(reviewKey(S3), true);
    await maybeAutoReview(fakeApi({ engineRun, turnEdits, engineModels: async () => [] }), { ...turn("t-podada"), id: S3.id }, 0);
    expect(turnEdits).toHaveBeenCalledWith(S3.id, "2026-10-14T10:00:00Z");
    expect(engineRun).toHaveBeenCalledTimes(1);
    const prompt = engineRun.mock.calls[0][0].prompt;
    expect(prompt).toContain("(6)");
    expect(prompt).toContain("- f1.ts");
    setAutoReview(reviewKey(S3), false);
  });

  it("si el backend no puede leer el transcript, avisa y cuenta solo la ventana", async () => {
    const { maybeAutoReview, setAutoReview } = await import("../auto-review");
    const S4 = { ...S, id: "s-sin-transcript", claudeSessionId: null };
    store.dispatch({ type: "sessions", sessions: [S4] });
    store.dispatch({ type: "messages", id: S4.id, messages: edits(4) });
    const engineRun = vi.fn();
    const turnEdits = vi.fn(async () => { throw new Error("sin transcript"); });
    setAutoReview(reviewKey(S4), true);
    expect(await maybeAutoReview(fakeApi({ engineRun, turnEdits }), { ...turn("t-sin"), id: S4.id }, 0)).toBeNull();
    expect(engineRun).not.toHaveBeenCalled();
    const notes = store.getState().bySession[S4.id]?.notes ?? [];
    expect(notes.some((n) => /no se pudo leer el transcript/.test(n.text))).toBe(true);
    setAutoReview(reviewKey(S4), false);
  });

  it("con menos de 5 ficheros no revisa (caso negativo)", async () => {
    const { maybeAutoReview, setAutoReview } = await import("../auto-review");
    const S2 = { ...S, id: "s-pocos", claudeSessionId: null };
    store.dispatch({ type: "sessions", sessions: [S2] });
    store.dispatch({ type: "messages", id: S2.id, messages: edits(4) });
    const engineRun = vi.fn();
    setAutoReview(reviewKey(S2), true);
    expect(await maybeAutoReview(fakeApi({ engineRun }), { ...turn("t-pocos"), id: S2.id }, 0)).toBeNull();
    expect(engineRun).not.toHaveBeenCalled();
    setAutoReview(reviewKey(S2), false);
  });
});
