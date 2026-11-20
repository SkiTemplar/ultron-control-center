/**
 * auto-changelog.selftest.mjs — selftest HERMÉTICO de `already_recorded`
 * (scripts/hooks/auto-changelog.py).
 *
 * Bug del 2026-11-14: el post-commit añadía una sección `<!-- v15.9.0 -->`
 * aunque CHANGELOG.md ya tenía la versión con cabecera Keep a Changelog
 * (`## [15.9.0] - 2026-11-12`), porque solo reconocía su propia ancla.
 *
 * Casos:
 *   A) ancla propia `<!-- vX.Y.Z -->`            -> registrada
 *   B) cabecera `## [X.Y.Z] - fecha`              -> registrada
 *   C) cabecera `## vX.Y.Z — título`             -> registrada
 *   D) otra versión (15.9.1 frente a 15.9.0)      -> NO registrada
 *   E) la versión solo citada en el cuerpo        -> NO registrada
 *   F) sin CHANGELOG.md                           -> NO registrada
 *
 * Python: uv en local (norma del repo); `python` en el runner del CI.
 * Uso: node scripts/hooks/auto-changelog.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "auto-changelog.py");
const TMP = mkdtempSync(join(tmpdir(), "auto-changelog-selftest-"));

function elegirPython() {
  const candidatos = [["uv", "run", "--no-project", "python"], ["python"], ["python3"]];
  for (const c of candidatos) {
    const r = spawnSync(c[0], [...c.slice(1), "--version"], { encoding: "utf8", windowsHide: true });
    if (r.status === 0) return c;
  }
  throw new Error("no hay intérprete de Python (uv, python ni python3)");
}
const PY = elegirPython();

// Carga el módulo por ruta (el nombre lleva guion) sin ejecutar main().
const PROGRAMA = [
  "import importlib.util, sys",
  "from pathlib import Path",
  "spec = importlib.util.spec_from_file_location('auto_changelog', sys.argv[1])",
  "m = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(m)",
  "print('1' if m.already_recorded(Path(sys.argv[2]), sys.argv[3]) else '0')",
].join("\n");

function registrada(contenido, version) {
  const changelog = join(TMP, "CHANGELOG.md");
  rmSync(changelog, { force: true });
  if (contenido !== null) writeFileSync(changelog, contenido, "utf8");
  const r = spawnSync(PY[0], [...PY.slice(1), "-c", PROGRAMA, SCRIPT, changelog, version], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`python exit ${r.status}: ${r.stderr}`);
  return r.stdout.trim() === "1";
}

let fail = 0;
const A = (cond, nombre) => {
  if (cond) console.log(`  [PASS] ${nombre}`);
  else {
    fail++;
    console.log(`  [FAIL] ${nombre}`);
  }
};

try {
  A(registrada("# Changelog\n\n<!-- v15.7.0 -->\n## v15.7.0 — 2026-07-18\n", "15.7.0"), "A) ancla propia");
  A(registrada("# Changelog\n\n## Unreleased\n\n## [15.9.0] - 2026-11-12\n", "15.9.0"), "B) cabecera Keep a Changelog");
  A(registrada("# Changelog\n\n## v15.6.0 — 2026-07-06 — Primer release\n", "15.6.0"), "C) cabecera ## vX.Y.Z");
  A(!registrada("# Changelog\n\n## [15.9.0] - 2026-11-12\n", "15.9.1"), "D) otra versión no cuenta");
  A(!registrada("# Changelog\n\n## [15.8.0]\n- prepara la 15.9.0 y v15.9.0\n", "15.9.0"), "E) mención en el cuerpo no cuenta");
  A(!registrada(null, "15.9.0"), "F) sin CHANGELOG.md");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(fail === 0 ? "\nauto-changelog selftest: VERDE" : `\nauto-changelog selftest: ${fail} FALLO(S)`);
process.exit(fail === 0 ? 0 : 1);
