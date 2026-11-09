// Las tareas del relevo automático (kind "relay") se leen como hilo: traspaso
// plegado, acciones plegadas y desplegables, errores siempre visibles y la
// respuesta con el Markdown del chat. Caso negativo: una tarea suelta (task)
// sigue en el bloque compacto y no se convierte en hilo.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { EngineBlock } from "../components/chat/EngineBlock";
import { isHandoff } from "../components/chat/EngineThread";
import { ApiContext } from "../context";
import type { EngineTask } from "../types";

const HANDOFF = "Continua el trabajo de Claude en este mismo repositorio.\n## Ultimo prompt que Claude no pudo atender\narregla el test";

function task(over: Partial<EngineTask>): EngineTask {
  return {
    id: "t1", engine: "codex", kind: "relay", mode: "local", cwd: "C:/repo", prompt: HANDOFF,
    status: "done", startedAt: new Date().toISOString(), events: [], sessionId: "s1", ...over,
  };
}

function mount(tasks: EngineTask[]) {
  const api = { isMock: true, engineCancel: vi.fn(async () => undefined), engineBring: vi.fn(async () => undefined) } as unknown as SesionesApi;
  render(
    <ApiContext.Provider value={api}>
      {tasks.map((t) => <EngineBlock key={t.id} task={t} />)}
    </ApiContext.Provider>,
  );
  return api;
}

afterEach(cleanup);

describe("hilo del relevo", () => {
  it("dos turnos en orden, con id y data-engine-task para el salto desde Agentes", () => {
    mount([
      task({ id: "a", summary: "primera respuesta" }),
      task({ id: "b", engine: "gemini", prompt: "y ahora los docs", summary: "segunda respuesta" }),
    ]);
    const turns = screen.getAllByTestId("engine-thread");
    expect(turns.map((t) => t.getAttribute("data-engine-task"))).toEqual(["a", "b"]);
    expect(turns[0].id).toBe("engine-task-a");
    expect(turns[0].textContent).toContain("Traspaso desde Claude");
    expect(turns[1].textContent).toContain("y ahora los docs");
    expect(turns[1].querySelector("[data-testid=engine-handoff]")).toBeNull();
  });

  it("el traspaso va plegado con el texto completo dentro", () => {
    mount([task({})]);
    const d = screen.getByTestId("engine-handoff") as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(d.textContent).toContain("arregla el test");
    expect(isHandoff("hola")).toBe(false);
  });

  it("todas las acciones plegadas en «N acciones» y desplegables; el error siempre visible", () => {
    const events = [
      ...Array.from({ length: 8 }, (_, i) => ({ kind: "command" as const, text: `cmd-${i}` })),
      { kind: "patch" as const, text: "src/a.ts" },
      { kind: "error" as const, text: "falló la build" },
    ];
    mount([task({ events })]);
    const acts = screen.getByTestId("engine-actions") as HTMLDetailsElement;
    expect(acts.open).toBe(false);
    expect(acts.querySelector("summary")?.textContent).toBe("9 acciones");
    // Sin recorte a los 6 últimos: el primero sigue accesible.
    expect(acts.textContent).toContain("$ cmd-0");
    fireEvent.click(acts.querySelector("summary")!);
    expect(acts.open).toBe(true);
    const errs = screen.getByTestId("engine-errors");
    expect(errs.closest("details")).toBeNull();
    expect(errs.textContent).toContain("falló la build");
  });

  it("la respuesta usa el Markdown del chat (código y fórmulas)", () => {
    mount([task({ summary: "**hecho**\n\n```ts\nconst x = 1;\n```\n\n$a^2$" })]);
    const t = screen.getByTestId("engine-thread");
    expect(t.querySelector(".md strong")?.textContent).toBe("hecho");
    expect(t.querySelector(".md pre code")?.textContent).toContain("const x = 1;");
    expect(t.querySelector(".md .katex")).not.toBeNull();
  });

  it("en curso: spinner y Cancelar llama a engineCancel", () => {
    const api = mount([task({ status: "running" })]);
    expect(screen.getByLabelText("En curso")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(api.engineCancel).toHaveBeenCalledWith("t1");
  });

  it("caso negativo: una tarea suelta sigue en el bloque compacto", () => {
    mount([task({ kind: "task", prompt: "revisa x" })]);
    expect(screen.queryByTestId("engine-thread")).toBeNull();
    const b = screen.getByTestId("engine-block");
    expect(b.getAttribute("data-engine-task")).toBe("t1");
  });
});
