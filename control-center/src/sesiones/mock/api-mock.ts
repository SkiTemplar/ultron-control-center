// Adaptador mock: demo viva sin backend y base del e2e. El backend simulado
// (`sim.ts`, `menus.ts`, `streamer.ts`) reproduce el orden y los estados reales;
// los comandos v0.2 viven en api-v2.ts y los v3 en api-v3.ts.
// `?confianza=1`: las sesiones nuevas arrancan con el diálogo de confianza.

import type { SesionesApi, Unlisten } from "../api";
import { NETWORK_PATH_BLOCKED, isNetworkPath } from "../components/inspector/rutas-sesion";
import type { Ask, ChatMessage, CreateSessionArgs, SesionesEventName, SesionesEvents, SessionId, SessionInfo } from "../types";
import { mergeMessages } from "../parse";
import { createEngineSessionMock } from "./api-engine-session";
import { createV2Mock } from "./api-v2";
import { createV3Mock, pending } from "./api-v3";
import * as D from "./data";
import { LONG_SESSION_ID, longConversation, longSession, pageOf } from "./history";
import { createSim } from "./sim";
import { terminalScreen, utf8ToBase64 } from "./terminal";
import { demoRun, WORKFLOW_MESSAGES } from "./workflow-demo";
import { STREAM_80_COLS, USAGE_IMAGE } from "./texts";

type Listener = (payload: never) => void;

const OLDER_PAGE_MS = 250;
const param = (name: string) => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(name));

/**
 * `autoplay: false` no arranca la demo (el streaming de s-mods y el latido de
 * subagentes): los tests que solo usan la API no dejan temporizadores vivos que
 * disparen tras desmontar el entorno («window is not defined», CI 2026-11-02).
 */
export function createMockApi({ autoplay = true }: { autoplay?: boolean } = {}): SesionesApi {
  const listeners = new Map<string, Set<Listener>>();
  const long = Number(param("largo") ?? 0);
  let sessions: SessionInfo[] = [...D.SESSIONS.map((s) => ({ ...s })), ...(long > 0 ? [longSession()] : [])];
  const messages = new Map<SessionId, ChatMessage[]>([
    ["s-mods", param("workflow") ? [...D.MODS_MESSAGES, ...WORKFLOW_MESSAGES] : D.MODS_MESSAGES], ["s-review", D.REVIEW_MESSAGES], ["s-practica", D.PRACTICA_MESSAGES],
    ...(long > 0 ? [[LONG_SESSION_ID, longConversation(long)] as [SessionId, ChatMessage[]]] : []),
  ]);
  let agents = D.MODS_AGENTS.map((a) => ({ ...a }));
  let workflowStep = param("workflow") ? 1 : 0;
  let git = D.GIT;
  let gitLog = D.GIT_LOG;
  const images = new Map<string, string>();
  const asks = new Map<string, Ask>([[D.REVIEW_ASK.askId, D.REVIEW_ASK]]);
  let seq = 0;
  const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;

  function emit<K extends SesionesEventName>(event: K, payload: SesionesEvents[K]): void {
    listeners.get(event)?.forEach((l) => (l as (p: SesionesEvents[K]) => void)(payload));
  }

  function emitPty(id: SessionId, text: string): void {
    const b64 = utf8ToBase64(text);
    listeners.get(`sesiones://pty/${id}`)?.forEach((l) => (l as (p: string) => void)(b64));
  }

  function patch(id: SessionId, change: Partial<SessionInfo>): void {
    sessions = sessions.map((s) => (s.id === id ? { ...s, ...change, lastActivityAt: new Date().toISOString() } : s));
    emit("sesiones://sessions", sessions);
  }

  function addMessages(id: SessionId, list: ChatMessage[]): void {
    messages.set(id, [...(messages.get(id) ?? []), ...list]);
    emit("sesiones://messages", { id, messages: list });
  }

  const sim = createSim({ emit, addMessages, uid, sessions: () => sessions, patch, asks, emitPty });
  const v2 = createV2Mock({ emit, addMessages, uid, sessions: () => sessions, create: (projectId) => createSession({ projectId, cwd: D.CWD_ULTRON }) });
  const v3 = createV3Mock({ sim, asks, sessions: () => sessions, patch });
  function upsertMessages(id: SessionId, list: ChatMessage[]): void {
    messages.set(id, mergeMessages(messages.get(id) ?? [], list));
    emit("sesiones://messages", { id, messages: list });
  }

  const engineSessions = createEngineSessionMock({
    emit, uid, sessions: () => sessions, engines: () => v2.engines(), upsertMessages,
    setSessions: (next) => {
      sessions = next;
      emit("sesiones://sessions", sessions);
    },
  });

  async function createSession(args: CreateSessionArgs): Promise<SessionInfo> {
    const mode = args.permissionMode ?? "bypassPermissions";
    const info: SessionInfo = {
      id: uid("s"), projectId: args.projectId ?? null, projectName: args.projectId ?? "ultron", cwd: args.cwd || D.CWD_ULTRON,
      title: args.resume ? "Sesión reanudada" : "Nueva sesión", claudeSessionId: args.resume ?? uid("conv"),
      status: "starting", model: args.model ?? "claude-opus-5-5", startedAt: new Date().toISOString(), bridgeConnected: false,
      ...D.liveFields(mode), screen: "unknown", bridgeProtocol: 0, launchPermissionMode: mode,
    };
    sessions = [...sessions, info];
    messages.set(info.id, []);
    emit("sesiones://sessions", sessions);
    window.setTimeout(() => {
      // `sinpuente=1`: el mod ultron-puente no dice hello (sesión solo por pantalla).
      if (param("sinpuente") !== "1") patch(info.id, { bridgeConnected: true, bridgeProtocol: 2 });
      if (param("confianza") === "1") sim.wait(info.id, { kind: "trust", label: "Confiar en la carpeta", since: new Date().toISOString(), options: [{ index: 0, label: "Sí, confiar", selected: true }, { index: 1, label: "No, salir", selected: false }] }, "trust");
      else sim.idle(info.id);
      emit("sesiones://status", { id: info.id, model: info.model ?? "", contextTokens: 18000, contextWindow: 1000000, costUsd: 0.04, mode });
    }, 1500);
    return info;
  }

  // Arranque de la demo: la primera sesión está respondiendo en directo.
  if (autoplay) window.setTimeout(() => {
    sim.streamer.reply("s-mods", STREAM_80_COLS, {
      chunkMs: 55,
      tool: { name: "Bash", summary: "npx tsx scripts/render-uso.ts --cols 80" },
      onStart: (turnId) => sim.working("s-mods", turnId),
      onDone: () => sim.idle("s-mods"),
    });
  }, 400);

  // Subagentes y Codex avanzan solos mientras la ventana está abierta.
  if (autoplay) window.setInterval(() => {
    agents = agents.map((a) => (a.status === "running" ? { ...a, turns: a.turns + 1, tokens: a.tokens + 1800 } : a));
    emit("sesiones://agents", { id: "s-mods", agents });
    if (workflowStep > 0 && workflowStep <= 5) emit("sesiones://workflow", { id: "s-mods", run: demoRun((workflowStep += 1)) });
    v2.tick();
  }, 4000);

  // Solo el estado de la barra se repite al suscribirse; las preguntas se piden con `pending_asks`.
  const replay: Partial<Record<SesionesEventName, () => void>> = {
    "sesiones://status": () => D.STATUS.forEach((s) => emit("sesiones://status", { ...s, mode: sessions.find((x) => x.id === s.id)?.permissionMode ?? undefined })),
  };

  return {
    isMock: true,
    relayList: async () => [],
    relaySwitchGemini: async () => { throw new Error("no hay relevo activo en la demo"); },
    relayReturn: async () => undefined,
    ...v2,
    ...v3,
    engineSessionCreate: engineSessions.engineSessionCreate,
    engineSessionSend: engineSessions.engineSessionSend,
    engineSessionInterrupt: engineSessions.engineSessionInterrupt,
    engineSessionPast: engineSessions.engineSessionPast,
    list: async () => sessions,
    past: async () => D.PAST,
    create: createSession,
    async send({ id, text, attachments, clientId, mode }) {
      const s = sessions.find((x) => x.id === id);
      if (!s || s.status === "exited") throw new Error("la sesión terminó");
      const item = { clientId, text, attachments, delegate: false, kind: "prompt" as const };
      if (mode === "now" && s.status === "working") {
        sim.enqueue(id, item);
        const queued = sim.queues.get(id)?.find((q) => q.clientId === clientId);
        if (queued) sim.absorb(id, queued);
        return { clientId, disposition: "written" };
      }
      const busy = s.status !== "idle" || (sim.queues.get(id) ?? []).some((q) => q.state === "queued" || q.state === "sending");
      sim.enqueue(id, item);
      return { clientId, disposition: busy ? "queued" : "written" };
    },
    key: async () => undefined,
    recover: async ({ id, action }) => sim.recover(id, action),
    async terminalInput({ id, data }) {
      if (sim.menus.key(id, data)) return;
      const typed = /^\/([\w:.-]+)\s*(.*)\r$/.exec(data);
      if (typed) {
        sim.commands.run(id, typed[1], typed[2]);
        return;
      }
      emitPty(id, data === "\r" ? "\r\n> " : data);
    },
    async kill(id) {
      if (engineSessions.close(id)) return;
      sessions = sessions.filter((s) => s.id !== id);
      emit("sesiones://sessions", sessions);
    },
    async rename({ id, title }) {
      patch(id, { title });
    },
    async history({ id, agentId, beforeUuid, limit }) {
      // Como el IPC real, una página anterior tarda un poco: la cabecera «cargando» se llega a ver.
      if (beforeUuid) await new Promise((r) => window.setTimeout(r, OLDER_PAGE_MS));
      if (!agentId) return pageOf(messages.get(id) ?? [], beforeUuid, limit);
      if (agentId === "a-reviewer") return pageOf(D.REVIEWER_MESSAGES, beforeUuid, limit);
      const node = agents.find((a) => a.agentId === agentId);
      return pageOf(node ? [{ uuid: `h-${agentId}`, role: "assistant", timestamp: node.startedAt, agentId, blocks: [{ kind: "text", text: `**${node.type}** · ${node.description}\n\nTranscript resumido del subagente: ${node.turns} turnos.` }] }] : [], beforeUuid, limit);
    },
    agents: async (id) => (id === "s-mods" ? agents : []),
    workflows: async (id) => (id === "s-mods" && workflowStep > 0 ? [demoRun(workflowStep)] : []),
    terminalAttach: async (id) => utf8ToBase64(sim.menus.screen(id) ?? terminalScreen(sessions.find((s) => s.id === id)?.title ?? "sesión")),
    terminalDetach: async () => undefined,
    terminalResize: async () => undefined,
    terminalRestoreSize: async () => undefined,
    async answer({ askId, answer }) {
      const ask = asks.get(askId);
      if (!ask) throw new Error("ask_gone");
      asks.delete(askId);
      emit("sesiones://ask-resolved", { askId, id: ask.id, outcome: "answered" });
      sim.working(ask.id, null);
      window.setTimeout(() => sim.streamer.reply(ask.id, sim.streamer.answerText(ask, answer), {
        chunkMs: 24, onStart: (turnId) => sim.working(ask.id, turnId), onDone: () => sim.idle(ask.id),
      }), 300);
    },
    async saveAttachment({ name, dataBase64, mediaType }) {
      const path = `~/.ultron/adjuntos/${new Date().toISOString().slice(0, 10)}/${uid("a")}-${name}`;
      const previewDataUrl = mediaType.startsWith("image/") ? `data:${mediaType};base64,${dataBase64}` : null;
      if (previewDataUrl) images.set(path, previewDataUrl);
      return { path, previewDataUrl };
    },
    readImage: async (path) => {
      if (isNetworkPath(path)) throw new Error(NETWORK_PATH_BLOCKED);
      return images.get(path) ?? USAGE_IMAGE;
    },
    openImage: async () => {},
    revealPath: async () => {},
    openFile: async () => {},
    // En la demo existe toda ruta que no lleve «no-existe».
    pathsStatus: async (paths) =>
      paths.map((path) => {
        const exists = !/no-existe/i.test(path);
        const canOpen = exists && !/\.(exe|bat|cmd|ps1)$/i.test(path);
        return { path, abs: exists ? path : null, exists, isFile: exists, canOpen, size: exists ? 1024 : null, error: exists ? null : `no existe: ${path}` };
      }),
    // En la demo no hay transcript: la segunda opinión cuenta solo la ventana.
    turnEdits: async () => [],
    openInEditor: async () => {},
    saveImage: async (_dataUrl, name) => `C:/mock/${name}.png`,
    exportConversation: async ({ format }) => ({ path: `C:/mock/conversacion.${format}`, messages: 42, bytes: 2048 }),
    openExport: async () => {},
    gitSnapshot: async () => git,
    gitDiffFile: async (_cwd, file) => D.DIFF_VIEW.replace(/mods\/ultron-uso\/hooks\/view\.tsx/g, file),
    async gitCommit(_cwd, message) {
      const short = Math.random().toString(16).slice(2, 9);
      gitLog = [{ hash: short, short, author: "dev", date: new Date().toISOString(), subject: message }, ...gitLog];
      git = { state: { ...git.state, dirty: false, dirty_count: 0, ahead: git.state.ahead + 1 }, changes: [] };
      return `[main ${short}] ${message}`;
    },
    gitLog: async () => gitLog,
    listFiles: async () => D.FILES,
    usage: async () => ({ fiveHour: { percent: 12, resetsAt: D.ago(-140) }, weekly: { percent: 51, resetsAt: D.ago(-60 * 70) }, stale: false }),
    usagePace: async () => ({
      windows: [
        { kind: "five_hour", used: 12, elapsedPct: 53, linearElapsedPct: 53, projectedPct: 23, isScheduled: false, isAlert: false, resetsAtMs: Date.now() + 140 * 60000, runsOutLabel: null },
        { kind: "seven_day", used: 51, elapsedPct: 48, linearElapsedPct: 42, projectedPct: 106, isScheduled: true, isAlert: true, resetsAtMs: Date.now() + 70 * 3600000, runsOutLabel: "dom 11 18:30" },
      ],
      weekInFiveHourPct: 382.5,
    }),
    enginesUsage: async () => ({
      generatedAtMs: Date.now(),
      engines: [
        { id: "codex", label: "Codex", status: "ok", source: "rollout", readAtMs: Date.now() - 4 * 60000, plan: "plus", activity: null, note: null, windows: [
          { kind: "five_hour", group: null, usedPct: 6, resetsAtMs: Date.now() + 200 * 60000, expired: false },
          { kind: "seven_day", group: null, usedPct: 2, resetsAtMs: Date.now() + 130 * 3600000, expired: false },
        ] },
        { id: "agy", label: "agy (Gemini)", status: "ok", source: "agy-usage", readAtMs: Date.now() - 60000, plan: null, activity: null, note: null, windows: [
          { kind: "five_hour", group: "Gemini Models", usedPct: 6, resetsAtMs: Date.now() + 250 * 60000, expired: false },
          { kind: "seven_day", group: "Gemini Models", usedPct: 2, resetsAtMs: Date.now() + 150 * 3600000, expired: false },
          { kind: "five_hour", group: "Claude and GPT models", usedPct: 0, resetsAtMs: Date.now() + 300 * 60000, expired: false },
          { kind: "seven_day", group: "Claude and GPT models", usedPct: 0, resetsAtMs: Date.now() + 160 * 3600000, expired: false },
        ] },
      ],
    }),
    newWindow: async (sessionId) => {
      const label = `sesiones-mock${Date.now().toString(36)}`;
      window.open(`${window.location.pathname}?mock=1&win=${label}${sessionId ? `&session=${sessionId}` : ""}`, "_blank");
      return label;
    },
    openControlCenter: async () => {
      (globalThis as { __sesionesOpenedCc?: number }).__sesionesOpenedCc =
        ((globalThis as { __sesionesOpenedCc?: number }).__sesionesOpenedCc ?? 0) + 1;
    },
    openUrl: async (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    reportRail: async (report) => {
      // Inspeccionable desde los e2e: último informe de la columna.
      (globalThis as { __sesionesRail?: unknown }).__sesionesRail = report;
    },
    mejorar: async ({ draft }) => `Objetivo: ${draft.trim()}\nCriterio de aceptación: tests verdes y sin avisos.`,
    // <WP-MOTORES>
    previewPut: () => pending("sesiones_preview_put"),
    ...((): Pick<SesionesApi, "engineEffortGet" | "engineEffortSet"> => {
      let effort: string | null = null;
      const onlyCodex = (engine: string) => (engine === "codex" ? null : new Error(`el motor '${engine}' no admite elegir effort`));
      return {
        engineEffortGet: async ({ engine }) => {
          const err = onlyCodex(engine);
          if (err) throw err;
          return { effort, levels: ["low", "medium", "high", "xhigh", "max", "ultra"] };
        },
        engineEffortSet: async ({ engine, effort: next }) => {
          const err = onlyCodex(engine);
          if (err) throw err;
          effort = next || null;
          return effort;
        },
      };
    })(),
    // </WP-MOTORES>
    async on(event, cb) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(cb as Listener);
      listeners.set(event, set);
      const r = replay[event];
      if (r) window.setTimeout(r, 0);
      return (() => set.delete(cb as Listener)) as Unlisten;
    },
    async onPty(id, cb) {
      const key = `sesiones://pty/${id}`;
      const set = listeners.get(key) ?? new Set<Listener>();
      set.add(cb as Listener);
      listeners.set(key, set);
      return () => set.delete(cb as Listener);
    },
  };
}
