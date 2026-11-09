// kirkardo/core.mjs — rutas canonicas, flags, helpers de shell/grep/JSON, doctor, sandbox de hooks y registro de categorias.
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import * as P from "./predicates.mjs";
import * as R3 from "./predicates-r3.mjs";
import { makeHookSandbox } from "./sandbox.mjs";

// ---------------------------------------------------------------------------
// Rutas canonicas (absolutas, sin ~ para reproducibilidad)
// ---------------------------------------------------------------------------
export const HOME = process.env.USERPROFILE || process.env.HOME || homedir();
export const ULTRON = join(HOME, ".ultron");
// Raiz del CODIGO medido (2026-10-23, ronda 2): el repo que contiene este
// script, sea el checkout principal (== ULTRON) o un worktree. El estado vivo
// (bin/, logs/, brain.db, cockpit de produccion, .codegraph) sigue en ULTRON;
// el codigo (control-center, hooks, scripts, skill-lazy, CI) sale de REPO. Sin
// esto, una corrida desde un worktree acababa midiendo el codigo del checkout
// principal.
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLAUDE = join(HOME, ".claude");
export const CC = join(REPO, "control-center");
export const CC_SRC = join(CC, "src");
export const CC_TAURI = join(CC, "src-tauri", "src");
export const BIN = join(ULTRON, "bin");
export const COCKPIT = join(ULTRON, "cockpit");
export const HOOKS_SCRIPTS = join(REPO, "hooks", "scripts");
export const HOOKS_MANIFEST = join(REPO, "hooks", "manifest.json");
export const SETTINGS_JSON = join(CLAUDE, "settings.json");
export const SKILL_LAZY = join(REPO, "cockpit", "skill-lazy");
// Estado vivo (ignorado por git): el de ~/.ultron, no el del repo medido.
export const SKILLS_REGISTRY_COCKPIT = join(COCKPIT, "skill-lazy", "skills-registry.json");
const SKILLS_REGISTRY_ROOT = join(ULTRON, "skills-registry.json");
export const ZONES_JSON = join(REPO, "cockpit", "ai-router", "zones.json");
export const METRICS_JSON = join(COCKPIT, "ai-router", "metrics.json");
const GOLDEN_LABELS_V1 = join(COCKPIT, "memory-rework", "evals", "golden_labels.json");
// Golden v2 (F1.5, 2026-09-06): prompts REALES etiquetados a mano, con project_id por
// query; vive solo en local (lleva prompts reales, gitignored). Si existe, es el
// oráculo de 1.1/1.6; ULTRON_GOLDEN=v1 fuerza el antiguo (29 queries limpias).
const GOLDEN_LABELS_V2 = join(COCKPIT, "memory-rework", "evals", "golden-v2", "golden_labels.v2.json");
export const GOLDEN_LABELS =
  process.env.ULTRON_GOLDEN === "v1" || !existsSync(GOLDEN_LABELS_V2) ? GOLDEN_LABELS_V1 : GOLDEN_LABELS_V2;
export const AGENTS_DIR = join(CLAUDE, "agents");
export const SKILLS_DIR = join(CLAUDE, "skills");
export const ULTRON_MEM = join(BIN, "ultron-memory.exe");
// Proyecto cuya bitacora y resume miden 1.8, 9.x y cat19.
export const RESUME_PROJECT = "ultron";

const ARGS = process.argv.slice(2);
export const FLAG_JSON = ARGS.includes("--json");
export const FLAG_CAT = ARGS.find((a) => a.startsWith("--cat="))?.split("=")[1];
// 0.4 (medidor honesto): gate por DEFECTO. Un harness que imprime "VERDICT: FAIL"
// pero sale con codigo 0 es un no-op silencioso (mand. 11). El exit codifica el
// veredicto salvo --no-gate explicito (reporte puro sin gate).
export const FLAG_GATE = !ARGS.includes("--no-gate");

// El GOAL exige 9.5 en CADA categoria, no solo en el promedio. El overall ponderado
// enmascara laggards (una cat rota se diluye entre checks verdes de otras categorias).
// (Fase 1 honestidad del medidor — audit runtime 2026-06-22)
export const LAGGARD_THRESHOLD = 9.5;
// (2026-10-28) El reparto core/suplementario por numero de categoria quedo
// sustituido por las areas ponderadas de kirkardo/areas.mjs: core = la
// categoria puntua en un area con peso. GOAL_CORE_MAX_CAT ya no lo usa nadie
// del medidor; se elimina para que no parezca vigente.

// Normaliza rutas Windows a forward-slash para usar en comandos shell
export function fwd(winPath) {
  return winPath.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Deteccion de shell disponible (bash preferido para reproducibilidad)
// ---------------------------------------------------------------------------
// En Git Bash, process.env.SHELL apunta a Git Bash; COMSPEC puede no ser
// accesible desde subprocesos Node.js. Detectamos bash explicitamente.
const BASH_CANDIDATES = [
  process.env.SHELL,                              // C:\Program Files\Git\bin\bash.exe
  fwd(join(HOME, "..", "..", "Program Files", "Git", "bin", "bash.exe")),
  "C:/Program Files/Git/bin/bash.exe",
  "C:/Program Files/Git/usr/bin/bash.exe",
].filter(Boolean);
const BASH_EXE = BASH_CANDIDATES.find((p) => existsSync(p)) ?? null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// P1 (2026-10-28): "no arranco" frente a "fallo"
// ---------------------------------------------------------------------------
// Un proceso que no llega a ejecutarse (0xC0000142, spawn fallido) no es un
// fallo del producto. Cada spawn del harness pasa por spawnTracked: reintenta una
// vez lo reintentable y, si sigue sin arrancar, anota la causa en el registro
// del check en curso. El runner convierte un rojo cuyo ultimo proceso no arranco
// en manual (R3.applyInfra), nunca en verde. Un timeout o un crash (2026-11-01)
// son del producto: el check da rojo y el fallo queda en su detalle.
let _infraLog = [];
let _faultLog = [];
export function beginInfraLog() {
  _infraLog = [];
  _faultLog = [];
}
export function takeInfraLog() {
  const out = _infraLog;
  _infraLog = [];
  return out;
}
export function takeFaultLog() {
  const out = _faultLog;
  _faultLog = [];
  return out;
}

/** spawnSync con reintento de infraestructura. Devuelve el resultado con `infra` (causa o null). */
export function spawnTracked(file, args, opts, label = file) {
  const once = () => {
    try {
      return spawnSync(file, args, opts);
    } catch (e) {
      return { status: null, stdout: "", stderr: String(e), error: e };
    }
  };
  let r = once();
  if (R3.isRetryableInfra(r)) r = once();
  const infra = R3.spawnInfraCause(r);
  _infraLog = R3.nextInfraLog(_infraLog, label, infra);
  const fault = R3.spawnProductFault(r);
  if (fault) _faultLog = [..._faultLog, `${String(label).slice(0, 60)}: ${fault}`];
  return { ...r, infra };
}

export function run(cmd, opts = {}) {
  const base = {
    encoding: "utf8",
    timeout: opts.timeout ?? 30000,
    cwd: opts.cwd ?? ULTRON,
    env: { ...process.env, ...opts.env },
    input: opts.input, // FIX 2026-06-25: run() ignoraba el stdin payload (20.4/20.5 nunca median)
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  };
  // Usa bash explicito: evita problemas con COMSPEC en subprocesos Git Bash.
  // pipefail (2026-10-23): sin el, `cmd | tail` devolvia el exit de tail y
  // 7.1/3.1 salian verdes con el comando en rojo.
  const r = BASH_EXE
    ? spawnTracked(BASH_EXE, ["-c", P.withPipefail(cmd)], base, cmd)
    : spawnTracked(cmd, [], { ...base, shell: true }, cmd);
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status, infra: r.infra };
}

// Grep nativo Node.js (evita problemas de rutas Windows en bash)

export function grepInFiles(pattern, rootDir, exts = [".ts", ".tsx", ".rs", ".js"]) {
  // Devuelve [{ file, line }] con las coincidencias
  const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
  const results = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === "node_modules" || name === "target" || name === "__pycache__") continue;
      const full = join(dir, name);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) { walk(full); continue; }
      if (exts.some((e) => name.endsWith(e))) {
        try {
          const content = readFileSync(full, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) results.push({ file: full, line: i + 1, text: lines[i].trim() });
          }
        } catch {}
      }
    }
  }
  walk(rootDir);
  return results;
}

export function grepCount(pattern, dir, exts = [".ts", ".tsx", ".rs", ".js", ".md"]) {
  return grepInFiles(pattern, dir, exts).length;
}

// invoke("cmd") / invoke<T>("cmd") REALES del frontend: sin comentarios ni tests.
export function invokeCallsites(cmd) {
  const re = new RegExp(`\\binvoke\\s*(?:<[^>]*>)?\\s*\\(\\s*["'\`]${cmd}["'\`]`);
  return grepInFiles(re, CC_SRC, [".ts", ".tsx"]).filter((m) => !P.isTestPath(m.file) && !P.isCommentLine(m.text));
}

// Ficheros .tsx de produccion que importan el modulo `basename` (montado en la UI).
export function importersOf(basename) {
  const re = new RegExp(`\\bfrom\\s+["'][^"']*/${basename}["']|import\\(\\s*["'][^"']*/${basename}["']`);
  return grepInFiles(re, CC_SRC, [".tsx", ".ts"]).filter((m) => !P.isTestPath(m.file));
}

export function fileExists(p) {
  return existsSync(p);
}

export function readJSON(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Oraculo de recall NO-circular: eval --golden mide contra labels hand-made
// (ids verificados), no contra keywords derivadas de la propia query (el `eval`
// sintetico daba recall=1.0 por construccion). Memoizado: E5 es caro, varios
// checks de cat1 lo comparten. Devuelve el JSON parseado o null si no medible.
let _goldenEvalCache;
export function runGoldenEval() {
  if (_goldenEvalCache !== undefined) return _goldenEvalCache;
  if (!existsSync(GOLDEN_LABELS)) {
    _goldenEvalCache = null;
    return null;
  }
  const cmd = `"${fwd(join(BIN, "ultron-memory.exe"))}" eval --golden "${fwd(GOLDEN_LABELS)}"`;
  // FIDELIDAD (bs60k6): con E5 frio el eval marca degraded:true y usa embeddings
  // hash de fallback -> recall ~0.18 vs ~0.67 caliente. Medir sobre embeddings
  // degradados es medir basura, no la calidad real del recall. Reintentar hasta
  // degraded:false: el modelo E5-large queda en page-cache del OS tras el 1er
  // cold-load, asi que el 2o/3er intento mide de verdad. Si tras 3 intentos sigue
  // degradado (p.ej. CI sin modelo), se cachea con degraded:true y los checks de
  // cat1 lo marcan 'skip' (no puntuan un falso ~0.18 como fallo de calidad).
  // Timeout 600s: el eval golden con rerank tarda ~347s WARM (~8-14 min frio)
  // medido 2026-07-22; con 120s los checks 1.1/1.6 morian por timeout y "median"
  // un JSON no parseable en vez de la calidad real del recall.
  let j = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = run(cmd, { timeout: 600000 });
    try {
      j = JSON.parse((r.stdout + r.stderr).trim());
    } catch {
      j = null;
    }
    if (j && j.degraded !== true) break;
  }
  _goldenEvalCache = j;
  return _goldenEvalCache;
}

export function countLines(filePath) {
  if (!existsSync(filePath)) return 0;
  try {
    const content = readFileSync(filePath, "utf8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

function findFilesOverLimit(dir, ext, limit) {
  // Devuelve lista de archivos con > limit lineas
  const r = run(
    `find "${dir}" -name "*.${ext}" -type f 2>/dev/null`,
    { cwd: ULTRON }
  );
  const files = r.stdout.trim().split("\n").filter(Boolean);
  return files.filter((f) => countLines(f) > limit);
}

// Doctor memoizado: varios checks leen su JSON y cada corrida cuesta ~10 s
// (incluye las evals). { json, raw }; json=null si la salida no es parseable.
let _doctorCache;
export function runDoctor() {
  if (_doctorCache !== undefined) return _doctorCache;
  const r = run(`"${fwd(join(BIN, "ultron-memory.exe"))}" doctor`, { timeout: 60000 });
  const raw = (r.stdout + r.stderr).trim();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  _doctorCache = { json, raw };
  return _doctorCache;
}

export function doctorCheck(name) {
  return (runDoctor().json?.checks ?? []).find((c) => c.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Hooks en HOME aislado (2026-10-23, medidor-1/6/12)
// ---------------------------------------------------------------------------
// Un sandbox por corrida, creado al primer uso y borrado al salir. Todo hook que
// lanza el harness pasa por spawnHook(): sus escrituras van al HOME temporal,
// no a logs/, la bitacora ni el estado de cadencias de produccion.
let _sandbox = null;
export function hookSandbox() {
  // El hook solo ve ULTRON_ORCHESTRATE por el entorno heredado del harness:
  // solo entonces necesita el lockfile del daemon (y su token) en el sandbox.
  if (!_sandbox) {
    _sandbox = makeHookSandbox({
      ultronRoot: ULTRON,
      project: RESUME_PROJECT,
      withDaemonLock: process.env.ULTRON_ORCHESTRATE === "full",
    });
  }
  return _sandbox;
}

export function cleanupHookSandbox() {
  if (!_sandbox) return;
  try {
    _sandbox.cleanup();
  } catch (e) {
    process.stderr.write(`[kirkardo] no se pudo borrar el sandbox ${_sandbox.root}: ${e.message}\n`);
  }
  _sandbox = null;
}

/**
 * Lanza un hook con stdin `input` en el HOME aislado. realBin=true le deja el
 * sidecar real (solo lectura: el resume); sin el, los hooks no encuentran
 * binario. env: variables extra (ganan a las del sandbox).
 */
export function spawnHook(script, input, { realBin = false, env = {}, timeout = 30000 } = {}) {
  const sb = hookSandbox();
  return spawnTracked(process.execPath, [script], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    timeout,
    cwd: ULTRON,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: sb.env({ realBin: realBin ? ULTRON_MEM : null, extra: env }),
  }, script.split(/[\\/]/).pop());
}

// Solo el bloque hooks: una mencion en prosa (notas del manifest) no es cableado.
export function hooksText(p) {
  const j = readJSON(p);
  if (!j) return null;
  return JSON.stringify(j.hooks ?? {});
}

// ---------------------------------------------------------------------------
// Definicion de criterios
// Formato: { id, desc, auto: true|false, check: fn() => boolean, note: string }
// auto=false => se marca 'manual'
// ---------------------------------------------------------------------------

export const CATS = [];

export function cat(num, name, checks) {
  CATS.push({ num, name, checks });
}

/**
 * Anade checks a una categoria ya registrada (los de la ronda 2 viven en
 * modulos propios para no pasar de 800 lineas por fichero). Lanza si la
 * categoria no existe: un check registrado en el vacio no se mediria nunca.
 */
export function extendCat(num, checks) {
  const c = CATS.find((x) => x.num === num);
  if (!c) throw new Error(`extendCat: la categoria ${num} no esta registrada`);
  c.checks.push(...checks);
}
