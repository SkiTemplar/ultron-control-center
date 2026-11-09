// Mock de las sesiones de motor (Codex, Gemini y OpenCode sin Claude): crear, enviar un
// turno que responde con mensajes del chat (como el proceso persistente de
// `motor_vivo.rs`), interrumpir, retomar las cerradas y el historial de cada una.
// Imita el contrato de `plans/2026-11-06-sesiones-motor-paridad-claude.md` (F2b).

import type { SesionesApi } from "../api";
import type { ChatMessage, EngineId, EngineSessionPast, EngineStatus, SesionesEventName, SesionesEvents, SessionId, SessionInfo, TurnEndReason } from "../types";
import { CWD_ULTRON } from "./data";

interface Deps {
  emit<K extends SesionesEventName>(event: K, payload: SesionesEvents[K]): void;
  uid(prefix: string): string;
  sessions(): SessionInfo[];
  setSessions(next: SessionInfo[]): void;
  engines(): Promise<EngineStatus[]>;
  /** Mensajes del hilo: sustituye por `uuid` (instantáneas del turno) y los emite. */
  upsertMessages(id: SessionId, list: ChatMessage[]): void;
}

type Keys = "engineSessionCreate" | "engineSessionSend" | "engineSessionInterrupt" | "engineSessionPast";

const LABEL: Record<EngineId, string> = { codex: "Codex", gemini: "Gemini", opencode: "OpenCode" };
const STEP_MS = 450;
const TITLE_MAX = 60;

interface LiveTurn {
  turnId: string;
  startedAt: string;
  reply: ChatMessage;
  timer: number;
}

function replyParts(engine: EngineId, text: string): string[] {
  const asked = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return [
    `Entendido: «${asked}».`,
    `\n\nHe revisado el proyecto en la carpeta de la sesión. En la demo no se ejecuta **${LABEL[engine]}** de verdad, pero el turno sigue el mismo camino que el real:`,
    "\n\n- el proceso del motor sigue vivo entre turnos;\n- la respuesta llega como mensajes del chat;\n- el siguiente mensaje retoma el hilo.",
  ];
}

export function createEngineSessionMock(deps: Deps): Pick<SesionesApi, Keys> & { close(id: SessionId): boolean } {
  const live = new Map<SessionId, LiveTurn>();
  const turnCount = new Map<SessionId, number>();
  let past: EngineSessionPast[] = [];

  const find = (id: SessionId) => deps.sessions().find((s) => s.id === id && s.engine);

  function patch(id: SessionId, change: Partial<SessionInfo>): void {
    deps.setSessions(deps.sessions().map((s) => (s.id === id ? { ...s, ...change, lastActivityAt: new Date().toISOString() } : s)));
  }

  function endTurn(id: SessionId, reason: TurnEndReason): void {
    const turn = live.get(id);
    if (!turn) return;
    window.clearTimeout(turn.timer);
    live.delete(id);
    const endedAt = new Date().toISOString();
    patch(id, { status: "idle", workingSince: null });
    deps.emit("sesiones://turn", {
      id, turnId: turn.turnId, startedAt: turn.startedAt, endedAt, reason,
      durationMs: Date.parse(endedAt) - Date.parse(turn.startedAt),
    });
  }

  function play(id: SessionId, engine: EngineId, parts: string[], step: number): void {
    const turn = live.get(id);
    if (!turn) return;
    turn.timer = window.setTimeout(() => {
      const current = live.get(id);
      if (!current || current !== turn) return;
      if (step < parts.length) {
        const text = parts.slice(0, step + 1).join("");
        const tool = step === 0 && engine === "codex"
          ? [{ kind: "toolUse" as const, id: `${turn.turnId}-t`, name: "Bash", input: { command: "rg --files src | head" }, summary: "rg --files src | head" }]
          : [];
        current.reply = { ...current.reply, blocks: [...tool, { kind: "text", text }] };
        deps.upsertMessages(id, [current.reply]);
        play(id, engine, parts, step + 1);
        return;
      }
      endTurn(id, "answer");
    }, STEP_MS);
  }

  return {
    async engineSessionCreate({ engine, projectId, cwd, model, resume }) {
      if (engine !== "codex" && engine !== "gemini" && engine !== "opencode") throw new Error(`motor no válido para una sesión: ${engine}`);
      const st = (await deps.engines()).find((e) => e.id === engine);
      if (!st?.available) throw new Error(st?.reason ?? `${LABEL[engine]} no está disponible`);
      const old = resume ? past.find((p) => p.id === resume) : undefined;
      if (resume && !old) throw new Error("No existe esa sesión de motor cerrada");
      const now = new Date().toISOString();
      const project = old?.projectName ?? projectId ?? "ultron";
      const info: SessionInfo = {
        id: old?.id ?? deps.uid(`m${engine[0]}`), projectId: old?.projectId ?? projectId ?? null, projectName: project,
        cwd: old?.cwd ?? (cwd || CWD_ULTRON), title: old?.title ?? `${LABEL[engine]} · ${project}`, claudeSessionId: null,
        status: "idle", model: model ?? null, startedAt: old?.startedAt ?? now, bridgeConnected: false,
        waiting: null, stalled: null, workingSince: null, lastActivityAt: now, turnId: null, screen: "unknown",
        permissionMode: null, launchPermissionMode: "default", exitCode: null, bridgeProtocol: 0, engine,
      };
      if (old) past = past.filter((p) => p.id !== old.id);
      deps.setSessions([...deps.sessions(), info]);
      return info;
    },
    async engineSessionSend({ id, text, attachments = [] }) {
      const s = find(id);
      if (!s?.engine) throw new Error("No existe esa sesión de motor");
      if (!text.trim()) throw new Error("el mensaje está vacío");
      if (s.status === "working" || live.has(id)) throw new Error("la sesión ya está trabajando");
      const startedAt = new Date().toISOString();
      const turnId = deps.uid("turno");
      const first = (turnCount.get(id) ?? 0) === 0;
      turnCount.set(id, (turnCount.get(id) ?? 0) + 1);
      const files = attachments.length ? `\n\nFicheros adjuntos:\n${attachments.map((a) => `- ${a}`).join("\n")}` : "";
      const user: ChatMessage = { uuid: deps.uid("u"), role: "user", kind: "prompt", timestamp: startedAt, agentId: null, blocks: [{ kind: "text", text: `${text.trim()}${files}` }] };
      const reply: ChatMessage = { uuid: `${turnId}-r`, role: "assistant", kind: "answer", timestamp: startedAt, agentId: null, blocks: [], ...(s.model ? { model: s.model } : {}) };
      live.set(id, { turnId, startedAt, reply, timer: 0 });
      patch(id, { status: "working", workingSince: startedAt, ...(first ? { title: text.trim().slice(0, TITLE_MAX) } : {}) });
      deps.upsertMessages(id, [user]);
      play(id, s.engine, replyParts(s.engine, text.trim()), 0);
      return {
        id: turnId, engine: s.engine, kind: "chat", mode: "local", cwd: s.cwd, prompt: text, status: "running",
        startedAt, events: [], sessionId: id, contextChars: 0, ...(s.model ? { model: s.model } : {}),
      };
    },
    async engineSessionInterrupt(id) {
      if (!find(id)) throw new Error("No existe esa sesión de motor");
      endTurn(id, "aborted");
    },
    engineSessionPast: async (limit) => past.slice(0, limit ?? past.length),
    close(id) {
      const s = find(id);
      if (!s?.engine) return false;
      endTurn(id, "aborted");
      past = [{ id, engine: s.engine, projectId: s.projectId, projectName: s.projectName, cwd: s.cwd, title: s.title, startedAt: s.startedAt, lastActivityAt: new Date().toISOString(), turns: turnCount.get(id) ?? 0 }, ...past];
      deps.setSessions(deps.sessions().filter((x) => x.id !== id));
      return true;
    },
  };
}
