// Vista final del asistente: los fallos de skills se avisan aparte aunque el
// proyecto se haya creado (link fallido o pool ilegible sin --skills).

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResultView } from "./ResultView";
import type { CreateData } from "../../../lib/project-create-cli";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function data(over: Partial<CreateData>): CreateData {
  return {
    projectPath: "C:/tmp/demo",
    projectId: "demo",
    template: "vacio",
    steps: [],
    filesCreated: [],
    skills: [],
    ...over,
  };
}

function renderResult(d: CreateData) {
  render(<ResultView result={{ ok: true, data: d }} onClose={() => {}} onRetry={() => {}} />);
}

describe("ResultView: avisos de skills", () => {
  it("avisa del link fallido con el nombre de la skill", () => {
    renderResult(data({ skills: [{ name: "impeccable", ok: false, message: "skill-pool link falló: x" }] }));
    expect(screen.getByText(/No se pudo enlazar: impeccable/)).toBeTruthy();
  });

  it("avisa si la pool no se pudo leer aunque skills venga vacío", () => {
    renderResult(data({ steps: [{ step: "skills", ok: false, message: "no se pudo leer la pool: ENOENT" }] }));
    expect(screen.getByText(/No se pudo leer la pool de skills/)).toBeTruthy();
  });

  it("negativo: sin fallos no muestra ningún aviso", () => {
    renderResult(data({ steps: [{ step: "skills", ok: true, message: "se enlazan (--skills): impeccable" }] }));
    expect(screen.queryByText(/No se pudo/)).toBeNull();
  });
});
