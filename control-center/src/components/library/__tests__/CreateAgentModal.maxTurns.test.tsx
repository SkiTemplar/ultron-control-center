// CreateAgentModal — invariante de los agentes de usuario (hallazgo #13 del
// audit 2026-11-08): todo agente creado desde Library lleva `maxTurns` y un ID
// exacto de la familia 5.5, nunca un alias ni `claude-fable-5-2`.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CreateAgentModal } from "../CreateAgentModal";
import {
  AGENT_MODELS,
  AGENT_TEMPLATES,
  isValidMaxTurns,
} from "../creatorTemplates";

vi.mock("../../../lib/button-prompts", () => ({
  getPrompt: vi.fn().mockResolvedValue("prompt de prueba"),
}));

const EXACT_IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue("/home/u/.claude/agents/mi-depurador.md");
});

function renderModal() {
  const onCreated = vi.fn();
  render(
    <CreateAgentModal projects={[]} onClose={() => {}} onCreated={onCreated} />,
  );
  return { onCreated };
}

function fillFrontmatter() {
  fireEvent.click(screen.getByText("Siguiente"));
  fireEvent.change(screen.getByPlaceholderText("mi-agente"), {
    target: { value: "mi-depurador" },
  });
  fireEvent.change(
    screen.getByPlaceholderText(/Una frase: qué hace este subagente/),
    { target: { value: "Acota fallos y propone arreglos mínimos." } },
  );
}

function maxTurnsInput(): HTMLInputElement {
  return screen.getByRole("spinbutton") as HTMLInputElement;
}

describe("plantillas de agente", () => {
  it("cada plantilla lleva un ID exacto 5.5 y un maxTurns válido", () => {
    for (const tpl of AGENT_TEMPLATES) {
      expect(EXACT_IDS).toContain(tpl.model);
      expect(isValidMaxTurns(tpl.maxTurns)).toBe(true);
    }
    expect(AGENT_MODELS.map((m) => m.id)).toEqual(EXACT_IDS);
  });

  it("isValidMaxTurns rechaza 0, 501, decimales y NaN", () => {
    for (const bad of [0, -5, 501, 12.5, Number.NaN]) {
      expect(isValidMaxTurns(bad)).toBe(false);
    }
  });
});

describe("CreateAgentModal — maxTurns y modelo", () => {
  it("envía el maxTurns de la plantilla y el ID exacto del modelo", async () => {
    const { onCreated } = renderModal();
    fireEvent.click(screen.getByText("Depurador"));
    fillFrontmatter();
    expect(maxTurnsInput().value).toBe("120");
    fireEvent.click(screen.getByText("Siguiente"));
    fireEvent.click(screen.getByText("Siguiente"));
    fireEvent.click(screen.getByText("Crear agente"));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "agent_create");
    const args = (call?.[1] as { args: Record<string, unknown> }).args;
    expect(args.maxTurns).toBe(120);
    expect(args.model).toBe("claude-opus-5-5");
  });

  it("el maxTurns editado a mano es el que se envía", async () => {
    const { onCreated } = renderModal();
    // La plantilla vacía no llega al mínimo de cuerpo; Implementador sí.
    fireEvent.click(screen.getByText("Implementador"));
    fillFrontmatter();
    expect(maxTurnsInput().value).toBe("200");
    fireEvent.change(maxTurnsInput(), { target: { value: "45" } });
    fireEvent.click(screen.getByText("claude-haiku-5-5"));
    fireEvent.click(screen.getByText("Siguiente"));
    fireEvent.click(screen.getByText("Siguiente"));
    fireEvent.click(screen.getByText("Crear agente"));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "agent_create");
    const args = (call?.[1] as { args: Record<string, unknown> }).args;
    expect(args.maxTurns).toBe(45);
    expect(args.model).toBe("claude-haiku-5-5");
  });

  it("con maxTurns fuera de rango no deja avanzar (caso negativo)", () => {
    renderModal();
    fillFrontmatter();
    fireEvent.change(maxTurnsInput(), { target: { value: "0" } });
    expect(screen.getByText("Siguiente").closest("button")).toBeDisabled();
    expect(screen.getByText(/Debe ser un entero entre 1 y 500/)).toBeTruthy();
    fireEvent.change(maxTurnsInput(), { target: { value: "501" } });
    expect(screen.getByText("Siguiente").closest("button")).toBeDisabled();
  });

  it("el selector no ofrece alias ni claude-fable-5-2", () => {
    renderModal();
    fillFrontmatter();
    // Por texto y no por rol: dentro del <label> de FieldLabel, el primer
    // botón toma como nombre accesible el texto de la etiqueta.
    for (const banned of ["opus", "sonnet", "haiku", "default", "claude-fable-5-2"]) {
      expect(screen.queryByText(banned, { selector: "button, button *" })).toBeNull();
    }
    for (const id of EXACT_IDS) {
      expect(screen.getByText(id).closest("button")).toBeTruthy();
    }
  });
});
