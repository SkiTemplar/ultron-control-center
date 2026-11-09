// kirkardo/cats-02-03.mjs — categorias 2 (CodeGraph) y 3 (AI Routing).
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as P from "./predicates.mjs";
import * as R2 from "./predicates-r2.mjs";
import { cargoTestCheck } from "./cargo.mjs";
import { CLAUDE, COCKPIT, METRICS_JSON, ULTRON, cat, fwd, readJSON, run } from "./core.mjs";

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
    desc: "codegraph CLI vivo + .db con nodos navegables (nodes - file - import > 0)",
    auto: true,
    check() {
      // El nudge que citaba la cifra de simbolos (codegraph-reminder.js) se retiro el
      // 2026-09-29; queda comprobar que el binario responde y que el .db tiene datos.
      const ver = run("codegraph --version 2>&1", { timeout: 15000 });
      const verOk = /^\d+\.\d+\.\d+/.test(ver.stdout.trim());
      if (!verOk) return { pass: false, detail: `no medible: codegraph --version no responde (${(ver.stdout + ver.stderr).trim().slice(0, 60)})` };
      const nav = readCodegraphDb((db) =>
        db.prepare("SELECT COUNT(*) c FROM nodes WHERE kind NOT IN ('file','import')").get().c,
      );
      if (nav === null) return { pass: false, detail: "no medible: codegraph.db ausente (clon limpio/CI)" };
      if (nav && nav.__error) return { pass: false, detail: `codegraph.db no abre: ${nav.__error}` };
      return {
        pass: nav > 0,
        detail: `codegraph ${ver.stdout.trim().slice(0, 8)}; navegable real=${nav}`,
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
    desc: "el motor de consulta del indice de ~/.ultron rinde datos reales: 'codegraph query' (CLI, no el comando codegraph_summary de la app) devuelve un simbolo conocido con filePath/qualifiedName",
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
    desc: "Consumo real de codegraph (Mandamiento 12): de las sesiones y subagentes recientes que EXPLORARON codigo (>=3 Grep/Glob/Read-codigo), >=80% usaron codegraph_* (el dato existe != se consume)",
    auto: true,
    check() {
      // Ratio (sesiones con tool_use de codegraph)/(sesiones que EXPLORARON codigo)
      // sobre los 40 transcripts principales mas recientes y los de sus subagentes
      // (<sesion>/subagents/*.jsonl, cada uno cuenta como una sesion). El numerador
      // solo cuenta sesiones del denominador (auditoria 2026-10-23, codegraph-4).
      // El nudge que lo recordaba se retiro el 2026-09-29; desde el 2026-11-02 lo
      // empuja el hook codegraph-first (una denegacion por sesion).
      const projDir = join(CLAUDE, "projects", ("C--Users-" + (process.env.USERNAME||process.env.USER||"user") + "--ultron"));
      if (!existsSync(projDir)) return { pass: false, detail: "no medible: dir de transcripts ausente" };
      let files;
      try {
        const mains = readdirSync(projDir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => ({ f: join(projDir, f), m: statSync(join(projDir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)
          .slice(0, 40);
        const subs = mains.flatMap(({ f }) => {
          const dir = join(f.replace(/\.jsonl$/, ""), "subagents");
          if (!existsSync(dir)) return [];
          return readdirSync(dir).filter((s) => s.endsWith(".jsonl")).map((s) => ({ f: join(dir, s) }));
        });
        files = { mains, subs };
      } catch (e) { return { pass: false, detail: `no medible: error leyendo transcripts (${e.message})` }; }
      if (files.mains.length === 0) return { pass: false, detail: "no medible: 0 transcripts .jsonl" };
      const usage = (f) => {
        try { return P.transcriptToolUsage(readFileSync(f, "utf8").split("\n")); }
        catch { return { exploreCalls: 0, usedCg: false }; }
      };
      const usages = [...files.mains, ...files.subs].map(({ f }) => usage(f));
      const v = P.codegraphConsumption(usages, 3);
      return { ...v, detail: `${v.detail} [${files.mains.length} sesiones + ${files.subs.length} subagentes]` };
    },
  },
  {
    id: "2.8",
    retiredBy: "medidor-r3", // 2026-10-28: sustituido por un check de comportamiento (SUPERSEDED en decisions.mjs)
    desc: "indice por proyecto: cada proyecto registrado con codigo trackeado tiene .codegraph/codegraph.db con >=1 fichero indexado",
    auto: true,
    check() {
      // 2.1-2.5 solo miden el indice de ~/.ultron (auditoria 2026-10-23,
      // codegraph-5). Codigo = >=1 fichero de codigo en `git ls-files`; un
      // proyecto sin git no se juzga (no hay forma barata y fiable de saberlo).
      const reg = readJSON(join(COCKPIT, "projects.json"));
      const list = Array.isArray(reg) ? reg : reg?.projects;
      if (!Array.isArray(list) || list.length === 0) return { pass: false, detail: "no medible: cockpit/projects.json ausente o vacio" };
      const CODE = /\.(rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|swift|c|cc|cpp|h|hpp|cs|vue|gd|lua)$/i;
      const projects = [];
      for (const p of list) {
        const dir = p?.path;
        if (!p?.id || !dir || !existsSync(join(dir, ".git"))) continue;
        const ls = spawnSync("git", ["-C", dir, "ls-files"], { encoding: "utf8", timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
        if (ls.status !== 0) continue;
        const codeFiles = ls.stdout.split("\n").filter((f) => CODE.test(f)).length;
        const db = join(dir, ".codegraph", "codegraph.db");
        let indexedFiles = null;
        if (existsSync(db)) {
          try {
            const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
            const conn = new DatabaseSync(db, { readOnly: true });
            try { indexedFiles = Number(conn.prepare("SELECT COUNT(*) c FROM files").get().c); } finally { conn.close(); }
          } catch { indexedFiles = 0; }
        }
        projects.push({ id: p.id, codeFiles, indexedFiles });
      }
      return P.projectIndexVerdict(projects);
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
      // Sin tuberia y con el exit real: `| head -1` daba exit 0 y /claude/ casaba
      // con el propio "claude: command not found" (auditoria 2026-10-23).
      const r = run("claude --version", { timeout: 30000 });
      return P.cliVersionVerdict({ code: r.code, output: r.stdout + r.stderr }, "claude");
    },
  },
  // 3.2 (politica CLI-first de las zonas de codigo) y 3.3 (codex autenticado)
  // retirados el 2026-10-23: las zonas code-edit y code-review se podaron por no
  // tener llamante (0f1189f4) y ya no hay zona que rutee a codex-cli. Las zonas
  // vigentes las mide 3.6 contra el seed.
  {
    id: "3.4",
    desc: "ventana reciente del router (recent_outcomes): fallback + failed < 10% con >= 10 rutas, y alguna clase activa con uso en los ultimos 7 dias",
    auto: true,
    check() {
      const m = readJSON(METRICS_JSON);
      if (!m) return { pass: false, detail: "no medible: metrics.json ausente (clon limpio/CI)" };
      // recent_outcomes (2026-10-23) distingue primary/fallback/failed; la ventana
      // booleana vieja (recent_routes, ya no se escribe) contaba un fallo total
      // como ruta sin fallback y no medible aqui.
      const v = R2.routerRecentVerdict(m, { minRoutes: 10, maxRate: 0.1 });
      // Frescura: ALGUNA clase activa con uso en 7 dias (K7): gemini es
      // fallback-only y cuanto mas sano el router mas vieja queda su fecha.
      const WINDOW_DAYS = 7;
      const active = Object.values(m.by_class ?? {}).filter((x) => x && (x.count ?? 0) > 0);
      const fresh = active.length > 0 && P.anyDateWithin(active.map((x) => x.date), Date.now(), WINDOW_DAYS);
      return { pass: v.pass && fresh, detail: `${v.detail}; clase_activa_en_${WINDOW_DAYS}d=${fresh}` };
    },
  },
  {
    id: "3.5",
    desc: "cargo test --features finance --lib ai_router: corre tests reales y pasan (logica de cadena, cuota y CLI, no solo exit 0)",
    auto: true,
    check() {
      // Baseline de la LOGICA de routing. NO es e2e contra proveedor vivo (3.4).
      return cargoTestCheck("ai_router", { minPassed: 1 });
    },
  },
  {
    id: "3.6",
    desc: "las zonas del seed son exactamente las que tienen llamante (cargo test seed_zones_are_exactly_the_zones_with_a_caller)",
    auto: true,
    check() {
      return cargoTestCheck("ai_router::tests::ai_router_tests::basics::seed_zones_are_exactly_the_zones_with_a_caller", { minPassed: 1 });
    },
  },
  {
    id: "3.7",
    desc: "una cadena que falla entera cuenta como failed en las metricas y se registra (cargo test a_failed_chain_is_counted_and_logged_as_failed)",
    auto: true,
    check() {
      return cargoTestCheck("ai_router::providers::routing::tests::a_failed_chain_is_counted_and_logged_as_failed", { minPassed: 1 });
    },
  },
]);