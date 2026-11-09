// Diff del inspector Git: la cabecera de git se quita, pero una línea del hunk que
// empieza por «-- » o «++ » es contenido y se queda (caso negativo del filtro antiguo).

import { describe, expect, it } from "vitest";
import { diffBodyLines } from "../components/inspector/Git";

const DIFF = [
  "diff --git a/x.sql b/x.sql",
  "index 1..2 100644",
  "--- a/x.sql",
  "+++ b/x.sql",
  "@@ -1,2 +1,2 @@",
  "--- comentario SQL borrado",
  "+++ contador incrementado",
  " sin cambios",
].join("\n");

describe("diffBodyLines", () => {
  it("quita la cabecera y conserva las líneas del hunk que parecen cabecera", () => {
    expect(diffBodyLines(DIFF)).toEqual(["@@ -1,2 +1,2 @@", "--- comentario SQL borrado", "+++ contador incrementado", " sin cambios"]);
  });

  it("caso negativo: un texto que no es diff (error o binario) no se vacía", () => {
    expect(diffBodyLines("fatal: no es un repositorio")).toEqual(["fatal: no es un repositorio"]);
    expect(diffBodyLines("diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ")).toEqual(["Binary files a/i.png and b/i.png differ"]);
  });
});
