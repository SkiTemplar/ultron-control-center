import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MAX_TURNS, MODEL_TURNS, appendExchange, modelHistory, type Turn } from "../chatLog";
import { ChatHead, ChatTranscript } from "../ChatHead";
import { baseName } from "../bubble";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const turns = (n: number): Turn[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `t${i}` }) as Turn);

describe("chat de Pupus: marca del freno", () => {
  const head = (agent: "claude" | "codex", guarded: boolean) => (
    <ChatHead
      agent={agent}
      label="x"
      tainted={false}
      guarded={guarded}
      turns={0}
      canReset={false}
      showLog={false}
      onToggleLog={vi.fn()}
      onReset={vi.fn()}
      onClose={vi.fn()}
    />
  );

  it("avisa de que cada acción pide confirmación cuando la conversación está marcada", () => {
    render(head("claude", true));
    expect(screen.getByText(/confirma acciones/)).toBeTruthy();
  });

  it("no avisa sin marca ni en los motores que no tienen freno", () => {
    const { unmount } = render(head("claude", false));
    expect(screen.queryByText(/confirma acciones/)).toBeNull();
    unmount();
    render(head("codex", true));
    expect(screen.queryByText(/confirma acciones/)).toBeNull();
  });

  it("el chip del adjunto enseña el nombre, también con rutas de Windows", () => {
    expect(baseName("C:\\Users\\u\\notas.md")).toBe("notas.md");
    expect(baseName("/home/u/notas.md")).toBe("notas.md");
    // Caso negativo: un nombre suelto se queda como está.
    expect(baseName("notas.md")).toBe("notas.md");
  });
});

describe("chat de Pupus: conversación guardada", () => {
  it("se guarda entera hasta el tope, pero al modelo solo le llegan los últimos turnos", () => {
    const long = turns(40);
    expect(modelHistory(long)).toHaveLength(MODEL_TURNS);
    expect(modelHistory(long)[MODEL_TURNS - 1].text).toBe("t39");
    const next = appendExchange(long, "pregunta", "respuesta");
    expect(next).toHaveLength(42);
    expect(next.slice(-2)).toEqual([
      { role: "user", text: "pregunta" },
      { role: "assistant", text: "respuesta" },
    ]);
    // Caso negativo: no crece sin límite.
    expect(appendExchange(turns(MAX_TURNS), "a", "b")).toHaveLength(MAX_TURNS);
    // Inmutable: el original no cambia.
    expect(long).toHaveLength(40);
  });

  it("«ver chat» despliega la conversación entera y «plegar» la recoge", () => {
    const onToggle = vi.fn();
    const head = (showLog: boolean) => (
      <ChatHead
        agent="claude"
        label="Claude"
        tainted={false}
        turns={4}
        canReset
        showLog={showLog}
        onToggleLog={onToggle}
        onReset={() => {}}
        onClose={() => {}}
      />
    );
    const { rerender } = render(head(false));
    fireEvent.click(screen.getByText("ver chat (4) ▾"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(head(true));
    expect(screen.getByText("plegar ▴").getAttribute("aria-expanded")).toBe("true");

    render(<ChatTranscript turns={turns(4)} linksEnabled />);
    const log = screen.getByTestId("mascot-transcript");
    expect(log.querySelectorAll(".mascot-turn")).toHaveLength(4);
    expect(log.querySelectorAll(".mascot-turn--user")).toHaveLength(2);
  });

  it("sin conversación no hay «ver chat» ni «nueva» (negativo)", () => {
    render(
      <ChatHead
        agent="codex"
        label="Codex"
        tainted={false}
        turns={0}
        canReset
        showLog={false}
        onToggleLog={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/ver chat/)).toBeNull();
    expect(screen.queryByText("nueva")).toBeNull();
  });
});
