// «Permitir siempre» solo se ofrece cuando el puente anuncia la regla que
// guardará y dónde (`always`); el botón dice el alcance y la regla. Caso
// negativo: sin `always` (o con uno mal formado) no hay botón, porque haría lo
// mismo que «Permitir» y la herramienta volvería a pedir permiso.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { AskCard, alwaysLabel, alwaysOption } from "../components/chat/AskCard";
import { ApiContext } from "../context";
import type { Ask } from "../types";

type PermissionAsk = Extract<Ask, { kind: "permission" }>;

const base: PermissionAsk = {
  askId: "ask-1", id: "s1", kind: "permission", tool: "Bash", agentId: null,
  input: { command: "git commit -m x" }, summary: "git commit -m x",
};

function mount(ask: Ask) {
  const answer = vi.fn(async () => undefined);
  const api = { isMock: true, answer } as unknown as SesionesApi;
  render(
    <ApiContext.Provider value={api}>
      <AskCard ask={ask} />
    </ApiContext.Provider>,
  );
  return answer;
}

afterEach(cleanup);

describe("«Permitir siempre» con regla real", () => {
  it("caso negativo: sin regla anunciada no se ofrece; «Permitir» sigue respondiendo allow", () => {
    const answer = mount(base);
    expect(screen.queryByRole("button", { name: /Permitir siempre/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Permitir" }));
    expect(answer).toHaveBeenCalledWith({ askId: "ask-1", answer: { kind: "permission", decision: "allow" } });
  });

  it("con regla anunciada, el botón dice el alcance y la regla, y responde allowAlways", () => {
    const answer = mount({ ...base, always: { rules: ["Bash(git commit:*)"], destination: "localSettings" } });
    const button = screen.getByRole("button", { name: "Permitir siempre en este proyecto (solo tú)" });
    expect(button).toHaveAttribute("title", "Añade la regla: Bash(git commit:*)");
    fireEvent.click(button);
    expect(answer).toHaveBeenCalledWith({ askId: "ask-1", answer: { kind: "permission", decision: "allowAlways" } });
  });

  it("valida la regla que llega del backend", () => {
    const withAlways = (always: unknown) => ({ ...base, always } as unknown as PermissionAsk);
    expect(alwaysOption(withAlways({ rules: ["Edit"], destination: "session" }))).toEqual({ rules: ["Edit"], destination: "session" });
    expect(alwaysOption(withAlways({ rules: [], destination: "session" }))).toBeNull();
    expect(alwaysOption(withAlways({ rules: [""], destination: "session" }))).toBeNull();
    expect(alwaysOption(withAlways({ rules: ["Edit"], destination: "toString" }))).toBeNull();
    expect(alwaysOption(withAlways({ rules: ["Edit"], destination: "cliArg" }))).toBeNull();
    expect(alwaysOption(withAlways("Bash"))).toBeNull();
    expect(alwaysLabel({ rules: ["Edit"], destination: "session" })).toBe("Permitir siempre en esta sesión");
    expect(alwaysLabel({ rules: ["Edit"], destination: "userSettings" })).toBe("Permitir siempre en todos los proyectos");
  });
});
