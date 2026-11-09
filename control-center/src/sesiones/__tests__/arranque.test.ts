// Hallazgo 11: el primer pintado solo espera a `api.list()`. La detección de
// motores y la petición de uso llegan cada una por su cuenta.

import { describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { SESSIONS } from "../mock/data";
import { store } from "../store";
import { workspaceStore } from "../workspace";

const never = () => new Promise<never>(() => undefined);
const DEFAULTS: Record<string, unknown> = { engineList: [], pendingAsks: [], queueList: [], relayList: [] };

const fake = new Proxy({ isMock: true }, {
  get(target, prop: string) {
    if (prop in target) return (target as Record<string, unknown>)[prop];
    if (prop === "then") return undefined;
    if (prop === "on") return async () => () => undefined;
    if (prop === "list") return async () => [SESSIONS[0]];
    if (prop === "engines" || prop === "usage") return never;
    return async () => DEFAULTS[prop];
  },
}) as unknown as SesionesApi;

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), loadApi: async () => fake, getApi: () => fake }));

describe("arranque sin esperar a motores ni uso (hallazgo 11)", () => {
  it("con engines() y usage() colgados, la sesión aparece y ocupa el panel enfocado", async () => {
    const { bootstrap } = await import("../bootstrap");
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 100));
    const result = await Promise.race([bootstrap().then(() => "ok" as const), timeout]);
    expect(result).toBe("ok");
    expect(store.getState().sessions).toHaveLength(1);
    const ws = workspaceStore.getState();
    expect(ws.panes[ws.focused].sessionId).toBe(SESSIONS[0].id);
  });
});
