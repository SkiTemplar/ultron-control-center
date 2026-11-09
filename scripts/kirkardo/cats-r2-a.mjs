// kirkardo/cats-r2-a.mjs — checks de la ronda 2 (2026-10-23) para las
// categorias 1 (memoria), 2 (CodeGraph), 4 (skills y agentes) y 5 (limpieza).
// Miden el COMPORTAMIENTO de lo que arreglo la primera ronda: tests concretos,
// salidas de scripts y artefactos, no la presencia de un simbolo.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as P from "./predicates.mjs";
import * as R2 from "./predicates-r2.mjs";
import { cargoTestCheck } from "./cargo.mjs";
import { activeAgentTools, pluginIndex } from "./claude-env.mjs";
import { AGENTS_DIR, CC_TAURI, COCKPIT, REPO, SKILLS_DIR, ULTRON, extendCat, fileExists, invokeCallsites } from "./core.mjs";
import { runResumeHook } from "./hook-io.mjs";

// ---------------------------------------------------------------------------
// CAT 1 — Memoria
// ---------------------------------------------------------------------------
extendCat(1, [
  {
    id: "1.11",
    desc: "la salud del store SQLite refleja el FTS5: con el indice desincronizado healthy=false (cargo test health_tests, positivo y negativo)",
    auto: true,
    check() {
      // memoria (a2e48ba4): SqliteStore::health devolvia healthy=true fijo.
      return cargoTestCheck("memory::sqlite_store::store_impl::health_tests::", { minPassed: 2 });
    },
  },
  {
    id: "1.12",
    desc: "el recall de diagnostico (doctor, evals) no escribe telemetria: ni evento Retrieved ni touch_injected; el recall real si (cargo test recall_unified::usage)",
    auto: true,
    check() {
      // memoria-3 (4437b5cc): el doctor tocaba access_count y last_accessed_at,
      // la senal de decaimiento del GC.
      return cargoTestCheck("commands::memory::recall_unified::usage::tests::", { minPassed: 3 });
    },
  },
  {
    id: "1.13",
    desc: "CLI del sidecar: --help/-h no despachan ninguno de los subcomandos que escriben (sweep --help sin ejecutar) y un flag desconocido (--dryrun) es error (cargo test --bin ultron-memory cli_spec)",
    auto: true,
    check() {
      // memoria-8 (4437b5cc): sweep --help y stale --help ejecutaban escrituras
      // masivas. Se mide con los tests del binario y no ejecutando el sidecar
      // desplegado: el de bin/ puede ser anterior al fix y escribiria de verdad.
      return cargoTestCheck("cli_spec::", { bin: "ultron-memory", minPassed: 5 });
    },
  },
  {
    id: "1.14",
    desc: "la bitacora no promueve autorizaciones ni restricciones de sesion a decisiones vigentes: selftest de project-state en verde Y el <project-state> del resume real sin 'autoriz' ni 'No hacer commits'",
    auto: true,
    check() {
      // aeae84ea: el SessionStart inyectaba «Usuario autorizo continuar…» y
      // «No hacer commits…» como decisiones vigentes.
      const st = join(REPO, "hooks", "scripts", "lib", "project-state.selftest.mjs");
      if (!existsSync(st)) return { pass: false, detail: "no medible: project-state.selftest.mjs ausente" };
      const r = spawnSync(process.execPath, [st], { cwd: REPO, encoding: "utf8", timeout: 120000, windowsHide: true });
      const art = R2.resumeSessionScopedVerdict(runResumeHook(ULTRON).ac ?? "");
      return {
        pass: r.status === 0 && art.pass === true,
        detail: `selftest project-state exit=${r.status}; artefacto: ${art.detail}`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 2 — CodeGraph
// ---------------------------------------------------------------------------
const VIEWER_CMDS = ["codegraph_files", "codegraph_search", "codegraph_neighborhood"];

extendCat(2, [
  {
    id: "2.9",
    desc: "visor CodeGraph in-app cableado: codegraph_files/search/neighborhood registrados en generate_handler! y con invoke() real en el frontend",
    auto: true,
    check() {
      const handlers = join(CC_TAURI, "handlers.rs");
      if (!fileExists(handlers)) return { pass: false, detail: "no medible: handlers.rs ausente" };
      const parsed = P.parseGenerateHandler(readFileSync(handlers, "utf8"));
      if (!parsed) return { pass: false, detail: "no medible: generate_handler! no encontrado" };
      return R2.commandsWiredVerdict(VIEWER_CMDS, parsed.registered, (c) => invokeCallsites(c).length);
    },
  },
  {
    id: "2.10",
    desc: "indice por proyecto con el criterio de ensure-project: codegraph-index-projects.mjs (informe) -> 0 proyectos que necesitan indexado",
    auto: true,
    check() {
      const script = join(REPO, "scripts", "codegraph-index-projects.mjs");
      if (!existsSync(script)) return { pass: false, detail: "no medible: codegraph-index-projects.mjs ausente" };
      const r = spawnSync(process.execPath, [script], { cwd: REPO, encoding: "utf8", timeout: 120000, windowsHide: true });
      return R2.indexPendingVerdict({ code: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` });
    },
  },
  {
    id: "2.11",
    desc: "agentes activos con codegraph: los que tienen lista tools: sin codegraph son solo doc-summarizer y game-designer (no exploran codigo)",
    auto: true,
    check() {
      return R2.agentsCodegraphVerdict(activeAgentTools(), ["doc-summarizer", "game-designer"]);
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 4 — Skills y agentes
// ---------------------------------------------------------------------------

// .md de una skill activa (SKILL.md, references/, agents/...), sin changelogs:
// el historico cita a proposito nombres que ya no existen.
function skillMarkdown(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md") && !/changelog/i.test(name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

extendCat(4, [
  {
    id: "4.10",
    desc: "0 referencias fantasma en las skills activas: cada subagent_type y cada `plugin:nombre` que citan resuelve en un agente activo, un builtin o un plugin habilitado",
    auto: true,
    check() {
      // skills-agentes-1: ultron y senior-engineer mandaban delegar en
      // ultron-*, superpowers:*, feature-dev:*... que no existen. Una linea que
      // declara la ausencia («deshabilitado», «no existe») no cuenta.
      if (!existsSync(SKILLS_DIR)) return { pass: false, detail: "no medible: ~/.claude/skills ausente" };
      const active = readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !/^[._]/.test(e.name) && existsSync(join(SKILLS_DIR, e.name, "SKILL.md")))
        .map((e) => e.name);
      const refs = active.flatMap((s) =>
        skillMarkdown(join(SKILLS_DIR, s)).map((f) => ({
          file: `${s}/${f.slice(join(SKILLS_DIR, s).length + 1).replace(/\\/g, "/")}`,
          ...R2.skillRefs(readFileSync(f, "utf8")),
        })),
      );
      const activeAgents = new Set(existsSync(AGENTS_DIR) ? readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)) : []);
      return R2.skillRefsVerdict(refs, { activeAgents, pluginItem: pluginIndex().item });
    },
  },
  {
    id: "4.11",
    desc: "la pestana Agents no activa ni guarda un agente fuera de la familia 5.5 o sin maxTurns (cargo test agents::tests, con los casos de rechazo)",
    auto: true,
    check() {
      // 8c2d8a81: agent_toggle_in renombraba .md.disabled a .md sin mirar el
      // frontmatter. Es la puerta que permite a 4.9 no contar los desactivados.
      return cargoTestCheck("agents::tests::", { minPassed: 12 });
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 5 — Limpieza
// ---------------------------------------------------------------------------
extendCat(5, [
  {
    id: "5.5",
    desc: "retencion viva: <= 10 copias de projects.json en cockpit/ y <= 8 logs de backup fechados por tipo en logs/",
    auto: true,
    check() {
      // N5: 36 projects.json.bak-* sin podar; logs de backup sin retencion. La
      // poda corre en la siguiente escritura del registro y del backup.
      const logs = join(ULTRON, "logs");
      if (!existsSync(COCKPIT)) return { pass: false, detail: "no medible: cockpit/ ausente" };
      const counts = R2.retentionCounts(readdirSync(COCKPIT), existsSync(logs) ? readdirSync(logs) : []);
      return R2.retentionVerdict(counts, { maxBak: 10, maxLogs: 8 });
    },
  },
]);
