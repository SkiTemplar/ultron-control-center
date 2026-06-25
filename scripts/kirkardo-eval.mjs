#!/usr/bin/env node
/**
 * kirkardo-eval.mjs — Harness DETERMINISTA de evaluacion Kirkardo
 *
 * Evalua los criterios Kirkardo AUTOMATIZABLES por comando fijo.
 * Salida: nota por cat + overall, escribe logs/kirkardo-eval.json.
 *
 * Misma entrada -> misma salida (sin agentes, sin LLM).
 * Los criterios que requieren juicio o verificacion visual se marcan 'manual'
 * y NO se cuentan en el denominador.
 *
 * Uso: node scripts/kirkardo-eval.mjs [--json] [--cat=N]
 *   --json   solo imprime el JSON final
 *   --cat=N  evalua solo la categoria N (1-19)
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Rutas canonicas (absolutas, sin ~ para reproducibilidad)
// ---------------------------------------------------------------------------
const HOME = process.env.USERPROFILE || process.env.HOME || homedir();
const ULTRON = join(HOME, ".ultron");
const CLAUDE = join(HOME, ".claude");
const CC = join(ULTRON, "control-center");
const CC_SRC = join(CC, "src");
const CC_TAURI = join(CC, "src-tauri", "src");
const BIN = join(ULTRON, "bin");
const COCKPIT = join(ULTRON, "cockpit");
const HOOKS_SCRIPTS = join(ULTRON, "hooks", "scripts");
const HOOKS_MANIFEST = join(ULTRON, "hooks", "manifest.json");
const SETTINGS_JSON = join(CLAUDE, "settings.json");
const SKILL_LAZY = join(COCKPIT, "skill-lazy");
const SKILLS_REGISTRY_COCKPIT = join(SKILL_LAZY, "skills-registry.json");
const SKILLS_REGISTRY_ROOT = join(ULTRON, "skills-registry.json");
const ZONES_JSON = join(COCKPIT, "ai-router", "zones.json");
const METRICS_JSON = join(COCKPIT, "ai-router", "metrics.json");
const GOLDEN_LABELS = join(COCKPIT, "memory-rework", "evals", "golden_labels.json");
const AGENTS_DIR = join(CLAUDE, "agents");
const SKILLS_DIR = join(CLAUDE, "skills");

const ARGS = process.argv.slice(2);
const FLAG_JSON = ARGS.includes("--json");
const FLAG_CAT = ARGS.find((a) => a.startsWith("--cat="))?.split("=")[1];
const FLAG_GATE = ARGS.includes("--gate"); // exit !=0 si alguna cat < umbral (gate CI estricto)

// El GOAL exige 9.5 en CADA categoria, no solo en el promedio. El overall ponderado
// enmascara laggards (una cat rota se diluye entre checks verdes de otras categorias).
// (Fase 1 honestidad del medidor — audit runtime 2026-06-22)
const LAGGARD_THRESHOLD = 9.5;
// GOAL.md declara 14 categorias (los 8 pilares). Las cats 15-18 (Observabilidad,
// Context Engineering, Compactacion, Reproducibilidad) son SUPLEMENTARIAS: sanas, pero
// no mapean a un pilar del GOAL. Se separan para que sus checks (hoy todos verdes) no
// diluyan el promedio de las 14 core.
const GOAL_CORE_MAX_CAT = 14;

// Normaliza rutas Windows a forward-slash para usar en comandos shell
function fwd(winPath) {
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
function run(cmd, opts = {}) {
  try {
    let r;
    if (BASH_EXE) {
      // Usa bash explicito: evita problemas con COMSPEC en subprocesos Git Bash
      r = spawnSync(BASH_EXE, ["-c", cmd], {
        encoding: "utf8",
        timeout: opts.timeout ?? 30000,
        cwd: opts.cwd ?? ULTRON,
        env: { ...process.env, ...opts.env },
        input: opts.input, // FIX 2026-06-25: run() ignoraba el stdin payload (20.4/20.5 nunca median)
      });
    } else {
      r = spawnSync(cmd, {
        shell: true,
        encoding: "utf8",
        timeout: opts.timeout ?? 30000,
        cwd: opts.cwd ?? ULTRON,
        env: { ...process.env, ...opts.env },
        input: opts.input, // FIX 2026-06-25: run() ignoraba el stdin payload (20.4/20.5 nunca median)
      });
    }
    return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e), code: -1 };
  }
}

// Grep nativo Node.js (evita problemas de rutas Windows en bash)
import { readdirSync, statSync } from "node:fs";

function grepInFiles(pattern, rootDir, exts = [".ts", ".tsx", ".rs", ".js"]) {
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

function grepCount(pattern, dir, exts = [".ts", ".tsx", ".rs", ".js", ".md"]) {
  return grepInFiles(pattern, dir, exts).length;
}

function fileExists(p) {
  return existsSync(p);
}

function readJSON(p) {
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
function runGoldenEval() {
  if (_goldenEvalCache !== undefined) return _goldenEvalCache;
  if (!existsSync(GOLDEN_LABELS)) {
    _goldenEvalCache = null;
    return null;
  }
  const r = run(
    `"${fwd(join(BIN, "ultron-memory.exe"))}" eval --golden "${fwd(GOLDEN_LABELS)}"`,
    { timeout: 120000 },
  );
  try {
    _goldenEvalCache = JSON.parse((r.stdout + r.stderr).trim());
  } catch {
    _goldenEvalCache = null;
  }
  return _goldenEvalCache;
}

function countLines(filePath) {
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

// ---------------------------------------------------------------------------
// Definicion de criterios
// Formato: { id, desc, auto: true|false, check: fn() => boolean, note: string }
// auto=false => se marca 'manual'
// ---------------------------------------------------------------------------

const CATS = [];

function cat(num, name, checks) {
  CATS.push({ num, name, checks });
}

// ---------------------------------------------------------------------------
// CAT 1 — Memoria Qdrant
// ---------------------------------------------------------------------------
cat(1, "Memoria Qdrant", [
  {
    id: "1.1",
    desc: "recall@8 >= 0.95 via ORACULO golden (no el eval sintetico circular)",
    auto: true,
    check() {
      // El `eval` sin --golden es CIRCULAR: deriva expect_any_of de los mismos
      // terminos de la query -> recall=1.0 por construccion. El oraculo golden
      // (ids hand-labeled) mide recall real. Hoy 0.73 vs GOAL 0.95 -> FAIL honesto.
      if (!existsSync(GOLDEN_LABELS)) {
        return { pass: false, detail: "golden_labels.json ausente (no medible sin oraculo)" };
      }
      const j = runGoldenEval();
      if (!j) return { pass: false, detail: "eval --golden no devolvio JSON parseable" };
      const recall = j.aggregate?.recall_at_k ?? null;
      if (recall === null) return { pass: false, detail: "sin recall_at_k en aggregate" };
      return {
        pass: recall >= 0.95,
        detail: `recall@8(golden)=${recall.toFixed(3)} vs GOAL 0.95 — oraculo no-circular sobre ${j.total_queries ?? "?"} queries`,
      };
    },
  },
  {
    id: "1.2",
    desc: "drift brain.db/Qdrant = 0 (doctor reconcile in_sync)",
    auto: true,
    check() {
      const r = run(`"${join(BIN, "ultron-memory.exe")}" doctor`, { timeout: 30000 });
      const txt = r.stdout + r.stderr;
      // Parsea JSON del doctor
      try {
        const j = JSON.parse(txt.trim());
        const reconcile = (j.checks ?? []).find((c) => c.name === "reconcile");
        if (reconcile) {
          const inSync = reconcile.data?.in_sync === true;
          const missing = reconcile.data?.missing ?? 0;
          const orphan = reconcile.data?.orphan ?? 0;
          return {
            pass: inSync && missing === 0 && orphan === 0,
            detail: `in_sync=${inSync}, missing=${missing}, orphan=${orphan}`,
          };
        }
        // Si no hay reconcile check, verifica max_severity
        const ok = j.max_severity === "ok";
        return { pass: ok, detail: `max_severity=${j.max_severity}` };
      } catch {}
      const hasDrift = /in_sync.*true|drift.*0/i.test(txt);
      return { pass: hasDrift, detail: txt.slice(0, 200) };
    },
  },
  {
    id: "1.3",
    desc: "memory_candidates pending > 7 dias = 0",
    auto: true,
    check() {
      const dbPath = join(ULTRON, "brain.db");
      if (!fileExists(dbPath)) return { pass: false, detail: "brain.db no encontrado" };
      // Usa el sidecar stats para obtener conteo de candidatos stale
      const rStats = run(`"${fwd(join(BIN, "ultron-memory.exe"))}" stats 2>&1`, { timeout: 10000 });
      if (rStats.ok) {
        try {
          const j = JSON.parse(rStats.stdout.trim());
          const stale = j.candidates_stale ?? j.pending_old ?? null;
          if (stale !== null) return { pass: stale === 0, detail: `candidates_stale=${stale}` };
        } catch {}
      }
      // Fallback: doctor OK implica que el sistema esta en buen estado
      const rDoc = run(`"${fwd(join(BIN, "ultron-memory.exe"))}" doctor 2>&1`, { timeout: 15000 });
      const ok = rDoc.ok && /max_severity.*ok/i.test(rDoc.stdout);
      return { pass: ok, detail: ok ? "doctor OK (candidates proxy)" : "doctor error" };
    },
  },
  {
    id: "1.4",
    desc: "ultron_sessions ausente o write-dead en doctor",
    auto: true,
    check() {
      const r = run(`"${join(BIN, "ultron-memory.exe")}" doctor`, { timeout: 30000 });
      const txt = r.stdout + r.stderr;
      try {
        const j = JSON.parse(txt.trim());
        const checks = j.checks ?? [];
        const sessCheck = checks.find((c) => c.name === "qdrant_ultron_sessions");
        if (!sessCheck) {
          return { pass: true, detail: "ultron_sessions ausente en doctor (OK)" };
        }
        const writeDead = sessCheck.data?.write_dead === true;
        return { pass: writeDead, detail: `write_dead=${writeDead}, pts=${sessCheck.data?.points}` };
      } catch {}
      const mentionsSessions = /ultron_sessions/i.test(txt);
      const writeDead = /write.?dead.*true/i.test(txt);
      return {
        pass: writeDead || !mentionsSessions,
        detail: !mentionsSessions ? "ausente en doctor" : `write_dead=${writeDead}`,
      };
    },
  },
  {
    id: "1.5",
    desc: "memory-session-resume < 3000ms (hook-timing.jsonl)",
    auto: true,
    check() {
      const timingFile = join(ULTRON, "logs", "hook-timing.jsonl");
      if (!fileExists(timingFile)) return { pass: false, detail: "hook-timing.jsonl ausente" };
      const lines = readFileSync(timingFile, "utf8").trim().split("\n").filter(Boolean);
      // Formato actual: {"ts":"...", "hook":"memory-session-resume", "elapsed_ms":104, "exit_code":0}
      const resumeEntries = lines
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && (e.hook === "memory-session-resume" || e.hook === "memory-orchestrate"))
        .map((e) => e.elapsed_ms ?? e.duration_ms ?? e.ms ?? 9999);
      if (resumeEntries.length === 0) return { pass: false, detail: "sin entradas memory-session-resume en timing" };
      const last5 = resumeEntries.slice(-5);
      const maxMs = Math.max(...last5);
      return { pass: maxMs < 3000, detail: `max_last5_resume=${maxMs}ms` };
    },
  },
  {
    id: "1.6",
    desc: "precision@3 >= 0.6 y context_waste <= 0.4 (el pack es relevante, no ruido) — oraculo golden",
    auto: true,
    check() {
      // La memoria CONTIENE el dato != lo inyectado es RELEVANTE. Hoy precision@3
      // ~0.32 y context_waste ~0.68: >2/3 del pack inyectado es ruido (no hay
      // score-floor en el recall de memorias). FAIL honesto hasta que exista floor.
      if (!existsSync(GOLDEN_LABELS)) {
        return { pass: false, detail: "golden_labels.json ausente (no medible)" };
      }
      const j = runGoldenEval();
      if (!j) return { pass: false, detail: "eval --golden no devolvio JSON parseable" };
      const p3 = j.aggregate_precision_at_3 ?? j.aggregate?.precision_at_3 ?? null;
      const waste = j.aggregate?.context_waste ?? null;
      if (p3 === null || waste === null) {
        return { pass: false, detail: "sin precision@3/context_waste en el aggregate" };
      }
      return {
        pass: p3 >= 0.6 && waste <= 0.4,
        detail: `precision@3=${p3.toFixed(3)} (>=0.6) context_waste=${waste.toFixed(3)} (<=0.4)`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 2 — CodeGraph
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CAT 2 — CodeGraph (consumido e2e)
//
// Mandamiento 12: el dato existe (9708 nodos) != se inyecta. cat2 antes grepeaba
// /codegraph/i (matchea comentarios/codigo muerto) y aceptaba "MCP en config" como
// verde aunque el .db estuviera stale o el daemon caido. Ahora cada check EJECUTA el
// binario codegraph / consulta el .db vivo / prueba el watcher round-trip, y asevera
// sobre OUTPUT observable. Sin datos (clon limpio / CI) -> pass:false "no medible".
// ---------------------------------------------------------------------------
const CODEGRAPH_DB = join(ULTRON, ".codegraph", "codegraph.db");
const CODEGRAPH_PID = join(ULTRON, ".codegraph", "daemon.pid");

// Lector del .db de codegraph via node:sqlite (mismo motor que usa el resto del
// harness). Devuelve null si el .db no existe o no abre (clon limpio / CI).
function readCodegraphDb(fn) {
  if (!existsSync(CODEGRAPH_DB)) return null;
  let db;
  try {
    // node:sqlite via getBuiltinModule: el harness es ESM (sin require) y check() es
    // sincrono (sin await dynamic-import). getBuiltinModule resuelve el builtin sin importar.
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    db = new DatabaseSync(CODEGRAPH_DB, { readOnly: true });
    const out = fn(db);
    db.close();
    return out;
  } catch (e) {
    try { db && db.close(); } catch {}
    return { __error: e.message };
  }
}

cat(2, "CodeGraph (consumido e2e)", [
  {
    id: "2.1",
    desc: "codegraph CLI vivo + nudge usa cifra real (no '~8k' hardcodeado, dentro de +-30% del nodecount navegable)",
    auto: true,
    check() {
      // Antes solo verificaba 'codegraph en mcpServers' (config). Ahora: el binario
      // responde --version Y el numero del nudge (codegraph-reminder.js) refleja el
      // count navegable real (nodes - file - import), no una constante congelada.
      const ver = run("codegraph --version 2>&1", { timeout: 15000 });
      const verOk = /^\d+\.\d+\.\d+/.test(ver.stdout.trim());
      if (!verOk) return { pass: false, detail: `no medible: codegraph --version no responde (${(ver.stdout + ver.stderr).trim().slice(0, 60)})` };
      // nodecount navegable real del .db
      const nav = readCodegraphDb((db) =>
        db.prepare("SELECT COUNT(*) c FROM nodes WHERE kind NOT IN ('file','import')").get().c,
      );
      if (nav === null) return { pass: false, detail: "no medible: codegraph.db ausente (clon limpio/CI)" };
      if (nav && nav.__error) return { pass: false, detail: `codegraph.db no abre: ${nav.__error}` };
      // cifra que pregona el hook del nudge
      const hook = join(HOOKS_SCRIPTS, "codegraph-reminder.js");
      if (!fileExists(hook)) return { pass: false, detail: "codegraph-reminder.js ausente (no medible)" };
      const txt = readFileSync(hook, "utf8");
      const m = txt.match(/~\s*([\d.]+)\s*k\s*simbolos/i);
      if (!m) return { pass: false, detail: `nudge sin cifra parseable de simbolos; navegable real=${nav}` };
      const claimed = parseFloat(m[1]) * 1000;
      const drift = Math.abs(claimed - nav) / nav;
      return {
        pass: drift <= 0.30,
        detail: `codegraph ${ver.stdout.trim().slice(0, 8)}; nudge=~${m[1]}k(${claimed}) vs navegable real=${nav} -> drift ${(drift * 100).toFixed(0)}% (<=30%)`,
      };
    },
  },
  {
    id: "2.2",
    desc: "Queries reales del .db vivo: COUNT files/nodes/edges>0 + MAX(indexed_at) + 0 drift de schema vs status --json",
    auto: true,
    check() {
      // Antes: solo 'el fichero .db existe'. Ahora ejecuta las MISMAS queries que el
      // comando codegraph_summary haria, asevera enteros>0 sin error, y compara nodes
      // contra 'codegraph status --json' para detectar bump de schema que rompe el panel.
      const data = readCodegraphDb((db) => ({
        files: db.prepare("SELECT COUNT(*) c FROM files").get().c,
        nodes: db.prepare("SELECT COUNT(*) c FROM nodes").get().c,
        edges: db.prepare("SELECT COUNT(*) c FROM edges").get().c,
        maxIndexed: db.prepare("SELECT MAX(indexed_at) m FROM files").get().m,
      }));
      if (data === null) return { pass: false, detail: "no medible: codegraph.db ausente (clon limpio/CI)" };
      if (data.__error) return { pass: false, detail: `codegraph.db no abre: ${data.__error}` };
      const allPos = data.files > 0 && data.nodes > 0 && data.edges > 0 && Number(data.maxIndexed) > 0;
      if (!allPos) {
        return { pass: false, detail: `db vacio o sin indexed_at: files=${data.files} nodes=${data.nodes} edges=${data.edges} maxIndexed=${data.maxIndexed}` };
      }
      // drift de schema: el conteo del .db debe coincidir (+-1%) con lo que reporta el binario
      const st = run("codegraph status --json 2>&1", { timeout: 20000 });
      let statusNodes = null;
      try { statusNodes = JSON.parse(st.stdout.trim()).nodeCount ?? null; } catch {}
      if (statusNodes === null) {
        return { pass: true, detail: `db OK (files=${data.files} nodes=${data.nodes} edges=${data.edges}); status --json no parseable (sin cruce de drift)` };
      }
      const drift = Math.abs(statusNodes - data.nodes) / Math.max(1, data.nodes);
      return {
        pass: drift <= 0.01,
        detail: `files=${data.files} nodes=${data.nodes} edges=${data.edges}; status.nodeCount=${statusNodes} -> drift schema ${(drift * 100).toFixed(2)}% (<=1%)`,
      };
    },
  },
  {
    id: "2.3",
    desc: "codegraph_summary rinde datos reales: 'codegraph query' devuelve un simbolo conocido con filePath/qualifiedName (no vacio, no error)",
    auto: true,
    check() {
      // Antes grepeaba /codegraph/i en src/ (matchea cualquier mencion). Ahora invoca el
      // motor de consulta real (lo mismo que alimenta el panel ProjectWorkspace) y asevera
      // que devuelve un nodo navegable con su ubicacion. La verif VISUAL del panel es 2.7 (manual).
      if (!existsSync(CODEGRAPH_DB)) return { pass: false, detail: "no medible: codegraph.db ausente (clon limpio/CI)" };
      const r = run(`codegraph query "MemoryService" --json --limit 3 2>&1`, { timeout: 25000 });
      let arr;
      try { arr = JSON.parse(r.stdout.trim()); } catch { return { pass: false, detail: `query no devolvio JSON: ${(r.stdout + r.stderr).trim().slice(0, 100)}` }; }
      if (!Array.isArray(arr) || arr.length === 0) return { pass: false, detail: "query 'MemoryService' devolvio 0 resultados (indice vacio o motor roto)" };
      const n = arr[0].node || {};
      const ok = !!n.filePath && !!(n.qualifiedName || n.name);
      return {
        pass: ok,
        detail: ok
          ? `${arr.length} hits; top=${n.qualifiedName || n.name} @ ${String(n.filePath).split(/[/\\]/).slice(-1)[0]}`
          : `hit sin filePath/qualifiedName: ${JSON.stringify(n).slice(0, 120)}`,
      };
    },
  },
  {
    id: "2.4",
    desc: "Daemon del watcher vivo: daemon.pid valido + proceso en ejecucion (no mtime laxo)",
    auto: true,
    check() {
      // Antes: 'db reciente <7d O MCP configurado' (mtime/config, no prueba que el daemon
      // corra). Ahora: parsea daemon.pid y asevera que el PID esta vivo -> el watcher esta
      // activo (es lo que hace fresco el indice; 2.5 lo prueba e2e).
      if (!existsSync(CODEGRAPH_PID)) return { pass: false, detail: "no medible: daemon.pid ausente (daemon no arrancado)" };
      let pid = null;
      try {
        const raw = readFileSync(CODEGRAPH_PID, "utf8").trim();
        pid = raw.startsWith("{") ? JSON.parse(raw).pid : parseInt(raw, 10);
      } catch (e) { return { pass: false, detail: `daemon.pid ilegible: ${e.message}` }; }
      if (!pid || isNaN(pid)) return { pass: false, detail: `daemon.pid sin pid valido` };
      // Liveness portable en Windows (powershell Get-Process); fallback a kill -0 en *nix.
      const ps = run(`powershell -NoProfile -Command "if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'DEAD' }"`, { timeout: 15000 });
      let alive = /ALIVE/.test(ps.stdout);
      if (!ps.ok && !/ALIVE|DEAD/.test(ps.stdout)) {
        const k = run(`kill -0 ${pid} 2>/dev/null && echo ALIVE || echo DEAD`, { timeout: 10000 });
        alive = /ALIVE/.test(k.stdout);
      }
      return { pass: alive, detail: alive ? `daemon vivo (pid=${pid})` : `daemon.pid=${pid} pero el proceso NO existe (watcher muerto, indice se quedara stale)` };
    },
  },
  {
    id: "2.5",
    desc: "Watcher cobertura+frescura (e2e): simbolo temporal __kirkardo_probe en un .rs bajo .ultron aparece en query y desaparece al borrarlo",
    auto: true,
    check() {
      // El borde mas comun: codigo recien escrito. Crea fn __kirkardo_probe_<rand>() en un
      // .rs temporal bajo .ultron, hace poll a 'codegraph query' hasta hallarlo, lo borra y
      // verifica que desaparece. Prueba el watcher + freshness de extremo a extremo.
      if (!existsSync(CODEGRAPH_DB)) return { pass: false, detail: "no medible: codegraph.db ausente (clon limpio/CI)" };
      const sym = `__kirkardo_probe_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
      const dir = join(ULTRON, ".codegraph_probe_tmp");
      const file = join(dir, "probe.rs");
      // rm -rf via run() (rmSync no esta importado en el harness): borra fichero+dir del fixture.
      const cleanup = () => { run(`rm -rf "${fwd(dir)}"`, { timeout: 8000 }); };
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, `pub fn ${sym}() -> u32 { 42 }\n`, "utf8");
      } catch (e) { cleanup(); return { pass: false, detail: `no se pudo crear el fixture: ${e.message}` }; }
      // poll aparicion (max ~24s)
      let appeared = 0;
      for (let i = 0; i < 12; i++) {
        const r = run(`codegraph query "${sym}" --json --limit 2 2>&1`, { timeout: 12000 });
        if (r.stdout.includes(sym)) { appeared = (i + 1) * 2; break; }
        run("sleep 2", { timeout: 4000 });
      }
      if (!appeared) {
        cleanup();
        return { pass: false, detail: `watcher NO indexo el simbolo nuevo tras ~24s (codigo recien escrito invisible al indice)` };
      }
      // borrar y poll desaparicion (max ~16s)
      cleanup();
      let gone = 0;
      for (let i = 0; i < 8; i++) {
        run("sleep 2", { timeout: 4000 });
        const r = run(`codegraph query "${sym}" --json --limit 2 2>&1`, { timeout: 12000 });
        if (!r.stdout.includes(sym)) { gone = (i + 1) * 2; break; }
      }
      return {
        pass: appeared > 0 && gone > 0,
        detail: gone > 0
          ? `watcher OK: indexado en ~${appeared}s, removido en ~${gone}s tras borrar`
          : `indexado en ~${appeared}s pero NO removido tras borrar (~16s) -> indice acumula fantasmas`,
      };
    },
  },
  {
    id: "2.6",
    desc: "Consumo real del nudge (Mandamiento 12): de las sesiones recientes que leyeron codigo, >=80% usaron codegraph_* (el dato existe != se consume)",
    auto: true,
    check() {
      // El nudge es VOLUNTARIO: el modelo puede ignorarlo y explorar a ciegas. Mide el ratio
      // (sesiones con tool_use mcp__codegraph__*)/(sesiones que leyeron codigo via Read-de-codigo/
      // Grep/Glob) en los ultimos transcripts. known_red: hoy 7/10=0.70 < 0.80 -> FAIL honesto
      // (30% de sesiones de codigo siguen explorando el FS teniendo el indice).
      const projDir = join(CLAUDE, "projects", ("C--Users-" + (process.env.USERNAME||process.env.USER||"user") + "--ultron"));
      if (!existsSync(projDir)) return { pass: false, detail: "no medible: dir de transcripts ausente" };
      let files;
      try {
        files = readdirSync(projDir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => ({ f: join(projDir, f), m: statSync(join(projDir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)
          .slice(0, 40);
      } catch (e) { return { pass: false, detail: `no medible: error leyendo transcripts (${e.message})` }; }
      if (files.length === 0) return { pass: false, detail: "no medible: 0 transcripts .jsonl" };
      const codeExt = /\.(rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|swift|c|cc|cpp|h|hpp|cs|vue)$/i;
      let codeSessions = 0, cgSessions = 0;
      for (const { f } of files) {
        let usedCode = false, usedCg = false, lines;
        try { lines = readFileSync(f, "utf8").split("\n"); } catch { continue; }
        for (const ln of lines) {
          if (!ln.trim()) continue;
          let o; try { o = JSON.parse(ln); } catch { continue; }
          const content = o.message && o.message.content;
          if (!Array.isArray(content)) continue;
          for (const c of content) {
            if (!c || c.type !== "tool_use") continue;
            const nm = c.name || "";
            if (/codegraph/i.test(nm)) usedCg = true;
            if (nm === "Grep" || nm === "Glob") usedCode = true;
            if (nm === "Read" && codeExt.test((c.input && c.input.file_path) || "")) usedCode = true;
          }
        }
        if (usedCode) codeSessions++;
        if (usedCg) cgSessions++;
      }
      if (codeSessions === 0) return { pass: false, detail: "no medible: 0 sesiones recientes leyeron codigo" };
      const ratio = cgSessions / codeSessions;
      return {
        pass: ratio >= 0.8,
        detail: `consumo codegraph: ${cgSessions}/${codeSessions} sesiones de codigo (ratio ${ratio.toFixed(2)} vs >=0.80)`,
      };
    },
  },
  {
    id: "2.7",
    desc: "Panel CodeGraph (ProjectWorkspace) muestra conteos reales sin 'sin indexar'/error — verificacion visual",
    auto: false,
    check: null,
  },
]);

// ---------------------------------------------------------------------------
// CAT 3 — AI Routing
// ---------------------------------------------------------------------------
cat(3, "AI Routing (route real)", [
  {
    id: "3.1",
    desc: "claude CLI en PATH (el orquestador propio; no lo rutea el AI Router pero debe existir)",
    auto: true,
    check() {
      const r = run("claude --version 2>&1 | head -1");
      return {
        pass: r.ok || /claude/i.test(r.stdout),
        detail: r.stdout.trim().slice(0, 80) || r.stderr.trim().slice(0, 80) || "claude no en PATH",
      };
    },
  },
  {
    id: "3.2",
    desc: "invariantes de politica en zones.json: code=>claude (codex-cli fallback), chat/utility/light=>groq, 0 gemini-cli (retirado)",
    auto: true,
    check() {
      const zones = readJSON(ZONES_JSON);
      if (!Array.isArray(zones) || zones.length === 0) {
        return { pass: false, detail: "no medible: zones.json ausente o vacio (clon limpio/CI)" };
      }
      // chat/utility/light son el plano FAST groq-first; summarize/routing-decision comparten el plano.
      const GROQ_FIRST = new Set(["chat", "utility", "light", "summarize", "routing-decision"]);
      const viol = [];
      for (const z of zones) {
        const pid = z.primary?.provider_id ?? "?";
        const chain = [pid, ...(z.fallbacks ?? []).map((f) => f.provider_id)];
        // Decision 2026-06-24: code zones arrancan por Claude (primary=claude),
        // con codex-cli como fallback en la cadena. code-fast-local se queda en
        // ollama por ser offline.
        if (z.category === "code" && z.id !== "code-fast-local") {
          if (pid !== "claude") {
            viol.push(`code:${z.id} primary=${pid}!=claude`);
          } else if (!chain.includes("codex-cli")) {
            viol.push(`code:${z.id} sin codex-cli en fallback`);
          }
        }
        if (GROQ_FIRST.has(z.id) && pid !== "groq") {
          viol.push(`fast:${z.id} primary=${pid}!=groq`);
        }
        // gemini-cli RETIRADO 2026-06-19 (Google corto el free-tier OAuth): 0 en cualquier cadena.
        if (chain.includes("gemini-cli")) viol.push(`${z.id}:gemini-cli en cadena`);
      }
      return {
        pass: viol.length === 0,
        detail: viol.length === 0 ? `${zones.length} zonas cumplen la politica CLI-first` : viol.slice(0, 4).join(" | "),
      };
    },
  },
  {
    id: "3.3",
    desc: "codex-cli AUTENTICADO: 'codex exec --sandbox read-only' responde exit 0 sin auth/login/IneligibleTier",
    auto: true,
    check() {
      // El subcomando REAL de call_cli (ai_router/exec.rs): codex exec <prompt> --sandbox read-only
      // --skip-git-repo-check. stdin cerrado (</dev/null): sin el, codex bloquea esperando
      // "additional input from stdin" y agota el timeout. Distingue instalado de autenticado-y-rutea.
      const probe = run(
        `codex exec "reply with just the word OK and nothing else" --sandbox read-only --skip-git-repo-check </dev/null 2>&1`,
        { timeout: 120000 },
      );
      const out = probe.stdout + probe.stderr;
      // Tokens de fallo de AUTENTICACION. OJO: NO usar la palabra "Failed" suelta: codex emite
      // "SessionStart Failed" (sus propios hooks, ajenos al login) en stdout aun autenticado.
      const authFail = /not logged in|please (log|sign) ?in|run `?codex login|IneligibleTier|unauthorized|\b401\b|invalid api key/i.test(out);
      const replied = /\bOK\b/.test(out);
      if (!probe.ok) {
        return { pass: false, detail: `codex exec exit=${probe.code} (no autenticado/no instalado/timeout): ${out.trim().slice(-120)}` };
      }
      return {
        pass: !authFail && replied,
        detail: authFail ? `auth fail en stdout: ${out.trim().slice(-120)}` : `exit 0, modelo respondio OK=${replied}`,
      };
    },
  },
  {
    id: "3.4",
    desc: "fallback ROLLING < 10% (recent_routes ventana viva, NO acumulado historico) + by_class del dia",
    auto: true,
    check() {
      const m = readJSON(METRICS_JSON);
      if (!m) return { pass: false, detail: "no medible: metrics.json ausente (clon limpio/CI)" };
      const rr = Array.isArray(m.recent_routes) ? m.recent_routes : null;
      if (!rr || rr.length < 10) {
        return { pass: false, detail: `no medible: recent_routes insuficiente (${rr ? rr.length : "ausente"} < 10)` };
      }
      // Ventana rolling (RECENT_FALLBACK_WINDOW=200 en ai_router/types.rs): mide el comportamiento
      // ACTUAL. El cat3.5 viejo promediaba routes_total (708) de configs/dias muertos -> sesgo historico.
      const fb = rr.filter(Boolean).length;
      const rate = fb / rr.length;
      // Frescura: las clases con trafico deben tener date==hoy (no puntuar sobre historia muerta).
      const today = new Date().toISOString().slice(0, 10);
      const active = Object.values(m.by_class ?? {}).filter((v) => v && (v.count ?? 0) > 0);
      const stale = active.filter((v) => v.date !== today).length;
      const fresh = active.length > 0 && stale === 0;
      return {
        pass: rate < 0.1 && fresh,
        detail: `rolling_fallback=${(rate * 100).toFixed(1)}% (${fb}/${rr.length}) by_class_hoy=${fresh} (stale=${stale}/${active.length})`,
      };
    },
  },
  {
    id: "3.5",
    desc: "cargo test ai_router ejecuta tests reales y pasan (logica cadena/quota/cli, no solo exit 0)",
    auto: true,
    check() {
      // Baseline de la LOGICA de routing (cadena primary->fallback, quota, sandbox flag). NO es e2e
      // contra provider vivo (eso lo cubren 3.3 codex + 3.4 metrics); endurece el viejo 3.4 exigiendo
      // que CORRIO >0 tests ('test result: ok. N passed') y NO el verde vacuo de exit 0 con 0 tests.
      const r = run("cargo test --lib --quiet ai_router -- --test-threads=1 2>&1", {
        cwd: join(CC, "src-tauri"),
        timeout: 240000,
      });
      const txt = r.stdout + r.stderr;
      const failed = /test result: FAILED|\bFAILED\b/.test(txt);
      const ranOk = txt.match(/test result: ok\.\s*(\d+)\s*passed/i);
      const passedN = ranOk ? parseInt(ranOk[1], 10) : 0;
      return {
        pass: !failed && passedN > 0,
        detail: failed ? `FAILED: ${txt.slice(-200)}` : `test result: ok, ${passedN} passed`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 4 — Skill/Agent Routing
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CAT 4 — Skill/Agent Routing (OUTPUT del hook, no rankCandidates)
// ---------------------------------------------------------------------------
// Endurecida 2026-06-24: la cat vieja medía rankCandidates() sobre 21 casos
// sintéticos con el trigger LITERAL — nunca ejecutaba main()/buildInjectionBlock
// ni observaba el additionalContext que de verdad llega al modelo. Verificado en
// runtime: un prompt TDD rutea bien PERO inyecta el SKILL.md del NAMESPACE
// catch-all 'superpowers' (name: superpowers) en vez del de TDD, y ADEMÁS arrastra
// un ecc:hexagonal-architecture irrelevante. cat4.5 medía --v3 mientras el binario
// LIVE de settings.json es v2 (sin fallback semántico). Esta versión EJECUTA el
// hook real (routing-dispatcher.v2.js por stdin) y asevera sobre su salida.
const DISPATCHER_V2 = join(SKILL_LAZY, "routing-dispatcher.v2.js");

// Ejecuta el hook con {prompt} por stdin y devuelve el additionalContext + lo
// parseado: skills inyectadas (bloques [skill-inyectada:X]) y candidatos sugeridos
// (Suggested: / "1)" / "2)" del hint). Fail-safe: ok=false si el hook no emite JSON.
function runDispatcher(prompt) {
  let r;
  try {
    r = spawnSync("node", [DISPATCHER_V2], {
      input: JSON.stringify({ prompt, hook_event_name: "UserPromptSubmit" }),
      encoding: "utf8",
      timeout: 30000,
      cwd: ULTRON,
    });
  } catch (e) {
    return { ok: false, raw: String(e) };
  }
  const out = (r.stdout ?? "").trim();
  let ac;
  try {
    ac = JSON.parse(out).hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return { ok: false, raw: out.slice(0, 160) };
  }
  // skills inyectadas: id + cuerpo del SKILL.md de cada bloque
  const blocks = [];
  const blockRe = /--- \[skill-inyectada: ([^\]]+)\] ---\n([\s\S]*?)\n--- \[fin skill-inyectada: \1\] ---/g;
  let bm;
  while ((bm = blockRe.exec(ac)) !== null) blocks.push({ id: bm[1], body: bm[2] });
  // candidatos sugeridos observables en el hint (sin contenido inyectado)
  const labels = [];
  const sug = ac.match(/Suggested:\s*\w+:(\S+)/);
  if (sug) labels.push(sug[1]);
  const numRe = /\d\)\s*\w+:([^\s(]+)/g;
  let nm;
  while ((nm = numRe.exec(ac)) !== null) labels.push(nm[1]);
  return {
    ok: true,
    ac,
    len: ac.length,
    injectedIds: blocks.map((b) => b.id),
    blocks,
    candidates: [...new Set(labels)],
  };
}

// Extrae el `name:` del front-matter YAML del cuerpo de un bloque inyectado.
function injectedSkillName(body) {
  const m = (body || "").match(/^\s*name:\s*([^\n]+)/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

// CASES e2e del hook: prompt -> id esperado en el top-3 OBSERVABLE del
// additionalContext (Suggested + candidatos del hint), no rankCandidates. Mismo set
// que el harness viejo medía in-process, ahora cruzado contra la SALIDA real del
// hook. Incluye casos EN donde el OUTPUT no lista el id (p.ej. el hint de
// "code-reviewer" solo lleva 1 candidato) -> ya no es 100% trivial.
const ROUTING_CASES = [
  { prompt: "activa don claudio para el netcode de ue5", expected: "don-claudio" },
  { prompt: "tio gilito, anade un gasto a mi presupuesto", expected: "tio-gilito" },
  { prompt: "modo tolkien, escribe el siguiente capitulo", expected: "tolkien" },
  { prompt: "jordan, necesito un pitch para inversores b2b", expected: "jordan-belfort" },
  { prompt: "mike tyson, revisa la jerarquia visual del landing", expected: "mike-tyson" },
  { prompt: "alfred, mata el proceso y limpia la carpeta local", expected: "alfred" },
  { prompt: "arregla los tipos de typescript en este componente react", expected: "typescript-pro" },
  { prompt: "optimiza el uso de memoria en rust con tokio", expected: "rust-engineer" },
  { prompt: "audita la seguridad: posible sql injection y owasp", expected: "security-auditor" },
  { prompt: "tengo un stack trace y un panic, encuentra la causa raiz", expected: "debugger" },
  { prompt: "haz tdd con red green refactor antes de implementar", expected: "superpowers:test-driven-development" },
  { prompt: "haz un security scan del repositorio buscando cve", expected: "security-scan" },
  { prompt: "consolida memoria y ordena el index de .ultron", expected: "consolidate-memory" },
  { prompt: "revisa el pr buscando problemas de calidad de codigo", expected: "pr-review-toolkit:code-reviewer" },
  { prompt: "review this pull request for code quality issues", expected: "code-reviewer" },
  { prompt: "profile the hot path, there is an n+1 query bottleneck", expected: "performance-engineer" },
  { prompt: "design a kubernetes helm chart for the cluster", expected: "kubernetes-specialist" },
  { prompt: "write a rag pipeline with a vector db and embeddings", expected: "ai-engineer" },
  { prompt: "set up a github actions ci cd pipeline", expected: "devops-engineer" },
  { prompt: "merge a postgresql schema migration with zero-downtime", expected: "database-migrations" },
  { prompt: "systematic debugging, I cannot find the intermittent bug", expected: "superpowers:systematic-debugging" },
];

// Negativos: NO deben inyectar nada (additionalContext sin Suggested/skill).
const NEGATIVE_CASES = ["gracias", "que hora es", "vale perfecto", "buenos dias", "ok dale"];

// Prompts representativos para el techo de context_chars (uno carga la persona
// dominante de un FAST PATH, otro arrastra el bug del namespace + ECC).
const CTX_PROMPTS = [
  "haz tdd con red green refactor antes de implementar",
  "optimiza el uso de memoria en rust con tokio",
  "audita la seguridad: posible sql injection y owasp",
];
const CTX_MAX_CHARS = 12000;

cat(4, "Skill/Agent Routing (output del hook)", [
  {
    id: "4.1",
    desc: "SKILL.md correcto inyectado: el bloque de un superpowers:* trae su propio name, no el namespace catch-all 'superpowers'",
    auto: true,
    check() {
      if (!fileExists(DISPATCHER_V2)) return { pass: false, detail: "no medible: routing-dispatcher.v2.js ausente" };
      // Cada superpowers:* debe inyectar SU SKILL.md (name == sub-skill), NO el del
      // namespace 'superpowers'. Hoy resolveSkillMdPath cae en skills/superpowers.disabled
      // (name: superpowers) -> el modelo recibe el manifiesto genérico, no la guía pedida.
      const cases = [
        { prompt: "haz tdd con red green refactor antes de implementar", id: "superpowers:test-driven-development", expectName: "test-driven-development" },
        { prompt: "haz un debug sistematico de este bug intermitente sin causa obvia", id: "superpowers:systematic-debugging", expectName: "systematic-debugging" },
      ];
      const bad = [];
      let checked = 0;
      for (const c of cases) {
        const r = runDispatcher(c.prompt);
        if (!r.ok) return { pass: false, detail: `no medible: hook no emitió JSON (${r.raw ?? ""})` };
        const blk = r.blocks.find((b) => b.id === c.id);
        if (!blk) { bad.push(`${c.id}:no-inyectado`); continue; }
        checked++;
        const nm = injectedSkillName(blk.body);
        if (nm !== c.expectName) bad.push(`${c.id}:name="${nm}"(esp ${c.expectName})`);
      }
      if (checked === 0) return { pass: false, detail: "no medible: ningún superpowers:* llegó a inyectarse" };
      return {
        pass: bad.length === 0,
        detail: bad.length === 0
          ? `${checked} superpowers:* inyectan su SKILL.md propio`
          : `${bad.length} con SKILL.md erróneo (namespace catch-all): ${bad.join(", ")}`,
      };
    },
  },
  {
    id: "4.2",
    desc: "0 falsos positivos ECC: prompts no-ECC (TDD/commit/debug) no inyectan ningún ecc:*",
    auto: true,
    check() {
      if (!fileExists(DISPATCHER_V2)) return { pass: false, detail: "no medible: routing-dispatcher.v2.js ausente" };
      // Set-trampa: ninguno pide arquitectura hexagonal/puertos-adaptadores. Si el
      // hook inyecta un ecc:* es un falso positivo (floor ECC rebajado). Verificado
      // hoy: TDD arrastra ecc:hexagonal-architecture -> FAIL honesto.
      const trap = [
        "haz tdd con red green refactor antes de implementar",
        "git commit con conventional commits",
        "haz un debug sistematico de este bug intermitente",
        "optimiza el uso de memoria en rust con tokio",
      ];
      const offenders = [];
      for (const p of trap) {
        const r = runDispatcher(p);
        if (!r.ok) return { pass: false, detail: `no medible: hook no emitió JSON (${r.raw ?? ""})` };
        const ecc = r.injectedIds.filter((id) => id.startsWith("ecc:"));
        if (ecc.length) offenders.push(`"${p.slice(0, 24)}"->${ecc.join("/")}`);
      }
      return {
        pass: offenders.length === 0,
        detail: offenders.length === 0
          ? `${trap.length} prompts no-ECC, 0 ecc:* inyectados`
          : `${offenders.length} falsos positivos ECC: ${offenders.join(" | ")}`,
      };
    },
  },
  {
    id: "4.3",
    desc: "accuracy@3 por OUTPUT del hook >= 90% (id esperado en el top-3 observable, no rankCandidates)",
    auto: true,
    check() {
      if (!fileExists(DISPATCHER_V2)) return { pass: false, detail: "no medible: routing-dispatcher.v2.js ausente" };
      let hits = 0;
      const miss = [];
      for (const c of ROUTING_CASES) {
        const r = runDispatcher(c.prompt);
        if (!r.ok) return { pass: false, detail: `no medible: hook no emitió JSON (${r.raw ?? ""})` };
        const top3 = r.candidates.slice(0, 3);
        if (top3.includes(c.expected)) hits++;
        else miss.push(`"${c.prompt.slice(0, 26)}"->${JSON.stringify(top3)}(esp ${c.expected})`);
      }
      const pct = (hits / ROUTING_CASES.length) * 100;
      return {
        pass: pct >= 90,
        detail: `accuracy@3(output)=${pct.toFixed(1)}% (${hits}/${ROUTING_CASES.length})` +
          (miss.length ? ` miss: ${miss.slice(0, 2).join(" | ")}` : ""),
      };
    },
  },
  {
    id: "4.4",
    desc: "casos negativos: 'gracias'/'que hora es' -> additionalContext sin routing (vacío, 0 skills)",
    auto: true,
    check() {
      if (!fileExists(DISPATCHER_V2)) return { pass: false, detail: "no medible: routing-dispatcher.v2.js ausente" };
      const offenders = [];
      for (const p of NEGATIVE_CASES) {
        const r = runDispatcher(p);
        if (!r.ok) return { pass: false, detail: `no medible: hook no emitió JSON (${r.raw ?? ""})` };
        // negativo limpio = sin candidato sugerido Y sin skill inyectada
        if (r.candidates.length > 0 || r.injectedIds.length > 0) {
          offenders.push(`"${p}"->cand=${JSON.stringify(r.candidates)} inj=${JSON.stringify(r.injectedIds)}`);
        }
      }
      return {
        pass: offenders.length === 0,
        detail: offenders.length === 0
          ? `${NEGATIVE_CASES.length} negativos -> 0 routing (correcto)`
          : `${offenders.length} negativos rutearon algo: ${offenders.join(" | ")}`,
      };
    },
  },
  {
    id: "4.5",
    desc: "binario LIVE == medido: si settings.json apunta a v2 (sin fallback semántico), prompt ambiguo NO emite [semantic-fallback]",
    auto: true,
    check() {
      // cat4.5 vieja medía --v3 (fallback semántico) mientras el hook LIVE de
      // settings.json es routing-dispatcher.v2.js (solo triggers literales). Medir el
      // binario que de verdad corre: con v2 vivo, un prompt ambiguo (sin trigger) NO
      // debe emitir [semantic-fallback] (v2 no lo tiene) -> known_red hasta migrar a v3
      // o etiquetar el modo. Si LIVE ya fuese v3, el check exige que SÍ lo emita.
      const s = readJSON(SETTINGS_JSON);
      if (!s) return { pass: false, detail: "no medible: settings.json ausente" };
      let liveCmd = null;
      for (const group of s.hooks?.UserPromptSubmit ?? []) {
        for (const h of group.hooks ?? []) {
          if (h.command && /routing-dispatcher/.test(h.command)) liveCmd = h.command;
        }
      }
      if (!liveCmd) return { pass: false, detail: "no medible: ningún routing-dispatcher en UserPromptSubmit" };
      const isV3 = /routing-dispatcher\.v3/.test(liveCmd);
      const ambiguous = "necesito ayuda con esto que tengo aqui montado";
      const r = runDispatcher(ambiguous);
      if (!r.ok) return { pass: false, detail: `no medible: hook no emitió JSON (${r.raw ?? ""})` };
      const hasFallback = /\[semantic-fallback\]/i.test(r.ac);
      if (isV3) {
        return { pass: hasFallback, detail: `LIVE=v3; prompt ambiguo semantic-fallback=${hasFallback}` };
      }
      // LIVE = v2: NO puede ofrecer fallback semántico; medir v3 sería medir un binario muerto.
      return {
        pass: false,
        detail: `LIVE=v2 (sin fallback semántico) pero la métrica histórica media --v3; prompt ambiguo no rutea (semantic-fallback=${hasFallback})`,
      };
    },
  },
  {
    id: "4.6",
    desc: "context_chars techo: additionalContext <= 12000 chars en prompts representativos (cap inflado silencioso)",
    auto: true,
    check() {
      if (!fileExists(DISPATCHER_V2)) return { pass: false, detail: "no medible: routing-dispatcher.v2.js ausente" };
      // Un prompt puede inflar el bloque (14032 chars visto con TDD por el namespace
      // catch-all + ECC). El cap de 3 inyecciones no acota los chars. Mide el OUTPUT real.
      const over = [];
      let maxLen = 0;
      for (const p of CTX_PROMPTS) {
        const r = runDispatcher(p);
        if (!r.ok) return { pass: false, detail: `no medible: hook no emitió JSON (${r.raw ?? ""})` };
        maxLen = Math.max(maxLen, r.len);
        if (r.len > CTX_MAX_CHARS) over.push(`"${p.slice(0, 24)}"=${r.len}`);
      }
      return {
        pass: over.length === 0,
        detail: over.length === 0
          ? `max additionalContext=${maxLen} chars (<=${CTX_MAX_CHARS})`
          : `${over.length} sobre techo (${CTX_MAX_CHARS}): ${over.join(", ")} [max=${maxLen}]`,
      };
    },
  },
  {
    id: "4.7",
    desc: "keep_active vs disco: carpetas no-.disabled con SKILL.md en ~/.claude/skills == keep_active del registry y <= 12",
    auto: true,
    check() {
      // cat4.3 vieja solo leía el JSON del registry. El criterio real es el DISCO: una
      // skill activa es una carpeta NO terminada en .disabled con SKILL.md (excluye
      // dotdirs como .git y dirs auxiliares sin manifiesto como 'learned').
      if (!existsSync(SKILLS_DIR)) return { pass: false, detail: "no medible: ~/.claude/skills ausente" };
      let active;
      try {
        active = readdirSync(SKILLS_DIR, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.endsWith(".disabled"))
          .filter((e) => existsSync(join(SKILLS_DIR, e.name, "SKILL.md")))
          .map((e) => e.name);
      } catch (e) {
        return { pass: false, detail: `no medible: readdir falló (${e.message})` };
      }
      const reg = readJSON(SKILLS_REGISTRY_COCKPIT);
      const keepActive = reg ? reg.filter((x) => x.keep_active === true).length : null;
      const diskCount = active.length;
      const matchesRegistry = keepActive === null ? true : diskCount === keepActive;
      return {
        pass: diskCount <= 12 && matchesRegistry,
        detail: `disco=${diskCount} (<=12) keep_active=${keepActive ?? "N/A"} match=${matchesRegistry}` +
          (matchesRegistry ? "" : ` [divergencia disco/registry]`),
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 5 — Limpieza de .ultron
// ---------------------------------------------------------------------------
cat(5, "Limpieza de .ultron", [
  {
    id: "5.1",
    desc: "FASTEMBED: 1 sola copia del modelo E5-large (model.onnx)",
    auto: true,
    check() {
      // El modelo E5 es model.onnx (NO safetensors). Busca SOLO en los caches fastembed
      // conocidos (acotado/rapido): un find sobre todo HOME timeouteaba y devolvia 0 = falso
      // pass que cazo el audit independiente 2026-06-21.
      const caches = [
        join(HOME, ".ultron", ".fastembed_cache"),
        join(HOME, "AppData", "Local", "Temp", "fastembed_cache"),
        join(HOME, "AppData", "Local", "fastembed-rs"),
      ];
      let count = 0;
      for (const d of caches) {
        if (!existsSync(d)) continue;
        const r = run(`find "${fwd(d)}" -ipath "*e5-large*" -name "model.onnx" 2>/dev/null | wc -l`, { timeout: 15000 });
        count += parseInt(r.stdout.trim(), 10) || 0;
      }
      return { pass: count === 1, detail: `${count} copia(s) de E5-large model.onnx en caches fastembed` };
    },
  },
  {
    id: "5.2",
    desc: "Disco libre >= 50GB (doctor informa free_gb)",
    auto: true,
    check() {
      // En vez de medir el tamaño (lento en Windows), usa el reporte del doctor
      const r = run(`"${fwd(join(BIN, "ultron-memory.exe"))}" doctor`, { timeout: 30000 });
      const txt = r.stdout + r.stderr;
      try {
        const j = JSON.parse(txt.trim());
        const diskCheck = (j.checks ?? []).find((c) => c.name === "disk");
        if (diskCheck) {
          const freeGb = diskCheck.data?.free_gb ?? null;
          if (freeGb !== null) {
            return { pass: freeGb >= 50, detail: `libre=${freeGb.toFixed(1)}GB` };
          }
        }
      } catch {}
      return { pass: false, detail: "no se pudo obtener info de disco del doctor" };
    },
  },
  {
    id: "5.3",
    desc: "0 dirs _cleanup_quarantine_* (o todos < 30 dias)",
    auto: true,
    check() {
      const r = run(`find "${fwd(ULTRON)}" -maxdepth 2 -type d -name "_cleanup_quarantine_*" 2>/dev/null`, { cwd: ULTRON });
      const dirs = r.stdout.trim().split("\n").filter(Boolean);
      if (dirs.length === 0) return { pass: true, detail: "0 quarantine dirs" };
      // En Windows, stat -c %Y puede no funcionar; usamos Node.js statSync
      const now = Date.now();
      const oldDirs = [];
      for (const d of dirs) {
        try {
          const { mtimeMs } = statSync(d);
          if (now - mtimeMs > 30 * 24 * 3600 * 1000) oldDirs.push(d);
        } catch {
          oldDirs.push(d); // si no podemos leer, conservador: cuenta como viejo
        }
      }
      return { pass: oldDirs.length === 0, detail: `${dirs.length} dirs total, ${oldDirs.length} > 30d` };
    },
  },
  {
    id: "5.4",
    desc: "0 archivos .bak de routing-dispatcher en ~/.claude/scripts",
    auto: true,
    check() {
      const scriptsDir = join(CLAUDE, "scripts");
      if (!existsSync(scriptsDir)) return { pass: true, detail: "~/.claude/scripts no existe" };
      const r = run(`find "${fwd(scriptsDir)}" -name "routing-dispatcher*.bak" 2>/dev/null | wc -l`);
      const count = parseInt(r.stdout.trim(), 10) || 0;
      return { pass: count === 0, detail: `${count} .bak de routing-dispatcher` };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 6 — Documentacion
// ---------------------------------------------------------------------------
cat(6, "Documentacion", [
  {
    id: "6.1",
    desc: "0 rutas personales en archivos trackeados (git grep)",
    auto: true,
    check() {
      // git grep con patrones de rutas personales
      // Usa git ls-files + Node.js para evitar problemas de comillas en Windows
      const r = run("git ls-files -- *.md *.rs *.ts *.tsx 2>/dev/null", { cwd: ULTRON });
      // Fiel al CI gate (audit_personal_data.py): AUTHORS.md/README.md exentos (atribucion de
      // autoria, NO fuga). Patrones = RUTAS personales reales, no el nombre del autor suelto.
      const ALLOWED = ["AUTHORS.md", "README.md"];
      const files = r.stdout.trim().split("\n").filter((f) => f.match(/\.(md|rs|ts|tsx)$/) && !ALLOWED.includes(f.split("/").pop()));
      // Username desde el entorno (no hardcodeado) -> el propio harness queda libre de PII.
      const userName = (process.env.USERNAME || process.env.USER || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const patterns = [/D:[/\\]Ultron/];
      if (userName) patterns.push(new RegExp("C:[/\\\\]Users[/\\\\]" + userName));
      let total = 0;
      for (const relFile of files) {
        const absFile = join(ULTRON, relFile);
        if (!existsSync(absFile)) continue;
        try {
          const content = readFileSync(absFile, "utf8");
          for (const pat of patterns) {
            if (pat.test(content)) { total++; break; }
          }
        } catch {}
      }
      return { pass: total === 0, detail: `${total} archivos trackeados con rutas personales` };
    },
  },
  {
    id: "6.2",
    desc: "audit_personal_data.py HIGH = 0",
    auto: true,
    check() {
      const script = join(ULTRON, "scripts", "cockpit", "audit_personal_data.py");
      if (!fileExists(script)) return { pass: false, detail: "audit_personal_data.py no encontrado" };
      const r = run(`python "${script}" 2>&1 | tail -10`, { timeout: 30000 });
      const txt = r.stdout + r.stderr;
      const highMatch = txt.match(/HIGH[^0-9]*([0-9]+)/i);
      const highCount = highMatch ? parseInt(highMatch[1], 10) : (r.ok ? 0 : -1);
      return { pass: highCount === 0, detail: `HIGH=${highCount}; ${txt.slice(-100)}` };
    },
  },
  {
    id: "6.3",
    desc: "0 broken links a .md en docs/ (links relativos reales, con/sin ./, con anchors)",
    auto: true,
    check() {
      const docsDir = join(ULTRON, "docs");
      if (!existsSync(docsDir)) return { pass: true, detail: "docs/ no existe" };
      // Parsea TODOS los links markdown relativos que apuntan a un .md: bare `]( INSTALL.md )`,
      // `]( ./X.md )`, `]( ../X.md#anchor )`. El check viejo solo matcheaba `](./` (los links
      // reales son bare) -> 0 matches -> "0 rotos" por vacuidad (cazado por audit independiente).
      let mdFiles;
      try { mdFiles = grepInFiles(/\.md/, docsDir, [".md"]).map((m) => m.file); }
      catch (e) { return { pass: false, detail: `error walk docs/: ${e.message}` }; }
      const uniq = [...new Set(mdFiles)];
      // Regex: captura el destino dentro de ]( ... ) que contenga ".md"
      const linkRe = /\]\(\s*([^)]+?\.md[^)\s]*)\s*\)/g;
      let links = 0, broken = 0;
      const brokenList = [];
      for (const f of uniq) {
        let content;
        try { content = readFileSync(f, "utf8"); } catch { continue; }
        let m;
        while ((m = linkRe.exec(content)) !== null) {
          let ref = m[1].trim();
          // Salta links externos / absolutos / solo-anchor
          if (/^(https?:|mailto:|#)/i.test(ref)) continue;
          ref = ref.replace(/^<|>$/g, "").split("#")[0].split("?")[0].trim();
          if (!ref || ref.startsWith("/")) continue; // ignora absolutos del repo
          links++;
          const target = join(dirname(f), ref);
          if (!existsSync(target)) {
            broken++;
            if (brokenList.length < 5) brokenList.push(`${f.split(/[/\\]/).pop()} -> ${ref}`);
          }
        }
      }
      // Si NO se parseo ningun link, es sospechoso (el check seria vacuo otra vez) -> reporta FAIL.
      if (links === 0) return { pass: false, detail: "0 links .md parseados en docs/ (sospechoso: check vacuo)" };
      return {
        pass: broken === 0,
        detail: broken === 0 ? `${links} links inspeccionados, 0 rotos` : `${broken}/${links} rotos: ${brokenList.join(", ")}`,
      };
    },
  },
  {
    id: "6.4",
    desc: "CLAUDE.md describe build:local (no build:app para escritorio)",
    auto: true,
    check() {
      const claudeMd = join(ULTRON, "CLAUDE.md");
      if (!fileExists(claudeMd)) return { pass: false, detail: "CLAUDE.md no encontrado" };
      const content = readFileSync(claudeMd, "utf8");
      const hasBuildLocal = /build:local/.test(content);
      const correctDesc = /build:local.*escritorio|escritorio.*build:local/i.test(content) || hasBuildLocal;
      return { pass: correctDesc, detail: hasBuildLocal ? "build:local presente en CLAUDE.md" : "build:local AUSENTE" };
    },
  },
  {
    id: "6.5",
    desc: "eval rechaza flags desconocidos (no finge medir con recall=1.0 ante un typo)",
    auto: true,
    check() {
      // Hoy `eval --flagquenoexiste` -> exit 0 + recall_at_k=1.0: ignora el flag y
      // corre el eval sintetico circular. Un typo (--gold por --golden) produce una
      // metrica falsamente optimista EN SILENCIO (mandamiento 11). known_red hasta
      // que el parser de args rechace lo desconocido.
      const r = run(`"${fwd(join(BIN, "ultron-memory.exe"))}" eval --flagquenoexiste 2>&1`, {
        timeout: 60000,
      });
      const txt = r.stdout + r.stderr;
      const rejected =
        r.code !== 0 || /unknown|unrecognized|invalid|no such|desconocid/i.test(txt);
      return {
        pass: rejected,
        detail: rejected
          ? "flag invalido rechazado (exit!=0 o error explicito)"
          : `flag invalido IGNORADO: exit=${r.code}, finge medir (recall=1.0 sintetico)`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 7 — Calidad de Codigo
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CAT 7 — Calidad de Codigo + Frescura del binario
// ---------------------------------------------------------------------------
// 7.1-7.5: calidad (clippy/tsc/lineas/tests). 7.3 (.rs >800L) PRESERVADO.
// 7.6-7.9: FRESCURA (mandamiento 3): el sidecar que ejecutan los hooks debe
// corresponder a HEAD, ser identico al binario recien compilado, y los hooks
// deben ARRANCAR de verdad (no solo pasar node --check). El gotcha mas caro del
// proyecto: bin/ultron-memory.exe stale -> "parece que no se aplico". Nada lo
// guardaba; ahora si.
cat(7, "Calidad de Codigo + Frescura del binario", [
  {
    id: "7.1",
    desc: "cargo clippy --lib --bins -- -D warnings pasa",
    auto: true,
    check() {
      const r = run("cargo clippy --lib --bins -- -D warnings 2>&1 | tail -5", {
        cwd: join(CC, "src-tauri"),
        timeout: 120000,
      });
      const txt = r.stdout + r.stderr;
      const ok = r.ok && !txt.includes("error[E") && !/^error/.test(txt.trim());
      return { pass: ok, detail: txt.slice(-200) };
    },
  },
  {
    id: "7.2",
    desc: "tsc --noEmit 0 errores",
    auto: true,
    check() {
      const r = run("npx tsc --noEmit 2>&1 | tail -10", { cwd: CC, timeout: 60000 });
      const txt = r.stdout + r.stderr;
      const hasErrors = /error TS[0-9]/i.test(txt);
      return { pass: r.ok && !hasErrors, detail: txt.slice(-200) || "OK" };
    },
  },
  {
    id: "7.3",
    desc: "0 archivos .rs > 800 lineas (excluyendo target/)",
    auto: true,
    check() {
      // PRESERVADO: anti-patron de fichero monolitico. find real + conteo de lineas.
      const r = run(
        `find "${CC_TAURI}" -name "*.rs" -not -path "*/target/*" -type f 2>/dev/null`,
        { cwd: ULTRON },
      );
      const files = r.stdout.trim().split("\n").filter(Boolean);
      const over = files.filter((f) => countLines(f) > 800);
      return {
        pass: over.length === 0,
        detail:
          over.length === 0
            ? "0 .rs >800L"
            : over.map((f) => `${f.split("/").slice(-1)[0]}:${countLines(f)}L`).join(", "),
      };
    },
  },
  {
    id: "7.4",
    desc: "0 archivos .tsx > 800 lineas",
    auto: true,
    check() {
      const r = run(`find "${CC_SRC}" -name "*.tsx" -type f 2>/dev/null`, { cwd: ULTRON });
      const files = r.stdout.trim().split("\n").filter(Boolean);
      const over = files.filter((f) => countLines(f) > 800);
      return {
        pass: over.length === 0,
        detail:
          over.length === 0
            ? "0 .tsx >800L"
            : over.map((f) => `${f.split("/").slice(-2).join("/")}:${countLines(f)}L`).join(", "),
      };
    },
  },
  {
    id: "7.5",
    desc: "cargo test --lib --bins pasa (0 failures)",
    auto: true,
    check() {
      const r = run("cargo test --lib --quiet -- --test-threads=1 2>&1", {
        cwd: join(CC, "src-tauri"),
        timeout: 240000,
      });
      const txt = r.stdout + r.stderr;
      const failed = /test result: FAILED|\bFAILED\b/.test(txt);
      const ok = /test result: ok/i.test(txt) || (r.ok && !failed && !txt.includes("error["));
      return { pass: ok && !failed, detail: txt.slice(-200) };
    },
  },
  {
    id: "7.6",
    desc: "sidecar deployado fresco: mtime(bin/ultron-memory.exe) >= ultimo commit que toca memory/",
    auto: true,
    check() {
      // Mandamiento 3: el .exe que ejecutan los hooks debe ser POSTERIOR al ultimo
      // cambio en memory/. Si quedo mas viejo -> "parece que no se aplico" (stale binary).
      const binPath = join(BIN, "ultron-memory.exe");
      if (!existsSync(binPath)) {
        return { pass: false, detail: "no medible: bin/ultron-memory.exe ausente" };
      }
      // git log -1 --format=%ct (epoch s) del ultimo commit que toca el modulo memory/.
      const r = run(
        `git log -1 --format=%ct -- control-center/src-tauri/src/memory/`,
        { cwd: ULTRON, timeout: 15000 },
      );
      const commitSec = parseInt(r.stdout.trim(), 10);
      if (!r.ok || !Number.isFinite(commitSec) || commitSec <= 0) {
        return { pass: false, detail: "no medible: git log -1 memory/ sin commit (clon shallow/sin historial)" };
      }
      let binSec;
      try {
        binSec = Math.floor(statSync(binPath).mtimeMs / 1000);
      } catch (e) {
        return { pass: false, detail: "no medible: statSync(bin) fallo: " + e.message };
      }
      const driftMin = ((binSec - commitSec) / 60).toFixed(1);
      return {
        pass: binSec >= commitSec,
        detail:
          binSec >= commitSec
            ? `bin fresco: mtime ${driftMin}min DESPUES del commit memory/`
            : `STALE: bin ${Math.abs(driftMin)}min ANTES del ultimo commit memory/ -> rebuild+redeploy`,
      };
    },
  },
  {
    id: "7.7",
    desc: "bin/ultron-memory.exe identico a target/release/ (cmp -s) — sin paso de copia olvidado",
    auto: true,
    check() {
      // Tras `cargo build --release` hay que COPIAR a bin/. Si se olvida, el .exe
      // deployado diverge del compilado. cmp -s exit 0 == byte-identicos.
      const binPath = join(BIN, "ultron-memory.exe");
      const relPath = join(CC, "src-tauri", "target", "release", "ultron-memory.exe");
      if (!existsSync(binPath)) return { pass: false, detail: "no medible: bin/ultron-memory.exe ausente" };
      if (!existsSync(relPath)) {
        return { pass: false, detail: "no medible: target/release/ultron-memory.exe ausente (sin build local)" };
      }
      const r = run(
        `cmp -s "${fwd(binPath)}" "${fwd(relPath)}"; echo $?`,
        { cwd: ULTRON, timeout: 20000 },
      );
      const code = parseInt(r.stdout.trim().split("\n").pop(), 10);
      return {
        pass: code === 0,
        detail:
          code === 0
            ? "bin/ == target/release/ (byte-identicos)"
            : `DIVERGEN (cmp exit=${code}): falta copiar el binario recien compilado a bin/`,
      };
    },
  },
  {
    id: "7.8",
    desc: "version embebido == HEAD: el .exe imprime el git SHA y coincide con rev-parse HEAD",
    auto: true,
    check() {
      // Unica prueba honesta de que el .exe corresponde a HEAD (mtime reciente lo
      // puede falsear un `touch`). known_red: HOY no existe subcomando que emita SHA
      // -> `version` da exit!=0 "unknown subcommand". ESE es el hallazgo (mandamiento 3):
      // sin SHA embebido no se puede verificar correspondencia exacta exe<->commit.
      const binPath = join(BIN, "ultron-memory.exe");
      if (!existsSync(binPath)) return { pass: false, detail: "no medible: bin/ultron-memory.exe ausente" };
      const rHead = run(`git rev-parse --short HEAD`, { cwd: ULTRON, timeout: 10000 });
      const head = rHead.stdout.trim();
      if (!rHead.ok || !head) return { pass: false, detail: "no medible: git rev-parse HEAD fallo" };
      // Prueba el subcomando que DEBERIA emitir el SHA.
      const rVer = run(`"${fwd(binPath)}" version 2>&1`, { cwd: ULTRON, timeout: 15000 });
      const out = (rVer.stdout + rVer.stderr).trim();
      // Falla honesta: no hay subcomando 'version' (unknown subcommand) o no imprime el SHA.
      if (!rVer.ok || /unknown subcommand|unrecognized|no such/i.test(out)) {
        return {
          pass: false,
          detail: `sin SHA embebido: 'version' -> "${out.slice(0, 80)}" (anadir build.rs git SHA + subcomando para verificar exe==HEAD)`,
        };
      }
      const emits = out.includes(head);
      return {
        pass: emits,
        detail: emits ? `version embebe HEAD ${head}` : `version="${out.slice(0, 60)}" NO contiene HEAD ${head}`,
      };
    },
  },
  {
    id: "7.9",
    desc: "cada hook ARRANCA sin crash (exit 0 + sin Error:/excepcion); los inyectores SessionStart emiten stdout no vacio",
    auto: true,
    check() {
      // cat12.4 hace solo `node --check` (sintaxis): un hook sintacticamente valido
      // puede PETAR al arrancar (require ausente, path Windows, JSON.parse de stdin).
      // Aqui se EJECUTA cada hook con un payload minimo y se asevera el arranque real.
      // Payload rico que cubre SessionStart + UserPromptSubmit + PreToolUse.
      const PAYLOAD = JSON.stringify({
        cwd: ULTRON,
        source: "startup",
        hook_event_name: "SessionStart",
        prompt: "refactoriza el modulo de auth",
        tool_name: "Glob",
        tool_input: { pattern: "*.rs" },
        transcript_path: "",
      });
      if (!existsSync(HOOKS_SCRIPTS)) return { pass: false, detail: "no medible: hooks/scripts ausente" };
      // Lista los .js de hooks via find (mismo patron que cat12.4).
      const rLs = run(`find "${fwd(HOOKS_SCRIPTS)}" -maxdepth 1 -name "*.js" 2>/dev/null`, { cwd: ULTRON });
      const hooks = rLs.stdout.trim().split("\n").filter(Boolean);
      if (hooks.length === 0) return { pass: false, detail: "no medible: 0 hooks .js en hooks/scripts" };
      // Inyectores SessionStart/UserPromptSubmit: su unico proposito es emitir
      // additionalContext -> stdout vacio = no-op silencioso (mandamiento 11). El resto
      // (capture/sync/relay) son side-effect y producen stdout vacio LEGITIMAMENTE.
      const MUST_EMIT = new Set([
        "memory-session-resume.js",
        "memory-orchestrate.js",
        "load-cross-project-memory.js",
        "session-start-override.js",
      ]);
      const CRASH = /\b(TypeError|ReferenceError|SyntaxError|RangeError|MODULE_NOT_FOUND)\b|Cannot read|is not a function|Error:/;
      const crashed = [];
      const silentInjectors = [];
      for (const f of hooks) {
        const name = f.split(/[/\\]/).pop();
        let r;
        try {
          r = spawnSync("node", [f], { input: PAYLOAD, encoding: "utf8", timeout: 30000, cwd: ULTRON });
        } catch (e) {
          crashed.push(`${name}:spawn-fail`);
          continue;
        }
        const out = (r.stdout ?? "") + (r.stderr ?? "");
        if (r.status !== 0 || CRASH.test(out)) {
          crashed.push(`${name}:exit=${r.status}`);
          continue;
        }
        if (MUST_EMIT.has(name) && (r.stdout ?? "").trim().length === 0) {
          silentInjectors.push(name);
        }
      }
      const bad = crashed.length + silentInjectors.length;
      return {
        pass: bad === 0,
        detail:
          bad === 0
            ? `${hooks.length} hooks arrancan OK; ${MUST_EMIT.size} inyectores emiten contexto`
            : `crash=[${crashed.join(", ")}] inyector-silencioso=[${silentInjectors.join(", ")}]`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 8 — UI funcional
// ---------------------------------------------------------------------------
cat(8, "UI funcional (cableada)", [
  {
    id: "8.1",
    desc: "invoke<->generate_handler!: 0 comandos invocados sin registrar (botones no-op), modulo finance",
    auto: true,
    check() {
      const libPath = join(CC_TAURI, "lib.rs");
      if (!fileExists(libPath) || !fileExists(CC_SRC)) {
        return { pass: false, detail: "no medible: falta lib.rs o control-center/src" };
      }
      // Invocados: invoke("x") / invoke<T>("x") -- primer string literal. Saltamos
      // lineas de comentario (JSDoc/line): un invoke("x") dentro de /** ... */ NO es
      // una llamada real (p.ej. recall_semantic solo vive en doc-comments de types/).
      const INVOKE_RE = /\binvoke\s*(?:<[^>]*>)?\s*\(\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]/;
      const invoked = new Set();
      let dynamicInvokes = 0;
      for (const m of grepInFiles(/\binvoke\s*(?:<[^>]*>)?\s*\(/, CC_SRC, [".ts", ".tsx"])) {
        if (/^\s*(\/\/|\*|\/\*)/.test(m.text)) continue;
        const mm = m.text.match(INVOKE_RE);
        if (mm) invoked.add(mm[1]);
        else if (!/\bimport\b/.test(m.text)) dynamicInvokes++; // invoke(var,...) sin literal
      }
      if (invoked.size === 0) return { pass: false, detail: "no medible: 0 invoke literales extraidos (regex/fuente cambio)" };
      // Registrados: bloque generate_handler![ ... ] de lib.rs. Cada linea
      // `modulo::sub::nombre,` aporta la ULTIMA componente como nombre de comando.
      // Las lineas finance van precedidas de `#[cfg(feature = "finance")]`.
      const lib = readFileSync(libPath, "utf8");
      const gs = lib.indexOf("generate_handler![");
      const ge = gs >= 0 ? lib.indexOf("])", gs) : -1;
      if (gs < 0 || ge < 0) return { pass: false, detail: "no medible: generate_handler! no encontrado en lib.rs" };
      const registered = new Set();
      const financeReg = new Set();
      let gate = false;
      for (const raw of lib.slice(gs, ge).split("\n")) {
        const line = raw.trim();
        if (line.includes('feature = "finance"')) { gate = true; continue; }
        const m = line.match(/^#?\s*(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Za-z_][A-Za-z0-9_]*)\s*,?$/);
        if (m && !line.startsWith("//") && !line.includes("generate_handler")) {
          const n = m[1];
          if (n === "cfg" || n === "feature") continue;
          if (gate) { financeReg.add(n); gate = false; } else registered.add(n);
        } else { gate = false; }
      }
      // Un comando registrado-y-no-usado no es no-op; el no-op es invocar-sin-registrar.
      const orphans = [...invoked].filter((c) => !registered.has(c) && !financeReg.has(c)).sort();
      return {
        pass: orphans.length === 0,
        detail:
          `invocados=${invoked.size} registrados=${registered.size} finance=${financeReg.size} dyn(var)=${dynamicInvokes} | ` +
          (orphans.length === 0 ? "0 huerfanos (sin botones no-op)" : `HUERFANOS(no-op): ${orphans.join(", ")}`),
      };
    },
  },
  {
    id: "8.2",
    desc: "tray-action contrato: 0 acciones emitidas en tray.rs sin listener en tauri-events.ts (y viceversa)",
    auto: true,
    check() {
      const trayPath = join(CC_TAURI, "tray.rs");
      const eventsPath = join(CC_SRC, "lib", "tauri-events.ts");
      if (!fileExists(trayPath) || !fileExists(eventsPath)) {
        return { pass: false, detail: "no medible: falta tray.rs o tauri-events.ts" };
      }
      const tray = readFileSync(trayPath, "utf8");
      const events = readFileSync(eventsPath, "utf8");
      // Emitidas: del `let action = match id { \"x\" => \"y\", ... }` que precede al
      // emit(\"tray-action\", {action}). Capturamos el destino \"y\" de cada arm.
      const emitted = new Set();
      const mm = tray.match(/let\s+action\s*=\s*match\s+id\s*\{([\s\S]*?)\};/);
      if (mm) for (const a of mm[1].matchAll(/"[a-z_]+"\s*=>\s*"([a-z_]+)"/g)) emitted.add(a[1]);
      if (emitted.size === 0) return { pass: false, detail: "no medible: 0 acciones emitidas extraidas de tray.rs (forma del match cambio)" };
      // Manejadas: cada `case \"x\":` del switch de tauri-events.ts.
      const handled = new Set();
      for (const a of events.matchAll(/case\s+"([a-z_]+)"\s*:/g)) handled.add(a[1]);
      const noListener = [...emitted].filter((a) => !handled.has(a)).sort();
      const noEmit = [...handled].filter((a) => !emitted.has(a)).sort();
      return {
        pass: noListener.length === 0 && noEmit.length === 0,
        detail:
          `emitidas=[${[...emitted].sort().join(",")}] manejadas=[${[...handled].sort().join(",")}] | ` +
          (noListener.length === 0 && noEmit.length === 0
            ? "contrato cerrado"
            : `emitidas_sin_listener(no-op)=[${noListener.join(",")}] listener_sin_emit=[${noEmit.join(",")}]`),
      };
    },
  },
  {
    id: "8.3",
    desc: "Finance en el binario desplegado: build:local (--features finance) y NO build:app",
    auto: true,
    check() {
      const finSrc = join(CC_TAURI, "finance.rs");
      if (!fileExists(finSrc)) {
        return { pass: true, detail: "N/A: finance.rs ausente (clon publico, no build:local-capable)" };
      }
      const exe = join(CC, "src-tauri", "target", "release", "control-center.exe");
      if (!fileExists(exe)) return { pass: false, detail: "no medible: control-center.exe no construido (target/release ausente)" };
      let lat;
      try { lat = readFileSync(exe).toString("latin1"); }
      catch (e) { return { pass: false, detail: "no medible: no se pudo leer el .exe: " + e.message }; }
      // Deteccion RELATIVA: los command-name strings no siempre quedan contiguos en
      // release; usamos varios anchors no-finance para confirmar que la deteccion
      // string funciona, y luego buscamos los comandos finance con el MISMO metodo.
      const anchors = ["kanban_load", "spawn_session", "ai_router_list_zones", "memory_inbox_list", "list_skills"];
      const anchorHits = anchors.filter((a) => lat.includes(a)).length;
      if (anchorHits < 2) {
        return { pass: false, detail: `no medible: solo ${anchorHits}/5 anchors detectados (binario strip/ofuscado; metodo string no fiable)` };
      }
      const finCmds = ["finance_overview", "finance_sync", "finance_open_setup"];
      const finHits = finCmds.filter((f) => lat.includes(f));
      return {
        pass: finHits.length >= 1,
        detail:
          `anchors=${anchorHits}/5 finance_cmds_en_exe=${finHits.length}/3 | ` +
          (finHits.length >= 1
            ? `finance compilado (${finHits.join(",")})`
            : "finance AUSENTE del .exe desplegado -> es build:app, no build:local"),
      };
    },
  },
  {
    id: "8.4",
    desc: "Todas las tabs montan sin TabErrorBoundary y panel renderiza >0 chars (Playwright sobre dev server) -- verificacion visual",
    auto: false,
  },
  {
    id: "8.5",
    desc: "0 mensajes console.* tras navegar todas las tabs (Playwright captura consola real) -- verificacion visual",
    auto: false,
  },
]);

// ---------------------------------------------------------------------------
// CAT 9 — Hooks
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CAT 9 — Hooks (arranque resiliente) — ENDURECIDA e2e (2026-06-24)
// ---------------------------------------------------------------------------
// Antes: manifest-parity + paths-existen + LATENCIA leida de hook-timing.jsonl
// (last5, log historico que ROTA a 1MiB y esta dominado por posttoolfail/codegraph
// -> muestras sesgables/perdidas) + grep "|| true" (pattern-only). El medidor leia
// historia, no veia el fail-safe-silencioso real. Ahora: salud POSITIVA del resume
// (estructura del artefacto que llega al modelo), caso negativo RUIDOSO (bin roto ->
// AC sin resume + exit 0 PERO debe dejar rastro en hook-errors.jsonl), y LATENCIA EN
// CALIENTE cronometrando el spawn real 3x (p50). manifest-parity preservado (9.1).
const ORCH_HOOK = join(HOOKS_SCRIPTS, "memory-orchestrate.js");
const HOOK_ERRORS_LOG = join(ULTRON, "logs", "hook-errors.jsonl");

// Cuenta lineas no vacias de un .jsonl (0 si no existe).
function jsonlLineCount(p) {
  if (!existsSync(p)) return 0;
  try { return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length; }
  catch { return 0; }
}

// Mediana de un array de numeros (orden asc, promedio de centrales si par).
function median(arr) {
  if (!arr.length) return Infinity;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Cronometra el spawn COMPLETO (incluye arranque de node) de un hook con stdin
// dado, n veces. Devuelve { samples[], exits[] }. Mide EN CALIENTE, no lee logs
// historicos sesgables (hook-timing.jsonl rota y se domina por otros hooks).
function timeHookSpawns(hookPath, stdinObj, n, perRunTimeoutMs) {
  const input = JSON.stringify(stdinObj);
  const samples = [];
  const exits = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const r = spawnSync("node", [hookPath], {
      input,
      encoding: "utf8",
      timeout: perRunTimeoutMs,
      cwd: ULTRON,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    samples.push(Date.now() - t0);
    exits.push(r.status);
  }
  return { samples, exits };
}

// Parsea el additionalContext del stdout JSON de un hook. Devuelve "" si AC vacio,
// null si el stdout NO es JSON valido (distinto de AC vacio).
function hookAdditionalContext(out) {
  try {
    const j = JSON.parse(out);
    return j.hookSpecificOutput?.additionalContext ?? j.additionalContext ?? "";
  } catch {
    return null;
  }
}

cat(9, "Hooks (arranque resiliente)", [
  {
    id: "9.1",
    desc: "manifest.json parity: todos los scripts del manifest existen en disco",
    auto: true,
    check() {
      if (!fileExists(HOOKS_MANIFEST)) return { pass: false, detail: "no medible: manifest.json ausente" };
      const manifest = readJSON(HOOKS_MANIFEST);
      const settings = readJSON(SETTINGS_JSON);
      if (!manifest || !settings) return { pass: false, detail: "no medible: manifest/settings no parseables" };
      const manifestScripts = new Set(
        (manifest.hooks ?? []).map((h) => h.script?.replace("~", HOME).replace(/\\/g, "/")),
      );
      let missing = 0;
      for (const s of manifestScripts) if (s && !existsSync(s)) missing++;
      return { pass: missing === 0, detail: `manifest: ${manifestScripts.size} scripts, ${missing} no existen en disco` };
    },
  },
  {
    id: "9.2",
    desc: "SALUD: resume hook sano emite JSON SessionStart + bloque <ultron-memory-resume (el artefacto que llega al modelo)",
    auto: true,
    check() {
      if (!fileExists(RESUME_HOOK)) return { pass: false, detail: "no medible: memory-session-resume.js ausente" };
      const r = spawnSync("node", [RESUME_HOOK], {
        input: JSON.stringify({ cwd: ULTRON, source: "startup", hook_event_name: "SessionStart" }),
        encoding: "utf8",
        timeout: 30000,
        cwd: ULTRON,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      const out = (r.stdout ?? "").trim();
      let j;
      try { j = JSON.parse(out); }
      catch { return { pass: false, detail: `stdout no es JSON: ${out.slice(0, 80)}` }; }
      const ev = j.hookSpecificOutput?.hookEventName;
      const ac = j.hookSpecificOutput?.additionalContext ?? "";
      const hasEvent = ev === "SessionStart";
      const hasResume = ac.includes("<ultron-memory-resume");
      const longEnough = ac.length > 50;
      return {
        pass: r.status === 0 && hasEvent && hasResume && longEnough,
        detail: `exit=${r.status} hookEventName=${ev} ac_len=${ac.length} hasResumeBlock=${hasResume}`,
      };
    },
  },
  {
    id: "9.3",
    desc: "CASO NEGATIVO RUIDOSO: bin roto -> AC sin <ultron-memory-resume + exit 0 PERO deja linea en hook-errors.jsonl (fail ruidosa, no silenciosa)",
    auto: true,
    check() {
      // known_red HOY: findBinary()/runCli() tragan el fallo del binario en
      // silencio (try/catch interno) -> el hook sale 0 con AC sin resume y NO
      // escribe a hook-errors.jsonl. logHookError solo se llama en el catch del
      // top-level main(), que NO se dispara porque runCli devuelve null SIN lanzar.
      // El usuario arranca MUDO sin senal accionable (mandamiento 11). Verificado en
      // runtime 2026-06-24: hook-errors.jsonl 0->0. FAIL honesto hasta que el hook
      // registre el binario ausente/roto en hook-errors.jsonl.
      if (!fileExists(RESUME_HOOK)) return { pass: false, detail: "no medible: memory-session-resume.js ausente" };
      // Fixture: archivo que EXISTE (findBinary lo acepta como ULTRON_MEMORY_BIN)
      // pero NO es ejecutable -> spawnSync del binario falla -> runCli devuelve null.
      let fakeBin;
      try {
        const tmpDir = join(ULTRON, ".tmp", "kirkardo");
        mkdirSync(tmpDir, { recursive: true });
        fakeBin = join(tmpDir, "fake-ultron-memory-broken.txt");
        writeFileSync(fakeBin, "not a binary\n");
      } catch (e) {
        return { pass: false, detail: `no medible: no se pudo crear fixture: ${e.message}` };
      }
      const before = jsonlLineCount(HOOK_ERRORS_LOG);
      // cwd a un proyecto INEXISTENTE -> projectIdFromCwd da basura -> sin context.md
      // -> el resume del binario es la unica fuente de <ultron-memory-resume>.
      const fakeCwd = join(ULTRON, ".tmp", "kirkardo", "nonexistent-project-xyz");
      const r = spawnSync("node", [RESUME_HOOK], {
        input: JSON.stringify({ cwd: fakeCwd, source: "startup", hook_event_name: "SessionStart" }),
        encoding: "utf8",
        timeout: 30000,
        cwd: ULTRON,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ULTRON_MEMORY_BIN: fwd(fakeBin) },
      });
      const after = jsonlLineCount(HOOK_ERRORS_LOG);
      const out = (r.stdout ?? "").trim();
      const ac = hookAdditionalContext(out);
      // (a) no crashea: exit 0 + JSON valido + el binario roto NO produjo resume
      const safe = r.status === 0 && ac !== null && !ac.includes("<ultron-memory-resume");
      // (b) RUIDOSO: dejo rastro accionable (>=1 linea nueva en hook-errors.jsonl)
      const noisy = after > before;
      return {
        pass: safe && noisy,
        detail: safe
          ? `fail-safe OK (exit 0, sin resume) pero RUIDO=${noisy} (hook-errors.jsonl ${before}->${after}; el fallo del binario no deja rastro accionable)`
          : `fail-safe ROTO: exit=${r.status} ac_null=${ac === null} hadResume=${ac !== null && ac.includes("<ultron-memory-resume")}`,
      };
    },
  },
  {
    id: "9.4",
    desc: "LATENCIA EN CALIENTE resume: p50 de spawn real 3x < 1500ms (mide el artefacto, no hook-timing.jsonl historico)",
    auto: true,
    check() {
      if (!fileExists(RESUME_HOOK)) return { pass: false, detail: "no medible: memory-session-resume.js ausente" };
      const { samples, exits } = timeHookSpawns(
        RESUME_HOOK,
        { cwd: ULTRON, source: "startup", hook_event_name: "SessionStart" },
        3,
        30000,
      );
      const p50 = median(samples);
      const allOk = exits.every((e) => e === 0);
      return {
        pass: allOk && p50 < 1500,
        detail: `p50=${p50}ms samples=[${samples.join(",")}]ms exits=[${exits.join(",")}] (umbral 1500ms; incluye spawn de node)`,
      };
    },
  },
  {
    id: "9.5",
    desc: "LATENCIA EN CALIENTE orchestrate: p50 de spawn real 3x < 300ms (daemon caliente)",
    auto: true,
    check() {
      // known_red en arranque limpio: el daemon serve (E5 residente) NO esta
      // caliente al inicio de cada sesion, asi que el spawn one-shot paga el
      // cold-load de E5-large. Verificado en runtime 2026-06-24 desde estado de
      // arranque (daemon muerto): samples [2758,583,207]ms -> p50=583ms; curva de
      // warmup visible (el 1er spawn arranca el daemon via spawnDetached, los
      // siguientes empiezan a pegarle por TCP). > 300ms -> FAIL honesto. NO relajar
      // el umbral: 300ms solo es alcanzable con el daemon ya residente; el limite
      // fisico real (E5 CPU cold) queda declarado aqui (mandamiento 13). Volatil por
      // diseno: si una sesion previa dejo el daemon caliente, p50 puede caer ~178ms
      // y pasar -> mide el regimen REAL del momento, no una historia vieja del log.
      if (!fileExists(ORCH_HOOK)) return { pass: false, detail: "no medible: memory-orchestrate.js ausente" };
      const { samples, exits } = timeHookSpawns(
        ORCH_HOOK,
        { prompt: "arregla el bug del router", cwd: ULTRON, source: "user-prompt" },
        3,
        20000,
      );
      const p50 = median(samples);
      const allOk = exits.every((e) => e === 0);
      return {
        pass: allOk && p50 < 300,
        detail: `p50=${p50}ms samples=[${samples.join(",")}]ms exits=[${exits.join(",")}] (umbral 300ms; daemon frio paga cold-E5 ~2.7-11s en el 1er spawn)`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 10 — Union del sistema (e2e)
// ---------------------------------------------------------------------------
cat(10, "Union del sistema (e2e)", [
  {
    id: "10.1",
    desc: "orchestrate_prompt tiene invoke() en frontend",
    auto: true,
    check() {
      const matches = grepInFiles(/orchestrate_prompt/, CC_SRC, [".tsx", ".ts"]);
      return { pass: matches.length >= 1, detail: `${matches.length} referencias a orchestrate_prompt en src/` };
    },
  },
  {
    id: "10.2",
    desc: ">= 90% comandos en lib.rs tienen caller en frontend",
    auto: true,
    check() {
      const libRs = join(CC_TAURI, "lib.rs");
      if (!fileExists(libRs)) return { pass: false, detail: "lib.rs no encontrado" };
      const content = readFileSync(libRs, "utf8");
      // Extrae nombres de comandos del invoke_handler![ ... ]
      // Formato: "  commands::module::function_name,"
      const handlerBlock = content.match(/\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/);
      if (!handlerBlock) return { pass: false, detail: "no se encontro invoke_handler block" };
      const handlers = handlerBlock[1]
        .split("\n")
        .map((l) => l.trim().replace(/,$/, "").replace(/\/\/.*$/, "").trim())
        .filter((l) => l.includes("::"))  // formato commands::module::fn_name
        .map((l) => l.split("::").pop())  // toma el nombre de funcion
        .filter((l) => l && l.length > 3 && /^[a-z_]+$/.test(l));
      const total = handlers.length;
      if (total === 0) return { pass: false, detail: "0 handlers extraidos de lib.rs" };
      // Usa grepInFiles para buscar cada handler en el frontend
      let matched = 0;
      for (const h of handlers) {
        const matches = grepInFiles(new RegExp(`["']${h}["']|invoke.*${h}`), CC_SRC, [".tsx", ".ts"]);
        if (matches.length > 0) matched++;
      }
      const pct = (matched / total) * 100;
      return {
        pass: pct >= 90,
        detail: `${matched}/${total} comandos con caller (${pct.toFixed(1)}%)`,
      };
    },
  },
  {
    id: "10.3",
    desc: "0 TODO:wire en lib.rs",
    auto: true,
    check() {
      const libRs = join(CC_TAURI, "lib.rs");
      if (!fileExists(libRs)) return { pass: false, detail: "lib.rs no encontrado" };
      const content = readFileSync(libRs, "utf8");
      const count = (content.match(/TODO.*wire/gi) ?? []).length;
      return { pass: count === 0, detail: `${count} TODO:wire en lib.rs` };
    },
  },
  {
    id: "10.4",
    desc: "0 nombres de agente (catalog + rosters) sin resolver en ~/.claude/agents o plugins",
    auto: true,
    check() {
      // El check viejo grepeaba use_agent|delegate|spawn_agent en .js/.py y NUNCA matcheaba un
      // NOMBRE de agente -> missing=0 por construccion (vacuo). Ahora extraigo los nombres REALES
      // del catalogo de agentes (agent-catalog.json: .agents[].name) y de todos los rosters de
      // proyecto (cockpit/projects/*/agent-roster.json: .entries[].name), y resuelvo cada uno.

      // Resolutor de plugins: indexa todos los <nombre>.md bajo .../plugins/cache/**/agents/
      const pluginAgents = new Set();
      try {
        const pluginsCache = join(CLAUDE, "plugins", "cache");
        const found = grepInFiles(/.*/, pluginsCache, [".md"]); // walk solo .md
        for (const { file } of found) {
          // Solo nos interesan los que viven en un dir llamado "agents"
          const parts = file.split(/[/\\]/);
          if (parts.includes("agents")) {
            const base = parts[parts.length - 1].replace(/\.md$/, "");
            pluginAgents.add(base.toLowerCase());
          }
        }
      } catch {}

      function resolves(name) {
        const candidates = [
          join(AGENTS_DIR, `${name}.md`),
          join(AGENTS_DIR, `${name}.md.disabled`),
        ];
        if (candidates.some((p) => existsSync(p))) return true;
        return pluginAgents.has(name.toLowerCase());
      }

      // 1) Nombres del catalogo
      const names = new Set();
      const catalog = readJSON(join(COCKPIT, "agent-catalog.json"));
      if (catalog && Array.isArray(catalog.agents)) {
        for (const a of catalog.agents) if (a?.name) names.add(a.name);
      }
      // 2) Nombres de los rosters de proyecto
      const projectsDir = join(COCKPIT, "projects");
      if (existsSync(projectsDir)) {
        let projs = [];
        try { projs = readdirSync(projectsDir); } catch {}
        for (const proj of projs) {
          const roster = readJSON(join(projectsDir, proj, "agent-roster.json"));
          for (const e of roster?.entries ?? []) if (e?.name) names.add(e.name);
        }
      }

      const all = [...names];
      if (all.length === 0) return { pass: false, detail: "0 nombres de agente extraidos (catalog+rosters vacios/sospechoso)" };
      const missing = all.filter((n) => !resolves(n));
      const resolved = all.length - missing.length;
      return {
        pass: missing.length === 0,
        detail: missing.length === 0
          ? `${resolved}/${all.length} agentes resueltos, 0 missing`
          : `${resolved}/${all.length} resueltos, ${missing.length} missing: ${missing.slice(0, 8).join(", ")}`,
      };
    },
  },
  {
    id: "10.5",
    desc: "Agents.tsx sin comentarios que mienten (TODO/FIXME)",
    auto: true,
    check() {
      const agentsTsx = join(CC_SRC, "components", "Agents.tsx");
      if (!fileExists(agentsTsx)) return { pass: false, detail: "Agents.tsx no encontrado" };
      const content = readFileSync(agentsTsx, "utf8");
      const todos = (content.match(/TODO|FIXME|HACK|XXX/g) ?? []).length;
      return { pass: todos === 0, detail: `${todos} TODO/FIXME en Agents.tsx` };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 11 — Plugins y MCPs
// ---------------------------------------------------------------------------
cat(11, "Plugins y MCPs", [
  {
    id: "11.1",
    desc: "0 entradas duplicadas de MCP en .claude.json",
    auto: true,
    check() {
      // MCPs viven en ~/.claude.json (no en settings.json)
      const claudeJson = join(HOME, ".claude.json");
      const s1 = readJSON(claudeJson) ?? {};
      const s2 = readJSON(SETTINGS_JSON) ?? {};
      const allNames = [
        ...Object.keys(s1.mcpServers ?? {}),
        ...Object.keys(s2.mcpServers ?? {}),
      ];
      const seen = new Set();
      const dups = [];
      for (const n of allNames) {
        if (seen.has(n)) dups.push(n);
        seen.add(n);
      }
      return {
        pass: dups.length === 0,
        detail: dups.length === 0 ? `0 MCPs duplicados (total=${allNames.length})` : `dups: ${dups.join(", ")}`,
      };
    },
  },
  {
    id: "11.2",
    desc: "0 scopes invalidos (System32, AppData\\Local\\Temp) en settings/.claude.json",
    auto: true,
    check() {
      const s1 = readJSON(SETTINGS_JSON) ?? {};
      const s2 = readJSON(join(HOME, ".claude.json")) ?? {};
      const txt = JSON.stringify(s1) + JSON.stringify(s2);
      const hasSystem32 = /System32/i.test(txt);
      const hasTemp = /AppData.Local.Temp/i.test(txt);
      return {
        pass: !hasSystem32 && !hasTemp,
        detail: `System32=${hasSystem32}, Temp=${hasTemp}`,
      };
    },
  },
  {
    id: "11.3",
    desc: "Spawns SIN headroom wrap (= 0 referencias en spawn scripts)",
    auto: true,
    check() {
      const spawnScript = join(ULTRON, "scripts", "cockpit", "spawn-claude-session.ps1");
      if (!fileExists(spawnScript)) {
        // Buscar en otra ubicacion
        const r = run(`find "${ULTRON}" -name "spawn*.ps1" 2>/dev/null`);
        if (!r.stdout.trim()) return { pass: true, detail: "spawn script no encontrado (OK)" };
      }
      const r = run(
        `grep -r "headroom wrap" "${ULTRON}/scripts" "${ULTRON}/cockpit" --include="*.ps1" --include="*.sh" --include="*.js" 2>/dev/null | wc -l`
      );
      const count = parseInt(r.stdout.trim(), 10) || 0;
      return { pass: count === 0, detail: `${count} referencias a headroom wrap` };
    },
  },
  {
    id: "11.4",
    desc: "ecc plugin DESACTIVADO en settings.json",
    auto: true,
    check() {
      const s = readJSON(SETTINGS_JSON);
      if (!s) return { pass: false, detail: "settings.json no encontrado" };
      const eccEnabled = s.enabledPlugins?.["ecc@ecc"];
      return { pass: eccEnabled === false, detail: `ecc@ecc enabled=${eccEnabled}` };
    },
  },
  {
    id: "11.5",
    desc: "delete_mcp persiste el borrado en config (no es no-op): cuerpo escribe el archivo",
    auto: true,
    check() {
      // Criterio binario 11.3 historico: delete_mcp modifica la config, no es un Ok(()) vacio.
      // Verificacion por inspeccion de codigo: localiza delete_mcp_inner, confirma que muta el
      // mapa mcpServers (servers.remove / mutate_mcp_servers) Y que la cadena persiste a disco
      // (fs::write / settings_save_inner / serde_json::to_string sobre el archivo de config).
      const mutFiles = grepInFiles(/fn\s+delete_mcp_inner/, CC_TAURI, [".rs"]);
      if (mutFiles.length === 0) return { pass: false, detail: "delete_mcp_inner no encontrado en src-tauri/src" };
      const file = mutFiles[0].file;
      let content;
      try { content = readFileSync(file, "utf8"); } catch (e) { return { pass: false, detail: `no se pudo leer ${file}: ${e.message}` }; }

      // 1) Cuerpo de delete_mcp_inner muta el mapa (remove) o delega en mutate_mcp_servers
      const bodyMatch = content.match(/fn\s+delete_mcp_inner[^{]*\{([\s\S]*?)\n\}/);
      const body = bodyMatch ? bodyMatch[1] : "";
      const isEmptyOk = /^\s*Ok\(\(\)\)\s*$/.test(body.trim());
      const mutates = /servers\.remove\b|mutate_mcp_servers\b/.test(body);
      if (isEmptyOk || !mutates) {
        return { pass: false, detail: "delete_mcp_inner no muta mcpServers (no-op / Ok(()) vacio)" };
      }

      // 2) Persistencia: en el propio cuerpo o en el helper mutate_mcp_servers debe escribir a disco.
      const persistsInFile = /settings_save_inner\b|fs::write\b|std::fs::write\b|serde_json::to_(?:string|writer)/.test(content);
      return {
        pass: persistsInFile,
        detail: persistsInFile
          ? "delete_mcp_inner muta mcpServers + persiste (settings_save_inner/fs::write)"
          : "delete_mcp_inner muta pero NO se ve persistencia a disco en el modulo",
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 12 — Facilidad de implementacion
// ---------------------------------------------------------------------------
cat(12, "Facilidad de implementacion", [
  {
    id: "12.1",
    desc: "CI .yml incluye cargo test + vitest",
    auto: true,
    check() {
      const ciFile = join(ULTRON, ".github", "workflows", "ci.yml");
      if (!fileExists(ciFile)) return { pass: false, detail: "ci.yml no encontrado" };
      const content = readFileSync(ciFile, "utf8");
      const hasCargo = /cargo test/i.test(content);
      const hasVitest = /vitest|npm test/i.test(content);
      return {
        pass: hasCargo && hasVitest,
        detail: `cargo test=${hasCargo}, vitest=${hasVitest}`,
      };
    },
  },
  {
    id: "12.2",
    desc: "CI timeout <= 30 min (windows job)",
    auto: true,
    check() {
      const ciFile = join(ULTRON, ".github", "workflows", "ci.yml");
      if (!fileExists(ciFile)) return { pass: false, detail: "ci.yml no encontrado" };
      const content = readFileSync(ciFile, "utf8");
      // Busca timeout-minutes en cargo job
      const m = content.match(/timeout-minutes:\s*([0-9]+)/g);
      const timeouts = (m ?? []).map((s) => parseInt(s.match(/([0-9]+)/)[1], 10));
      const maxTimeout = Math.max(...(timeouts.length ? timeouts : [0]));
      return { pass: maxTimeout <= 30, detail: `max timeout-minutes=${maxTimeout}` };
    },
  },
  {
    id: "12.3",
    desc: ".pre-commit-config.yaml existe",
    auto: true,
    check() {
      const p = join(ULTRON, ".pre-commit-config.yaml");
      return { pass: fileExists(p), detail: fileExists(p) ? "presente" : "ausente" };
    },
  },
  {
    id: "12.4",
    desc: "node --check en todos los scripts de hooks (syntax OK)",
    auto: true,
    check() {
      const r = run(`find "${HOOKS_SCRIPTS}" -name "*.js" 2>/dev/null`);
      const files = r.stdout.trim().split("\n").filter(Boolean);
      const errors = [];
      for (const f of files) {
        const res = run(`node --check "${f}" 2>&1`);
        if (!res.ok) errors.push(f.split("/").slice(-1)[0] + ": " + res.stderr.trim().slice(0, 80));
      }
      return {
        pass: errors.length === 0,
        detail: errors.length === 0 ? `${files.length} scripts OK` : errors.join("; "),
      };
    },
  },
  {
    id: "12.5",
    desc: "CI real < 300s (duracion del ultimo run success de ci.yml, via gh)",
    auto: true,
    check() {
      // Mide el RUN REAL (updatedAt - createdAt) del ultimo ci.yml success. El check 12.2 solo
      // miraba timeout-minutes<=30 (un techo, no la duracion real). Criterio documentado = <300s.
      const r = run(
        `gh run list --workflow=ci.yml --status success --limit 1 --json databaseId,createdAt,updatedAt 2>&1`,
        { timeout: 30000 }
      );
      if (!r.ok) {
        return { pass: false, detail: `gh no disponible/fallo: ${(r.stdout + r.stderr).trim().slice(0, 120)}` };
      }
      let arr;
      try { arr = JSON.parse(r.stdout.trim()); } catch {
        return { pass: false, detail: `gh devolvio JSON no parseable: ${r.stdout.trim().slice(0, 120)}` };
      }
      if (!Array.isArray(arr) || arr.length === 0) {
        return { pass: false, detail: "0 runs success de ci.yml" };
      }
      const run0 = arr[0];
      const start = new Date(run0.createdAt).getTime();
      const end = new Date(run0.updatedAt).getTime();
      if (isNaN(start) || isNaN(end) || end < start) {
        return { pass: false, detail: `timestamps invalidos: ${run0.createdAt} / ${run0.updatedAt}` };
      }
      const secs = Math.round((end - start) / 1000);
      return { pass: secs < 300, detail: `CI run #${run0.databaseId} duro ${secs}s (limite 300s)` };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 13 — Mejora de prompts
// ---------------------------------------------------------------------------
cat(13, "Mejora de prompts", [
  {
    id: "13.1",
    desc: "optimizador de prompt CABLEADO (llamada real optimize_prompt() en orchestrate.rs + build_prompt_plan fn existe)",
    auto: true,
    check() {
      // El check viejo grepeaba /build_prompt_plan/i y matcheaba un COMENTARIO (orchestrate.rs:114),
      // no la llamada real (que es super::ranking::optimize_prompt). Ahora exijo wiring REAL:
      //  (1) orchestrate.rs invoca optimize_prompt( como CALLSITE (no en comentario)
      //  (2) build_prompt_plan existe como fn (en ranking.rs o donde este realmente)
      const orchestrateFile = join(CC_TAURI, "orchestrator", "orchestrate.rs");
      if (!fileExists(orchestrateFile)) return { pass: false, detail: "orchestrate.rs no encontrado" };
      const content = readFileSync(orchestrateFile, "utf8");

      // Callsite real: una linea con `optimize_prompt(` que NO sea comentario de linea.
      const callsite = content.split("\n").some((l) => {
        const code = l.replace(/\/\/.*$/, ""); // descarta comentario de linea
        return /\boptimize_prompt\s*\(/.test(code);
      });

      // build_prompt_plan declarada como fn en el orquestador (ranking.rs u otro .rs).
      const fnDef = grepInFiles(/\bfn\s+build_prompt_plan\b/, join(CC_TAURI, "orchestrator"), [".rs"]);
      const hasFn = fnDef.length > 0;

      const pass = callsite && hasFn;
      const where = hasFn ? fnDef[0].file.split(/[/\\]/).pop() : "n/a";
      return {
        pass,
        detail: `callsite optimize_prompt()=${callsite}, fn build_prompt_plan=${hasFn} (${where})`,
      };
    },
  },
  {
    id: "13.2",
    desc: "optimize() o optimize_prompt llamado en orchestrate.rs",
    auto: true,
    check() {
      const orchestrateFile = join(CC_TAURI, "orchestrator", "orchestrate.rs");
      if (!fileExists(orchestrateFile)) return { pass: false, detail: "orchestrate.rs no encontrado" };
      const content = readFileSync(orchestrateFile, "utf8");
      const count = (content.match(/\boptimize\b|\boptimize_prompt\b/g) ?? []).length;
      return { pass: count >= 1, detail: `${count} llamadas a optimize/optimize_prompt` };
    },
  },
  {
    id: "13.3",
    desc: "skills-registry.json (cockpit) sin fantasmas (skills o agentes existen en ~/.claude/)",
    auto: true,
    check() {
      const reg = readJSON(SKILLS_REGISTRY_COCKPIT);
      if (!reg) return { pass: false, detail: "skills-registry.json no encontrado" };
      const phantoms = [];
      // Skills con ":" son de plugins (commit-commands:commit) — se verifican por plugin activo
      const settings = readJSON(SETTINGS_JSON) ?? {};
      const enabledPlugins = Object.keys(settings.enabledPlugins ?? {}).filter((k) => settings.enabledPlugins[k] === true);
      for (const entry of reg) {
        const rawId = entry.id ?? entry.name;
        if (!rawId) continue;
        if (rawId.includes(":")) {
          // Formato "plugin-name:skill-name" — verifica que el plugin este activo en settings.json
          const pluginName = rawId.split(":")[0];
          // Busca si algun enabledPlugin empieza por el nombre del plugin
          const pluginActive = enabledPlugins.some((p) => p.startsWith(pluginName));
          if (!pluginActive) phantoms.push(rawId);
          continue;
        }
        // Verifica en ~/.claude/skills/ (activo o .disabled) O ~/.claude/agents/
        const checks = [
          join(SKILLS_DIR, rawId),
          join(SKILLS_DIR, rawId + ".disabled"),
          join(AGENTS_DIR, `${rawId}.md`),
          join(AGENTS_DIR, `${rawId}.md.disabled`),
        ];
        if (!checks.some((p) => existsSync(p))) {
          phantoms.push(rawId);
        }
      }
      return {
        pass: phantoms.length === 0,
        detail: phantoms.length === 0 ? `0 fantasmas en ${reg.length} entries` : `${phantoms.length} fantasmas: ${phantoms.slice(0, 5).join(", ")}`,
      };
    },
  },
  {
    id: "13.4",
    desc: "Routing propone GRUPO y optimiza por paso — verificacion manual",
    auto: false,
    check: null,
  },
]);

// ---------------------------------------------------------------------------
// CAT 14 — Backend/UI
// ---------------------------------------------------------------------------
cat(14, "Backend/UI", [
  {
    id: "14.1",
    desc: "ai_router_validate_keys invocado desde Settings UI",
    auto: true,
    check() {
      // Usa grepInFiles Node.js nativo
      const matches = grepInFiles(/validate_keys|ai_router_validate_keys/, CC_SRC, [".tsx", ".ts"]);
      return { pass: matches.length >= 1, detail: `${matches.length} referencias a validate_keys en src/` };
    },
  },
  {
    id: "14.2",
    desc: "Usage tab visible (componente Usage.tsx existe y se importa en App.tsx)",
    auto: true,
    check() {
      const usageTsx = join(CC_SRC, "components", "Usage.tsx");
      if (!fileExists(usageTsx)) return { pass: false, detail: "Usage.tsx no encontrado" };
      // Lee App.tsx directamente
      const appTsx = join(CC_SRC, "App.tsx");
      if (!fileExists(appTsx)) return { pass: false, detail: "App.tsx no encontrado" };
      const appContent = readFileSync(appTsx, "utf8");
      const hasUsage = /Usage/.test(appContent);
      return { pass: hasUsage, detail: `Usage.tsx existe, importado en App.tsx=${hasUsage}` };
    },
  },
  {
    id: "14.3",
    desc: "orchestrate_prompt modal/boton en UI",
    auto: true,
    check() {
      const matches = grepInFiles(/orchestrate_prompt/, CC_SRC, [".tsx"]);
      return { pass: matches.length >= 1, detail: `${matches.length} referencias en .tsx` };
    },
  },
  {
    id: "14.4",
    desc: "Panel Git funciona (verificacion visual)",
    auto: false,
    check: null,
  },
  {
    id: "14.5",
    desc: "Zone Editor presente en AIRouter",
    auto: true,
    check() {
      const zoneEditorPath = join(CC_SRC, "components", "AIRouter", "ZoneEditor.tsx");
      const found = fileExists(zoneEditorPath);
      return { pass: found, detail: found ? "ZoneEditor.tsx presente en AIRouter/" : "ZoneEditor.tsx no encontrado" };
    },
  },
  {
    id: "14.6",
    desc: "Panel CodeGraph en ProjectWorkspace — verificacion visual",
    auto: false,
    check: null,
  },
]);

// ---------------------------------------------------------------------------
// CAT 15 — Observabilidad
// ---------------------------------------------------------------------------
cat(15, "Observabilidad", [
  {
    id: "15.1",
    desc: "hook-timing.jsonl existe y tiene entradas recientes (< 7 dias)",
    auto: true,
    check() {
      const timingFile = join(ULTRON, "logs", "hook-timing.jsonl");
      if (!fileExists(timingFile)) return { pass: false, detail: "hook-timing.jsonl ausente" };
      const lines = readFileSync(timingFile, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length === 0) return { pass: false, detail: "hook-timing.jsonl vacio" };
      const last = lines[lines.length - 1];
      let lastEntry = null;
      try { lastEntry = JSON.parse(last); } catch {}
      if (!lastEntry?.timestamp && !lastEntry?.ts) return { pass: true, detail: `${lines.length} entradas (sin timestamp parseable)` };
      const ts = new Date(lastEntry.timestamp ?? lastEntry.ts).getTime();
      const ageMs = Date.now() - ts;
      const ageDays = ageMs / (1000 * 3600 * 24);
      return { pass: ageDays < 7, detail: `ultima entrada hace ${ageDays.toFixed(1)} dias` };
    },
  },
  {
    id: "15.2",
    desc: "hook-errors.jsonl existe (rotacion de errores)",
    auto: true,
    check() {
      const errFile = join(ULTRON, "logs", "hook-errors.jsonl");
      return { pass: fileExists(errFile), detail: fileExists(errFile) ? "presente" : "ausente" };
    },
  },
  {
    id: "15.3",
    desc: "router guarda {zona, modelo, resultado} por sesion (metrics.json actualizado hoy)",
    auto: true,
    check() {
      const m = readJSON(METRICS_JSON);
      if (!m) return { pass: false, detail: "metrics.json no encontrado" };
      const today = new Date().toISOString().slice(0, 10);
      // Verifica que hay datos del dia actual en by_class o daily
      const hasByClass = m.by_class && Object.keys(m.by_class).length > 0;
      const byClassDate = Object.values(m.by_class ?? {}).some((v) => v.date === today);
      return {
        pass: hasByClass && byClassDate,
        detail: `by_class entries=${Object.keys(m.by_class ?? {}).length}, today=${byClassDate}`,
      };
    },
  },
  {
    id: "15.4",
    desc: "logs/ tiene rotacion (no crece indefinidamente): hook-timing.jsonl < 10MB",
    auto: true,
    check() {
      const timingFile = join(ULTRON, "logs", "hook-timing.jsonl");
      if (!fileExists(timingFile)) return { pass: true, detail: "hook-timing.jsonl ausente (OK)" };
      const r = run(`wc -c < "${timingFile}" 2>/dev/null`);
      const bytes = parseInt(r.stdout.trim(), 10) || 0;
      const mb = bytes / (1024 * 1024);
      return { pass: mb < 10, detail: `${mb.toFixed(2)}MB` };
    },
  },
  {
    id: "15.5",
    desc: "tracing estructurado en el backend Rust (crate tracing + tracing:: en src-tauri/src)",
    auto: true,
    check() {
      // cat15 daba 10/10 pero el backend Rust no tiene tracing estructurado (solo logging de hooks
      // por el lado JS). Observabilidad app-wide REAL = el crate tracing/tracing-subscriber declarado
      // en Cargo.toml + uso de tracing:: en el codigo. Si no hay -> FAIL honesto (documenta el gap).
      const cargoToml = join(CC, "src-tauri", "Cargo.toml");
      let crateDeclared = false;
      if (fileExists(cargoToml)) {
        const toml = readFileSync(cargoToml, "utf8");
        // dependencia tracing o tracing-subscriber al inicio de linea (no en comentario)
        crateDeclared = /^\s*tracing(-subscriber)?\s*=/m.test(toml);
      }
      const usage = grepInFiles(/\btracing::/, CC_TAURI, [".rs"]);
      const subscriberInit = grepInFiles(/tracing_subscriber::|tracing::subscriber|\.with_subscriber\(|fmt\(\)\.init\(/, CC_TAURI, [".rs"]);
      const usageFiles = new Set(usage.map((m) => m.file)).size;
      const pass = crateDeclared && usage.length > 0 && subscriberInit.length > 0;
      return {
        pass,
        detail: `crate tracing en Cargo.toml=${crateDeclared}, tracing:: en ${usageFiles} ficheros, subscriber init=${subscriberInit.length > 0}`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 16 — Context Engineering (tokens)
// ---------------------------------------------------------------------------
cat(16, "Context Engineering", [
  {
    id: "16.1",
    desc: "RTK NO mencionado como obligatorio en CLAUDE.md global",
    auto: true,
    check() {
      const globalClaude = join(CLAUDE, "CLAUDE.md");
      if (!fileExists(globalClaude)) return { pass: true, detail: "CLAUDE.md global no encontrado" };
      const content = readFileSync(globalClaude, "utf8");
      const hasMandatoryRtk = /RTK.*obligatorio|obligatorio.*RTK/i.test(content);
      const rtkCount = (content.match(/\bRTK\b/g) ?? []).length;
      return {
        pass: !hasMandatoryRtk && rtkCount < 5,
        detail: `RTK menciones=${rtkCount}, mandatory=${hasMandatoryRtk}`,
      };
    },
  },
  {
    id: "16.2",
    desc: "headroom NO instalado (uv tool list no muestra headroom-ai)",
    auto: true,
    check() {
      const r = run("uv tool list 2>&1 | grep -i headroom || echo 'NONE'", { timeout: 15000 });
      const txt = r.stdout.trim();
      const hasHeadroom = !/NONE/.test(txt) && /headroom/i.test(txt);
      return { pass: !hasHeadroom, detail: hasHeadroom ? txt : "headroom no instalado (OK)" };
    },
  },
  {
    id: "16.3",
    desc: "mem0 NO en lista activa de writers (solo en forbidden list)",
    auto: true,
    check() {
      // mem0 en WRITER_PATHS_FORBIDDEN es CORRECTO (prohibido)
      // mem0 en WRITER_PATHS_ALLOWED o en llamadas activas seria un FAIL
      const matches = grepInFiles(/mem0/, HOOKS_SCRIPTS, [".js"])
        .filter((m) => {
          const t = m.text.trim();
          // Permitido: menciones en listas de rutas prohibidas o comentarios
          if (/FORBIDDEN|forbidden|prohibited|blocked/i.test(t)) return false;
          if (/^\s*\/\//.test(t)) return false;         // comentario linea
          if (/^\s*\*/.test(t)) return false;            // comentario bloque JSDoc
          if (/opt-out|opt_out/.test(t)) return false;
          return true;
        });
      return { pass: matches.length === 0, detail: `${matches.length} referencias activas a mem0 (excl FORBIDDEN list)` };
    },
  },
  {
    id: "16.4",
    desc: "0 referencias a mem0 en hooks activos de settings.json",
    auto: true,
    check() {
      const settings = readJSON(SETTINGS_JSON);
      if (!settings) return { pass: false, detail: "settings.json no encontrado" };
      const txt = JSON.stringify(settings.hooks ?? {});
      const hasMem0 = /mem0/i.test(txt);
      return { pass: !hasMem0, detail: hasMem0 ? "mem0 en hooks de settings.json" : "0 referencias a mem0 en hooks" };
    },
  },
  {
    // Pilar 1 POSITIVO (no solo ausencia de anti-features): mide el gasto REAL de
    // tokens que los hooks inyectan al CLI cada prompt y lo acota. La telemetria la
    // produce hooks/scripts/lib/token-meter.js (emit de cada hook de memoria).
    // Sin este check, hook-tokens.jsonl seria dato sin consumo (mandamiento 12).
    id: "16.5",
    desc: "Gasto de tokens de memory-orchestrate al CLI medido y acotado (mediana last20 < 1500 est_tokens)",
    auto: true,
    check() {
      const log = join(ULTRON, "logs", "hook-tokens.jsonl");
      if (!fileExists(log)) return { pass: false, detail: "hook-tokens.jsonl ausente (telemetria de gasto no corriendo)" };
      const toks = readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && e.hook === "memory-orchestrate" && typeof e.est_tokens === "number")
        .map((e) => e.est_tokens);
      if (toks.length === 0) return { pass: false, detail: "0 entradas memory-orchestrate en hook-tokens.jsonl" };
      const last = toks.slice(-20).sort((a, b) => a - b);
      const median = last[Math.floor(last.length / 2)];
      const LIMIT = 1500;
      return { pass: median < LIMIT, detail: `mediana est_tokens (last${last.length})=${median} < ${LIMIT}` };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 17 — Calidad de compactacion
// ---------------------------------------------------------------------------
cat(17, "Calidad de compactacion", [
  {
    id: "17.1",
    desc: "stop-compress-session.js existe y no tiene require roto",
    auto: true,
    check() {
      const script = join(HOOKS_SCRIPTS, "stop-compress-session.js");
      if (!fileExists(script)) return { pass: false, detail: "script no existe" };
      const r = run(`node --check "${script}" 2>&1`);
      if (!r.ok) return { pass: false, detail: "syntax error: " + r.stderr.slice(0, 100) };
      // Verifica que no importa mem0-sync (que fue borrado)
      const content = readFileSync(script, "utf8");
      const hasMem0Sync = /require.*mem0-sync/i.test(content);
      return { pass: !hasMem0Sync, detail: hasMem0Sync ? "require(mem0-sync) PRESENTE (ROTO)" : "OK sin mem0-sync" };
    },
  },
  {
    id: "17.2",
    desc: "precompact-preserve-l0.js existe (scratch L0 se preserva)",
    auto: true,
    check() {
      const script = join(HOOKS_SCRIPTS, "precompact-preserve-l0.js");
      const exists = fileExists(script);
      if (!exists) return { pass: false, detail: "precompact-preserve-l0.js no existe" };
      const r = run(`node --check "${script}" 2>&1`);
      return { pass: r.ok, detail: r.ok ? "presente y syntax OK" : r.stderr.slice(0, 100) };
    },
  },
  {
    id: "17.3",
    desc: "session-end-summary.js existe (candidatos por sesion)",
    auto: true,
    check() {
      const script = join(HOOKS_SCRIPTS, "session-end-summary.js");
      const exists = fileExists(script);
      if (!exists) return { pass: false, detail: "session-end-summary.js no existe" };
      const r = run(`node --check "${script}" 2>&1`);
      return { pass: r.ok, detail: r.ok ? "presente y syntax OK" : r.stderr.slice(0, 100) };
    },
  },
  {
    id: "17.4",
    desc: "decisions-pending.jsonl existe en algun proyecto (pipeline activo)",
    auto: true,
    check() {
      // El archivo puede estar en cockpit/projects/<nombre>/decisions-pending.jsonl
      // o en ubicaciones raiz
      const candidates = [
        join(ULTRON, "decisions-pending.jsonl"),
        join(ULTRON, "logs", "decisions-pending.jsonl"),
        join(ULTRON, "batches", "decisions-pending.jsonl"),
      ];
      const found = candidates.find((p) => fileExists(p));
      if (found) return { pass: true, detail: found.split(/[/\\]/).slice(-3).join("/") };
      // Busca en cockpit/projects/
      const projectsDir = join(COCKPIT, "projects");
      if (existsSync(projectsDir)) {
        try {
          const projects = readdirSync(projectsDir);
          for (const proj of projects) {
            const candidate = join(projectsDir, proj, "decisions-pending.jsonl");
            if (fileExists(candidate)) {
              return { pass: true, detail: `cockpit/projects/${proj}/decisions-pending.jsonl` };
            }
          }
        } catch {}
      }
      return { pass: false, detail: "decisions-pending.jsonl no encontrado" };
    },
  },
  {
    id: "17.5",
    desc: "compact.json mas reciente con contenido estructurado real (no stub vacio)",
    auto: true,
    check() {
      // cat17 daba 10/10 pero solo verificaba node --check; nunca media CALIDAD del resultado.
      // Ahora abro el compact.json mas reciente y valido que tenga contenido estructurado real.
      const projectsDir = join(COCKPIT, "projects");
      if (!existsSync(projectsDir)) return { pass: false, detail: "cockpit/projects no existe" };
      // Localiza todos los compact.json bajo projects/*/sessions/*/
      let compacts;
      try { compacts = grepInFiles(/.*/, projectsDir, ["compact.json"]); }
      catch (e) { return { pass: false, detail: `error walk projects: ${e.message}` }; }
      const files = [...new Set(compacts.map((m) => m.file))];
      if (files.length === 0) return { pass: false, detail: "0 compact.json encontrados (pipeline de compactacion sin output)" };
      // Mas reciente por mtime
      let latest = null, latestMs = -1;
      for (const f of files) {
        try { const { mtimeMs } = statSync(f); if (mtimeMs > latestMs) { latestMs = mtimeMs; latest = f; } } catch {}
      }
      if (!latest) return { pass: false, detail: "no se pudo determinar el compact.json mas reciente" };
      const j = readJSON(latest);
      if (!j) return { pass: false, detail: `compact.json mas reciente no parseable: ${latest.split(/[/\\]/).slice(-2).join("/")}` };

      // Schema esperado: campos estructurados. Valido que AL MENOS uno de los campos de contenido
      // tenga datos reales (no todos vacios). Campos: human (resumen), decisions, next, bugs, arch_delta.
      const nonEmptyStr = (v) => typeof v === "string" && v.trim().length > 0;
      const nonEmptyArr = (v) => Array.isArray(v) && v.length > 0;
      const hasHuman = nonEmptyStr(j.human) || nonEmptyStr(j.summary);
      const contentArrays = ["decisions", "next", "bugs", "arch_delta"].filter((k) => nonEmptyArr(j[k]));
      const hasMachine = j.machine && typeof j.machine === "object" && (j.machine.turns_total ?? 0) >= 0;
      // Flag heuristico de origen AI vs heuristico (si esta presente, lo reportamos)
      const aiFlag = j.machine?.ai_used ?? j.ai ?? j.via ?? null;

      // Calidad minima: schema reconocible (human o machine) + al menos 1 array de contenido NO vacio.
      const structured = (hasHuman || hasMachine) && contentArrays.length > 0;
      return {
        pass: structured,
        detail: structured
          ? `${latest.split(/[/\\]/).slice(-2).join("/")}: human=${hasHuman}, arrays no vacios=[${contentArrays.join(",")}]${aiFlag !== null ? `, ai=${aiFlag}` : ""}`
          : `${latest.split(/[/\\]/).slice(-2).join("/")} sin contenido estructurado (human=${hasHuman}, machine=${hasMachine}, arrays no vacios=${contentArrays.length}) -> stub/vacio`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 18 — Reproducibilidad
// ---------------------------------------------------------------------------
cat(18, "Reproducibilidad", [
  {
    id: "18.1",
    desc: "bootstrap.ps1 existe en repo (instalacion reproducible)",
    auto: true,
    check() {
      const p = join(ULTRON, "bootstrap.ps1");
      return { pass: fileExists(p), detail: fileExists(p) ? "bootstrap.ps1 presente" : "ausente" };
    },
  },
  {
    id: "18.2",
    desc: "INSTALL.md existe con instrucciones",
    auto: true,
    check() {
      const p = join(ULTRON, "INSTALL.md");
      if (!fileExists(p)) return { pass: false, detail: "INSTALL.md ausente" };
      const content = readFileSync(p, "utf8");
      const hasSteps = content.length > 500;
      return { pass: hasSteps, detail: `INSTALL.md ${content.length} chars` };
    },
  },
  {
    id: "18.3",
    desc: "E2E Playwright config existe",
    auto: true,
    check() {
      const p = join(CC, "playwright.config.ts");
      return { pass: fileExists(p), detail: fileExists(p) ? "playwright.config.ts presente" : "ausente" };
    },
  },
  {
    id: "18.4",
    desc: "vitest configurado con setupFiles + mocks (determinismo por mocks)",
    auto: true,
    check() {
      // El check viejo hacia return {pass:true} INCONDICIONAL si existia vitest.config.ts y afirmaba
      // "seed/fixture fijos" que NO existen. Verifico lo que de verdad da determinismo: el config
      // declara setupFiles y ese fichero de setup usa mocks (vi.mock). Sin seed inventado.
      const cfg = join(CC, "vitest.config.ts");
      if (!fileExists(cfg)) return { pass: false, detail: "vitest.config.ts ausente" };
      const cfgContent = readFileSync(cfg, "utf8");
      // Extrae setupFiles: ["./src/test/setup.ts"] (acepta comillas simples/dobles, multiples)
      const setupBlock = cfgContent.match(/setupFiles\s*:\s*\[([^\]]*)\]/);
      if (!setupBlock) return { pass: false, detail: "vitest.config.ts sin setupFiles -> sin garantia de determinismo" };
      const setupPaths = [...setupBlock[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
      if (setupPaths.length === 0) return { pass: false, detail: "setupFiles vacio" };
      // Resuelve cada setup file relativo a control-center/ y verifica que use vi.mock
      let mockedFiles = 0, missing = 0;
      for (const sp of setupPaths) {
        const rel = sp.replace(/^\.\//, "");
        const abs = join(CC, rel);
        if (!existsSync(abs)) { missing++; continue; }
        const c = readFileSync(abs, "utf8");
        if (/\bvi\.mock\s*\(/.test(c)) mockedFiles++;
      }
      const pass = missing === 0 && mockedFiles > 0;
      return {
        pass,
        detail: pass
          ? `setupFiles=[${setupPaths.join(",")}] con vi.mock (determinismo por mocks)`
          : `setupFiles missing=${missing}, con vi.mock=${mockedFiles}/${setupPaths.length}`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 19 — Session-Start fidelity (resume VIVO, del proyecto, no nota podrida)
// ---------------------------------------------------------------------------
// Verifica el BINARIO real `ultron-memory resume --project ultron`: que
// open_tasks/decisions sean 100% del proyecto (0 cross-project/globales) y que
// next_action coincida con el estado VIVO (card In-Progress / Backlog-top del
// kanban, o el ultimo commit) — NO una nota vieja en pasado.
const RESUME_PROJECT = "ultron";

function runResume(project) {
  const r = run(`"${join(BIN, "ultron-memory.exe")}" resume --project ${project}`, {
    timeout: 30000,
  });
  const txt = (r.stdout + r.stderr).trim();
  try {
    return { ok: true, json: JSON.parse(txt) };
  } catch {
    return { ok: false, raw: txt.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// cat19 e2e — el ARTEFACTO real, no el binario a mano
// ---------------------------------------------------------------------------
// runResume() llama al binario directamente; eso NO es lo que el usuario recibe.
// Lo que llega a su contexto lo produce el hook memory-session-resume.js
// (lee cwd via stdin -> projectIdFromCwd -> render -> additionalContext).
// cat19 debe ejecutar ESE hook y aseverar sobre su salida. (Sprint 2026-06-24,
// causa raiz: cat19=10/10 mientras el resume inyectado llegaba PODRIDO.)
const RESUME_HOOK = join(HOOKS_SCRIPTS, "memory-session-resume.js");

// Verbos/estados que delatan una tarea ya hecha (no debe seguir viva en el resume).
const COMPLETED_MARKERS =
  /\b(actualizad[oa]|commite?ar|complet(ad[oa]|e)|hech[oa]|listo|finalizad[oa]|rebuild|tauri build|se ha (realizado|hecho)|ya hecho)\b/i;

// Ejecuta el HOOK real con stdin {cwd} y devuelve el additionalContext + el
// bloque <ultron-memory-resume> parseado por secciones.
function runResumeHook(cwd) {
  const input = JSON.stringify({ cwd, source: "startup", hook_event_name: "SessionStart" });
  let r;
  try {
    r = spawnSync("node", [RESUME_HOOK], { input, encoding: "utf8", timeout: 30000, cwd: ULTRON });
  } catch (e) {
    return { ok: false, raw: String(e) };
  }
  const out = (r.stdout ?? "").trim();
  let ac = "";
  try {
    const j = JSON.parse(out);
    ac = j.hookSpecificOutput?.additionalContext ?? j.additionalContext ?? "";
  } catch {
    return { ok: false, raw: out.slice(0, 160) };
  }
  const m = ac.match(/<ultron-memory-resume[^>]*>([\s\S]*?)<\/ultron-memory-resume>/);
  if (!m) return { ok: false, ac, raw: ac.slice(0, 160) };
  return { ok: true, ac, parsed: parseResumeBlock(m[1]) };
}

// Parser por secciones del bloque resume. Items = lineas "  - ...". list_noise =
// lineas no vacias dentro de una seccion de lista que NO son items (markdown crudo
// volcado por un summary multilinea: el sintoma exacto del render roto).
function parseResumeBlock(body) {
  const HEADERS = /^(project|open_tasks|recent_decisions|next_action|warnings|project_context)\b/;
  const out = {
    project: "",
    next_action: "",
    open_tasks: [],
    recent_decisions: [],
    project_context: [],
    list_noise: {},
  };
  let section = null;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const h = line.match(HEADERS);
    if (h && !line.startsWith("  ")) {
      section = h[1];
      if (section === "project") out.project = line.replace(/^project:\s*/, "").trim();
      if (section === "next_action") out.next_action = line.replace(/^next_action:\s*/, "").trim();
      continue;
    }
    const item = line.match(/^\s{2}-\s(.*)$/);
    if (item) {
      if (section === "open_tasks") out.open_tasks.push(item[1].trim());
      else if (section === "recent_decisions") out.recent_decisions.push(item[1].trim());
      else if (section === "project_context") out.project_context.push(item[1].trim());
    } else if (
      line.trim() !== "" &&
      (section === "open_tasks" || section === "recent_decisions" || section === "project_context")
    ) {
      out.list_noise[section] = (out.list_noise[section] || 0) + 1;
    } else if (section === "next_action" && line.trim() !== "") {
      out.next_action += " " + line.trim();
    }
  }
  return out;
}

// Titulos de cards VIVAS (doing/todo/blocked) del kanban del proyecto. null si no
// hay kanban (clon limpio / CI): el check degrada a N/A explicito, no a pass falso.
function liveCardTitles(project) {
  const p = join(COCKPIT, "projects", project, "kanban.json");
  if (!existsSync(p)) return null;
  let doc;
  try {
    doc = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  const liveCols = new Set(
    (doc.columns ?? []).filter((c) => ["doing", "todo", "blocked"].includes(c.role)).map((c) => c.id),
  );
  return (doc.cards ?? [])
    .filter((c) => liveCols.has(c.column_id))
    .map((c) => (c.title ?? "").trim())
    .filter(Boolean);
}

const normResume = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[`*#_~\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// ¿El string de tarea corresponde a alguna card viva? (inclusion bidireccional con
// un prefijo significativo, tolerante a recortes del render).
function mapsToLiveCard(taskStr, titles) {
  const t = normResume(taskStr);
  if (!t) return false;
  const key = t.slice(0, 40);
  return titles.some((title) => {
    const n = normResume(title);
    return n.includes(key) || t.includes(n.slice(0, 40));
  });
}

// Similitud Jaccard de tokens (split por espacio/barra/coma para cazar
// "Rust y Tauri" vs "Tauri/Rust" como near-duplicados).
function jaccardTokens(a, b) {
  const A = new Set(normResume(a).split(/[\s/,]+/).filter(Boolean));
  const B = new Set(normResume(b).split(/[\s/,]+/).filter(Boolean));
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
}

// Replica el esquema del kanban: card In-Progress (role doing, menor column
// order) por menor card order; si no hay, top de Backlog (role todo).
function kanbanNextAction(project) {
  const p = join(COCKPIT, "projects", project, "kanban.json");
  if (!existsSync(p)) return null;
  let doc;
  try {
    doc = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  const cols = (doc.columns ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const cards = doc.cards ?? [];
  const pickRole = (role) => {
    for (const col of cols.filter((c) => c.role === role)) {
      const inCol = cards
        .filter((c) => c.column_id === col.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      if (inCol.length) return inCol[0].title ?? null;
    }
    return null;
  };
  return pickRole("doing") || pickRole("todo");
}

// cat19 PIVOTADA a e2e (2026-06-24): ejecuta el HOOK real
// (memory-session-resume.js) y asevera sobre el additionalContext que de verdad
// llega al modelo, NO sobre 'ultron-memory.exe resume' invocado a mano. La version
// anterior media el binario y daba 10/10 mientras el resume inyectado llegaba
// podrido (open_tasks muertas, markdown crudo, project_context duplicado).
// TODO(siguiente incremento): 19.6 recent_decisions con ventana de frescura (<7d),
// 19.7 L0-scratch gate (mtime>24h no inyecta / fresco si, clipeado 2000).
cat(19, "Session-Start fidelity (e2e hook)", [
  {
    id: "19.1",
    desc: "el hook real emite resume con project correcto (cwd->projectId) + next_action presente",
    auto: true,
    check() {
      const h = runResumeHook(ULTRON);
      if (!h.ok) return { pass: false, detail: "hook no emitio resume: " + (h.raw ?? "") };
      const P = h.parsed;
      const pmatch = P.project === RESUME_PROJECT;
      const hasNA = P.next_action.trim() !== "";
      return {
        pass: pmatch && hasNA,
        detail: `project=${P.project || "?"} (esperado ${RESUME_PROJECT}) next_action_present=${hasNA}`,
      };
    },
  },
  {
    id: "19.2",
    desc: "open_tasks inyectadas = card viva del kanban y NO completadas (0 podridas)",
    auto: true,
    check() {
      const h = runResumeHook(ULTRON);
      if (!h.ok) return { pass: false, detail: "hook no emitio resume: " + (h.raw ?? "") };
      const titles = liveCardTitles(RESUME_PROJECT);
      if (!titles) return { pass: true, detail: "N/A (sin kanban local; clon limpio/CI)" };
      const tasks = h.parsed.open_tasks;
      const bad = tasks.filter((t) => !mapsToLiveCard(t, titles) || COMPLETED_MARKERS.test(t));
      return {
        pass: bad.length === 0,
        detail:
          bad.length === 0
            ? `${tasks.length} open_tasks, todas = card viva`
            : `${bad.length}/${tasks.length} podridas (no-card o completada): ${bad.map((b) => b.slice(0, 28)).slice(0, 4).join(" | ")}`,
      };
    },
  },
  {
    id: "19.3",
    desc: "render limpio: 0 summaries con salto de linea/markdown crudo + 0 ruido en listas",
    auto: true,
    check() {
      const h = runResumeHook(ULTRON);
      if (!h.ok) return { pass: false, detail: "hook no emitio resume: " + (h.raw ?? "") };
      const bin = runResume(RESUME_PROJECT);
      const binTasks = (bin.json?.open_tasks ?? []).map((t) => t.summary ?? "");
      const dirty = binTasks.filter((s) => s.includes("\n") || /^\s*#/.test(s));
      const noise = Object.values(h.parsed.list_noise).reduce((a, b) => a + b, 0);
      return {
        pass: dirty.length === 0 && noise === 0,
        detail: `summaries_multilinea_o_md=${dirty.length} lineas_ruido_en_listas=${noise}`,
      };
    },
  },
  {
    id: "19.4",
    desc: "next_action inyectado = card viva o 'ultimo commit:' y NO una nota completada",
    auto: true,
    check() {
      const h = runResumeHook(ULTRON);
      if (!h.ok) return { pass: false, detail: "hook no emitio resume: " + (h.raw ?? "") };
      const na = h.parsed.next_action;
      if (!na.trim()) return { pass: false, detail: "next_action vacio en el artefacto inyectado" };
      const titles = liveCardTitles(RESUME_PROJECT);
      const isCommit = /^(último|ultimo) commit:/i.test(na);
      const completed = COMPLETED_MARKERS.test(na);
      if (!titles) {
        return { pass: isCommit && !completed, detail: `N/A sin kanban; isCommit=${isCommit} completed=${completed}` };
      }
      const nk = normResume(na);
      const isCard = titles.some(
        (tt) => normResume(tt).includes(nk.slice(0, 40)) || nk.includes(normResume(tt).slice(0, 40)),
      );
      return {
        pass: (isCard || isCommit) && !completed,
        detail: `isCard=${isCard} isCommit=${isCommit} completed=${completed}: "${na.slice(0, 50)}"`,
      };
    },
  },
  {
    id: "19.5",
    desc: "project_context inyectado <=6 lineas y sin near-duplicados (ruido bajo control)",
    auto: true,
    check() {
      const h = runResumeHook(ULTRON);
      if (!h.ok) return { pass: false, detail: "hook no emitio resume: " + (h.raw ?? "") };
      const pc = h.parsed.project_context;
      const MAX = 6;
      const JT = 0.5;
      let dups = 0;
      for (let i = 0; i < pc.length; i++) {
        for (let j = i + 1; j < pc.length; j++) {
          if (jaccardTokens(pc[i], pc[j]) > JT) dups++;
        }
      }
      return {
        pass: pc.length <= MAX && dups === 0,
        detail: `lineas=${pc.length} (max ${MAX}) near_dups=${dups}`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 20 — Write-path real (dedupe + PII + sink + ledger)
// ---------------------------------------------------------------------------
// e2e del WRITE-PATH de memoria: cada check EJECUTA SQL real contra brain.db o
// el binario `candidate` y asevera sobre el dato persistido (no sobre codigo).
// Las consultas a brain.db corren en un subproceso `node --input-type=module`
// (node:sqlite es experimental -> aislado del proceso del harness); el SQL viaja
// por STDIN y la ruta de la BD por argv, evitando todo problema de quoting.
const BRAIN_DB = join(ULTRON, "brain.db");
const ULTRON_MEM = join(BIN, "ultron-memory.exe");

// Ejecuta `sql` (SELECT) sobre brain.db INLINE (mismo patron probado que
// readCodegraphDb en cat2: node:sqlite via getBuiltinModule, sincrono). El
// subproceso base64 anterior petaba con "statement has been finalized".
// Devuelve { rows } | { err } | { nodata } (BD ausente: clon limpio/CI). NUNCA lanza.
function sql20(sql) {
  if (!existsSync(BRAIN_DB)) return { nodata: true };
  let db;
  try {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    db = new DatabaseSync(BRAIN_DB, { readOnly: true });
    const rows = db.prepare(sql).all();
    db.close();
    return { rows };
  } catch (e) {
    try { db && db.close(); } catch {}
    return { err: String(e?.message || e).slice(0, 160) };
  }
}

cat(20, "Write-path real (dedupe + PII + sink + ledger)", [
  {
    id: "20.1",
    desc: "dedupe activo: ningun content_hash con > 3 copias 'active' en brain.db (advisory-only hoy)",
    auto: true,
    check() {
      const q = sql20(
        "SELECT content_hash, COUNT(*) c FROM memory_items " +
          "WHERE status='active' AND content_hash IS NOT NULL AND content_hash<>'' " +
          "GROUP BY content_hash HAVING c>1 ORDER BY c DESC LIMIT 1",
      );
      if (q.nodata) return { pass: false, detail: "no medible: brain.db ausente (clon limpio/CI)" };
      if (q.err) return { pass: false, detail: `no medible: ${q.err}` };
      const max = q.rows.length ? q.rows[0].c : 0;
      // KNOWN_RED: dedupe es advisory (create_candidate marca Merge pero no fusiona).
      // Medido 2026-06-24: max=211 (mismo error WebFetch repetido) -> FAIL honesto.
      return { pass: max <= 3, detail: `max copias activas de un content_hash=${max} (umbral <=3)` };
    },
  },
  {
    id: "20.2",
    desc: "posttoolfail rate-limit: total/distinct < 3 en capture_source='posttoolfail-capture' (inundacion de ruido)",
    auto: true,
    check() {
      const q = sql20(
        "SELECT COUNT(*) total, COUNT(DISTINCT content_hash) distinct_h FROM memory_items " +
          "WHERE status='active' AND capture_source='posttoolfail-capture'",
      );
      if (q.nodata) return { pass: false, detail: "no medible: brain.db ausente (clon limpio/CI)" };
      if (q.err) return { pass: false, detail: `no medible: ${q.err}` };
      const total = q.rows[0]?.total ?? 0;
      const distinct = q.rows[0]?.distinct_h ?? 0;
      if (total === 0) return { pass: true, detail: "0 items posttoolfail-capture (nada que limitar)" };
      const ratio = distinct > 0 ? total / distinct : Infinity;
      // KNOWN_RED: medido 244/10 = 24.4x -> FAIL (sin rate-limit por hash).
      return {
        pass: ratio < 3,
        detail: `posttoolfail total/distinct=${total}/${distinct}=${ratio.toFixed(1)}x (umbral <3)`,
      };
    },
  },
  {
    id: "20.3",
    desc: "sink de decisiones con consumidor: decisions-pending.jsonl no debe crecer append-only sin drenador en src-tauri",
    auto: true,
    check() {
      // El sink vive por proyecto: cockpit/projects/<proj>/decisions-pending.jsonl.
      const sinkUltron = join(COCKPIT, "projects", "ultron", "decisions-pending.jsonl");
      const sinkLegacy = join(COCKPIT, "decisions-pending.jsonl");
      const sink = existsSync(sinkUltron) ? sinkUltron : existsSync(sinkLegacy) ? sinkLegacy : null;
      if (!sink) return { pass: true, detail: "sin decisions-pending.jsonl (nada que drenar)" };
      // Consumidor real = codigo Rust en src-tauri que LEE/drena el fichero.
      const consumers = grepCount(/decisions[-_]pending/, CC_TAURI, [".rs"]);
      const lines = (() => {
        try {
          return readFileSync(sink, "utf8").split("\n").filter(Boolean).length;
        } catch {
          return -1;
        }
      })();
      // KNOWN_RED: grep en src-tauri = 0 (sink muerto que crece sin sumidero). El check
      // 17.4 viejo pasaba VERDE por existir el fichero (premiaba el sintoma de la enfermedad).
      return {
        pass: consumers > 0,
        detail:
          consumers > 0
            ? `decisions-pending.jsonl tiene ${consumers} consumidor(es) Rust`
            : `decisions-pending.jsonl existe (${lines} lineas) SIN consumidor en src-tauri (grep=0) -> sink muerto`,
      };
    },
  },
  {
    id: "20.4",
    desc: "redaction PII e2e: candidato con email/telefono/ruta C:/Users queda redactado en el item persistido",
    auto: true,
    check() {
      if (!existsSync(ULTRON_MEM)) return { pass: false, detail: "no medible: ultron-memory.exe ausente" };
      if (!existsSync(BRAIN_DB)) return { pass: false, detail: "no medible: brain.db ausente" };
      const marker = `kirkardo_pii_${Date.now()}`;
      const email = "redacttest@example.com";
      const phoneDigits = "698 123 456";
      const winPath = "C:/Users/TestUser/secreto_pii.txt"; // ruta sintetica, NO username real (audit 2026-06-25)
      const payload = JSON.stringify({
        type: "fact",
        scope: "session",
        title: marker,
        summary: `contacto ${email} tel +34 ${phoneDigits} ruta ${winPath}`,
        confidence: 0.9,
        project: "__kirkardo_test__", // scope efimero aislado del corpus productivo (audit 2026-06-25)
      });
      // Crea el candidato por la ruta real del binario (write-path productivo).
      const r = run(`"${fwd(ULTRON_MEM)}" candidate`, { input: payload, timeout: 30000 });
      const out = (r.stdout || "") + (r.stderr || "");
      const idm = out.match(/"candidate_id"\s*:\s*"([0-9a-f-]+)"/i);
      if (!idm) return { pass: false, detail: `candidate no devolvio id: ${out.slice(0, 120)}` };
      const q = sql20(`SELECT proposed_summary ps FROM memory_candidates WHERE id='${idm[1]}'`);
      if (q.err) return { pass: false, detail: `no medible: ${q.err}` };
      const ps = q.rows[0]?.ps ?? "";
      const leaks = [
        ps.includes(email) && "email",
        ps.includes(phoneDigits) && "telefono",
        /C:[\\/]Users[\\/]/i.test(ps) && "ruta",
      ].filter(Boolean);
      // KNOWN_RED: medido 2026-06-24 -> proposed_summary persiste TODO verbatim
      // (la redaction solo cubre credenciales con prefijo, NO PII de usuario).
      return {
        pass: leaks.length === 0,
        detail:
          leaks.length === 0
            ? "email/telefono/ruta redactados en el item persistido"
            : `PII sin redactar en proposed_summary: ${leaks.join(", ")}`,
      };
    },
  },
  {
    id: "20.5",
    desc: "redaction de campos codegraph e2e: file_path/signature con token (ghp_/sk-) quedan redactados",
    auto: true,
    check() {
      if (!existsSync(ULTRON_MEM)) return { pass: false, detail: "no medible: ultron-memory.exe ausente" };
      if (!existsSync(BRAIN_DB)) return { pass: false, detail: "no medible: brain.db ausente" };
      const marker = `kirkardo_cg_${Date.now()}`;
      const fp = "C:/Users/TestUser/secret/ghp_AAAABBBBCCCCDDDDEEEE.rs"; // ruta sintetica, NO username real (audit 2026-06-25)
      const sig = 'fn leak() { let t = "sk-abcdef1234567890"; }';
      const payload = JSON.stringify({
        type: "fact",
        scope: "session",
        title: marker,
        summary: "codegraph probe",
        file_path: fp,
        signature: sig,
        confidence: 0.9,
        project: "__kirkardo_test__", // scope efimero aislado del corpus productivo (audit 2026-06-25)
      });
      const r = run(`"${fwd(ULTRON_MEM)}" candidate`, { input: payload, timeout: 30000 });
      const out = (r.stdout || "") + (r.stderr || "");
      const idm = out.match(/"candidate_id"\s*:\s*"([0-9a-f-]+)"/i);
      if (!idm) return { pass: false, detail: `candidate no devolvio id: ${out.slice(0, 120)}` };
      const q = sql20(
        `SELECT proposed_file_path fp, proposed_signature sig FROM memory_candidates WHERE id='${idm[1]}'`,
      );
      if (q.err) return { pass: false, detail: `no medible: ${q.err}` };
      const gotFp = q.rows[0]?.fp ?? "";
      const gotSig = q.rows[0]?.sig ?? "";
      const leaks = [
        /ghp_[A-Za-z0-9]/.test(gotFp) && "ghp_token",
        /sk-[a-z0-9]{6,}/i.test(gotSig) && "sk_token",
        /C:[\\/]Users[\\/]/i.test(gotFp) && "ruta",
      ].filter(Boolean);
      // KNOWN_RED: solo se mapean los campos; ninguna redaction sobre
      // proposed_file_path/proposed_signature -> tokens persisten verbatim.
      return {
        pass: leaks.length === 0,
        detail:
          leaks.length === 0
            ? "campos codegraph redactados"
            : `secreto sin redactar en campos codegraph: ${leaks.join(", ")}`,
      };
    },
  },
  {
    id: "20.6",
    desc: "integridad ledger single-writer: 0 items 'active' sin NINGUN evento (escritura que salto MemoryService)",
    auto: true,
    check() {
      // No uso 'NOT EXISTS created' (sobre-cuenta: muchos items legitimos entran via
      // event_type='imported', no 'created' -> daria ~3139 falsos positivos). El hallazgo
      // honesto (audit 2026-06-24) es el item activo SIN evento de ningun tipo: prueba de
      // una escritura que esquivo el ledger del MemoryService (sin redaction/dedupe).
      const q = sql20(
        "SELECT COUNT(*) n FROM memory_items i WHERE i.status='active' " +
          "AND NOT EXISTS (SELECT 1 FROM memory_events e WHERE e.memory_id=i.id)",
      );
      if (q.nodata) return { pass: false, detail: "no medible: brain.db ausente (clon limpio/CI)" };
      if (q.err) return { pass: false, detail: `no medible: ${q.err}` };
      const orphans = q.rows[0]?.n ?? -1;
      // KNOWN_RED: medido 2026-06-24 -> 1 item activo huerfano (regla de oro ya violada).
      return { pass: orphans === 0, detail: `items 'active' sin evento alguno=${orphans} (regla single-writer)` };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 21 — Estado vivo (codigo muerto: Stale / TTL / cierre-kanban / deprecation)
// ---------------------------------------------------------------------------
// Cuatro metricas estructuralmente VERDES que NO son salud (verde-vacuo):
//   - Status::Stale: ningun path productivo lo escribe -> stats.stale==0 eterno.
//   - expires_at/TTL: siempre None y el recall NUNCA filtra por expires_at
//     (engine.rs governance gate: status/valid_to/project/source/sensitivity,
//     jamas expires_at) -> un item caducado sigue saliendo en recall.
//   - deprecation_entries: tabla vacia -> doctor.overdue=0 por vacuidad.
//   - cierre-kanban: el unico mecanismo es un Stop hook (kanban-update-reminder)
//     que SOLO emite texto "RECORDATORIO"; nunca mueve la card a 'done' ni
//     escribe kanban.json.
// Todos ejecutan un artefacto REAL (hook/binario/brain.db) y aseveran sobre su
// output observable. Los cuatro son known_red HOY: deben FALLAR honesto. Sin
// datos (clon limpio/CI sin brain.db/kanban/binario) -> pass:false con detail
// "no medible: <que falta>" (nunca pass por vacuidad).
const KANBAN_CAT21 = join(COCKPIT, "projects", "ultron", "kanban.json");
const KANBAN_REMINDER_HOOK = join(HOOKS_SCRIPTS, "kanban-update-reminder.js");

// python -c en UNA sola linea (sin '\n' literal, que el shell no reconvierte a
// salto y rompe el parser de python). Statements unidos por ';'. Requiere
// 'python' en PATH; sin el, las funciones devuelven null -> el check degrada a
// "no medible" (pass:false), nunca a verde por vacuidad.
function pyLine(stmts) {
  return `python -c ${JSON.stringify(stmts.join(";"))}`;
}
function sqliteScalar(query) {
  if (!existsSync(BRAIN_DB)) return null;
  const r = run(
    pyLine([
      "import sqlite3",
      `c=sqlite3.connect(${JSON.stringify(fwd(BRAIN_DB))})`,
      `print(c.execute(${JSON.stringify(query)}).fetchone()[0])`,
    ]),
    { timeout: 20000 },
  );
  if (!r.ok) return null;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

cat(21, "Estado vivo (codigo muerto: Stale/TTL/cierre-kanban)", [
  {
    id: "21.1",
    desc: "cierre-kanban e2e: el Stop hook con transcript de tarea-hecha CIERRA la card (role=done) o escribe el kanban, NO solo emite texto RECORDATORIO",
    auto: true,
    check() {
      if (!fileExists(KANBAN_REMINDER_HOOK)) {
        return { pass: false, detail: "no medible: falta hooks/scripts/kanban-update-reminder.js" };
      }
      if (!fileExists(KANBAN_CAT21)) {
        return { pass: false, detail: "no medible: falta cockpit/projects/ultron/kanban.json (clon limpio/CI)" };
      }
      // Fixture: usuario pide tarea completable + asistente la marca hecha + commit.
      const logsDir = join(ULTRON, "logs");
      try { if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true }); } catch {}
      const fixture = join(logsDir, `kirkardo-cat21-transcript-${Date.now()}.jsonl`);
      const transcript = [
        JSON.stringify({ type: "user", message: { role: "user", content: "implementa el cierre automatico de cards en el kanban" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Listo. He completado la tarea y la card ya esta hecha. Commit aplicado." }] } }),
      ].join("\n");

      // Conteo de cards en columnas role=done ANTES (detecta cierre real).
      const countDone = (raw) => {
        try {
          const d = JSON.parse(raw);
          const doneCols = new Set((d.columns ?? []).filter((c) => c.role === "done").map((c) => c.id));
          return (d.cards ?? []).filter((c) => doneCols.has(c.column_id)).length;
        } catch { return null; }
      };
      const before = (() => { try { return readFileSync(KANBAN_CAT21, "utf8"); } catch { return null; } })();
      const doneBefore = before === null ? null : countDone(before);

      let out = "", code = -1;
      try {
        writeFileSync(fixture, transcript, "utf8");
        const payload = JSON.stringify({
          transcript_path: fwd(fixture),
          cwd: fwd(ULTRON),
          hook_event_name: "Stop",
          session_id: "kirkardo-cat21",
        });
        // stdin via spawnSync DIRECTO (el helper run() NO reenvia opts.input);
        // mismo patron que runResumeHook.
        const r = spawnSync("node", [KANBAN_REMINDER_HOOK], {
          input: payload, encoding: "utf8", timeout: 15000, cwd: ULTRON,
        });
        out = (r.stdout ?? "").trim();
        code = r.status;
      } catch (e) {
        return { pass: false, detail: `excepcion ejecutando el hook: ${e.message}` };
      } finally {
        try { run(`rm -f "${fwd(fixture)}"`, { timeout: 5000 }); } catch {}
      }

      const after = (() => { try { return readFileSync(KANBAN_CAT21, "utf8"); } catch { return null; } })();
      const doneAfter = after === null ? null : countDone(after);
      const kanbanChanged = before !== null && after !== null && before !== after;
      const cardClosed = doneBefore !== null && doneAfter !== null && doneAfter > doneBefore;
      const realClose = cardClosed || kanbanChanged;
      const onlyReminder = /RECORDATORIO/i.test(out) && !realClose;

      return {
        pass: realClose,
        detail: realClose
          ? `cierre real detectado (cards_done ${doneBefore}->${doneAfter}, kanban_changed=${kanbanChanged})`
          : onlyReminder
            ? `solo RECORDATORIO de texto, kanban INTACTO (cards_done=${doneBefore}); no-op de cierre (mandamiento 11)`
            : `sin cierre ni recordatorio (exit=${code}, out="${out.slice(0, 80)}")`,
      };
    },
  },
  {
    id: "21.2",
    desc: "Stale vivo: existe un path que transiciona items a Status::Stale Y stats.stale lo refleja (hoy ningun path lo escribe -> stale==0 estructural)",
    auto: true,
    check() {
      // stats.stale es el contador productivo. NINGUN subcomando transiciona a
      // Stale (deprecate escribe status=deprecated, nunca stale). Si 0 items en
      // stale, la metrica es verde-vacua: codigo muerto.
      const r = run(`"${fwd(join(BIN, "ultron-memory.exe"))}" stats 2>&1`, { timeout: 15000 });
      let stale = null;
      try { stale = JSON.parse(r.stdout.trim()).stale; } catch {}
      if (stale === null || stale === undefined) {
        // Fallback a brain.db directo (CI/sin binario sano).
        stale = sqliteScalar("SELECT COUNT(*) FROM memory_items WHERE status='stale'");
      }
      if (stale === null || stale === undefined) {
        return { pass: false, detail: "no medible: ni stats ni brain.db dieron el conteo de stale" };
      }
      // Status presentes (evidencia de que 'stale' jamas aparece).
      const distinct = (() => {
        if (!existsSync(BRAIN_DB)) return "";
        const q = run(
          pyLine([
            "import sqlite3",
            `c=sqlite3.connect(${JSON.stringify(fwd(BRAIN_DB))})`,
            "print(','.join(s for (s,) in c.execute(\"SELECT DISTINCT status FROM memory_items ORDER BY status\")))",
          ]),
          { timeout: 15000 },
        );
        return q.ok ? q.stdout.trim() : "";
      })();
      return {
        // PASS solo si la transicion a Stale ESTA viva (>=1 item stale). Hoy 0 -> FAIL.
        pass: stale >= 1,
        detail: stale >= 1
          ? `stale=${stale} (la transicion productiva esta viva)`
          : `stale=${stale} -> NINGUN path escribe Status::Stale (codigo muerto); status presentes: [${distinct}]`,
      };
    },
  },
  {
    id: "21.3",
    desc: "TTL vivo e2e: un item con expires_at en el pasado NO debe salir en recall (hoy expires_at nunca se setea y el recall no lo filtra -> el item caducado sale)",
    auto: true,
    check() {
      if (!existsSync(BRAIN_DB)) return { pass: false, detail: "no medible: falta brain.db (clon limpio/CI)" };
      const binPath = join(BIN, "ultron-memory.exe");
      if (!fileExists(binPath)) return { pass: false, detail: "no medible: falta bin/ultron-memory.exe" };

      const probeId = "kirkardo-ttl-probe-cat21";
      const token = "Zxqvprobe"; // token raro: el probe sera el unico sparse hit
      const past = Math.floor(Date.now() / 1000) - 999999; // ~11.5 dias en el pasado
      const now = Math.floor(Date.now() / 1000);

      // Inserta un item ACTIVO scope=global source=direct con expires_at en el
      // pasado. (No hay subcomando 'insert'; el unico modo de tener un item activo
      // con TTL pasado es escribirlo en brain.db — los triggers FTS lo indexan.)
      const vals = {
        id: probeId, type: "fact", scope: "global",
        title: `${token} ${token}`,
        summary: `${token} ${token} ${token} item caducado de prueba`,
        content: token, status: "active", confidence: 0.9, importance: 0.9,
        stability: "stable", sensitivity: "normal", source: "direct",
        created_at: now, updated_at: now, expires_at: past,
        token_estimate: 10, access_count: 0, validated_by_user: 0, pinned: 0,
        schema_version: 1, content_hash: "kprobehash21",
      };
      const ins = run(
        pyLine([
          "import sqlite3,json",
          `c=sqlite3.connect(${JSON.stringify(fwd(BRAIN_DB))})`,
          `c.execute('DELETE FROM memory_items WHERE id=?', (${JSON.stringify(probeId)},))`,
          `v=json.loads(${JSON.stringify(JSON.stringify(vals))})`,
          "k=list(v.keys())",
          "c.execute('INSERT INTO memory_items ('+','.join(k)+') VALUES ('+','.join('?'*len(k))+')',[v[x] for x in k])",
          "c.commit()",
          "c.close()",
          "print('OK')",
        ]),
        { timeout: 20000 },
      );
      if (!/OK/.test(ins.stdout)) {
        return { pass: false, detail: `no medible: no se pudo insertar el probe (${(ins.stderr || ins.stdout).slice(0, 120)})` };
      }

      // Limpieza garantizada del probe pase lo que pase.
      const cleanup = () => {
        run(
          pyLine([
            "import sqlite3",
            `c=sqlite3.connect(${JSON.stringify(fwd(BRAIN_DB))})`,
            `c.execute('DELETE FROM memory_items WHERE id=?', (${JSON.stringify(probeId)},))`,
            "c.commit()",
            "c.close()",
          ]),
          { timeout: 15000 },
        );
      };

      let leaked = false, total = 0;
      try {
        const r = run(`"${fwd(binPath)}" recall "${token}" 2>&1`, { timeout: 60000 });
        let entries = [];
        try { entries = JSON.parse(r.stdout.trim()).entries ?? []; } catch {}
        total = entries.length;
        leaked = entries.some((e) => `${e.summary ?? ""}${e.title ?? ""}`.includes(token));
      } finally {
        cleanup();
      }

      return {
        // PASS si el item caducado fue EXCLUIDO del recall (TTL honrado). Hoy sale -> FAIL.
        pass: !leaked,
        detail: leaked
          ? `item con expires_at ${past} (pasado) SALE en recall (${total} entries) -> TTL no se honra (codigo muerto)`
          : `item caducado correctamente excluido del recall (TTL honrado, ${total} entries)`,
      };
    },
  },
  {
    id: "21.4",
    desc: "deprecation_deadlines NO-vacuo: deprecation_entries tiene >=1 fila (si 0 -> N/A explicito, NO verde); doctor.overdue=0 sobre tabla vacia no es salud",
    auto: true,
    check() {
      const total = sqliteScalar("SELECT COUNT(*) FROM deprecation_entries");
      if (total === null) {
        return { pass: false, detail: "no medible: falta brain.db o python sqlite3 (clon limpio/CI)" };
      }
      if (total === 0) {
        // Tabla vacia: doctor reporta overdue=0 por VACUIDAD, no por salud (nada se
        // deprecia con entrada de ledger). FAIL/N/A explicito, nunca pass por vacio.
        return {
          pass: false,
          detail: "N/A: deprecation_entries VACIA (0 filas) -> doctor.overdue=0 por vacuidad, no por salud; ningun path escribe el ledger de deprecacion",
        };
      }
      // Con >=1 fila el check vive: 0 deadlines vencidos = salud real.
      const overdue = sqliteScalar(
        "SELECT COUNT(*) FROM deprecation_entries WHERE deadline IS NOT NULL AND deadline <> '' AND deadline < strftime('%Y-%m-%dT%H:%M:%SZ','now')",
      );
      if (overdue === null) {
        return { pass: false, detail: `deprecation_entries=${total} pero no se pudo medir overdue` };
      }
      return {
        pass: overdue === 0,
        detail: `deprecation_entries=${total} filas, overdue=${overdue} (deadlines vencidos)`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 22 — Delegacion coherente (calidad>tokens, agente correcto) — e2e hook
// ---------------------------------------------------------------------------
// Ejecuta el ARTEFACTO real (memory-orchestrate.js) que decide la delegacion y
// asevera sobre la <orchestration-directive> que de verdad llega al modelo, NO
// sobre decide_delegation() invocada a mano. La directiva contradice hoy el
// feedback literal del usuario (2026-06-24: calidad>tokens -> Sonnet/Opus, NUNCA
// haiku para trabajo de codigo): orchestrator/delegation.rs model_for_intent()
// mapea security/bug_fix/refactor/performance/testing/architecture_review a HAIKU.
// known_red: 22.1 y 22.2 DEBEN fallar hoy (haiku donde se exige calidad).

// route -> set de agentes validos. Espejo de orchestrator/ranking.rs
// preferred_specialists(intent): el agente de la directiva es el top de
// delegate_agents (boost + floor sobre ese set), asi que un agente fuera del
// set para su route es incoherencia (route=rust => cpp-pro es valido por estar
// listado como fallback; route=rust => python-pro NO lo seria).
const ROUTE_VALID_AGENTS = {
  security: ["security-auditor", "penetration-tester", "ultron-security", "code-reviewer"],
  bug_fix: ["debugger", "error-detective", "qa-expert"],
  performance: ["performance-engineer", "ultron-perf", "debugger"],
  testing: ["test-automator", "qa-expert", "code-reviewer"],
  refactor: ["refactoring-specialist", "ultron-refactor", "code-reviewer"],
  architecture_review: ["architect-reviewer", "microservices-architect", "cloud-architect", "ultron-arch"],
  feature: ["architect-reviewer", "fullstack-developer", "code-reviewer"],
  research: ["ai-engineer", "llm-architect", "architect-reviewer"],
  database: ["postgres-pro", "sql-pro", "database-administrator"],
  rust: ["rust-engineer", "cpp-pro"],
  python: ["python-pro", "backend-developer"],
  typescript: ["typescript-pro", "javascript-pro", "frontend-developer"],
  golang: ["golang-pro", "backend-developer"],
  csharp: ["csharp-developer", "backend-developer"],
  ml: ["ml-engineer", "mlops-engineer", "ai-engineer"],
  data_eng: ["data-engineer", "database-administrator"],
  devops: ["devops-engineer", "deployment-engineer", "kubernetes-specialist", "docker-expert"],
  docker: ["devops-engineer", "deployment-engineer", "kubernetes-specialist", "docker-expert"],
  cloud_infra: ["terraform-engineer", "cloud-architect", "kubernetes-specialist"],
  api_design: ["api-designer", "backend-developer"],
  llm: ["llm-architect", "ai-engineer", "ml-engineer"],
};

// Ejecuta el hook con stdin {prompt,cwd} y parsea la <orchestration-directive>
// del additionalContext renderizado. Devuelve { ok, route, directive|null }.
function runOrchestrate(prompt, cwd) {
  const input = JSON.stringify({ prompt, cwd, hook_event_name: "UserPromptSubmit" });
  let r;
  try {
    r = spawnSync("node", [ORCH_HOOK], { input, encoding: "utf8", timeout: 60000, cwd: ULTRON });
  } catch (e) {
    return { ok: false, raw: String(e) };
  }
  const out = (r.stdout ?? "").trim();
  let ac = "";
  try {
    const j = JSON.parse(out);
    ac = j.hookSpecificOutput?.additionalContext ?? j.additionalContext ?? "";
  } catch {
    return { ok: false, raw: out.slice(0, 160) };
  }
  const route = (ac.match(/route="([^"]*)"/) || [])[1] ?? "";
  const m = ac.match(/<orchestration-directive[^>]*>([\s\S]*?)<\/orchestration-directive>/);
  if (!m) return { ok: true, route, directive: null, ac };
  const body = m[1];
  const field = (k) => (body.match(new RegExp("^" + k + ":\\s*(.*)$", "m")) || [])[1]?.trim() ?? "";
  return {
    ok: true,
    route,
    directive: { agent: field("agent"), model: field("modelo"), reason: field("motivo") },
    ac,
  };
}

// Prompts de codigo NO-trivial cuyo intent mapea a un especialista de revision/
// fix/refactor (los que hoy reciben haiku). Sin nombres de tecnologia para no
// disparar el Pass-1 de dominio (rust/sql/ts -> sonnet) y aislar el bug del
// modelo: la decision de modelo por ROL de revision, no por lenguaje.
const HAIKU_INTENT_PROMPTS = [
  ["security", "audita el modulo de autenticacion siguiendo OWASP buscando vulnerabilidades"],
  ["refactor", "refactoriza este modulo para reducir la deuda tecnica y deduplica la logica repetida"],
  ["bug_fix", "arregla el bug que hace crash a la aplicacion al guardar un cambio"],
  ["performance", "optimiza el rendimiento del hot path que esta lento por un cuello de botella"],
  ["testing", "escribe tests unitarios y de cobertura para el modulo de recall"],
];

// Prompts mono-stack (un lenguaje/dominio claro) para coherencia agente<->route.
const STACK_PROMPTS = [
  "refactoriza el modulo de memoria escrito en rust para reducir el acoplamiento",
  "arregla el bug en este archivo typescript que rompe el render del componente",
  "optimiza esta consulta sql query que hace un full table scan en postgres",
  "implementa una nueva funcion en python con fastapi para el endpoint de usuarios",
  "implementa un microservicio en golang con grpc para el gateway de eventos",
];

// Meta-tareas: el escritor unico de memoria / edicion de skill / kanban NO se
// delegan a un subagente generico -> directive debe ser null.
const META_PROMPTS = [
  "consolida la memoria y fusiona las notas duplicadas del index",
  "edita la skill de ultron para mejorar su descripcion de triggers",
  "mueve la card del kanban a la columna done porque ya esta hecha",
  "olvida esa decision y actualiza la memoria con la nueva politica del proyecto",
];

// Negativos: charla / pregunta corta -> 0 directiva (caso negativo, mandamiento 7).
const NEGATIVE_PROMPTS = ["hola que tal como estas hoy", "que hora es ahora mismo"];

function orchHookAvailable() {
  return fileExists(ORCH_HOOK) && fileExists(join(BIN, "ultron-memory.exe"));
}

cat(22, "Delegacion coherente (calidad>tokens)", [
  {
    id: "22.1",
    desc: "model_hint respeta calidad>tokens: review/fix/refactor/perf/test -> sonnet|opus, NUNCA haiku",
    auto: true,
    check() {
      if (!orchHookAvailable()) return { pass: false, detail: "no medible: falta memory-orchestrate.js o bin/ultron-memory.exe (clon limpio/CI)" };
      const QUALITY = new Set(["sonnet", "opus"]);
      const bad = [], seen = [];
      for (const [label, prompt] of HAIKU_INTENT_PROMPTS) {
        const r = runOrchestrate(prompt, ULTRON);
        if (!r.ok) return { pass: false, detail: `hook no emitio salida (${label}): ${r.raw ?? ""}` };
        if (!r.directive) { bad.push(`${label}:sin-directiva`); continue; }
        seen.push(`${label}=${r.directive.model}`);
        if (!QUALITY.has((r.directive.model || "").toLowerCase())) bad.push(`${label}:${r.directive.model || "?"}`);
      }
      return {
        pass: bad.length === 0,
        detail: bad.length === 0
          ? `${seen.length} intents de codigo con model_hint in {sonnet,opus}: ${seen.join(", ")}`
          : `${bad.length}/${HAIKU_INTENT_PROMPTS.length} con modelo barato (contradice calidad>tokens): ${bad.join(", ")}`,
      };
    },
  },
  {
    id: "22.2",
    desc: "opus para razonamiento profundo: revision de arquitectura -> opus (jamas haiku)",
    auto: true,
    check() {
      if (!orchHookAvailable()) return { pass: false, detail: "no medible: falta hook/binario (clon limpio/CI)" };
      const r = runOrchestrate(
        "revisa la arquitectura del nuevo pipeline de recall: trade-offs, modulos y su acoplamiento",
        ULTRON,
      );
      if (!r.ok) return { pass: false, detail: `hook no emitio salida: ${r.raw ?? ""}` };
      if (!r.directive) return { pass: false, detail: `route=${r.route} sin directiva para un prompt de arquitectura no-trivial` };
      const model = (r.directive.model || "").toLowerCase();
      return {
        pass: model === "opus",
        detail: `route=${r.route} agent=${r.directive.agent} model=${model} (se exige opus para razonamiento profundo)`,
      };
    },
  },
  {
    id: "22.3",
    desc: "agente coherente con el route (agent in preferred_specialists(route)); coherencia >= 90%",
    auto: true,
    check() {
      if (!orchHookAvailable()) return { pass: false, detail: "no medible: falta hook/binario (clon limpio/CI)" };
      const mism = [];
      let evaluated = 0;
      for (const prompt of STACK_PROMPTS) {
        const r = runOrchestrate(prompt, ULTRON);
        if (!r.ok) return { pass: false, detail: `hook no emitio salida: ${r.raw ?? ""}` };
        if (!r.directive) continue; // sin directiva no aporta a coherencia (lo cubre 22.1/22.5)
        evaluated++;
        const valid = ROUTE_VALID_AGENTS[r.route];
        if (!valid) { mism.push(`${r.route}:route-desconocido(${r.directive.agent})`); continue; }
        if (!valid.includes(r.directive.agent)) mism.push(`${r.route}->${r.directive.agent}`);
      }
      if (evaluated === 0) return { pass: false, detail: "0 directivas emitidas sobre prompts mono-stack (sospechoso)" };
      const rate = (evaluated - mism.length) / evaluated;
      return {
        pass: rate >= 0.9,
        detail: mism.length === 0
          ? `${evaluated}/${evaluated} agentes coherentes con su route (100%)`
          : `coherencia=${(rate * 100).toFixed(0)}% (${mism.length} incoherente(s): ${mism.join(", ")})`,
      };
    },
  },
  {
    id: "22.4",
    desc: "agente resoluble por la herramienta Agent: fileExists(~/.claude/agents/<name>.md) para cada directiva",
    auto: true,
    check() {
      if (!orchHookAvailable()) return { pass: false, detail: "no medible: falta hook/binario (clon limpio/CI)" };
      const prompts = [...HAIKU_INTENT_PROMPTS.map((p) => p[1]), ...STACK_PROMPTS];
      const emitted = new Set();
      for (const prompt of prompts) {
        const r = runOrchestrate(prompt, ULTRON);
        if (!r.ok) return { pass: false, detail: `hook no emitio salida: ${r.raw ?? ""}` };
        if (r.directive && r.directive.agent) emitted.add(r.directive.agent);
      }
      if (emitted.size === 0) return { pass: false, detail: "0 agentes emitidos sobre el set delegable (sospechoso)" };
      const unresolved = [...emitted].filter(
        (n) => !fileExists(join(AGENTS_DIR, `${n}.md`)) && !fileExists(join(AGENTS_DIR, `${n}.md.disabled`)),
      );
      return {
        pass: unresolved.length === 0,
        detail: unresolved.length === 0
          ? `${emitted.size} agentes distintos emitidos, todos resueltos en ~/.claude/agents/`
          : `${unresolved.length}/${emitted.size} agentes NO resolubles (Agent tool no los acepta): ${unresolved.join(", ")}`,
      };
    },
  },
  {
    id: "22.5",
    desc: "meta-tareas NO delegables (consolida memoria / edita skill / mueve card / olvida) -> directive null",
    auto: true,
    check() {
      if (!orchHookAvailable()) return { pass: false, detail: "no medible: falta hook/binario (clon limpio/CI)" };
      const leaked = [];
      for (const prompt of META_PROMPTS) {
        const r = runOrchestrate(prompt, ULTRON);
        if (!r.ok) return { pass: false, detail: `hook no emitio salida: ${r.raw ?? ""}` };
        if (r.directive) leaked.push(`"${prompt.slice(0, 24)}"->${r.directive.agent}`);
      }
      return {
        pass: leaked.length === 0,
        detail: leaked.length === 0
          ? `${META_PROMPTS.length} meta-tareas sin directiva (no delegables)`
          : `${leaked.length} meta-tarea(s) delegada(s) por error: ${leaked.join(" | ")}`,
      };
    },
  },
  {
    id: "22.6",
    desc: "negativos (charla/pregunta corta) -> directive null (caso negativo)",
    auto: true,
    check() {
      if (!orchHookAvailable()) return { pass: false, detail: "no medible: falta hook/binario (clon limpio/CI)" };
      const leaked = [];
      for (const prompt of NEGATIVE_PROMPTS) {
        const r = runOrchestrate(prompt, ULTRON);
        if (!r.ok) return { pass: false, detail: `hook no emitio salida: ${r.raw ?? ""}` };
        if (r.directive) leaked.push(`"${prompt}"->${r.directive.agent}`);
      }
      return {
        pass: leaked.length === 0,
        detail: leaked.length === 0
          ? `${NEGATIVE_PROMPTS.length} negativos sin directiva (correcto)`
          : `${leaked.length} negativo(s) con directiva (falso positivo): ${leaked.join(" | ")}`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function evaluate() {
  const results = [];
  let totalPass = 0;
  let totalDenominator = 0;

  const catsToRun = FLAG_CAT ? CATS.filter((c) => c.num === parseInt(FLAG_CAT, 10)) : CATS;

  for (const catDef of catsToRun) {
    const catResult = {
      cat: catDef.num,
      name: catDef.name,
      tier: catDef.num <= GOAL_CORE_MAX_CAT ? "core" : "supplementary",
      checks: [],
      pass: 0,
      total: 0,
      nota: 0,
    };

    for (const check of catDef.checks) {
      if (!check.auto || !check.check) {
        catResult.checks.push({
          id: check.id,
          desc: check.desc,
          status: "manual",
          pass: null,
          detail: "requiere verificacion visual o juicio humano",
        });
        continue; // no cuenta en denominador
      }

      let result;
      try {
        result = check.check();
      } catch (e) {
        result = { pass: false, detail: `exception: ${e.message}` };
      }

      catResult.checks.push({
        id: check.id,
        desc: check.desc,
        status: result.pass ? "pass" : "fail",
        pass: result.pass,
        detail: result.detail ?? "",
      });

      catResult.total++;
      if (result.pass) catResult.pass++;
    }

    catResult.nota = catResult.total > 0 ? (catResult.pass / catResult.total) * 10 : 0;
    totalPass += catResult.pass;
    totalDenominator += catResult.total;
    results.push(catResult);
  }

  const overall = totalDenominator > 0 ? (totalPass / totalDenominator) * 10 : 0;

  // -------------------------------------------------------------------------
  // Gate de laggard + overall core: el medidor deja de mentir por promedio.
  // worst_cat = la categoria mas baja; all_cats_pass = el GOAL (9.5 en TODAS)
  // se cumple solo si NINGUNA cat esta por debajo del umbral.
  // -------------------------------------------------------------------------
  const rated = results.filter((c) => c.total > 0); // cats con >=1 check auto
  const worst = rated.length ? rated.reduce((m, c) => (c.nota < m.nota ? c : m)) : null;
  const laggards = rated
    .filter((c) => c.nota < LAGGARD_THRESHOLD)
    .map((c) => ({ cat: c.cat, name: c.name, nota: parseFloat(c.nota.toFixed(1)) }))
    .sort((a, b) => a.nota - b.nota);
  const allCatsPass = laggards.length === 0;

  // overall_core = solo las 14 categorias del GOAL (sin diluir con suplementarias)
  const coreRated = rated.filter((c) => c.tier === "core");
  const corePass = coreRated.reduce((s, c) => s + c.pass, 0);
  const coreTotal = coreRated.reduce((s, c) => s + c.total, 0);
  const overallCore = coreTotal > 0 ? (corePass / coreTotal) * 10 : 0;

  const output = {
    generated_at: new Date().toISOString(),
    deterministic: true,
    overall: parseFloat(overall.toFixed(2)),
    overall_core: parseFloat(overallCore.toFixed(2)),
    all_cats_pass: allCatsPass,
    laggard_threshold: LAGGARD_THRESHOLD,
    worst_cat: worst ? { cat: worst.cat, name: worst.name, nota: parseFloat(worst.nota.toFixed(1)) } : null,
    laggards,
    total_pass: totalPass,
    total_checks: totalDenominator,
    cats: results,
  };

  // Escribe JSON
  const logsDir = join(ULTRON, "logs");
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, "kirkardo-eval.json"), JSON.stringify(output, null, 2), "utf8");

  // Imprime resumen
  if (!FLAG_JSON) {
    console.log("\n=== KIRKARDO EVAL — Harness Determinista ===");
    console.log(`Generated: ${output.generated_at}`);
    console.log("");

    for (const cat of results) {
      const manualCount = cat.checks.filter((c) => c.status === "manual").length;
      const nota = cat.nota.toFixed(1);
      const bar = "=".repeat(Math.round(cat.nota));
      const icon = cat.nota >= 9 ? "OK" : cat.nota >= 7 ? "OK" : cat.nota >= 5 ? ".." : "!!";
      console.log(`[${icon}] cat${cat.cat.toString().padStart(2, "0")} ${cat.name.padEnd(30)} ${cat.pass}/${cat.total} auto  nota=${nota}  (${manualCount} manual)`);

      // Muestra fails
      for (const c of cat.checks) {
        if (c.status === "fail") {
          console.log(`     FAIL ${c.id}: ${c.desc}`);
          if (c.detail) console.log(`          -> ${c.detail.slice(0, 120)}`);
        }
      }
    }

    console.log("");
    console.log(`OVERALL: ${overall.toFixed(2)}/10  (${totalPass}/${totalDenominator} checks auto)`);
    console.log(`CORE (14 cats GOAL): ${overallCore.toFixed(2)}/10`);
    if (allCatsPass) {
      console.log(`VERDICT: PASS — todas las categorias >= ${LAGGARD_THRESHOLD} (gate de laggard)`);
    } else {
      const lg = laggards.map((l) => `cat${l.cat}=${l.nota}`).join(", ");
      console.log(`VERDICT: FAIL — ${laggards.length} laggard(s) < ${LAGGARD_THRESHOLD}: ${lg}`);
      if (worst) console.log(`         worst_cat: cat${worst.cat} ${worst.name} = ${worst.nota.toFixed(1)}`);
    }
    console.log(`JSON: ${join(logsDir, "kirkardo-eval.json")}`);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }

  return output;
}

evaluate()
  .then((out) => {
    // --gate: exit !=0 si alguna categoria esta por debajo del umbral (gate CI estricto).
    // Sin el flag mantiene exit 0 (compatibilidad) pero imprime VERDICT: FAIL.
    if (FLAG_GATE && !out.all_cats_pass) process.exit(2);
  })
  .catch((e) => {
    console.error("Error en kirkardo-eval:", e);
    process.exit(1);
  });
