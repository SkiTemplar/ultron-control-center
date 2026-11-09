import { describe, expect, it } from "vitest";
import { scanResultAction, type ScanReport } from "./scanReport";

const report = (over: Partial<ScanReport> = {}): ScanReport => ({
  projects: [],
  added: [],
  scanned_roots: ["C:/raiz"],
  missing_roots: [],
  ...over,
});

const added = (name: string) => ({ id: name, name, path: `C:/raiz/${name}` });

describe("scanResultAction", () => {
  it("un escaneo sin novedades lo dice y nombra lo que recorrió", () => {
    const action = scanResultAction(report());
    expect(action.stdout).toContain("ninguna carpeta nueva");
    expect(action.stdout).toContain("C:/raiz");
    expect(action.stderr).toBe("");
  });

  it("nombra las altas y resume las que no caben", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const action = scanResultAction(report({ added: names.map(added) }));
    expect(action.stdout).toContain("10 proyectos nuevos");
    expect(action.stdout).toContain("h y 2 más");
    expect(scanResultAction(report({ added: [added("a")] })).stdout).toContain("1 proyecto nuevo (a)");
  });

  it("avisa de las raíces que no existen", () => {
    const action = scanResultAction(report({ missing_roots: ["D:/fuera"] }));
    expect(action.stderr).toContain("D:/fuera");
  });
});
