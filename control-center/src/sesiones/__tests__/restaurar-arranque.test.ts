// Hallazgo #35: una sesión restaurada al arrancar ULTRON conserva su id, así que
// el workspace guardado la sigue mostrando; si su relanzamiento falló llega
// terminada, y su cola (que Reiniciar envía) también se tiene que cargar.

import { describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { SESSIONS } from "../mock/data";
import { store } from "../store";
import type { QueueItem, SessionInfo } from "../types";
import { workspaceStore } from "../workspace";

const viva: SessionInfo = { ...SESSIONS[0], id: "restaurada-viva", status: "starting" };
const terminada: SessionInfo = { ...SESSIONS[1], id: "restaurada-terminada", status: "exited", waiting: null };
const pendiente: QueueItem = {
  clientId: "q1", text: "pendiente", attachments: [], delegate: false, kind: "prompt",
  origin: "ultron", state: "queued", createdAt: new Date().toISOString(),
};
const queueList = vi.fn(async (id: string) => (id === terminada.id ? [pendiente] : []));

const fake = new Proxy({ isMock: true }, {
  get(target, prop: string) {
    if (prop in target) return (target as Record<string, unknown>)[prop];
    if (prop === "then") return undefined;
    if (prop === "on") return async () => () => undefined;
    if (prop === "list") return async () => [viva, terminada];
    if (prop === "queueList") return queueList;
    if (prop === "engineList" || prop === "pendingAsks") return async () => [];
    return () => new Promise<never>(() => undefined);
  },
}) as unknown as SesionesApi;

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), loadApi: async () => fake, getApi: () => fake }));

describe("sesiones restauradas al arrancar (#35)", () => {
  it("el panel guardado con su id sigue en pie y la cola de la terminada se carga", async () => {
    workspaceStore.dispatch(() => ({ tabs: [terminada.id], panes: [{ key: "k1", sessionId: terminada.id, agentId: null }], focused: 0, split: "h" }));
    const { bootstrap } = await import("../bootstrap");
    await bootstrap();
    const ws = workspaceStore.getState();
    expect(ws.panes[0].sessionId).toBe(terminada.id);
    expect(queueList).toHaveBeenCalledWith(terminada.id);
    expect(queueList).toHaveBeenCalledWith(viva.id);
    expect(store.getState().bySession[terminada.id]?.queue.map((q) => q.clientId)).toEqual(["q1"]);
  });
});
