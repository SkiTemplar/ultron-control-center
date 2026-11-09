import { beforeEach, describe, expect, it, vi } from "vitest";
import { listWithProjectEntries } from "./projectScoped";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const entry = (origin: string, path: string) => ({ origin, path });
const GLOBAL = entry("global", "C:/home/.claude/agents/a.md");

function backend(perProject: Record<string, unknown>, projects?: unknown) {
  invokeMock.mockImplementation(async (cmd: string, args?: { projectPath?: string | null }) => {
    if (cmd === "list_projects") {
      if (projects instanceof Error) throw projects;
      return projects ?? [
        { id: "__home", path: "C:/home" },
        { id: "uno", path: "C:/uno" },
        { id: "dos", path: "C:/dos" },
        { id: "sin-ruta", path: "" },
      ];
    }
    const key = args?.projectPath ?? "null";
    const value = perProject[key];
    if (value instanceof Error) throw value;
    return value ?? [];
  });
}

describe("listWithProjectEntries", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("añade las entradas de proyecto sin repetir las globales", async () => {
    const uno = entry("project", "C:/uno/.claude/agents/u.md");
    backend({ null: [GLOBAL], "C:/uno": [GLOBAL, uno], "C:/dos": [GLOBAL] });
    const { entries, failures } = await listWithProjectEntries("list_agents");
    expect(entries).toEqual([GLOBAL, uno]);
    expect(failures).toEqual([]);
  });

  it("no pregunta por el home ni por proyectos sin ruta", async () => {
    backend({ null: [] });
    await listWithProjectEntries("list_skills");
    const asked = invokeMock.mock.calls
      .filter(([cmd]) => cmd === "list_skills")
      .map(([, args]) => args.projectPath);
    expect(asked).toEqual([null, "C:/uno", "C:/dos"]);
  });

  it("un proyecto ilegible no tumba el resto y se avisa", async () => {
    const dos = entry("project", "C:/dos/.claude/agents/d.md");
    backend({ null: [GLOBAL], "C:/uno": new Error("sin permiso"), "C:/dos": [dos] });
    const { entries, failures } = await listWithProjectEntries("list_agents");
    expect(entries).toEqual([GLOBAL, dos]);
    expect(failures).toEqual(["uno: sin permiso"]);
  });

  it("sin lista de proyectos enseña lo global y lo dice", async () => {
    backend({ null: [GLOBAL] }, new Error("projects.json roto"));
    const { entries, failures } = await listWithProjectEntries("list_agents");
    expect(entries).toEqual([GLOBAL]);
    expect(failures[0]).toContain("projects.json roto");
  });

  it("un fallo del listado global sigue siendo un error", async () => {
    backend({ null: new Error("boom") });
    await expect(listWithProjectEntries("list_agents")).rejects.toThrow("boom");
  });
});
