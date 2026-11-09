// kirkardo/cats-15-18.mjs — categorias 15 (observabilidad), 16 (contexto), 17 (compactacion) y 18 (reproducibilidad).
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as P from "./predicates.mjs";
import { CC, CC_TAURI, CLAUDE, COCKPIT, HOOKS_MANIFEST, HOOKS_SCRIPTS, REPO, SETTINGS_JSON, ULTRON, cat, fileExists, grepInFiles, hooksText, readJSON, run } from "./core.mjs";

// ---------------------------------------------------------------------------
// CAT 15 — Observabilidad
// ---------------------------------------------------------------------------
cat(15, "Observabilidad", [
  {
    id: "15.1",
    desc: "hook-timing.jsonl existe y tiene entradas recientes (< 7 dias) de trafico real",
    auto: true,
    check() {
      // Desde el 2026-10-23 el harness lanza los hooks en HOME aislado, asi que
      // este log ya no se alimenta de sus propias corridas (medidor-6); las de
      // antes de esa fecha salen de la ventana en 7 dias.
      const timingFile = join(ULTRON, "logs", "hook-timing.jsonl");
      if (!fileExists(timingFile)) return { pass: false, detail: "hook-timing.jsonl ausente" };
      const lines = readFileSync(timingFile, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length === 0) return { pass: false, detail: "hook-timing.jsonl vacio" };
      const last = lines[lines.length - 1];
      let lastEntry = null;
      try { lastEntry = JSON.parse(last); } catch { /* sin JSON: cae al rojo de abajo */ }
      const ts = new Date(lastEntry?.timestamp ?? lastEntry?.ts ?? NaN).getTime();
      // Sin timestamp parseable no hay frescura que afirmar (antes era verde).
      if (!Number.isFinite(ts)) return { pass: false, detail: `${lines.length} entradas, la ultima sin timestamp parseable` };
      const ageDays = (Date.now() - ts) / (1000 * 3600 * 24);
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
    desc: "router guarda {zona, modelo, proveedor, fallback} por decision (logs/route-decisions.jsonl, ventana movil de 7 dias)",
    auto: true,
    check() {
      // Antes miraba si alguna clase de metrics.json tenia fecha de HOY: dependia
      // de que ese dia hubiera habido rutas (K7) y metrics.json no guarda la zona
      // (router-7). route-decisions.jsonl si la guarda, por decision. Limite
      // declarado en el detalle: los fallos totales de ruta no se registran.
      const log = join(ULTRON, "logs", "route-decisions.jsonl");
      if (!fileExists(log)) return { pass: false, detail: "route-decisions.jsonl ausente" };
      const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.trim());
      return P.routeDecisionsVerdict(lines, Date.now(), 7);
    },
  },
  {
    id: "15.4",
    desc: "logs/ tiene rotacion (no crece indefinidamente): hook-timing.jsonl < 10MB",
    auto: true,
    check() {
      const timingFile = join(ULTRON, "logs", "hook-timing.jsonl");
      // Sin el fichero no hay rotacion que demostrar (antes era verde).
      if (!fileExists(timingFile)) return { pass: false, detail: "no medible: hook-timing.jsonl ausente" };
      const mb = statSync(timingFile).size / (1024 * 1024);
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
    retiredBy: "medidor-r3", // 2026-10-28: sustituido por un check de comportamiento (SUPERSEDED en decisions.mjs)
    desc: "RTK NO mencionado como obligatorio en CLAUDE.md global",
    auto: true,
    check() {
      const globalClaude = join(CLAUDE, "CLAUDE.md");
      if (!fileExists(globalClaude)) return { pass: false, detail: "no medible: CLAUDE.md global no encontrado" };
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
    retiredBy: "medidor-r3", // 2026-10-28: sustituido por un check de comportamiento (SUPERSEDED en decisions.mjs)
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
    retiredBy: "medidor-r3", // 2026-10-28: sustituido por un check de comportamiento (SUPERSEDED en decisions.mjs)
    desc: "mem0 NO en lista activa de writers (solo en forbidden list)",
    auto: true,
    check() {
      // mem0 en WRITER_PATHS_FORBIDDEN es CORRECTO (prohibido)
      // mem0 en WRITER_PATHS_ALLOWED o en llamadas activas seria un FAIL
      if (!existsSync(HOOKS_SCRIPTS)) return { pass: false, detail: "no medible: hooks/scripts ausente" };
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
    retiredBy: "medidor-r3", // 2026-10-28: sustituido por un check de comportamiento (SUPERSEDED en decisions.mjs)
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
    desc: "Gasto de tokens que los hooks de memoria inyectan al CLI, sobre trafico REAL de 14 dias: mediana < 1500 est_tokens en memory-orchestrate (por prompt) y en memory-session-resume (por arranque), con >= 5 muestras cada uno",
    auto: true,
    check() {
      // (2026-10-23, medidor-6 / hooks-10) Antes: las 20 ultimas entradas de
      // memory-orchestrate, que eran las 17 llamadas del propio harness (0 tokens
      // en modo ligero): verde por construccion. Ahora: ventana movil de 14 dias,
      // sin rafagas (entradas a < 500 ms / 2 s de otra del mismo hook = corridas
      // del harness o de un selftest, no prompts) y con el resume, que es por
      // donde entra hoy la memoria (modo ligero).
      const logs = join(ULTRON, "logs");
      const files = ["hook-tokens.jsonl.1", "hook-tokens.jsonl"].map((f) => join(logs, f)).filter((f) => existsSync(f));
      if (files.length === 0) return { pass: false, detail: "hook-tokens.jsonl ausente (telemetria de gasto no corriendo)" };
      const entries = files.flatMap((f) => readFileSync(f, "utf8").split("\n"))
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      const LIMIT = 1500;
      const MIN = 5;
      const now = Date.now();
      const parts = [
        ["memory-orchestrate", 500],
        ["memory-session-resume", 2000],
      ].map(([hook, burstMs]) => {
        const v = P.realTrafficSamples(entries, hook, { nowMs: now, days: 14, burstMs });
        return { hook, n: v.length, med: v.length ? P.median(v) : null };
      });
      const few = parts.filter((p) => p.n < MIN);
      const detail = parts.map((p) => `${p.hook}: mediana=${p.med ?? "-"} (n=${p.n})`).join("; ");
      if (few.length) return { pass: false, detail: `no medible: < ${MIN} muestras reales en 14 dias (${detail})` };
      return { pass: parts.every((p) => p.med < LIMIT), detail: `${detail}; limite ${LIMIT}` };
    },
  },
  {
    // [mmeyhg] Detector D24 (prompt-cache hit rate) CONSUMIDO aqui: la telemetria
    // computa on-demand sobre transcripts (no necesita cron para acumular), pero
    // sin un punto de consumo periodico era dato huerfano (mand.12). El harness
    // es el pulso que SE MIRA: verdict pass exige hit_rate >= 0.6 en 14 dias.
    id: "16.6",
    desc: "Prompt-cache hit rate (detector D24 de cache_telemetry.py): verdict=pass en la ventana de 14 dias",
    auto: true,
    check() {
      const script = join(REPO, "scripts", "cockpit", "cache_telemetry.py");
      if (!fileExists(script)) return { pass: false, detail: "cache_telemetry.py no existe" };
      // `uv run python`, nunca python suelto (regla del proyecto, 2026-10-23).
      const r = spawnSync("uv", ["run", "python", script, "budget"], { cwd: ULTRON, encoding: "utf8", timeout: 180000, windowsHide: true });
      const out = (r.stdout || "") + (r.stderr || "");
      let j = null;
      try {
        j = JSON.parse(out.slice(out.indexOf("{")));
      } catch {
        return { pass: false, detail: `no medible: output no-JSON (${out.trim().slice(0, 100)})` };
      }
      const verdict = j.verdict ?? "insufficient";
      return {
        pass: verdict === "pass",
        detail: `verdict=${verdict} hit_rate=${j.hit_rate} turns=${j.turns_observed} window=${j.window_days}d`,
      };
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
    retiredBy: "cowork-retired", // 2026-10-28: fallaba por diseno: el plugin que empaquetaba el hook esta borrado
    desc: "session-end-summary.js (candidatos por sesion) existe, compila Y esta cableado en settings.json o hooks/manifest.json",
    auto: true,
    check() {
      // Existir y compilar no es producir candidatos: el script no esta en
      // settings.json (solo lo empaqueta Cowork) y daba verde (hooks-2).
      const script = join(HOOKS_SCRIPTS, "session-end-summary.js");
      const exists = fileExists(script);
      if (!exists) return { pass: false, detail: "session-end-summary.js no existe" };
      const r = run(`node --check "${script}" 2>&1`);
      if (!r.ok) return { pass: false, detail: r.stderr.slice(0, 100) };
      const wiredIn = [["settings.json", hooksText(SETTINGS_JSON)], ["hooks/manifest.json", hooksText(HOOKS_MANIFEST)]]
        .filter(([, t]) => t && /session-end-summary\.js/.test(t))
        .map(([l]) => l);
      return {
        pass: wiredIn.length > 0,
        detail: wiredIn.length ? `syntax OK y cableado en ${wiredIn.join(", ")}` : "syntax OK pero SIN cablear: ni settings.json ni hooks/manifest.json lo lanzan",
      };
    },
  },
  // [17.4 retirado 2026-07-01 · cat20.3] "decisions-pending.jsonl existe (pipeline
  // activo)" premiaba el SINTOMA: el sink nunca tuvo consumidor en src-tauri. El
  // pipeline se enterro (redundante con `ultron-memory capture` -> inbox gobernado).
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

      // Schema esperado: campos estructurados. (2026-10-23, hooks-2) arch_delta NO
      // cuenta como contenido: es `git log -10` del repo y esta siempre lleno, asi
      // que el check pasaba por construccion. Cuentan decisions/next/bugs o
      // machine.facts_extracted > 0.
      const nonEmptyStr = (v) => typeof v === "string" && v.trim().length > 0;
      const hasHuman = nonEmptyStr(j.human) || nonEmptyStr(j.summary);
      const hasMachine = j.machine && typeof j.machine === "object" && (j.machine.turns_total ?? 0) >= 0;
      // Flag heuristico de origen AI vs heuristico (si esta presente, lo reportamos)
      const aiFlag = j.machine?.ai_used ?? j.ai ?? j.via ?? null;
      const c = P.compactContent(j);
      const structured = (hasHuman || hasMachine) && c.pass;
      const where = latest.split(/[/\\]/).slice(-2).join("/");
      return {
        pass: structured,
        detail: structured
          ? `${where}: human=${hasHuman}, arrays no vacios=[${c.arrays.join(",")}], facts=${c.facts}${aiFlag !== null ? `, ai=${aiFlag}` : ""}`
          : `${where} sin contenido estructurado (decisions/next/bugs vacios, facts_extracted=${c.facts}; arch_delta no cuenta) -> stub`,
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
      const p = join(REPO, "bootstrap.ps1");
      return { pass: fileExists(p), detail: fileExists(p) ? "bootstrap.ps1 presente" : "ausente" };
    },
  },
  {
    id: "18.2",
    desc: "INSTALL.md existe con instrucciones",
    auto: true,
    check() {
      const p = join(REPO, "INSTALL.md");
      if (!fileExists(p)) return { pass: false, detail: "INSTALL.md ausente" };
      const content = readFileSync(p, "utf8");
      const hasSteps = content.length > 500;
      return { pass: hasSteps, detail: `INSTALL.md ${content.length} chars` };
    },
  },
  {
    id: "18.3",
    retiredBy: "medidor-r3", // 2026-10-28: sustituido por un check de comportamiento (SUPERSEDED en decisions.mjs)
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
