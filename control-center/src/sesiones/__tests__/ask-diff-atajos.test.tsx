// Tarjetas de permiso: el diff de Edit/Write se ve antes de aprobar y los números
// 1/2/3 contestan. Casos negativos: un Bash no pinta diff, un número tecleado en el
// composer no contesta (solo Alt+número) y Enter en el motivo no manda dos veces.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { AskCard, askKeyNumber } from "../components/chat/AskCard";
import { ApiContext } from "../context";
import type { Ask } from "../types";

type PermissionAsk = Extract<Ask, { kind: "permission" }>;

const edit: PermissionAsk = {
  askId: "ask-e", id: "s1", kind: "permission", tool: "Edit", agentId: null,
  input: { file_path: "C:/p/a.ts", old_string: "const a = 1;", new_string: "const a = 2;\nconst b = 3;" }, summary: "a.ts",
};
const bash: PermissionAsk = { ...edit, askId: "ask-b", tool: "Bash", input: { command: "ls" }, summary: "ls" };

function mount(ask: Ask, answer = vi.fn(() => new Promise<undefined>(() => undefined))) {
  const api = { isMock: true, answer } as unknown as SesionesApi;
  render(
    <ApiContext.Provider value={api}>
      <div data-pane-index="0">
        <AskCard ask={ask} />
        <textarea aria-label="composer" />
      </div>
    </ApiContext.Provider>,
  );
  return answer;
}

afterEach(cleanup);

describe("diff en la tarjeta de permiso", () => {
  it("Edit enseña las líneas borradas y añadidas con el recuento", () => {
    mount(edit);
    const diff = screen.getByRole("region", { name: "Cambios que se aplicarán" });
    expect(diff.textContent).toContain("- const a = 1;");
    expect(diff.textContent).toContain("+ const b = 3;");
    expect(screen.getByTestId("ask-diff-stats").textContent).toContain("+2");
  });

  it("caso negativo: Bash no pinta diff", () => {
    mount(bash);
    expect(screen.queryByRole("region", { name: "Cambios que se aplicarán" })).toBeNull();
  });
});

describe("atajos numéricos", () => {
  it("1 fuera del texto permite; el nombre accesible del botón no cambia", () => {
    const answer = mount(edit);
    expect(screen.getByRole("button", { name: "Permitir" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "1" });
    expect(answer).toHaveBeenCalledWith({ askId: "ask-e", answer: { kind: "permission", decision: "allow" } });
  });

  it("caso negativo: «1» escrito en el composer no contesta; Alt+1 sí", () => {
    const answer = mount(edit);
    const ta = screen.getByLabelText("composer");
    ta.focus();
    fireEvent.keyDown(ta, { key: "1" });
    expect(answer).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: "1", altKey: true });
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it("el último número abre el motivo de Denegar y Enter repetido manda una sola respuesta", () => {
    const answer = mount(edit);
    fireEvent.keyDown(window, { key: "2" });
    const field = screen.getByPlaceholderText(/Motivo/);
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith({ askId: "ask-e", answer: { kind: "permission", decision: "deny", reason: undefined } });
  });

  it("pregunta de opción única: el número responde con esa opción", () => {
    const answer = mount({
      askId: "ask-q", id: "s1", kind: "question",
      questions: [{ question: "¿Qué base?", header: "", multiSelect: false, options: [{ label: "SQLite", description: "" }, { label: "Postgres", description: "" }] }],
    });
    fireEvent.keyDown(window, { key: "2" });
    expect(answer).toHaveBeenCalledWith({ askId: "ask-q", answer: { kind: "question", answers: { "¿Qué base?": "Postgres" } } });
  });

  it("caso negativo: con dos tarjetas y el foco en la segunda, el número no contesta la primera", () => {
    const answer = vi.fn(() => new Promise<undefined>(() => undefined));
    const api = { isMock: true, answer } as unknown as SesionesApi;
    render(
      <ApiContext.Provider value={api}>
        <div data-pane-index="0">
          <AskCard ask={edit} />
          <AskCard ask={bash} />
        </div>
      </ApiContext.Provider>,
    );
    const second = screen.getAllByRole("button", { name: "Permitir" })[1];
    second.focus();
    fireEvent.keyDown(second, { key: "1" });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith({ askId: "ask-b", answer: { kind: "permission", decision: "allow" } });
  });

  it("askKeyNumber ignora Ctrl, Mayús, autorrepetición y teclas que no son 1-9", () => {
    const base = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false };
    expect(askKeyNumber({ ...base, key: "3" }, false)).toBe(3);
    expect(askKeyNumber({ ...base, key: "3", ctrlKey: true }, false)).toBeNull();
    expect(askKeyNumber({ ...base, key: "3", repeat: true }, false)).toBeNull();
    expect(askKeyNumber({ ...base, key: "0" }, false)).toBeNull();
    expect(askKeyNumber({ ...base, key: "a" }, false)).toBeNull();
  });
});
