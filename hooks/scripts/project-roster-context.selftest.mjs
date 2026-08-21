/**
 * project-roster-context.selftest.mjs — check conductual del SessionStart hook
 * que inyecta el roster de subagentes del proyecto.
 *
 * Contrato bajo prueba:
 *   1) Proyecto SIN roster -> el hook lo genera por stack detectado (fixture
 *      MONOREPO: manifiestos dos niveles abajo, node_modules como ruido), lo
 *      PERSISTE en cockpit/projects/<id>/agent-roster.json y lo inyecta.
 *   2) Roster ya existente -> se respeta tal cual (no se regenera ni se
 *      reordena) y las entradas de agentes SIN fichero en disco se filtran.
 *   3) cwd fuera de cualquier proyecto conocido -> sin output.
 *
 * Aislamiento: ULTRON_ROSTER_ROOT_OVERRIDE + ULTRON_ROSTER_AGENTS_OVERRIDE
 * apuntan a un fixture temporal; nunca se toca el cockpit real.
 *
 * Uso: node hooks/scripts/project-roster-context.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "project-roster-context.js");
const FIXTURE = join(HERE, "..", "..", "logs", "_selftest-project-roster");
const ULTRON_FAKE = join(FIXTURE, "ultron-root");
const AGENTS_FAKE = join(FIXTURE, "agents");
const PROJECT_DIR = join(FIXTURE, "proyecto-demo");

let fail = 0;
function A(cond, name, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}`);
    if (detail) console.log(`         -> ${detail}`);
  }
}

function resetFixture() {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(ULTRON_FAKE, "cockpit", "projects"), { recursive: true });
  mkdirSync(AGENTS_FAKE, { recursive: true });
  mkdirSync(PROJECT_DIR, { recursive: true });

  // Catalogo de agentes disponible (solo estos existen en "disco").
  for (const name of [
    "code-reviewer",
    "debugger",
    "architect-reviewer",
    "test-automator",
    "security-auditor",
    "rust-engineer",
    "typescript-pro",
    "react-specialist",
    "vue-expert",
  ]) {
    writeFileSync(join(AGENTS_FAKE, `${name}.md`), `---\nname: ${name}\n---\n`, "utf8");
  }

  // Monorepo Rust + React/TS con los manifiestos DOS niveles abajo (misma
  // forma que ULTRON: control-center/package.json y
  // control-center/src-tauri/Cargo.toml). Un escaneo de solo la raiz no
  // detectaria nada de esto.
  const appDir = join(PROJECT_DIR, "control-center");
  const tauriDir = join(appDir, "src-tauri");
  mkdirSync(tauriDir, { recursive: true });
  writeFileSync(join(tauriDir, "Cargo.toml"), "[package]\nname = \"demo\"\n", "utf8");
  writeFileSync(
    join(appDir, "package.json"),
    JSON.stringify({ dependencies: { react: "19", typescript: "5" } }),
    "utf8",
  );
  // Ruido que NO debe recorrerse (si se recorriera, apareceria vue en el roster).
  const noise = join(PROJECT_DIR, "node_modules", "paquete");
  mkdirSync(noise, { recursive: true });
  writeFileSync(join(noise, "package.json"), JSON.stringify({ dependencies: { vue: "3" } }), "utf8");

  writeFileSync(
    join(ULTRON_FAKE, "cockpit", "projects.json"),
    JSON.stringify({ projects: [{ id: "demo", path: PROJECT_DIR }] }),
    "utf8",
  );
}

function fireHook(cwd) {
  return spawnSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd }),
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      ULTRON_ROSTER_ROOT_OVERRIDE: ULTRON_FAKE,
      ULTRON_ROSTER_AGENTS_OVERRIDE: AGENTS_FAKE,
    },
  });
}

const rosterPath = join(ULTRON_FAKE, "cockpit", "projects", "demo", "agent-roster.json");

// --- Caso 1: sin roster -> genera, persiste e inyecta ----------------------
resetFixture();
const r1 = fireHook(PROJECT_DIR);
A(r1.status === 0, "caso1: hook exit 0", `status=${r1.status} stderr=${r1.stderr}`);

let out1 = null;
try { out1 = JSON.parse(r1.stdout); } catch { /* invalido */ }
A(
  !!out1 && out1.hookSpecificOutput?.hookEventName === "SessionStart",
  "caso1: output es hookSpecificOutput de SessionStart",
  r1.stdout.slice(0, 160),
);
const ctx1 = out1?.hookSpecificOutput?.additionalContext ?? "";
A(/rust-engineer/.test(ctx1), "caso1: el especialista del stack (rust) aparece", ctx1.slice(0, 200));
A(/react-specialist/.test(ctx1), "caso1: el especialista de react aparece", ctx1.slice(0, 200));
A(/code-reviewer/.test(ctx1), "caso1: la baseline rellena el roster", ctx1.slice(0, 200));
A(
  !/vue-expert/.test(ctx1),
  "caso1: node_modules no se recorre (el paquete con vue no entra en el stack)",
  ctx1.slice(0, 240),
);

let saved = null;
try { saved = JSON.parse(readFileSync(rosterPath, "utf8")); } catch { /* no escrito */ }
A(!!saved && Array.isArray(saved.entries) && saved.entries.length > 0, "caso1: roster persistido en disco");
A(saved?.source === "auto-deterministic", "caso1: el roster generado se marca como automatico", JSON.stringify(saved)?.slice(0, 120));
A(
  saved?.entries.every((e) => e.name && e.reason && e.suggested_role),
  "caso1: cada entrada trae los 3 campos que espera el backend Rust",
  JSON.stringify(saved?.entries?.[0]),
);
A(saved?.entries.length <= 8, "caso1: el roster no pasa del tope de 8 empleados", `n=${saved?.entries.length}`);

// --- Caso 2: roster existente se respeta y se filtra el fantasma ----------
writeFileSync(
  rosterPath,
  JSON.stringify({
    entries: [
      { name: "debugger", reason: "manda en los bugs", suggested_role: "Bugs" },
      { name: "agente-fantasma", reason: "no existe en disco", suggested_role: "Nada" },
    ],
  }),
  "utf8",
);
const r2 = fireHook(PROJECT_DIR);
const ctx2 = JSON.parse(r2.stdout).hookSpecificOutput.additionalContext;
A(/debugger — Bugs: manda en los bugs/.test(ctx2), "caso2: la entrada manual se respeta literal", ctx2);
A(!/agente-fantasma/.test(ctx2), "caso2: el agente sin fichero se filtra (no se sugiere un fantasma)", ctx2);
A(!/rust-engineer/.test(ctx2), "caso2: con roster propio NO se regenera por stack", ctx2);
const saved2 = JSON.parse(readFileSync(rosterPath, "utf8"));
A(saved2.entries.length === 2, "caso2: el fichero del usuario no se reescribe", JSON.stringify(saved2.entries));

// --- Caso 3: cwd fuera de todo proyecto -> sin output ---------------------
const r3 = fireHook(join(FIXTURE, "carpeta-suelta"));
A(r3.status === 0 && r3.stdout.trim() === "", "caso3: cwd desconocido -> sin contexto inyectado", `stdout="${r3.stdout}"`);

rmSync(FIXTURE, { recursive: true, force: true });
console.log(
  fail === 0
    ? "\nSELFTEST project-roster-context: VERDE"
    : `\nSELFTEST project-roster-context: ROJO (${fail} fallo/s)`,
);
process.exit(fail === 0 ? 0 : 1);
