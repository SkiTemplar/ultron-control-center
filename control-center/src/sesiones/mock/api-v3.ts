// Mock de los comandos v3 (contrato de estabilidad 2026-10-08, §7.1) sobre el
// backend simulado de `sim.ts`: cola única idempotente, comandos y menús en el
// chat, diálogos y confianza y modo de permisos con «fuera del ciclo». Lo que
// el backend real devolvería como error, aquí también.

import type { SesionesApi } from "../api";
import type { Ask, PermissionMode, SessionId, SessionInfo, SessionPrefs } from "../types";
import type { Sim } from "./sim";

type V3Keys =
  | "runCommand" | "trustAnswer" | "dialogAnswer" | "setPermissionMode" | "logDir" | "reportIncident" | "pendingAsks"
  | "queueList" | "queueEnqueue" | "queueUpdate" | "queueRemove" | "queueMove" | "queueSendNow" | "queueRetry"
  | "prefsGet" | "prefsSet"
  | "background" | "interruptAndSend";

interface Deps {
  sim: Sim;
  asks: Map<string, Ask>;
  sessions(): SessionInfo[];
  patch(id: SessionId, change: Partial<SessionInfo>): void;
}

/** Rechazo explícito de un comando aún sin implementar (nunca un no-op silencioso). */
export function pending(command: string): Promise<never> {
  return Promise.reject(new Error(`pendiente: ${command}`));
}

export const DEFAULT_PREFS: SessionPrefs = { launchPermissionMode: "bypassPermissions", stallSeconds: 120 };

/** Ciclo de Shift+Tab de una sesión: bypass solo si se lanzó con él (§2.5). */
export function permissionCycle(launch: PermissionMode): PermissionMode[] {
  const base: PermissionMode[] = ["default", "acceptEdits", "plan"];
  return launch === "bypassPermissions" ? [...base, "bypassPermissions"] : base;
}

export function createV3Mock(deps: Deps): Pick<SesionesApi, V3Keys> {
  let prefs: SessionPrefs = { ...DEFAULT_PREFS };
  const { sim } = deps;
  const queue = (id: SessionId) => sim.queues.get(id) ?? [];
  const info = (id: SessionId) => deps.sessions().find((s) => s.id === id);
  const replace = (id: SessionId, items: ReturnType<typeof queue>) => {
    sim.queues.set(id, items);
    return sim.emitQueue(id);
  };

  return {
    runCommand: async ({ id, command, args, clientId }) => sim.runCommand(id, command, args, clientId),
    async trustAnswer({ id, accept }) {
      if (info(id)?.waiting?.kind !== "trust") throw new Error("No hay ningún diálogo de confianza en la pantalla.");
      if (accept) sim.idle(id);
      else sim.processExit(id, 1);
    },
    dialogAnswer: async ({ id, index }) => sim.menus.answer(id, index),
    async setPermissionMode({ id, mode }) {
      const s = info(id);
      if (!s) throw new Error("Sesión desconocida");
      if (!permissionCycle(s.launchPermissionMode).includes(mode)) {
        return { ok: false, error: `El modo «${mode}» está fuera del ciclo de esta sesión: reiníciala en ese modo.` };
      }
      deps.patch(id, { permissionMode: mode });
      return { ok: true, text: `Modo de permisos: ${mode}` };
    },
    logDir: async () => "C:/mock/logs",
    reportIncident: async () => {},
    pendingAsks: async (id) => [...deps.asks.values()].filter((a) => !id || a.id === id),
    queueList: async (id) => queue(id),
    queueEnqueue: async ({ id, item }) => sim.enqueue(id, item),
    queueUpdate: async ({ id, clientId, patch }) => replace(id, queue(id).map((q) => (q.clientId === clientId ? { ...q, ...patch } : q))),
    queueRemove: async ({ id, clientId }) => replace(id, queue(id).filter((q) => q.clientId !== clientId)),
    async queueMove({ id, clientId, toIndex }) {
      const list = queue(id);
      const item = list.find((q) => q.clientId === clientId);
      if (!item) return list;
      const rest = list.filter((q) => q.clientId !== clientId);
      return replace(id, [...rest.slice(0, toIndex), item, ...rest.slice(toIndex)]);
    },
    async queueSendNow({ id, clientId }) {
      const targets = queue(id).filter((q) => q.state === "queued" && (!clientId || q.clientId === clientId));
      const s = info(id);
      targets.forEach((q) => (s?.status === "idle" ? sim.deliver(id, q) : sim.absorb(id, q)));
      return queue(id);
    },
    async queueRetry({ id, clientId }) {
      replace(id, queue(id).map((q) => (q.clientId === clientId ? { ...q, state: "queued" as const, error: undefined } : q)));
      sim.drain(id);
      return queue(id);
    },
    prefsGet: async () => prefs,
    async prefsSet(next) {
      prefs = { ...next };
      return prefs;
    },
    async background({ id }) {
      const tool = info(id)?.foregroundTool;
      if (!tool) throw new Error("No hay ninguna herramienta en primer plano");
      if (!tool.backgroundable) throw new Error(`${tool.name} no se puede pasar a segundo plano`);
      sim.backgroundTool(id);
      return { ok: true, toolUseId: tool.toolUseId, tool: tool.name, evidence: "toolEnd", steps: ["pista", "ctrlB", "toolEnd"] };
    },
    async interruptAndSend({ id, text, attachments, clientId, delegate }) {
      const s = info(id);
      if (!s || s.status === "exited") throw new Error("la sesión terminó");
      if (s.screen === "dialog" || s.screen === "trust") throw new Error("La TUI tiene un diálogo abierto: no se escribe");
      const kind = text.startsWith("/") ? "command" as const : text.startsWith("!") ? "bash" as const : "prompt" as const;
      const item = { clientId, text, attachments, delegate, kind, origin: "ultron" as const, state: "queued" as const, createdAt: new Date().toISOString() };
      replace(id, [item, ...queue(id).filter((q) => q.clientId !== clientId)]);
      const busy = s.status === "working" || s.status === "waiting";
      const out = busy ? sim.recover(id, "interrupt") : null;
      if (out && !out.ok) return { interrupted: false, sent: false, steps: ["encoladoDelante", ...out.steps], item };
      sim.deliver(id, item);
      const sent = queue(id).find((q) => q.clientId === clientId) ?? item;
      return { interrupted: busy, sent: true, steps: ["encoladoDelante", ...(out?.steps ?? ["sinTurno"]), "enviado"], item: sent };
    },
  };
}
