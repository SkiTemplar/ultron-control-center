// F4: la tarjeta de permiso de una sesión de motor es la de Claude, con el nombre
// del motor y «Permitir siempre en esta sesión» si el motor lo ofrece. Denegar no
// pide motivo (Codex, Gemini y OpenCode no lo reciben) y responde deny al momento.
// Caso negativo: en una sesión de Claude, «Denegar…» sigue pidiendo el motivo.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { AskCard } from "../components/chat/AskCard";
import { ApiContext } from "../context";
import { store } from "../store";
import type { Ask, SessionInfo } from "../types";

type PermissionAsk = Extract<Ask, { kind: "permission" }>;

const SESSION = {
  id: "m1", projectId: "p", projectName: "p", cwd: "C:/p", title: "Codex · p", claudeSessionId: null, status: "waiting", model: null,
  startedAt: "", bridgeConnected: false, waiting: null, stalled: null, workingSince: null, lastActivityAt: "", turnId: null, screen: "unknown",
  permissionMode: "default", launchPermissionMode: "default", exitCode: null, bridgeProtocol: 0, engine: "codex",
} as SessionInfo;

const ASK: PermissionAsk = {
  askId: "ask-m", id: "m1", kind: "permission", tool: "Bash", agentId: null,
  input: { command: "cargo test" }, summary: "Bash", always: { rules: ["Bash"], destination: "session" },
};

function mount(info: SessionInfo, ask: PermissionAsk) {
  act(() => store.dispatch({ type: "sessions", sessions: [info] }));
  const answer = vi.fn(async () => undefined);
  render(<ApiContext.Provider value={{ isMock: true, answer } as unknown as SesionesApi}><AskCard ask={ask} /></ApiContext.Provider>);
  return answer;
}

afterEach(() => {
  cleanup();
  act(() => store.dispatch({ type: "sessions", sessions: [] }));
});

describe("tarjeta de permiso de una sesión de motor", () => {
  it("dice el motor, enseña el comando y ofrece «Permitir siempre en esta sesión»", () => {
    const answer = mount(SESSION, ASK);
    expect(screen.getByTestId("ask-permission").textContent).toContain("Codex");
    expect(screen.getByText("cargo test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Permitir siempre en esta sesión" }));
    expect(answer).toHaveBeenCalledWith({ askId: "ask-m", answer: { kind: "permission", decision: "allowAlways" } });
  });

  it("Denegar responde deny al momento, sin pedir un motivo que el motor no recibe", () => {
    const answer = mount(SESSION, ASK);
    fireEvent.click(screen.getByRole("button", { name: "Denegar" }));
    expect(answer).toHaveBeenCalledWith({ askId: "ask-m", answer: { kind: "permission", decision: "deny" } });
    expect(screen.queryByPlaceholderText(/Motivo/)).toBeNull();
  });

  it("caso negativo: en una sesión de Claude «Denegar…» pide el motivo", () => {
    const claude = { ...SESSION, id: "s1", engine: undefined, claudeSessionId: "c" } as SessionInfo;
    const answer = mount(claude, { ...ASK, id: "s1" });
    fireEvent.click(screen.getByRole("button", { name: "Denegar…" }));
    expect(answer).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/Motivo/)).toBeTruthy();
  });
});
