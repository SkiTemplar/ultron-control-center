import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dropdown, type DropdownOption } from "../components/Dropdown";
import { nextEnabled, typeahead } from "../components/dropdown-keys";

const OPTIONS: DropdownOption[] = [
  { value: "opus", label: "Opus 5.5", description: "Código y diseño" },
  { value: "opus1m", label: "Opus 5.5 · 1M", disabled: true, disabledReason: "No disponible en este plan" },
  { value: "sonnet", label: "Sonnet 5.5" },
  { value: "haiku", label: "Haiku antiguo", disabled: true },
];

function setup(value = "opus") {
  const onSelect = vi.fn();
  render(<Dropdown label="Modelo" value={value} options={OPTIONS} onSelect={onSelect} trigger={<span>Modelo</span>} />);
  const trigger = screen.getByRole("button", { name: "Modelo" });
  return { onSelect, trigger };
}

async function flushFrame() {
  await act(() => new Promise((r) => window.requestAnimationFrame(() => r(undefined))));
}

function activeLabel(): string | null {
  const list = screen.getByRole("listbox", { name: "Modelo" });
  const id = list.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.querySelector(".dd-label")?.textContent ?? null : null;
}

describe("Dropdown: navegación pura", () => {
  it("salta opciones deshabilitadas y da la vuelta", () => {
    expect(nextEnabled(OPTIONS, 0, 1)).toBe(2);
    expect(nextEnabled(OPTIONS, 2, 1)).toBe(0);
    expect(nextEnabled(OPTIONS, 0, -1)).toBe(2);
  });

  it("devuelve -1 si no hay ninguna opción habilitada (caso negativo)", () => {
    expect(nextEnabled([{ label: "a", disabled: true }], 0, 1)).toBe(-1);
    expect(nextEnabled([], -1, 1)).toBe(-1);
  });

  it("la búsqueda por letra ignora las deshabilitadas", () => {
    expect(typeahead(OPTIONS, 0, "s")).toBe(2);
    expect(typeahead(OPTIONS, 0, "h")).toBe(-1);
  });
});

describe("Dropdown: teclado y accesibilidad", () => {

  it("abre con ↓, marca la opción actual y expone el estado ARIA", async () => {
    const { trigger } = setup("sonnet");
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await flushFrame();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("listbox", { name: "Modelo" });
    expect(document.activeElement).toBe(list);
    expect(activeLabel()).toBe("Sonnet 5.5");
    expect(screen.getByRole("option", { name: /Sonnet 5.5/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /1M/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("No disponible en este plan")).toBeInTheDocument();
  });

  it("↑↓ Inicio Fin saltan las deshabilitadas y Enter elige y devuelve el foco", async () => {
    const { trigger, onSelect } = setup("opus");
    fireEvent.click(trigger);
    await flushFrame();
    const list = screen.getByRole("listbox", { name: "Modelo" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(activeLabel()).toBe("Sonnet 5.5");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(activeLabel()).toBe("Opus 5.5");
    fireEvent.keyDown(list, { key: "End" });
    expect(activeLabel()).toBe("Sonnet 5.5");
    fireEvent.keyDown(list, { key: "Home" });
    expect(activeLabel()).toBe("Opus 5.5");
    fireEvent.keyDown(list, { key: "s" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("sonnet");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("Esc cierra sin elegir y devuelve el foco al disparador", async () => {
    const { trigger, onSelect } = setup();
    fireEvent.click(trigger);
    await flushFrame();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("una opción deshabilitada no se elige ni con clic (caso negativo)", async () => {
    const { trigger, onSelect } = setup();
    fireEvent.click(trigger);
    await flushFrame();
    fireEvent.click(screen.getByRole("option", { name: /1M/ }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("un clic fuera cierra el popover", async () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    await flushFrame();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("sin opciones abre un diálogo con el detalle", async () => {
    render(<Dropdown label="Contexto" header={<button>Escribir /compact</button>} trigger={<span>ctx</span>} />);
    const trigger = screen.getByRole("button", { name: "ctx" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(trigger);
    await flushFrame();
    const dialog = screen.getByRole("dialog", { name: "Contexto" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Escribir /compact" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
