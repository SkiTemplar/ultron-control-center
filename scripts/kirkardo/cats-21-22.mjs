// kirkardo/cats-21-22.mjs — categorias 21 (estado vivo) y 22 (delegacion).
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import * as P from "./predicates.mjs";
import { AGENTS_DIR, BIN, HOOKS_SCRIPTS, ULTRON, ULTRON_MEM, cat, fileExists, fwd, run, spawnHook, spawnTracked } from "./core.mjs";
import { ORCH_HOOK, sql20 } from "./hook-io.mjs";

// ---------------------------------------------------------------------------
// CAT 21 — Estado vivo (codigo muerto: Stale / TTL / deprecation)
// ---------------------------------------------------------------------------
// Tres metricas estructuralmente VERDES que NO son salud (verde-vacuo); la
// cuarta (cierre-kanban por el Stop hook kanban-update-reminder) salio con el
// hook el 2026-10-08:
//   - Status::Stale: ningun path productivo lo escribe -> stats.stale==0 eterno.
//   - expires_at/TTL: siempre None y el recall NUNCA filtra por expires_at
//     (engine.rs governance gate: status/valid_to/project/source/sensitivity,
//     jamas expires_at) -> un item caducado sigue saliendo en recall.
//   - deprecation_entries: tabla vacia -> doctor.overdue=0 por vacuidad.
// Todos ejecutan un artefacto REAL (binario/brain.db) y aseveran sobre su
// output observable. Sin datos (clon limpio/CI sin brain.db/binario) -> pass:false con detail
// "no medible: <que falta>" (nunca pass por vacuidad).

// (2026-10-23) Las lecturas de brain.db van por node:sqlite en solo lectura
// (sql20); el `python -c` suelto de antes rompia la regla de uv y escribia en
// produccion (21.3). Sidecar para las sondas: el desplegado, o el que indique
// KIRKARDO_MEMORY_BIN (verificar un build sin desplegar; nunca en el gate).
const PROBE_MEM_BIN = process.env.KIRKARDO_MEMORY_BIN || ULTRON_MEM;

function sqliteScalar(query) {
  const q = sql20(query);
  if (!q.rows?.length) return null;
  const v = Number(Object.values(q.rows[0])[0]);
  return Number.isFinite(v) ? v : null;
}

// Fixture del TTL en una brain.db TEMPORAL creada por el propio sidecar: un item
// vigente (control positivo) y otro con expires_at en el pasado, en milisegundos
// como el resto del sistema (pack.rs compara contra now_millis).
function insertTtlFixture(dbPath, token, nowMs) {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const ins = db.prepare(
      "INSERT INTO memory_items (id, type, scope, title, summary, content, status, confidence, importance, " +
        "source, created_at, updated_at, expires_at, token_estimate, content_hash) " +
        "VALUES (?, 'fact', 'global', ?, ?, ?, 'active', 0.9, 0.9, 'direct', ?, ?, ?, 10, ?)",
    );
    const add = (id, title, expiresAt) =>
      ins.run(id, title, `${title} ${token} ${token} item de prueba del TTL`, token, nowMs, nowMs, expiresAt, `kprobe-${id}`);
    add("kirkardo-ttl-control", `${token}vigente`, null);
    add("kirkardo-ttl-expired", `${token}caducado`, nowMs - 86400000);
  } finally {
    db.close();
  }
}

cat(21, "Estado vivo (codigo muerto: Stale/TTL/deprecation)", [
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
      const distinct = (sql20("SELECT DISTINCT status AS s FROM memory_items ORDER BY status").rows ?? []).map((r) => r.s).join(",");
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
    desc: "TTL vivo e2e por el sidecar contra una brain.db TEMPORAL: el recall devuelve el item vigente (control positivo) y NO el que tiene expires_at en el pasado",
    auto: true,
    check() {
      // (2026-10-23, medidor-9 / memoria-7) Antes escribia un item activo en el
      // brain.db de PRODUCCION con `python -c` (saltandose MemoryService) y
      // pasaba con un recall vacio. Ahora: el sidecar crea y lee una base temporal
      // (ULTRON_BRAIN_DB; sin daemon), la fixture lleva un control positivo y el
      // brain.db de produccion no se toca nunca. Limite: ningun productor fija hoy
      // expires_at, asi que esto prueba el filtro, no que haya items con TTL.
      if (!existsSync(PROBE_MEM_BIN)) return { pass: false, detail: `no medible: falta ${PROBE_MEM_BIN}` };
      const dir = mkdtempSync(join(tmpdir(), "kirkardo-ttl-"));
      const db = join(dir, "brain.db");
      const env = { ...process.env, ULTRON_BRAIN_DB: db };
      // spawnTracked (P1): el 0xC0000142 del 23-10 no era "el sidecar no admite
      // ULTRON_BRAIN_DB" sino un proceso que no arranco.
      const mem = (args, timeout) => spawnTracked(PROBE_MEM_BIN, args, { env, encoding: "utf8", timeout, windowsHide: true, cwd: dir }, `ultron-memory ${args[0]}`);
      try {
        // El sidecar crea el esquema en la ruta pedida; si no la crea, el binario
        // desplegado no tiene la costura y el check NO sigue (no hay plan B contra
        // produccion).
        const st = mem(["stats"], 30000);
        if (st.infra) return { manual: true, detail: `no ejecutable (infraestructura): ultron-memory stats -> ${st.infra}` };
        if (!existsSync(db)) {
          return { pass: false, detail: `no medible: el sidecar no admite ULTRON_BRAIN_DB (exit=${st.status}); falta desplegar el binario con la costura (node scripts/redeploy-memory-sidecar.mjs)` };
        }
        const token = "Zxqvkirkttl";
        insertTtlFixture(db, token, Date.now());
        const r = mem(["recall", token], 60000);
        let entries;
        try { entries = JSON.parse(String(r.stdout ?? "").trim()).entries ?? []; }
        catch { return { pass: false, detail: `no medible: recall sin JSON (exit=${r.status}): ${String(r.stdout || r.stderr || "").slice(0, 120)}` }; }
        return P.ttlProbeVerdict(entries, { controlTitle: `${token}vigente`, expiredTitle: `${token}caducado` });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    id: "21.4",
    desc: "deprecation_deadlines NO-vacuo: deprecation_entries tiene >=1 fila (si 0 -> N/A explicito, NO verde) y 0 deadlines vencidos hace mas de 10 dias en entradas NO terminales (misma semantica que el doctor: un vencido reciente espera al GC semanal)",
    auto: true,
    check() {
      // Lectura en solo lectura (node:sqlite, sin python suelto). Las entradas en
      // estado terminal (deleted/restored/archived) ya se ejecutaron o se
      // revirtieron: su deadline pasado no es una limpieza pendiente. Contarlas
      // daba overdue=954 (838 archived + 112 deleted + 4 deprecated, 2026-10-23)
      // frente a los 4 del doctor (doctor.rs, check_deprecation_deadlines).
      const q = sql20(
        "SELECT state, COUNT(*) AS n, SUM(CASE WHEN deadline IS NOT NULL AND deadline <> '' AND deadline < strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 days') THEN 1 ELSE 0 END) AS overdue FROM deprecation_entries GROUP BY state",
      );
      if (!q.rows) {
        return { pass: false, detail: `no medible: ${q.err ?? "falta brain.db (clon limpio/CI)"}` };
      }
      const total = q.rows.reduce((a, r) => a + Number(r.n), 0);
      if (total === 0) {
        // Tabla vacia: doctor reporta overdue=0 por VACUIDAD, no por salud (nada se
        // deprecia con entrada de ledger). FAIL/N/A explicito, nunca pass por vacio.
        return {
          pass: false,
          detail: "N/A: deprecation_entries VACIA (0 filas) -> doctor.overdue=0 por vacuidad, no por salud; ningun path escribe el ledger de deprecacion",
        };
      }
      const TERMINAL = new Set(["deleted", "restored", "archived"]);
      const live = q.rows.filter((r) => !TERMINAL.has(r.state));
      const overdue = live.reduce((a, r) => a + Number(r.overdue ?? 0), 0);
      const terminalPast = q.rows.filter((r) => TERMINAL.has(r.state)).reduce((a, r) => a + Number(r.overdue ?? 0), 0);
      const byState = live.filter((r) => Number(r.overdue) > 0).map((r) => `${r.state}=${r.overdue}`).join(",");
      return {
        pass: overdue === 0,
        detail: `deprecation_entries=${total} filas, overdue=${overdue} en estados no terminales${byState ? ` (${byState})` : ""}; ${terminalPast} terminales con deadline pasado (no cuentan)`,
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
//
// (2026-10-23) Con el orchestrate en modo ligero (default desde el 2026-09-28)
// no hay directiva para ningun prompt: 22.1-22.4 daban rojo por "sin directiva" y
// 22.5/22.6 verde por vacuidad. Todos quedan retirados mientras siga el ligero;
// 22.7 mide el comportamiento que hay hoy. Con ULTRON_ORCHESTRATE=full vuelven.

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
// (2026-08-17) Reintenta si la salida viene del CACHE stale (daemon frio en el
// arranque de la corrida): el pack cacheado ya NO trae directiva (el hook la
// anula porque es de otro prompt), asi que medirlo puntuaba la ventana de
// warmup como fallo de delegacion (22.1/22.2/22.5 con detalles de otro prompt
// o "sin-directiva"). El primer intento ya spawnea el daemon; 5s despues la
// respuesta es del motor real. Max 3 intentos; si sigue cacheado se mide tal
// cual (un daemon que nunca arranca SI es un fallo real).
let _orchWarmed = false;
function warmOrchestrateOnce() {
  // Mismo patron que runGoldenEval con E5 (fidelidad bs60k6): el primer prompt
  // TECNICO de una corrida paga la carga del cross-encoder (~1 GB) y vence el
  // presupuesto del hook -> pack cacheado sin directiva. Eso mide la ventana de
  // warmup, no la calidad de delegacion. Un orchestrate de sacrificio (no
  // puntuado) calienta el CE; los checks miden el motor en regimen.
  if (_orchWarmed) return;
  _orchWarmed = true;
  const input = JSON.stringify({
    prompt: "warmup tecnico del harness: analiza el rendimiento del pipeline de recall hibrido",
    cwd: ULTRON,
    hook_event_name: "UserPromptSubmit",
  });
  // best-effort: un fallo del calentamiento lo vera el primer check que mida.
  spawnHook(ORCH_HOOK, input, { realBin: true, timeout: 60000 });
}

function runOrchestrate(prompt, cwd) {
  warmOrchestrateOnce();
  const input = JSON.stringify({ prompt, cwd, hook_event_name: "UserPromptSubmit" });
  let ac = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) execSync("node -e \"setTimeout(()=>{},5000)\"", { timeout: 20000 });
    // Sidecar real: en modo completo el hook cae al orchestrate --sparse si el
    // daemon no contesta (lectura de brain.db, como en una sesion real).
    const r = spawnHook(ORCH_HOOK, input, { realBin: true, timeout: 60000 });
    if (r.error) return { ok: false, raw: String(r.error) };
    const out = (r.stdout ?? "").trim();
    try {
      const j = JSON.parse(out);
      ac = j.hookSpecificOutput?.additionalContext ?? j.additionalContext ?? "";
    } catch {
      return { ok: false, raw: out.slice(0, 160) };
    }
    if (!ac.includes("context pack CACHEADO")) break;
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

// 2026-10-28 (P6): la cat 22 pasa a "Delegacion multimotor y relevo". Los
// checks 22.1-22.6 (directivas de memory-orchestrate) siguen retirados por
// orchestrate-light; 22.7 mide el modo ligero del hook y puntua en el area de
// hooks. Los checks nuevos viven en cats-22-delegacion.mjs.
cat(22, "Delegacion multimotor y relevo", [
  {
    id: "22.1",
    desc: "model_hint respeta calidad>tokens: review/fix/refactor/perf/test -> claude-sonnet-5-5|claude-opus-5-5, NUNCA haiku",
    auto: true,
    retiredBy: "orchestrate-light",
    check() {
      if (!orchHookAvailable()) return { pass: false, detail: "no medible: falta memory-orchestrate.js o bin/ultron-memory.exe (clon limpio/CI)" };
      const QUALITY = new Set(["claude-sonnet-5-5", "claude-opus-5-5"]);
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
          ? `${seen.length} intents de codigo con model_hint in {claude-sonnet-5-5,claude-opus-5-5}: ${seen.join(", ")}`
          : `${bad.length}/${HAIKU_INTENT_PROMPTS.length} con modelo barato (contradice calidad>tokens): ${bad.join(", ")}`,
      };
    },
  },
  {
    id: "22.2",
    desc: "opus para razonamiento profundo: revision de arquitectura -> claude-opus-5-5 (jamas haiku)",
    auto: true,
    retiredBy: "orchestrate-light",
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
        pass: model === "claude-opus-5-5",
        detail: `route=${r.route} agent=${r.directive.agent} model=${model} (se exige claude-opus-5-5 para razonamiento profundo)`,
      };
    },
  },
  {
    id: "22.3",
    desc: "agente coherente con el route (agent in preferred_specialists(route)); coherencia >= 90%",
    auto: true,
    retiredBy: "orchestrate-light",
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
    retiredBy: "orchestrate-light",
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
    retiredBy: "orchestrate-light",
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
    retiredBy: "orchestrate-light",
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
  {
    id: "22.7",
    desc: "modo ligero real: en el set delegable+meta+charla el hook no emite orchestration-context ni directiva, cada salida <= 2500 chars, y un tono pedido SI se inyecta (control positivo)",
    auto: true,
    onlyWhile: "orchestrate-light",
    area: "hooks", // mide el hook memory-orchestrate, no la delegacion multimotor
    check() {
      // Sustituye a 22.1-22.6 mientras el orchestrate vaya en ligero. Mide el
      // artefacto vivo: 0 delegacion fantasma y 0 recall por prompt, sin pasar por
      // vacuidad: el control positivo exige que un tono pedido llegue (si el hook
      // devolviera siempre vacio, falla). 2500 chars: la directiva de tono completa
      // mide ~1,8K y el modo completo llega a ~3K por prompt (medido 2026-10-23).
      if (!fileExists(ORCH_HOOK)) return { pass: false, detail: "no medible: falta memory-orchestrate.js" };
      const MAX = 2500;
      const prompts = [
        ...HAIKU_INTENT_PROMPTS.map((p) => p[1]),
        ...STACK_PROMPTS,
        ...META_PROMPTS,
        ...NEGATIVE_PROMPTS,
      ];
      const call = (prompt) => {
        // HOME aislado: estas 17 llamadas ya no copan hook-tokens.jsonl (16.5).
        const r = spawnHook(ORCH_HOOK, { prompt, cwd: ULTRON, hook_event_name: "UserPromptSubmit" }, { timeout: 60000 });
        try {
          const j = JSON.parse((r.stdout ?? "").trim());
          return j.hookSpecificOutput?.additionalContext ?? j.additionalContext ?? "";
        } catch {
          return null;
        }
      };
      const bad = [];
      let maxLen = 0;
      for (const p of prompts) {
        const ac = call(p);
        if (ac === null) return { pass: false, detail: `hook sin salida JSON para "${p.slice(0, 24)}"` };
        maxLen = Math.max(maxLen, ac.length);
        if (/<orchestration-(context|directive)/.test(ac) || ac.length > MAX) bad.push(`"${p.slice(0, 24)}"=${ac.length}`);
      }
      // Control positivo: primer tono no-default con disparador explicito, leido de
      // la configuracion de personalidad (sin fijar nombres de tono aqui).
      let ctl = null;
      try {
        const td = createRequire(import.meta.url)(join(HOOKS_SCRIPTS, "lib", "tone-detect.js"));
        const pers = td.loadPersonality();
        const t = (pers?.tones ?? []).find((x) => x.id !== pers.default_tone && (x.explicit_triggers ?? []).length);
        if (t) ctl = { id: t.id, prompt: `${t.explicit_triggers[0]} y explica el bug del login` };
      } catch { /* sin personalidad: ctl=null -> el control positivo falla */ }
      const tone = ctl ? call(ctl.prompt) : null;
      const toneOk =
        typeof tone === "string" && tone.includes("tone_detected:") && tone.includes(`[${ctl.id}]`) && tone.length <= MAX;
      return {
        pass: bad.length === 0 && toneOk,
        detail: `${prompts.length} prompts: ${bad.length} con orchestration/oversize (max=${maxLen} chars, <=${MAX})` +
          ` · tono pedido (${ctl?.id ?? "sin tono de control"}) inyectado=${toneOk} (${tone?.length ?? "?"} chars)` +
          (bad.length ? ` · ${bad.slice(0, 3).join(" | ")}` : ""),
      };
    },
  },
]);
