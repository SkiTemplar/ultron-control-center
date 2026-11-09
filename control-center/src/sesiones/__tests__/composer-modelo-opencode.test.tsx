import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Composer } from "../components/composer/Composer";
import { modelEngineOfTarget } from "../components/composer/ComposerParts";
import { FALLBACK_COMMANDS } from "../components/composer/commands";
import { clearDrafts, saveDraft } from "../components/composer/drafts";
import { ApiContext } from "../context";
import { store } from "../store";
import type { SendTarget, SessionInfo } from "../types";

const base: SessionInfo = {
  id: "s1", projectId: "p", projectName: "p", cwd: "C:/p", title: "t", claudeSessionId: "c", status: "idle", model: "claude-opus-5-5",
  startedAt: "", bridgeConnected: false, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "prompt",
  permissionMode: "default", launchPermissionMode: "default", exitCode: null, bridgeProtocol: 2,
};

const DEFAULTS: Record<string, unknown> = { promptHistory: [], listFiles: [], commands: FALLBACK_COMMANDS, engineModels: [] };

function fakeApi(): SesionesApi {
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({ isMock: true }, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      if (!fns.has(prop)) fns.set(prop, vi.fn().mockResolvedValue(DEFAULTS[prop]));
      return fns.get(prop);
    },
  }) as SesionesApi;
}

function mountWithTarget(target: SendTarget) {
  saveDraft("s1", { text: "hola", attachments: [], target, delegate: false });
  act(() => store.dispatch({ type: "sessions", sessions: [base] }));
  render(<ApiContext.Provider value={fakeApi()}><Composer sessionId="s1" /></ApiContext.Provider>);
}

beforeEach(() => {
  clearDrafts();
  store.dispatch({ type: "reset", id: "s1" });
});

describe("selector de modelo del composer", () => {
  it("con destino OpenCode muestra el selector de modelo de OpenCode", () => {
    mountWithTarget("opencode");
    expect(screen.getByTestId("engine-model-opencode")).toBeTruthy();
  });

  it("Claude y Codex Cloud no tienen selector; Codex local y Gemini sí", () => {
    expect(modelEngineOfTarget("claude")).toBeNull();
    expect(modelEngineOfTarget("codexCloud")).toBeNull();
    expect(modelEngineOfTarget("codexLocal")).toBe("codex");
    expect(modelEngineOfTarget("gemini")).toBe("gemini");
    expect(modelEngineOfTarget("opencode")).toBe("opencode");
  });
});
