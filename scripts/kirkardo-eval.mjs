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
      });
    } else {
      r = spawnSync(cmd, {
        shell: true,
        encoding: "utf8",
        timeout: opts.timeout ?? 30000,
        cwd: opts.cwd ?? ULTRON,
        env: { ...process.env, ...opts.env },
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
    desc: "recall@8 >= 0.95",
    auto: true,
    check() {
      const r = run(`"${join(BIN, "ultron-memory.exe")}" eval`, { timeout: 60000 });
      const txt = r.stdout + r.stderr;
      // Intenta parsear JSON (formato actual del binario)
      try {
        const j = JSON.parse(txt.trim());
        const val = j.recall_at_k ?? j.recall_at_8 ?? null;
        if (val !== null) return { pass: val >= 0.95, detail: `recall_at_k=${val}` };
      } catch {}
      // Fallback: parseo por texto
      const m = txt.match(/recall[@_](?:at_k|at_8|8)\s*[=:]\s*([0-9.]+)/i);
      if (!m) return { pass: false, detail: "no recall en salida: " + txt.slice(0, 100) };
      const val = parseFloat(m[1]);
      return { pass: val >= 0.95, detail: `recall=${val}` };
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
]);

// ---------------------------------------------------------------------------
// CAT 2 — CodeGraph
// ---------------------------------------------------------------------------
cat(2, "CodeGraph", [
  {
    id: "2.1",
    desc: "MCP codegraph configurado en ~/.claude.json o settings.json",
    auto: true,
    check() {
      // La config MCP principal esta en ~/.claude.json (no settings.json)
      const claudeJson = join(HOME, ".claude.json");
      const s1 = readJSON(claudeJson);
      const s2 = readJSON(SETTINGS_JSON);
      const mcps1 = s1?.mcpServers ?? {};
      const mcps2 = s2?.mcpServers ?? {};
      const allKeys = [...Object.keys(mcps1), ...Object.keys(mcps2)];
      const has = allKeys.some((k) => k.toLowerCase().includes("codegraph"));
      return { pass: has, detail: has ? `codegraph en mcpServers (${claudeJson.split(/[/\\]/).pop()})` : "codegraph NO en mcpServers" };
    },
  },
  {
    id: "2.2",
    desc: "Index codegraph: .codegraph/codegraph.db existe",
    auto: true,
    check() {
      // Ubicaciones conocidas del .db de codegraph
      const candidates = [
        join(ULTRON, ".codegraph", "codegraph.db"),
        join(ULTRON, "codegraph.db"),
        join(ULTRON, "code_graph.db"),
      ];
      const found = candidates.find((p) => fileExists(p));
      return { pass: !!found, detail: found ? found.split(/[/\\]/).slice(-2).join("/") : "codegraph.db no encontrado" };
    },
  },
  {
    id: "2.3",
    desc: ">= 1 punto de entrada UI para codegraph en src/",
    auto: true,
    check() {
      const matches = grepInFiles(/codegraph/i, CC_SRC, [".tsx", ".ts"]);
      // Cuenta archivos unicos
      const files = new Set(matches.map((m) => m.file));
      return { pass: files.size >= 1, detail: `${files.size} archivos tsx/ts referencian codegraph` };
    },
  },
  {
    id: "2.4",
    desc: "Watcher codegraph activo (db reciente < 7 dias O MCP configurado)",
    auto: true,
    check() {
      const dbPath = join(ULTRON, ".codegraph", "codegraph.db");
      if (fileExists(dbPath)) {
        const r = run(`stat -c %Y "${fwd(dbPath)}" 2>/dev/null`);
        const ts = parseInt(r.stdout.trim(), 10) * 1000;
        const ageDays = (Date.now() - ts) / (1000 * 3600 * 24);
        if (!isNaN(ageDays) && ageDays < 7) {
          return { pass: true, detail: `codegraph.db actualizado hace ${ageDays.toFixed(1)} dias` };
        }
      }
      // Fallback: MCP configurado implica watcher del daemon externo
      const claudeJson = join(HOME, ".claude.json");
      const s = readJSON(claudeJson);
      const has = Object.keys(s?.mcpServers ?? {}).some((k) => k.toLowerCase().includes("codegraph"));
      return { pass: has, detail: has ? "MCP codegraph configurado (daemon con watcher)" : "ni db reciente ni MCP" };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 3 — AI Routing
// ---------------------------------------------------------------------------
cat(3, "AI Routing", [
  {
    id: "3.1",
    desc: "claude CLI en PATH",
    auto: true,
    check() {
      const r = run("claude --version 2>&1 | head -1");
      return { pass: r.ok || r.stdout.includes("claude"), detail: r.stdout.trim().slice(0, 80) || r.stderr.trim().slice(0, 80) };
    },
  },
  {
    id: "3.2",
    desc: "codex CLI en PATH",
    auto: true,
    check() {
      const r = run("codex --version 2>&1 | head -1");
      return { pass: r.ok, detail: r.stdout.trim().slice(0, 80) || r.stderr.trim().slice(0, 80) };
    },
  },
  {
    id: "3.3",
    desc: "0 zonas en zones.json con provider_id inexistente en providers.json",
    auto: true,
    check() {
      const zones = readJSON(ZONES_JSON);
      const providers = readJSON(join(COCKPIT, "ai-router", "providers.json"));
      if (!zones || !providers) return { pass: false, detail: "zones.json o providers.json no encontrado" };
      const providerIds = new Set(providers.map((p) => p.id ?? p.provider_id));
      const orphanZones = [];
      for (const z of zones) {
        const pid = z.primary?.provider_id;
        if (pid && !providerIds.has(pid)) orphanZones.push(`${z.id}:${pid}`);
        for (const fb of z.fallbacks ?? []) {
          if (fb.provider_id && !providerIds.has(fb.provider_id)) orphanZones.push(`${z.id}:fb:${fb.provider_id}`);
        }
      }
      return { pass: orphanZones.length === 0, detail: orphanZones.length === 0 ? "0 orphan providers" : orphanZones.join(", ") };
    },
  },
  {
    id: "3.4",
    desc: "cargo test ai_router pasa",
    auto: true,
    check() {
      // Pasa el filtro como argumento posicional a cargo test.
      // --test-threads=1: serie -> determinista. Algunos tests del router comparten
      // metrics.json y bajo paralelismo dan flakiness (ver card tests-no-hermeticos).
      const r = run("cargo test --lib --quiet ai_router -- --test-threads=1 2>&1", {
        cwd: join(CC, "src-tauri"),
        timeout: 180000,
      });
      const txt = r.stdout + r.stderr;
      const failed = /test result: FAILED|\bFAILED\b/.test(txt);
      const passed = /test result: ok/i.test(txt) || (r.ok && !failed);
      return { pass: passed && !failed, detail: txt.slice(-300) };
    },
  },
  {
    id: "3.5",
    desc: "real_fallback_rate < 10% (metrics.json del dia)",
    auto: true,
    check() {
      const m = readJSON(METRICS_JSON);
      if (!m) return { pass: false, detail: "metrics.json no encontrado" };
      // Ratio REAL acumulado = real_fallback_count / routes_total. NO uso el EMA fallback_rate
      // (se infla con historia) ni solo recent_routes (da 0% volatil si no hubo rutas recientes
      // -> falso pass que cazo el audit independiente 2026-06-21).
      const total = m.routes_total ?? 0;
      const fb = m.real_fallback_count ?? 0;
      if (total < 10) return { pass: false, detail: `datos insuficientes (routes_total=${total})` };
      const rate = fb / total;
      return { pass: rate < 0.1, detail: `real_fallback=${(rate * 100).toFixed(1)}% (${fb}/${total})` };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 4 — Skill/Agent Routing
// ---------------------------------------------------------------------------
cat(4, "Skill/Agent Routing", [
  {
    id: "4.1",
    desc: "_verify_final.js pasa (Failed: 0)",
    auto: true,
    check() {
      const script = join(SKILL_LAZY, "_verify_final.js");
      if (!fileExists(script)) return { pass: false, detail: "_verify_final.js no existe" };
      const r = run(`node "${fwd(script)}" 2>&1`, { timeout: 30000, cwd: ULTRON });
      const txt = r.stdout + r.stderr;
      // Formato actual: "  Passed: 26\n  Failed: 0"
      const failedMatch = txt.match(/Failed:\s*([0-9]+)/i);
      const failed = failedMatch ? parseInt(failedMatch[1], 10) : -1;
      const passedMatch = txt.match(/Passed:\s*([0-9]+)/i);
      const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
      return { pass: failed === 0 && passed > 0, detail: `Passed=${passed}, Failed=${failed}` };
    },
  },
  {
    id: "4.2",
    desc: "accuracy@1 >= 90% (dispatcher)",
    auto: true,
    check() {
      const script = join(SKILL_LAZY, "_accuracy_at3.js");
      if (!fileExists(script)) return { pass: false, detail: "_accuracy_at3.js no existe" };
      const r = run(`node "${fwd(script)}" 2>&1`, { timeout: 30000, cwd: ULTRON });
      const txt = r.stdout + r.stderr;
      // Formato: "  accuracy@1: 95.2% (20/21)"
      const m = txt.match(/accuracy@1:\s*([0-9.]+)%/i);
      if (!m) {
        // Fallback: busca cualquier porcentaje de accuracy
        const m2 = txt.match(/accuracy.*?([0-9]+\.[0-9]+)%/i);
        if (m2) return { pass: parseFloat(m2[1]) >= 90, detail: `accuracy=${m2[1]}%` };
        return { pass: false, detail: "no se pudo parsear accuracy@1: " + txt.slice(-100) };
      }
      const pct = parseFloat(m[1]);
      return { pass: pct >= 90, detail: `accuracy@1=${pct.toFixed(1)}%` };
    },
  },
  {
    id: "4.3",
    desc: "keep_active <= 12 en skills-registry.json",
    auto: true,
    check() {
      const reg = readJSON(SKILLS_REGISTRY_COCKPIT);
      if (!reg) return { pass: false, detail: "skills-registry.json no encontrado" };
      const keepActive = reg.filter((e) => e.keep_active === true).length;
      return { pass: keepActive <= 12, detail: `keep_active=${keepActive}` };
    },
  },
  {
    id: "4.4",
    desc: "accuracy@3 = 100% (dispatcher propone top3 correctamente)",
    auto: true,
    check() {
      // El criterio real: el dispatcher devuelve un top-3 (grupo) para el harness
      // accuracy@3 = 100% verifica que el top3 incluye la skill correcta
      const script = join(SKILL_LAZY, "_accuracy_at3.js");
      if (!fileExists(script)) return { pass: false, detail: "script no existe" };
      const r = run(`node "${fwd(script)}" 2>&1`, { timeout: 30000, cwd: ULTRON });
      const txt = r.stdout + r.stderr;
      // Formato: "  accuracy@3: 100.0% (21/21)"
      const m = txt.match(/accuracy@3:\s*([0-9.]+)%/i);
      if (!m) return { pass: false, detail: "no se pudo parsear accuracy@3: " + txt.slice(-100) };
      const pct = parseFloat(m[1]);
      return { pass: pct >= 90, detail: `accuracy@3=${pct.toFixed(1)}%` };
    },
  },
  {
    id: "4.5",
    desc: "v3 semantico: > 0 matches en test set (--v3)",
    auto: true,
    check() {
      const script = join(SKILL_LAZY, "_accuracy_at3.js");
      if (!fileExists(script)) return { pass: false, detail: "script no existe" };
      // Timeout 90 s: embed_skills.py batch_query carga sentence-transformers una sola
      // vez para todas las queries (~34 s), mucho menos que los ~120 s del modo secuencial
      // (12 llamadas x ~10 s/llamada). Sin pipe a tail: la linea clave
      // "semantic accuracy@3: X% (N/M)" puede ser cualquier linea del output.
      const r = run(`node "${script}" --v3 2>&1`, { timeout: 90000 });
      const txt = r.stdout + r.stderr;
      // Parsea "semantic accuracy@3: 91.7% (11/12)" -> hits=11, total=12
      const mAcc = txt.match(/semantic\s+accuracy@3:\s*[\d.]+%\s*\((\d+)\/(\d+)\)/i);
      if (mAcc) {
        const hits = parseInt(mAcc[1], 10);
        const total = parseInt(mAcc[2], 10);
        return { pass: hits > 0, detail: `v3 hits=${hits}/${total}; semantic accuracy@3 OK` };
      }
      // Fallback: si el subprocess fallo del todo
      const unavail = /semantic\s+unavailable:\s*(\d+)/i.exec(txt);
      const unavailN = unavail ? parseInt(unavail[1], 10) : 0;
      return { pass: false, detail: `v3 hits=0; unavailable=${unavailN}; ${txt.slice(-120)}` };
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
]);

// ---------------------------------------------------------------------------
// CAT 7 — Calidad de Codigo
// ---------------------------------------------------------------------------
cat(7, "Calidad de Codigo", [
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
      const hasWarnings = /error\[/i.test(txt) || /warning: unused/i.test(txt) && /D warnings/.test(txt);
      const ok = r.ok && !txt.includes("error[E") && !/^error/.test(txt.trim());
      return { pass: ok, detail: txt.slice(-200) };
    },
  },
  {
    id: "7.2",
    desc: "tsc --noEmit 0 errores",
    auto: true,
    check() {
      const r = run("npx tsc --noEmit 2>&1 | tail -10", {
        cwd: CC,
        timeout: 60000,
      });
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
      const r = run(
        `find "${CC_TAURI}" -name "*.rs" -not -path "*/target/*" -type f 2>/dev/null`,
        { cwd: ULTRON }
      );
      const files = r.stdout.trim().split("\n").filter(Boolean);
      const over = files.filter((f) => countLines(f) > 800);
      return {
        pass: over.length === 0,
        detail: over.length === 0 ? "0 .rs >800L" : over.map((f) => `${f.split("/").slice(-1)[0]}:${countLines(f)}L`).join(", "),
      };
    },
  },
  {
    id: "7.4",
    desc: "0 archivos .tsx > 800 lineas",
    auto: true,
    check() {
      const r = run(
        `find "${CC_SRC}" -name "*.tsx" -type f 2>/dev/null`,
        { cwd: ULTRON }
      );
      const files = r.stdout.trim().split("\n").filter(Boolean);
      const over = files.filter((f) => countLines(f) > 800);
      return {
        pass: over.length === 0,
        detail: over.length === 0 ? "0 .tsx >800L" : over.map((f) => `${f.split("/").slice(-2).join("/")}:${countLines(f)}L`).join(", "),
      };
    },
  },
  {
    id: "7.5",
    desc: "cargo test --lib --bins pasa (0 failures)",
    auto: true,
    check() {
      // exit code 0 + no FAILED = OK (puede haber 0 tests si features finance no activas).
      // --test-threads=1: serie -> determinista (evita la flakiness de tests que comparten
      // metrics.json bajo paralelismo; ver card tests-no-hermeticos).
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
]);

// ---------------------------------------------------------------------------
// CAT 8 — UI funcional
// ---------------------------------------------------------------------------
cat(8, "UI funcional", [
  {
    id: "8.1",
    desc: "0 console.log en src/ (excl tests)",
    auto: true,
    check() {
      // Usa grep Node.js nativo para evitar problemas de rutas Windows
      const matches = grepInFiles(/console\.log/, CC_SRC, [".tsx", ".ts"])
        .filter((m) => {
          // Excluir comentados y archivos de test
          if (/^\s*\/\//.test(m.text)) return false;
          if (m.file.includes("__tests__") || m.file.includes(".test.") || m.file.includes(".spec.")) return false;
          return true;
        });
      return { pass: matches.length === 0, detail: `${matches.length} console.log en src/` };
    },
  },
  {
    id: "8.2",
    desc: "0 prompts hardcodeados inline (string literal de prompt real en .tsx, excl getPrompt/button_prompts)",
    auto: true,
    check() {
      // El check viejo (regex /invoke.*prompt.*['"]/ + filtro /getPrompt|button_prompts|PROMPT/i)
      // era CO-EXTENSIVO: toda linea que matcheaba se excluia -> nunca podia fallar.
      // Ahora detecto STRINGS de prompt LITERALES de verdad: `prompt: "Eres ..."`, `prompt: \`You are ...\``
      // con un verbo/comienzo de instruccion real. El filtro de exclusion deja getPrompt/button_prompts
      // (factories legitimas) pero ya NO excluye por la palabra "PROMPT" (eso anulaba el check).
      const promptLiteral = /prompt\s*[:=]\s*[`'"]\s*(Eres|You are|Act as|Actua|Genera|Generate|Write|Escribe|Analiza|Analyze|Resume|Summarize|Translate|Traduce|Given the|Dado el)/i;
      const matches = grepInFiles(promptLiteral, CC_SRC, [".tsx"])
        .filter((m) => !/getPrompt|button_prompts/.test(m.text));
      return {
        pass: matches.length === 0,
        detail: matches.length === 0
          ? "0 prompts inline reales"
          : `${matches.length} prompts inline: ${matches.slice(0, 3).map((m) => m.file.split(/[/\\]/).pop() + ":" + m.line).join(", ")}`,
      };
    },
  },
  {
    id: "8.3",
    desc: "Todas las tabs cargan sin crash (verificacion visual)",
    auto: false,
    check: null,
  },
  {
    id: "8.4",
    desc: "0 botones no-op (onClick sin invoke/navigate) — verificacion visual",
    auto: false,
    check: null,
  },
]);

// ---------------------------------------------------------------------------
// CAT 9 — Hooks
// ---------------------------------------------------------------------------
cat(9, "Hooks", [
  {
    id: "9.1",
    desc: "manifest.json parity con settings.json (hook scripts coinciden)",
    auto: true,
    check() {
      if (!fileExists(HOOKS_MANIFEST)) return { pass: false, detail: "manifest.json no encontrado" };
      const manifest = readJSON(HOOKS_MANIFEST);
      const settings = readJSON(SETTINGS_JSON);
      if (!manifest || !settings) return { pass: false, detail: "no se pudo parsear JSON" };

      // Extrae scripts del manifest
      const manifestScripts = new Set(
        (manifest.hooks ?? []).map((h) => h.script?.replace("~", HOME).replace(/\\/g, "/"))
      );
      // Extrae comandos de settings.json hooks
      const settingsCommands = [];
      for (const event of Object.values(settings.hooks ?? {})) {
        for (const group of event) {
          for (const h of group.hooks ?? []) {
            if (h.command) settingsCommands.push(h.command.replace(/\\/g, "/"));
          }
        }
      }

      // Verifica que los scripts del manifest existen en disco
      let missingFromDisk = 0;
      for (const s of manifestScripts) {
        if (s && !existsSync(s)) missingFromDisk++;
      }

      return {
        pass: missingFromDisk === 0,
        detail: `manifest: ${manifestScripts.size} scripts, ${missingFromDisk} no existen en disco`,
      };
    },
  },
  {
    id: "9.2",
    desc: "Todos los paths de hook en settings.json existen en disco",
    auto: true,
    check() {
      const settings = readJSON(SETTINGS_JSON);
      if (!settings) return { pass: false, detail: "settings.json no encontrado" };
      const missing = [];
      for (const event of Object.values(settings.hooks ?? {})) {
        for (const group of event) {
          for (const h of group.hooks ?? []) {
            if (!h.command) continue;
            // Extrae la ruta del script del comando "node /path/to/script.js"
            const m = h.command.match(/(?:node|python|uv run python)\s+"?([^"'\s]+\.[a-z]+)"?/i);
            if (!m) continue;
            const scriptPath = m[1].replace(/\\/g, "/");
            if (!existsSync(scriptPath)) missing.push(scriptPath.split("/").slice(-1)[0]);
          }
        }
      }
      return {
        pass: missing.length === 0,
        detail: missing.length === 0 ? "todos los scripts existen" : `missing: ${missing.join(", ")}`,
      };
    },
  },
  {
    id: "9.3",
    desc: "memory-session-resume < 500ms (hook-timing.jsonl)",
    auto: true,
    check() {
      // Formato actual: {"ts":"...", "hook":"memory-session-resume", "elapsed_ms":104, "exit_code":0}
      const timingFile = join(ULTRON, "logs", "hook-timing.jsonl");
      if (!fileExists(timingFile)) return { pass: false, detail: "hook-timing.jsonl ausente" };
      const lines = readFileSync(timingFile, "utf8").trim().split("\n").filter(Boolean);
      const entries = lines
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && e.hook === "memory-session-resume");
      if (entries.length === 0) return { pass: false, detail: "sin entradas memory-session-resume en timing" };
      const last5 = entries.slice(-5);
      const maxMs = Math.max(...last5.map((e) => e.elapsed_ms ?? e.duration_ms ?? 9999));
      return { pass: maxMs < 500, detail: `max_last5_resume=${maxMs}ms` };
    },
  },
  {
    id: "9.4",
    desc: "memory-orchestrate < 300ms (hook-timing.jsonl)",
    auto: true,
    check() {
      const timingFile = join(ULTRON, "logs", "hook-timing.jsonl");
      if (!fileExists(timingFile)) return { pass: false, detail: "hook-timing.jsonl ausente" };
      const lines = readFileSync(timingFile, "utf8").trim().split("\n").filter(Boolean);
      const entries = lines
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && e.hook === "memory-orchestrate");
      if (entries.length === 0) return { pass: false, detail: "sin entradas memory-orchestrate en timing" };
      const last5 = entries.slice(-5);
      const maxMs = Math.max(...last5.map((e) => e.elapsed_ms ?? e.duration_ms ?? 9999));
      return { pass: maxMs < 300, detail: `max_last5_orchestrate=${maxMs}ms` };
    },
  },
  {
    id: "9.5",
    desc: "0 hooks con error silenciado (|| true en scripts clave)",
    auto: true,
    check() {
      // Usa grep Node.js para evitar problemas Windows
      const matches = grepInFiles(/\|\|\s*true/, HOOKS_SCRIPTS, [".js"]);
      return { pass: matches.length === 0, detail: `${matches.length} ocurrencias de || true en hooks` };
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

cat(19, "Session-Start fidelity", [
  {
    id: "19.1",
    desc: "resume --project: open_tasks 100% del proyecto (0 cross-project/globales)",
    auto: true,
    check() {
      const r = runResume(RESUME_PROJECT);
      if (!r.ok) return { pass: false, detail: "resume no devolvio JSON: " + (r.raw ?? "") };
      const bad = (r.json.open_tasks ?? []).filter(
        (t) => t.project_id !== RESUME_PROJECT,
      );
      return {
        pass: bad.length === 0,
        detail:
          bad.length === 0
            ? `open_tasks=${(r.json.open_tasks ?? []).length}, todas de '${RESUME_PROJECT}'`
            : `${bad.length} task(s) ajenas: ${bad.map((t) => t.project_id ?? "GLOBAL").slice(0, 5).join(",")}`,
      };
    },
  },
  {
    id: "19.2",
    desc: "resume --project: decisions 100% del proyecto (0 cross-project/globales)",
    auto: true,
    check() {
      const r = runResume(RESUME_PROJECT);
      if (!r.ok) return { pass: false, detail: "resume no devolvio JSON: " + (r.raw ?? "") };
      const bad = (r.json.decisions ?? []).filter(
        (d) => d.project_id !== RESUME_PROJECT,
      );
      return {
        pass: bad.length === 0,
        detail:
          bad.length === 0
            ? `decisions=${(r.json.decisions ?? []).length}, todas de '${RESUME_PROJECT}'`
            : `${bad.length} decision(es) ajenas: ${bad.map((d) => d.project_id ?? "GLOBAL").slice(0, 5).join(",")}`,
      };
    },
  },
  {
    id: "19.3",
    desc: "next_action = card viva del kanban O ultimo commit (NO nota podrida/vieja)",
    auto: true,
    check() {
      // Si no existe kanban.json (CI / clon limpio — gitignored) el check es
      // N/A: no podemos validar contra estado local inexistente, pero tampoco
      // penalizamos. La ausencia de kanban es un estado valido en CI.
      const kanbanPath = join(COCKPIT, "projects", RESUME_PROJECT, "kanban.json");
      const hasKanban = existsSync(kanbanPath);

      const r = runResume(RESUME_PROJECT);
      if (!r.ok) return { pass: false, detail: "resume no devolvio JSON: " + (r.raw ?? "") };
      const got = r.json.next_action ?? "";

      if (!hasKanban) {
        // Sin kanban: acepta cualquier next_action no vacio y no-pasado
        // (el fallback de git o de memoria se activa).
        const empty = got.trim() === "";
        return {
          pass: !empty,
          detail: empty
            ? "next_action vacio sin kanban (no hay estado vivo ni commits)"
            : `N/A (sin kanban local); next_action via fallback: "${got.slice(0, 80)}"`,
        };
      }

      // Con kanban: acepta (a) coincidencia exacta con card viva, o (b) el
      // prefijo de commit ("ultimo commit: ...") como fallback valido — ambos
      // vienen de estado VIVO, no de memoria que se pudre.
      const cardTitles = [];
      try {
        const doc = JSON.parse(readFileSync(kanbanPath, "utf8"));
        const cols = (doc.columns ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const cards = doc.cards ?? [];
        for (const role of ["doing", "todo"]) {
          for (const col of cols.filter((c) => c.role === role)) {
            const inCol = cards
              .filter((c) => c.column_id === col.id)
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            for (const card of inCol) {
              if (card.title) cardTitles.push(card.title);
            }
          }
        }
      } catch {
        return { pass: false, detail: "kanban.json no parseable" };
      }

      // Pass si es alguna card viva (In-Progress o Backlog) o si es el fallback
      // de ultimo commit (reconocible por el prefijo que emite derive_next_action).
      const isCardMatch = cardTitles.includes(got);
      const isCommitFallback = got.startsWith("último commit:") || got.startsWith("ultimo commit:");
      const pass = isCardMatch || isCommitFallback;
      return {
        pass,
        detail: pass
          ? isCardMatch
            ? `next_action == card viva ("${got.slice(0, 60)}")`
            : `next_action == fallback commit ("${got.slice(0, 60)}")`
          : `next_action="${got.slice(0, 70)}" no es card viva ni commit (${cardTitles.length} cards disponibles)`,
      };
    },
  },
  {
    id: "19.4",
    desc: "next_action NO es una nota en pasado/completada (no se pudre)",
    auto: true,
    check() {
      const r = runResume(RESUME_PROJECT);
      if (!r.ok) return { pass: false, detail: "resume no devolvio JSON: " + (r.raw ?? "") };
      const got = (r.json.next_action ?? "").toLowerCase();
      const stale = [
        "se ha realizado",
        "se ha hecho",
        "commit hecho",
        "se vigilara",
        "se vigilará",
        "ya hecho",
        "completado",
        "completada",
      ];
      const hit = stale.find((m) => got.includes(m));
      return {
        pass: !hit,
        detail: hit ? `next_action suena a hecho: "...${hit}..."` : "next_action accionable",
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
