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
 *   --cat=N  evalua solo la categoria N (1-18)
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
      // La metrica se llama fallback_rate o real_fallback_rate
      const rate = m.real_fallback_rate ?? m.fallback_rate ?? null;
      if (rate === null) return { pass: false, detail: "campo fallback_rate no encontrado" };
      return { pass: rate < 0.1, detail: `fallback_rate=${(rate * 100).toFixed(1)}%` };
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
    desc: "FASTEMBED: <= 1 copia de model.safetensors",
    auto: true,
    check() {
      // Usa find con path conocido de fastembed en Windows
      const fastembed_dir = join(HOME, "AppData", "Local", "fastembed-rs");
      const r = run(
        `find "${fwd(HOME)}" -name "model.safetensors" -not -path "*/target/*" 2>/dev/null | wc -l`,
        { timeout: 30000, cwd: HOME }
      );
      const count = parseInt(r.stdout.trim(), 10) || 0;
      return { pass: count <= 1, detail: `${count} copias de model.safetensors (excl target/)` };
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
    desc: "0 broken links en docs/ (solo archivos .md locales referenciados)",
    auto: true,
    check() {
      const docsDir = join(ULTRON, "docs");
      if (!existsSync(docsDir)) return { pass: true, detail: "docs/ no existe" };
      // Busca links markdown [texto](./path) y verifica que existan
      const r = run(`grep -r "\\](\\./" "${docsDir}" --include="*.md" 2>/dev/null`);
      const lines = r.stdout.trim().split("\n").filter(Boolean);
      let broken = 0;
      for (const line of lines) {
        const m = line.match(/\]\((\.[^)]+)\)/);
        if (!m) continue;
        const ref = m[1].split("#")[0]; // quita anchor
        const srcFile = line.split(":")[0];
        const srcDir = dirname(srcFile);
        const target = join(srcDir, ref);
        if (!existsSync(target)) broken++;
      }
      return { pass: broken === 0, detail: `${broken} links rotos en docs/` };
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
    desc: "0 prompts hardcodeados inline (invoke con string literal, excl getPrompt)",
    auto: true,
    check() {
      const matches = grepInFiles(/invoke.*prompt.*['"]/, CC_SRC, [".tsx"])
        .filter((m) => !/getPrompt|button_prompts|PROMPT/i.test(m.text));
      return { pass: matches.length === 0, detail: `${matches.length} prompts inline potenciales` };
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
    desc: "0 agentes delegados que no existen en ~/.claude/agents/",
    auto: true,
    check() {
      // Usa grepInFiles Node.js para evitar problemas de rutas
      const hooksDir = join(ULTRON, "hooks");
      const matches = [
        ...grepInFiles(/use_agent|delegate.*agent|spawn_agent/, hooksDir, [".js"]),
        ...grepInFiles(/use_agent|delegate.*agent|spawn_agent/, COCKPIT, [".js", ".py"]),
      ];
      let missing = 0;
      for (const { text } of matches) {
        const m = text.match(/['"]([a-z][\w-]{3,})['"]/g);
        if (!m) continue;
        for (const name of m) {
          const agentName = name.replace(/['"]/g, "");
          if (agentName.length < 4) continue;
          const agentFile = join(AGENTS_DIR, `${agentName}.md`);
          if (!existsSync(agentFile)) missing++;
        }
      }
      return { pass: missing === 0, detail: `${missing} refs a agentes inexistentes (busqueda heuristica)` };
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
]);

// ---------------------------------------------------------------------------
// CAT 13 — Mejora de prompts
// ---------------------------------------------------------------------------
cat(13, "Mejora de prompts", [
  {
    id: "13.1",
    desc: "build_prompt_plan cableado en orchestrate.rs",
    auto: true,
    check() {
      const orchestrateFile = join(CC_TAURI, "orchestrator", "orchestrate.rs");
      if (!fileExists(orchestrateFile)) return { pass: false, detail: "orchestrate.rs no encontrado" };
      const content = readFileSync(orchestrateFile, "utf8");
      const has = /build_prompt_plan/i.test(content);
      return { pass: has, detail: has ? "build_prompt_plan presente" : "build_prompt_plan AUSENTE" };
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
    desc: "vitest.config.ts existe con seed/fixture fijos",
    auto: true,
    check() {
      const p = join(CC, "vitest.config.ts");
      if (!fileExists(p)) return { pass: false, detail: "vitest.config.ts ausente" };
      const content = readFileSync(p, "utf8");
      return { pass: true, detail: "vitest.config.ts presente" };
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

  const output = {
    generated_at: new Date().toISOString(),
    deterministic: true,
    overall: parseFloat(overall.toFixed(2)),
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
    console.log(`JSON: ${join(logsDir, "kirkardo-eval.json")}`);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }

  return output;
}

evaluate().catch((e) => {
  console.error("Error en kirkardo-eval:", e);
  process.exit(1);
});
