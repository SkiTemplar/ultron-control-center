// #20 (F2): un envío que la cola da por entregado por orden (resolver_huerfanos)
// lleva el `messageUuid` del prompt con el que se emparejó, pero ese mensaje no
// trae `clientId` y su texto puede no coincidir (envoltorio de un pegado largo).
// El eco tiene que retirarse por ese uuid; sin él, quedaba duplicado en el hilo.

import { describe, expect, it } from "vitest";
import { absorbEchoes, reconcileEchoes, type Echo } from "../echo";
import type { ChatMessage, QueueItem } from "../types";

const SENT = "2026-10-14T10:00:00.000Z";

const item = (state: QueueItem["state"], messageUuid?: string): QueueItem => ({
  clientId: "c1", text: "texto pegado largo", attachments: [], delegate: false, kind: "prompt", origin: "ultron", state,
  createdAt: SENT, sentAt: SENT, ...(messageUuid ? { messageUuid } : {}),
});

/** Prompt del transcript sin `clientId` y con otro texto (la CLI lo envolvió). */
const wrapped = (uuid: string): ChatMessage => ({
  uuid, role: "user", timestamp: "2026-10-14T10:00:02.000Z", agentId: null, kind: "prompt",
  blocks: [{ kind: "text", text: "[Pasted text #1 +40 lines]" }],
});

const echo: Echo = { clientId: "c1", text: "texto pegado largo", attachments: [], at: SENT, state: "pending", seen: true };

describe("eco de un envío entregado por orden", () => {
  it("la cola trae su messageUuid y el mensaje ya está: el eco se retira", () => {
    const out = reconcileEchoes([echo], [item("delivered", "m9")], [wrapped("m9")]);
    expect(out).toEqual([]);
  });

  it("la cola llega antes que el mensaje: el eco guarda el uuid y se retira al llegar", () => {
    const pending = reconcileEchoes([echo], [item("delivered", "m9")], []);
    expect(pending.map((e) => e.messageUuid)).toEqual(["m9"]);
    expect(absorbEchoes(pending, [wrapped("m9")])).toEqual([]);
  });

  it("caso negativo: otro mensaje sin relación no retira el eco", () => {
    const pending = reconcileEchoes([echo], [item("delivered", "m9")], []);
    expect(absorbEchoes(pending, [wrapped("m3")]).map((e) => e.clientId)).toEqual(["c1"]);
    expect(reconcileEchoes([echo], [item("sending")], [wrapped("m3")]).map((e) => e.clientId)).toEqual(["c1"]);
  });
});
