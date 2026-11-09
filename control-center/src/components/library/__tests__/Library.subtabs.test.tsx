// Biblioteca: la subpestaña Routing se retiró (2026-10-18). Ni aparece en la
// navegación ni se restaura desde un valor antiguo guardado en localStorage.

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../Skills", () => ({ Skills: () => <div>vista-skills</div> }));
vi.mock("../../Agents", () => ({ Agents: () => <div>vista-agentes</div> }));
vi.mock("../../Rules", () => ({ Rules: () => <div>vista-reglas</div> }));
vi.mock("../../Hooks", () => ({ Hooks: () => <div>vista-hooks</div> }));
vi.mock("../../Settings/PluginsSection", () => ({ PluginsSection: () => <div>vista-plugins</div> }));
vi.mock("../Catalog", () => ({ Catalog: () => <div>vista-catalogo</div> }));
vi.mock("../Commands", () => ({ Commands: () => <div>vista-comandos</div> }));
vi.mock("../Tones", () => ({ Tones: () => <div>vista-tonos</div> }));

import { Library } from "../../Library";

const STORAGE_KEY = "control-center.library.sub_tab.v1";

describe("Library sin la subpestaña Routing", () => {
  afterEach(() => localStorage.clear());

  it("no ofrece Routing entre las subpestañas", () => {
    render(<Library />);
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual([
      "Skills",
      "Agentes",
      "Reglas",
      "Plugins",
      "Hooks",
      "Comandos",
      "Tonos",
      "Catálogo",
    ]);
  });

  it("un 'routing' guardado de una versión anterior cae a Skills", () => {
    localStorage.setItem(STORAGE_KEY, "routing");
    render(<Library />);
    expect(screen.getByRole("tab", { name: "Skills" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("vista-skills")).toBeTruthy();
  });
});
