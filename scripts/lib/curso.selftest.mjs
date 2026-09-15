// curso.selftest.mjs — test hermético del índice del curso (sin tocar cockpit real).
// Uso: node scripts/lib/curso.selftest.mjs   (exit 0 = verde)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cursoStatus } from "./curso.mjs";

const root = mkdtempSync(path.join(tmpdir(), "curso-selftest-"));
let fail = 0;
const A = (c, n, d) => { if (c) console.log(`  [PASS] ${n}`); else { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); } };
const expectThrow = (fn, re, n) => {
  try { fn(); A(false, n, "no lanzó error"); } catch (e) { A(re.test(e.message), n, e.message); }
};

try {
  // Arrange: dos proyectos, uno con git y otro sin git, más un id huérfano.
  const pA = path.join(root, "A");
  const pB = path.join(root, "B");
  mkdirSync(path.join(pA, "trabajos"), { recursive: true });
  mkdirSync(path.join(pB, "node_modules"), { recursive: true });
  writeFileSync(path.join(pA, "trabajos", "entrega1.md"), "a");
  writeFileSync(path.join(pB, "notas.txt"), "b");
  writeFileSync(path.join(pB, "node_modules", "ignorado.js"), "x");
  const old = new Date("2026-01-01T00:00:00Z");
  utimesSync(path.join(pA, "trabajos", "entrega1.md"), old, old);
  const recent = new Date("2026-09-01T00:00:00Z");
  utimesSync(path.join(pB, "notas.txt"), recent, recent);
  utimesSync(path.join(pB, "node_modules", "ignorado.js"), new Date(), new Date());
  const git = (...args) => execFileSync("git", ["-C", pA, ...args], { stdio: "ignore", env: { ...process.env, GIT_COMMITTER_DATE: "2026-02-01T00:00:00Z", GIT_AUTHOR_DATE: "2026-02-01T00:00:00Z" } });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "primera entrega");

  const projectsPath = path.join(root, "projects.json");
  writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "a", name: "A", path: pA }, { id: "b", name: "B", path: pB }] }));
  const cursoPath = path.join(root, "curso.json");
  writeFileSync(cursoPath, JSON.stringify({
    curso: "2026-27",
    periodo_actual: "C1",
    asignaturas: [
      { codigo: "SEG", nombre: "Segunda", prioridad: 2, proyectos: ["b", "fantasma"] },
      { codigo: "PRI", nombre: "Primera", prioridad: 1, proyectos: ["a"] },
    ],
  }));

  // Act
  const all = cursoStatus({ cursoPath, projectsPath });

  // Assert
  A(all.asignaturas.map((a) => a.codigo).join() === "PRI,SEG", "ordena por prioridad", all.asignaturas.map((a) => a.codigo).join());
  const a = all.asignaturas[0].proyectos[0];
  A(a.ultimo_commit?.subject === "primera entrega", "lee el último commit git", JSON.stringify(a.ultimo_commit));
  A(a.ultimo_fichero?.file === path.join("trabajos", "entrega1.md"), "localiza el fichero más reciente", JSON.stringify(a.ultimo_fichero));
  const b = all.asignaturas[1].proyectos[0];
  A(b.ultimo_commit === null && b.ultimo_fichero?.file === "notas.txt", "proyecto sin git: ignora node_modules y usa mtime", JSON.stringify(b));
  A(all.asignaturas[1].proyectos[1].existe === false && /no registrado/.test(all.asignaturas[1].proyectos[1].error), "id huérfano se informa, no se oculta", JSON.stringify(all.asignaturas[1].proyectos[1]));
  A(all.ultimo_trabajo?.asignatura === "SEG" && all.ultimo_trabajo?.fichero === "notas.txt", "ultimo_trabajo = actividad más reciente global", JSON.stringify(all.ultimo_trabajo));

  const one = cursoStatus({ codigo: "pri", cursoPath, projectsPath });
  A(one.asignaturas.length === 1 && one.asignaturas[0].codigo === "PRI", "filtra por código sin distinguir mayúsculas", JSON.stringify(one.asignaturas.map((x) => x.codigo)));

  // Casos negativos
  expectThrow(() => cursoStatus({ codigo: "NOPE", cursoPath, projectsPath }), /desconocida: NOPE .*PRI/, "código desconocido -> error con las disponibles");
  expectThrow(() => cursoStatus({ cursoPath: path.join(root, "no.json"), projectsPath }), /curso\.json no existe/, "curso.json ausente -> error claro");
  writeFileSync(path.join(root, "roto.json"), "{");
  expectThrow(() => cursoStatus({ cursoPath: path.join(root, "roto.json"), projectsPath }), /no es JSON válido/, "curso.json corrupto -> error claro");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fail === 0 ? "\nSELFTEST CURSO: VERDE" : `\nSELFTEST CURSO: ROJO (${fail})`);
process.exit(fail === 0 ? 0 : 1);
