// curso.mjs — índice del curso académico consultable bajo demanda.
//
// Fuente: cockpit/curso.json (asignaturas, prioridad, periodo y proyectos
// enlazados por id de cockpit/projects.json). La actividad NO se guarda en el
// fichero: se calcula en cada consulta (último commit git y fichero modificado
// más reciente de cada proyecto), para que nunca quede vieja.
//
// Consumidores: tool MCP `curso_status` (scripts/mcp-memory-server.mjs) y CLI
// scripts/curso.mjs. Sin inyección en SessionStart: se consulta cuando hace falta.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const COCKPIT = path.join(homedir(), ".ultron", "cockpit");
export const DEFAULT_CURSO_PATH = path.join(COCKPIT, "curso.json");
export const DEFAULT_PROJECTS_PATH = path.join(COCKPIT, "projects.json");

const SKIP_DIRS = new Set([".git", "node_modules", ".codegraph", ".idea", ".vs", "target", "build", "dist", ".venv", "Binaries", "Intermediate", "Saved", "DerivedDataCache"]);
const MAX_SCANNED_ENTRIES = 5000;
const GIT_TIMEOUT_MS = 5000;

function readJson(file, label) {
  if (!existsSync(file)) throw new Error(`${label} no existe: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${label} no es JSON válido (${file}): ${e.message}`);
  }
}

function lastCommit(dir) {
  if (!existsSync(path.join(dir, ".git"))) return null;
  try {
    const out = execFileSync("git", ["-C", dir, "log", "-1", "--format=%cI%x1f%s"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    const [date, subject] = out.split("\x1f");
    return { date, subject };
  } catch {
    return null; // repo sin commits o git no disponible: se informa como null
  }
}

// Recorrido en anchura acotado: el fichero modificado más reciente, ignorando
// artefactos de build y metadatos. Devuelve también si el recorrido se cortó.
function newestFile(dir) {
  let best = null;
  let scanned = 0;
  const queue = [dir];
  while (queue.length > 0 && scanned < MAX_SCANNED_ENTRIES) {
    const current = queue.shift();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++scanned > MAX_SCANNED_ENTRIES) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) queue.push(full);
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      try {
        const mtime = statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { mtime, file: full };
      } catch {
        // fichero borrado durante el recorrido: se ignora
      }
    }
  }
  if (!best) return null;
  return {
    date: new Date(best.mtime).toISOString(),
    file: path.relative(dir, best.file),
    truncated: scanned > MAX_SCANNED_ENTRIES,
  };
}

function projectActivity(project) {
  const exists = existsSync(project.path);
  const commit = exists ? lastCommit(project.path) : null;
  const file = exists ? newestFile(project.path) : null;
  const dates = [commit?.date, file?.date].filter(Boolean).map((d) => Date.parse(d));
  return {
    id: project.id,
    nombre: project.name,
    ruta: project.path,
    existe: exists,
    ultimo_commit: commit,
    ultimo_fichero: file,
    ultima_actividad: dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null,
  };
}

export function cursoStatus({ codigo, cursoPath = DEFAULT_CURSO_PATH, projectsPath = DEFAULT_PROJECTS_PATH } = {}) {
  const curso = readJson(cursoPath, "curso.json");
  if (!Array.isArray(curso.asignaturas)) throw new Error("curso.json sin array 'asignaturas'");
  const projectsRaw = readJson(projectsPath, "projects.json");
  const projects = Array.isArray(projectsRaw) ? projectsRaw : projectsRaw.projects ?? [];
  const byId = new Map(projects.map((p) => [p.id, p]));

  const wanted = codigo ? String(codigo).trim().toUpperCase() : null;
  const selected = curso.asignaturas.filter((a) => !wanted || String(a.codigo).toUpperCase() === wanted);
  if (wanted && selected.length === 0) {
    const known = curso.asignaturas.map((a) => a.codigo).join(", ");
    throw new Error(`asignatura desconocida: ${codigo} (disponibles: ${known})`);
  }

  const asignaturas = selected
    .map((a) => {
      const ids = Array.isArray(a.proyectos) ? a.proyectos : [];
      const proyectos = ids.map((id) => (byId.has(id) ? projectActivity(byId.get(id)) : { id, existe: false, error: "id no registrado en projects.json" }));
      const fechas = proyectos.map((p) => p.ultima_actividad).filter(Boolean).sort();
      return { ...a, proyectos, ultima_actividad: fechas.at(-1) ?? null };
    })
    .sort((x, y) => (x.prioridad ?? 99) - (y.prioridad ?? 99));

  const ultimo = asignaturas
    .flatMap((a) => a.proyectos.filter((p) => p.ultima_actividad).map((p) => ({ asignatura: a.codigo, proyecto: p.id, fecha: p.ultima_actividad, fichero: p.ultimo_fichero?.file ?? null, commit: p.ultimo_commit?.subject ?? null })))
    .sort((x, y) => Date.parse(y.fecha) - Date.parse(x.fecha))[0] ?? null;

  return {
    schema: "curso_status.v1",
    curso: curso.curso ?? null,
    periodo_actual: curso.periodo_actual ?? null,
    generado: new Date().toISOString(),
    ultimo_trabajo: ultimo,
    asignaturas,
  };
}
