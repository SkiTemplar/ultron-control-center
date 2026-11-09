import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { reconcileEchoes, visibleQueue } from "../echo";
import {
  LEGACY_STORAGE_KEY, delegateText, enqueueItem, legacyInputs, migrateLegacyQueue, removeItem, targetIndex,
} from "../queue";
import { store } from "../store";
import type { ChatMessage, QueueItem, QueueItemInput } from "../types";

const item = (clientId: string, state: QueueItem["state"], extra: Partial<QueueItem> = {}): QueueItem => ({
  clientId, text: clientId, attachments: [], delegate: false, kind: "prompt", origin: "ultron", state, createdAt: "2026-10-08T10:00:00Z", ...extra,
});

/** Backend falso idempotente por `clientId` (§5.2), como `cola.rs`. */
function fakeApi() {
  const queues = new Map<string, QueueItem[]>();
  const calls: string[] = [];
  const api = {
    async queueEnqueue({ id, item: input }: { id: string; item: QueueItemInput }) {
      calls.push(`enqueue:${input.clientId}`);
      const list = queues.get(id) ?? [];
      if (!list.some((q) => q.clientId === input.clientId)) list.push({ ...input, origin: "ultron", state: "queued", createdAt: "x" });
      queues.set(id, list);
      return [...list];
    },
    async queueRemove({ id, clientId }: { id: string; clientId: string }) {
      calls.push(`remove:${clientId}`);
      queues.set(id, (queues.get(id) ?? []).filter((q) => q.clientId !== clientId));
      return [...(queues.get(id) ?? [])];
    },
  } as unknown as SesionesApi;
  return { api, queues, calls };
}

describe("cola como cliente fino del backend", () => {
  beforeEach(() => store.dispatch({ type: "queue", id: "s1", items: [] }));

  it("encolar y borrar aplican la instantánea del backend en el store", async () => {
    const { api } = fakeApi();
    await enqueueItem(api, "s1", { clientId: "a", text: "uno", attachments: [], delegate: false, kind: "prompt" });
    expect(store.getState().bySession.s1.queue.map((q) => q.clientId)).toEqual(["a"]);
    await removeItem(api, "s1", "a");
    expect(store.getState().bySession.s1.queue).toEqual([]);
  });

  it("dos «ventanas» que encolan el mismo clientId dejan un solo elemento (idempotencia)", async () => {
    const { api, queues } = fakeApi();
    const input: QueueItemInput = { clientId: "x", text: "hola", attachments: [], delegate: false, kind: "prompt" };
    await enqueueItem(api, "s1", input);
    await enqueueItem(api, "s1", input);
    expect(queues.get("s1")).toHaveLength(1);
  });

  it("el panel solo muestra lo que espera o falló; lo escrito pasa a eco", () => {
    const all = [item("a", "queued"), item("b", "sending"), item("c", "failed", { error: "la sesión terminó" }), item("d", "delivered")];
    expect(visibleQueue(all).map((q) => q.clientId)).toEqual(["a", "c"]);
  });

  it("subir y bajar calcula la posición absoluta saltando los elementos ya enviados (caso negativo en los bordes)", () => {
    const all = [item("a", "queued"), item("b", "sending"), item("c", "queued")];
    expect(targetIndex(all, "c", -1)).toBe(0);
    expect(targetIndex(all, "a", 1)).toBe(2);
    expect(targetIndex(all, "a", -1)).toBeNull();
    expect(targetIndex(all, "zz", 1)).toBeNull();
  });

  it("la delegación pide un subagente en segundo plano y conserva el texto", () => {
    const t = delegateText("revisa el puente HTTP");
    expect(t).toMatch(/subagente en segundo plano/);
    expect(t.endsWith("revisa el puente HTTP")).toBe(true);
  });
});

describe("migración única desde localStorage", () => {
  const legacy = JSON.stringify({
    s1: [{ id: "q1", text: "pendiente", delegate: true, attachments: [{ path: "C:/a.png", name: "a.png", previewDataUrl: "data:image/png;base64,AAAA" }] }],
    muerta: [{ id: "q2", text: "de una sesión cerrada", attachments: [] }],
  });

  it("solo sube las sesiones vivas, con rutas y sin vistas previas (M1)", () => {
    const inputs = legacyInputs(legacy, ["s1"]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].item).toMatchObject({ text: "pendiente", delegate: true, attachments: ["C:/a.png"], kind: "prompt" });
    expect(JSON.stringify(inputs)).not.toContain("data:");
  });

  it("el clientId derivado es estable entre ventanas: la idempotencia evita duplicados", async () => {
    expect(legacyInputs(legacy, ["s1"])[0].item.clientId).toBe(legacyInputs(legacy, ["s1"])[0].item.clientId);
    const { api, queues } = fakeApi();
    const storage = { getItem: () => legacy, removeItem: vi.fn() } as unknown as Storage;
    await migrateLegacyQueue(api, ["s1"], storage);
    await migrateLegacyQueue(api, ["s1"], storage);
    expect(queues.get("s1")).toHaveLength(1);
    expect(storage.removeItem).toHaveBeenCalledWith(LEGACY_STORAGE_KEY);
  });

  it("una clave corrupta se descarta con error visible, no en silencio (caso negativo)", async () => {
    const { api } = fakeApi();
    const storage = { getItem: () => "{no es json", removeItem: vi.fn() } as unknown as Storage;
    await expect(migrateLegacyQueue(api, ["s1"], storage)).rejects.toThrow(/no se pudo leer/);
    expect(storage.removeItem).toHaveBeenCalledWith(LEGACY_STORAGE_KEY);
  });
});

describe("eco optimista frente a la cola", () => {
  const echo = (clientId: string, seen = false) => ({ clientId, text: clientId, attachments: [], at: "2026-10-08T10:00:00Z", state: "pending" as const, seen });
  const userMsg = (clientId: string): ChatMessage => ({ uuid: `m-${clientId}`, role: "user", timestamp: "2026-10-08T10:00:01Z", agentId: null, blocks: [{ kind: "text", text: "x" }], clientId });

  it("lo escrito sigue como eco con su estado y lo que vuelve a la cola sale del eco", () => {
    const out = reconcileEchoes([echo("a"), echo("b")], [item("a", "cliQueued"), item("b", "queued")], []);
    expect(out.map((e) => [e.clientId, e.state])).toEqual([["a", "cliQueued"]]);
  });

  it("el mensaje con el mismo clientId retira el eco; otro clientId no (caso negativo)", () => {
    expect(reconcileEchoes([echo("a")], [item("a", "delivered")], [userMsg("a")])).toEqual([]);
    expect(reconcileEchoes([echo("a")], [item("a", "sending")], [userMsg("otro")]).map((e) => e.clientId)).toEqual(["a"]);
  });

  it("un elemento drenado por el backend aparece como eco aunque esta ventana no lo enviara", () => {
    expect(reconcileEchoes([], [item("z", "sending")], []).map((e) => e.clientId)).toEqual(["z"]);
  });
});
