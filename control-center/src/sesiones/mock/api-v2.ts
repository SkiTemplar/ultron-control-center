// Mock de los comandos v0.2 (contrato v2): ajustes del HUD, historial,
// catálogo, mods, bitácora y motores con intervenciones que
// avanzan solas. `?sinMotor=gemini` simula Gemini no instalado.

import type { SesionesApi } from "../api";
import type { ChatMessage, EngineTask, SesionesEventName, SesionesEvents, SessionId, SessionInfo, SessionSettings } from "../types";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import * as V from "./data-v2";

interface Deps {
  emit<K extends SesionesEventName>(event: K, payload: SesionesEvents[K]): void;
  addMessages(id: SessionId, list: ChatMessage[]): void;
  uid(prefix: string): string;
  sessions(): SessionInfo[];
  create(projectId: string): Promise<SessionInfo>;
}

type V2Keys =
  | "launch" | "projects" | "settings" | "setEffort" | "setModel" | "setSocratic" | "promptHistory" | "commands"
  | "bitacora" | "engines" | "engineRun" | "engineBring" | "engineCancel" | "engineList" | "engineClear" | "engineContrast" | "engineModels" | "transcribe";

const OPINION_SUMMARY = "Coincido en lo esencial. Dos matices: falta un caso límite de **60 columnas** y conviene medir el texto en `stringWidth` para los emojis del panel.";
const TASK_SUMMARY = "Hecho en el mismo cwd: cambio pequeño en `api.ts` (+6 −2) y tests en verde. No he tocado nada más.";

function withoutGemini(): boolean {
  return new URLSearchParams(window.location.search).get("sinMotor") === "gemini";
}

export function createV2Mock(deps: Deps): Pick<SesionesApi, V2Keys> & { tick(): void } {
  const settings = new Map<SessionId, SessionSettings>(Object.entries(V.SETTINGS).map(([k, v]) => [k, { ...v }]));
  let tasks: EngineTask[] = V.ENGINE_TASKS.map((t) => ({ ...t }));
  const engines = V.engineStatus(withoutGemini());

  function settingsOf(id: SessionId): SessionSettings {
    const s = deps.sessions().find((x) => x.id === id);
    return settings.get(id) ?? { model: s?.model ?? null, effort: "high", permissionMode: "default", socratic: "strict", projectId: s?.projectId ?? null, launchPermissionMode: "bypassPermissions" };
  }

  function finishTask(id: string): void {
    tasks = tasks.map((t) => (t.id === id && t.status === "running"
      ? { ...t, status: "done", finishedAt: new Date().toISOString(), usage: t.engine === "codex" ? { inputTokens: 18400, cachedInputTokens: 12000, outputTokens: 640 } : undefined, summary: t.kind === "opinion" ? OPINION_SUMMARY : TASK_SUMMARY, events: [...t.events, { kind: t.engine === "codex" ? "patch" : "message", text: t.engine === "codex" ? "src/sesiones/api.ts · +6 −2" : "Respuesta lista." }] }
      : t));
    const done = tasks.find((t) => t.id === id);
    if (done) deps.emit("sesiones://engine", done);
  }

  return {
    // Las intervenciones en curso avanzan con el temporizador de la demo.
    tick() {
      tasks = tasks.map((t) => (t.status === "running" && t.events.length < 8
        ? { ...t, events: [...t.events, { kind: "message" as const, text: `Paso ${t.events.length + 1}: comprobando casos límite.` }] }
        : t));
      tasks.filter((t) => t.status === "running").forEach((t) => deps.emit("sesiones://engine", t));
    },
    launch: (projectId) => deps.create(projectId),
    // Rutas con `\\` escapada: con una sola, «C:\Users» perdía las barras.
    projects: async () => [
      { id: "render-lab", name: "render-lab", path: "D:\\proyectos\\render-lab" },
      { id: "skills-ultron", name: "skills-ultron", path: "C:\\Users\\demo\\.ultron\\skills", lastActive: new Date(Date.now() - 30 * 3_600_000).toISOString() },
      { id: "ultron", name: "ultron", path: "C:\\Users\\demo\\.ultron", lastActive: new Date(Date.now() - 1 * 3_600_000).toISOString() },
      { id: "tfg", name: "TFG", path: "C:\\Users\\demo\\Carrera\\TFG", lastActive: new Date(Date.now() - 5 * 3_600_000).toISOString() },
      { id: "isw", name: "ISW — Ingeniería del Software", path: "C:\\Users\\demo\\Carrera\\ISW" },
      { id: "dvj", name: "DVJ — Diseño de Videojuegos", path: "C:\\Users\\demo\\Carrera\\DVJ" },
      { id: "juego", name: "Juego de cartas", path: "C:\\Users\\demo\\Personal\\juego" },
      { id: "web", name: "Web del club", path: "C:\\Users\\demo\\Personal\\web" },
    ],
    settings: async (id) => settingsOf(id),
    async setEffort({ id, effort }) {
      if (effort === "max") throw new Error("El effort «max» solo se aplica a sesiones nuevas: Claude Code no lo cambia en caliente.");
      settings.set(id, { ...settingsOf(id), effort });
      return { ok: true, text: `Effort: ${effort}` };
    },
    async setModel({ id, model }) {
      // Igual que `valid_model_55` de ajustes.rs: Haiku 5.5 va sin ventana de 1M.
      if (!/^claude-(?:(?:opus|sonnet)-5-5(?:\[1m\])?|haiku-5-5)$/.test(model)) throw new Error(`Modelo fuera de la familia 5.5: ${model}`);
      if (!deps.sessions().some((x) => x.id === id)) throw new Error("Sesión desconocida");
      settings.set(id, { ...settingsOf(id), model });
      deps.emit("sesiones://status", { id, model, contextTokens: 168000, contextWindow: model.endsWith("[1m]") ? 1000000 : 200000, costUsd: 3.42, mode: settingsOf(id).permissionMode ?? "auto" });
      return { ok: true, text: `Modelo: ${model}` };
    },
    async setSocratic({ projectId, mode }) {
      deps.sessions().filter((s) => s.projectId === projectId).forEach((s) => settings.set(s.id, { ...settingsOf(s.id), socratic: mode }));
    },
    promptHistory: async () => V.PROMPT_HISTORY,
    // Catálogo vivo simulado: los integrados de 2.1.293 más los mods, skills y plugins de la demo.
    commands: async () => [...FALLBACK_COMMANDS.filter((c) => c.source === "builtin"), ...V.COMMANDS.filter((c) => c.source !== "builtin")],
    bitacora: async () => V.BITACORA,
    engines: async () => engines,
    async engineRun({ sessionId, engine, prompt, kind, mode, includeContext, model, group }) {
      const st = engines.find((e) => e.id === engine);
      if (!st?.available) throw new Error(st?.reason ?? `${engine} no disponible`);
      const cwd = deps.sessions().find((s) => s.id === sessionId)?.cwd ?? "";
      const task: EngineTask = {
        id: deps.uid(engine === "codex" ? "cx" : "gm"), engine, kind, mode: mode ?? "local", cwd, prompt, sessionId, contextChars: includeContext ? 18400 : 0, model, group,
        status: "running", startedAt: new Date().toISOString(), events: [{ kind: "message", text: "Leyendo el contexto del hilo (24 000 caracteres máx.)…" }],
      };
      tasks = [task, ...tasks];
      deps.emit("sesiones://engine", task);
      window.setTimeout(() => finishTask(task.id), 3500);
      return task;
    },
    async engineBring({ taskId, sessionId }) {
      const t = tasks.find((x) => x.id === taskId);
      if (!t) throw new Error("Intervención desconocida");
      const who = t.engine === "codex" ? "Codex" : "Gemini";
      const text = `Resultado de ${who} (${t.kind === "opinion" ? "segunda opinión" : t.prompt}):\n${t.summary ?? "sin resumen"}`;
      deps.addMessages(sessionId, [{ uuid: deps.uid("u"), role: "user", timestamp: new Date().toISOString(), agentId: null, blocks: [{ kind: "text", text }] }]);
      const brought = { ...t, broughtAt: new Date().toISOString() };
      tasks = tasks.map((x) => (x.id === taskId ? brought : x));
      deps.emit("sesiones://engine", brought);
    },
    async engineCancel(taskId) {
      tasks = tasks.map((t) => (t.id === taskId ? { ...t, status: "cancelled", finishedAt: new Date().toISOString() } : t));
      const t = tasks.find((x) => x.id === taskId);
      if (t) deps.emit("sesiones://engine", t);
    },
    engineList: async () => tasks,
    async engineClear(sessionId) {
      // Como el backend: los tribunales con un miembro en curso no se parten.
      const vivos = new Set(tasks.filter((t) => t.status === "running" && t.group).map((t) => t.group));
      tasks = tasks.filter((t) => t.status === "running" || (t.group && vivos.has(t.group)) || (t.sessionId !== undefined && t.sessionId !== sessionId));
      deps.emit("sesiones://engine-list", tasks);
      return tasks;
    },
    async engineContrast({ group, sessionId }) {
      const grupo = tasks.filter((t) => t.group === group);
      if (grupo.length < 2 || grupo.some((t) => t.status !== "done" || t.broughtAt)) throw new Error("El tribunal necesita dos respuestas terminadas y sin traer");
      const text = ["Contrasta estas respuestas de otros motores al mismo encargo:", ...grupo.map((t) => `<${t.engine}>\n${t.summary ?? "sin resumen"}\n</${t.engine}>`)].join("\n\n");
      deps.addMessages(sessionId, [{ uuid: deps.uid("u"), role: "user", timestamp: new Date().toISOString(), agentId: null, blocks: [{ kind: "text", text }] }]);
      const now = new Date().toISOString();
      tasks = tasks.map((t) => (t.group === group ? { ...t, broughtAt: now } : t));
      grupo.forEach((t) => deps.emit("sesiones://engine", { ...t, broughtAt: now }));
    },
    engineModels: async (engine) =>
      engine === "codex"
        ? [{ id: "gpt-6-astra", label: "GPT-6-Astra" }, { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }]
        : engine === "opencode"
          ? [{ id: "deepseek/deepseek-flash", label: "DeepSeek V4.1 Flash" }, { id: "groq/llama-3.3-70b-versatile", label: "llama-3.3-70b-versatile" }]
          : [{ id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" }, { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" }],
    transcribe: async () => "texto dictado de prueba",
  };
}
