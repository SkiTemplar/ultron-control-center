import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { engineSendKind } from "../components/composer/composer-handlers";
import { RelayBanner, relayTarget, returnText } from "../components/composer/RelayBanner";

const relay = {
  sessionId: "s1", activeEngine: "codex" as const, since: "2026-10-28T00:00:00Z",
  returnAt: "2026-10-28T01:20:00Z", taskIds: ["t1"], failedPrompt: "continua",
};

describe("relevo", () => {
  it("enruta por defecto al motor activo y respeta el destino manual", () => {
    expect(relayTarget("claude", relay, false)).toBe("codexLocal");
    expect(relayTarget("gemini", relay, true)).toBe("gemini");
    expect(relayTarget("claude", null, false)).toBe("claude");
  });

  it("muestra la banda, el error y sus dos acciones", () => {
    const onReturn = vi.fn();
    const onGemini = vi.fn();
    render(<RelayBanner relay={{ ...relay, error: "cuota agotada" }} onReturn={onReturn} onGemini={onGemini} />);
    expect(screen.getByText(/Relevo: Codex sigue el trabajo/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("cuota agotada");
    fireEvent.click(screen.getByRole("button", { name: "Volver a Claude ya" }));
    fireEvent.click(screen.getByRole("button", { name: "Pasar a Gemini" }));
    expect(onReturn).toHaveBeenCalledOnce();
    expect(onGemini).toHaveBeenCalledOnce();
  });

  it("los turnos de seguimiento a Gemini piden contexto; Codex y OpenCode conservan el hilo", () => {
    expect(engineSendKind({ ...relay, activeEngine: "gemini" }, "gemini")).toEqual({ kind: "relay", includeContext: true });
    expect(engineSendKind(relay, "codex")).toEqual({ kind: "relay", includeContext: false });
    expect(engineSendKind({ ...relay, activeEngine: "opencode" }, "opencode")).toEqual({ kind: "relay", includeContext: false });
    expect(engineSendKind(relay, "gemini")).toEqual({ kind: "task", includeContext: true });
    expect(engineSendKind(null, "codex")).toEqual({ kind: "task", includeContext: true });
  });

  it("sin hora de reinicio la banda dice que la vuelta es manual", () => {
    render(<RelayBanner relay={{ ...relay, returnAt: undefined }} onReturn={() => {}} onGemini={() => {}} />);
    expect(screen.getByTestId("relay-banner")).toHaveTextContent(/la vuelta a Claude es manual/);
    expect(returnText("no-es-fecha")).toMatch(/manual/);
    const now = new Date(2026, 9, 28, 12, 0);
    expect(returnText(new Date(2026, 9, 28, 15, 0).toISOString(), now)).toMatch(/^Claude vuelve ~15:00$/);
    expect(returnText(new Date(2026, 9, 30, 9, 0).toISOString(), now)).toMatch(/^Claude vuelve ~.*30.* 09:00$/);
  });
});
