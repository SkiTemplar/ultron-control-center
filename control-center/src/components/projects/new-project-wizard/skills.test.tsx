// Skills de la pool en el asistente "Nuevo proyecto" — unit tests
//
// Covers:
//   (a) SkillsSection: casillas preseleccionadas (sugeridas y revisadas),
//       licencia y condiciones visibles, la sin revisar deshabilitada.
//   (b) Negativo: pool vacía = la sección no se pinta; pool ilegible = error
//       visible con reintento, no un hueco silencioso.
//   (c) Flujo del hook: al elegir plantilla se piden sus sugeridas, la
//       selección se puede cambiar y viaja a cliCreate como `skills`.
//   (d) cliCreate traduce `skills` a `--skills a,b` o `--skills none` en los
//       args del comando Tauri `project_create_cli`.

import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  cliCreate, cliList, cliRoots, cliSkills, cliTemplates,
  type CliRoot, type CliSkill, type CliTemplate,
} from "../../../lib/project-create-cli";
import { SkillsSection } from "./SkillsSection";
import { useNewProjectWizard } from "./useNewProjectWizard";
import { defaultSelection, type SkillPickerState } from "./useSkillPicker";

type CliModule = typeof import("../../../lib/project-create-cli");

// cliCreate conserva la implementación real (para (d)); el resto, mocks.
vi.mock("../../../lib/project-create-cli", async (importOriginal) => {
  const actual = await importOriginal<CliModule>();
  return {
    ...actual,
    cliRoots: vi.fn(),
    cliList: vi.fn(),
    cliTemplates: vi.fn(),
    cliSkills: vi.fn(),
    cliCreate: vi.fn(actual.cliCreate),
  };
});

const SKILLS: CliSkill[] = [
  { name: "impeccable", license: "Apache-2.0", reviewed: true, suggested: true, conditions: "APTA CON CONDICIONES. HIGH mitigado…" },
  { name: "humanizer", license: "MIT", reviewed: true, suggested: false, conditions: "APTA CON CONDICIONES. Sin red…" },
  { name: "cruda", license: null, reviewed: false, suggested: true, conditions: "" },
];

function picker(over: Partial<SkillPickerState> = {}): SkillPickerState {
  return {
    skills: SKILLS,
    error: null,
    loading: false,
    selected: defaultSelection(SKILLS),
    toggle: vi.fn(),
    reload: vi.fn(),
    ...over,
  };
}

describe("SkillsSection", () => {
  it("marca las sugeridas revisadas y deshabilita la que no tiene revisión", () => {
    render(<SkillsSection picker={picker()} />);
    expect(screen.getByRole("checkbox", { name: /impeccable/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /humanizer/ })).not.toBeChecked();
    const cruda = screen.getByRole("checkbox", { name: /cruda/ });
    expect(cruda).not.toBeChecked();
    expect(cruda).toBeDisabled();
    expect(screen.getByText("Apache-2.0")).toBeInTheDocument();
    expect(screen.getByText(/HIGH mitigado/)).toBeInTheDocument();
    expect(screen.getByText(/Sin revisión de seguridad/)).toBeInTheDocument();
  });

  it("al pulsar una casilla llama a toggle con su nombre", () => {
    const p = picker();
    render(<SkillsSection picker={p} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /humanizer/ }));
    expect(p.toggle).toHaveBeenCalledWith("humanizer");
  });

  it("negativo: con la pool vacía no pinta nada", () => {
    const { container } = render(<SkillsSection picker={picker({ skills: [], selected: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("negativo: si la pool no se puede leer lo dice y deja reintentar", () => {
    const p = picker({ skills: null, selected: [], error: { code: "POOL_UNAVAILABLE", message: "pool.json roto" } });
    render(<SkillsSection picker={p} />);
    expect(screen.getByText(/pool\.json roto/)).toBeInTheDocument();
    expect(screen.getByText(/se creará sin skills/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(p.reload).toHaveBeenCalled();
  });
});

const ROOT: CliRoot = { id: "personal", label: "Personal", path: "C:\\dev\\Proyectos", kind: "personal", exists: true };
const WEB: CliTemplate = {
  id: "web-vite-react-ts", label: "Web", description: "", source: "generator", requires: ["npm"], available: true, kinds: ["personal"],
};

describe("useNewProjectWizard — skills de la pool", () => {
  beforeEach(() => {
    vi.mocked(cliRoots).mockResolvedValue({ ok: true, roots: [ROOT] });
    vi.mocked(cliList).mockResolvedValue({ ok: true, root: ROOT.id, sub: "", entries: [] });
    vi.mocked(cliTemplates).mockResolvedValue({ ok: true, templates: [WEB] });
    vi.mocked(cliSkills).mockResolvedValue({ ok: true, template: WEB.id, skills: SKILLS });
  });

  it("preselecciona las sugeridas de la plantilla y envía la selección a cliCreate", async () => {
    const create = vi.mocked(cliCreate).mockResolvedValueOnce({
      ok: true, projectPath: "C:\\dev\\Proyectos\\Web", projectId: "web", template: WEB.id, steps: [], filesCreated: [], skills: [],
    });
    const { result } = renderHook(() => useNewProjectWizard({ open: true, onClose: vi.fn() }));
    await waitFor(() => expect(result.current.roots).not.toBeNull());
    act(() => result.current.setRootId(ROOT.id));
    await waitFor(() => expect(result.current.selectedRoot).not.toBeNull());
    act(() => result.current.next()); // tipo -> carpeta
    await waitFor(() => expect(result.current.entries).not.toBeNull());
    act(() => result.current.next()); // carpeta -> nombre
    act(() => result.current.setName("Web"));
    act(() => result.current.next()); // nombre -> plantilla
    await waitFor(() => expect(result.current.templates).not.toBeNull());
    act(() => result.current.setTemplateId(WEB.id));
    act(() => result.current.next()); // plantilla -> opciones

    await waitFor(() => expect(result.current.skillPicker.skills).toEqual(SKILLS));
    expect(cliSkills).toHaveBeenCalledWith(WEB.id);
    expect(result.current.skillPicker.selected).toEqual(["impeccable"]);
    expect(result.current.canAdvance()).toBe(true);

    act(() => result.current.skillPicker.toggle("humanizer"));
    act(() => result.current.skillPicker.toggle("cruda")); // sin revisar: se ignora
    await act(() => result.current.submitCreate());

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ template: WEB.id, skills: ["impeccable", "humanizer"] }));
  });
});

describe("cliCreate — argumento --skills", () => {
  const base = { root: "personal", sub: "", name: "Web", template: "web-vite-react-ts" };

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({ ok: true });
  });

  it("envía --skills con la lista, none si está vacía y nada si no se indica", async () => {
    const argsOf = () => (vi.mocked(invoke).mock.lastCall?.[1] as { args: string[] }).args;

    const real = await vi.importActual<CliModule>("../../../lib/project-create-cli");
    await real.cliCreate({ ...base, skills: ["impeccable", "supabase"] });
    expect(vi.mocked(invoke).mock.lastCall?.[0]).toBe("project_create_cli");
    expect(argsOf()).toEqual(expect.arrayContaining(["--skills", "impeccable,supabase"]));

    await real.cliCreate({ ...base, skills: [] });
    expect(argsOf()).toEqual(expect.arrayContaining(["--skills", "none"]));

    await real.cliCreate(base);
    expect(argsOf()).not.toContain("--skills");
  });
});
