// Barreras por fila, panel y pestaña: lo que falla se queda dentro y lo de al lado
// sigue. Las piezas se sustituyen por otras que lanzan a la orden.

import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { Item } from "../components/chat/MessageList";
import { Inspector } from "../components/inspector/Inspector";
import { PaneView } from "../components/Pane";
import { ApiContext } from "../context";
import { store } from "../store";
import type { ChatMessage, SessionInfo } from "../types";
import { setUi } from "../ui";
import { makePane, updateWorkspace } from "../workspace";

vi.mock("../components/chat/Message", () => ({
  rendersNothing: () => false,
  Message: ({ m }: { m: { uuid: string } }) => {
    if (m.uuid === "mala") throw new Error("mensaje roto");
    return <p>{m.uuid}</p>;
  },
}));
vi.mock("../components/chat/ChatPane", () => ({
  ChatPane: ({ sessionId }: { sessionId: string }) => {
    if (sessionId === "mala") throw new Error("panel roto");
    return <p>chat {sessionId}</p>;
  },
}));
vi.mock("../components/inspector/Agentes", () => ({
  Agentes: ({ session }: { session: { id: string } | null }) => {
    if (session?.id === "mala") throw new Error("pestaña rota");
    return <p>agentes {session?.id}</p>;
  },
}));
// Guarda en estado el primer `cwd`, como el mensaje de commit del panel real.
vi.mock("../components/inspector/Git", () => ({
  Git: function Git({ cwd }: { cwd: string | null }) {
    const [first] = useState(cwd);
    return <p data-testid="git-first">{first}</p>;
  },
}));

const api = { isMock: true } as unknown as SesionesApi;

const session = (id: string, cwd = "C:/p"): SessionInfo => ({ id, cwd, projectId: "p", projectName: "p", title: id, status: "idle" }) as unknown as SessionInfo;

const msg = (uuid: string): ChatMessage => ({ uuid, role: "assistant", timestamp: "2026-11-01T10:00:00Z", blocks: [], agentId: null });

function focus(id: string) {
  act(() => updateWorkspace((w) => ({ ...w, panes: [makePane(id)], focused: 0 })));
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("barrera por fila del hilo", () => {
  const row = (m: ChatMessage) => <Item item={{ kind: "message", m } as never} results={new Map()} />;

  it("el mensaje que falla enseña el aviso y las otras filas siguen", () => {
    render(<>{row(msg("mala"))}{row(msg("buena"))}</>);
    expect(screen.getByRole("alert").textContent).toContain("mensaje roto");
    expect(screen.getByText("buena")).not.toBeNull();
  });

  it("caso negativo: una fila sana no añade aviso", () => {
    render(row(msg("buena")));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("una versión nueva del mensaje se reintenta", () => {
    const view = render(row(msg("mala")));
    expect(screen.queryByRole("alert")).not.toBeNull();
    view.rerender(row(msg("arreglada")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("arreglada")).not.toBeNull();
  });
});

describe("barrera por panel", () => {
  const pane = (id: string, index: number) => <PaneView pane={{ key: id, sessionId: id, agentId: null }} index={index} focused={false} count={2} />;
  const wrap = (children: React.ReactNode) => <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;

  it("un panel roto conserva su cabecera y el otro panel sigue", () => {
    store.dispatch({ type: "sessions", sessions: [session("mala"), session("buena")] });
    render(wrap(<>{pane("mala", 0)}{pane("buena", 1)}</>));
    expect(screen.getByRole("alert").textContent).toContain("panel roto");
    expect(screen.getByText("chat buena")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Cerrar panel 1" })).not.toBeNull();
  });

  it("cambiar de sesión en el panel se recupera", () => {
    store.dispatch({ type: "sessions", sessions: [session("mala"), session("buena")] });
    const view = render(wrap(<PaneView pane={{ key: "k", sessionId: "mala", agentId: null }} index={0} focused count={1} />));
    expect(screen.queryByRole("alert")).not.toBeNull();
    view.rerender(wrap(<PaneView pane={{ key: "k", sessionId: "buena", agentId: null }} index={0} focused count={1} />));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("chat buena")).not.toBeNull();
  });
});

describe("inspector", () => {
  const wrap = () => render(<ApiContext.Provider value={api}><Inspector /></ApiContext.Provider>);

  it("una pestaña rota deja las pestañas a mano y se recupera al cambiar de sesión", () => {
    store.dispatch({ type: "sessions", sessions: [session("mala"), session("buena")] });
    act(() => setUi((s) => ({ ...s, inspectorTab: "agentes" })));
    focus("mala");
    wrap();
    expect(screen.getByRole("alert").textContent).toContain("pestaña rota");
    expect(screen.getByRole("tab", { name: "Git" })).not.toBeNull();
    focus("buena");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("agentes buena")).not.toBeNull();
  });

  it("Git se remonta al cambiar de repositorio: el mensaje a medias no pasa a otro", () => {
    store.dispatch({ type: "sessions", sessions: [session("a", "C:/repo-a"), session("b", "C:/repo-b")] });
    act(() => setUi((s) => ({ ...s, inspectorTab: "git" })));
    focus("a");
    wrap();
    expect(screen.getByTestId("git-first").textContent).toBe("C:/repo-a");
    focus("b");
    expect(screen.getByTestId("git-first").textContent).toBe("C:/repo-b");
  });
});
