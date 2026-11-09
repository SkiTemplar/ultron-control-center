// kirkardo/cats-08-10.mjs — categorias 8 (UI cableada), 9 (hooks) y 10 (union del sistema).
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as P from "./predicates.mjs";
import * as R2 from "./predicates-r2.mjs";
import { pluginIndex } from "./claude-env.mjs";
import { AGENTS_DIR, CC, CC_SRC, CC_TAURI, CLAUDE, COCKPIT, HOME, HOOKS_MANIFEST, REPO, ULTRON, cat, fileExists, fwd, grepInFiles, hookSandbox, invokeCallsites, readJSON, spawnHook } from "./core.mjs";
import { ORCH_HOOK, RESUME_HOOK } from "./hook-io.mjs";

// ---------------------------------------------------------------------------
// CAT 8 — UI funcional
// ---------------------------------------------------------------------------
cat(8, "UI funcional (cableada)", [
  {
    id: "8.1",
    desc: "invoke<->generate_handler!: 0 comandos invocados sin registrar (botones no-op), modulo finance",
    auto: true,
    check() {
      // El bloque generate_handler! vive en handlers.rs desde el 2026-08-16
      // (cat7.3: lib.rs superaba las 800 lineas). Medirlo en lib.rs daba rojo
      // del medidor, no del sistema (audit 2026-09-04).
      const libPath = join(CC_TAURI, "handlers.rs");
      if (!fileExists(libPath) || !fileExists(CC_SRC)) {
        return { pass: false, detail: "no medible: falta handlers.rs o control-center/src" };
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
      // Registrados: bloque generate_handler![ ... ] de handlers.rs, con el mismo
      // parser que 10.2 (antes cada check contaba distinto: 336 frente a 351).
      const parsed = P.parseGenerateHandler(readFileSync(libPath, "utf8"));
      if (!parsed) return { pass: false, detail: "no medible: generate_handler! no encontrado en handlers.rs" };
      const { registered, finance: financeReg } = parsed;
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
      // El modulo es finance/ (mod.rs) desde el 2026-08-15; buscar solo
      // finance.rs devolvia "N/A" en verde sin mirar el .exe (medidor-3). Sin el
      // modulo (clon publico) no hay nada que juzgar: skip, no verde.
      if (!P.financeSourcePresent(existsSync, join, CC_TAURI)) {
        return { skip: true, detail: "N/A: modulo finance ausente (ni finance.rs ni finance/mod.rs): clon publico, no build:local-capable" };
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
const median = P.median;

// Cronometra el spawn COMPLETO (incluye arranque de node) de un hook con stdin
// dado, n veces. Devuelve { samples[], exits[] }. Mide EN CALIENTE, no lee logs
// historicos sesgables (hook-timing.jsonl rota y se domina por otros hooks).
function timeHookSpawns(hookPath, stdinObj, n, perRunTimeoutMs, { realBin = false } = {}) {
  const samples = [];
  const exits = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const r = spawnHook(hookPath, stdinObj, { timeout: perRunTimeoutMs, realBin });
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
    retiredBy: "medidor-r3", // 2026-10-28: sustituido por un check de comportamiento (SUPERSEDED en decisions.mjs)
    desc: "manifest.json parity: todos los scripts del manifest existen en disco",
    auto: true,
    check() {
      if (!fileExists(HOOKS_MANIFEST)) return { pass: false, detail: "no medible: manifest.json ausente" };
      const manifest = readJSON(HOOKS_MANIFEST);
      if (!manifest) return { pass: false, detail: "no medible: manifest no parseable" };
      const scripts = P.manifestHookScripts(manifest, HOME, REPO);
      if (scripts.length === 0) return { pass: false, detail: "no medible: manifest sin hooks (0 scripts)" };
      const missing = scripts.filter((s) => !existsSync(s.script)).map((s) => s.script.split("/").pop());
      return {
        pass: missing.length === 0,
        detail: `manifest: ${scripts.length} scripts, ${missing.length} no existen en disco` + (missing.length ? `: ${missing.join(", ")}` : ""),
      };
    },
  },
  {
    id: "9.2",
    desc: "SALUD: resume hook sano emite JSON SessionStart + bloque <ultron-memory-resume (el artefacto que llega al modelo)",
    auto: true,
    check() {
      if (!fileExists(RESUME_HOOK)) return { pass: false, detail: "no medible: memory-session-resume.js ausente" };
      const r = spawnHook(RESUME_HOOK, { cwd: ULTRON, source: "startup", hook_event_name: "SessionStart" }, { realBin: true });
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
      // Todo dentro del HOME aislado: el rastro se cuenta en SU hook-errors.jsonl,
      // no en el de produccion (antes cada corrida le anadia una linea).
      const sb = hookSandbox();
      let fakeBin;
      try {
        const tmpDir = join(sb.ultron, ".tmp", "kirkardo");
        mkdirSync(tmpDir, { recursive: true });
        fakeBin = join(tmpDir, "fake-ultron-memory-broken.txt");
        writeFileSync(fakeBin, "not a binary\n");
      } catch (e) {
        return { pass: false, detail: `no medible: no se pudo crear fixture: ${e.message}` };
      }
      const before = sb.countLines("hook-errors.jsonl");
      // cwd a un proyecto INEXISTENTE -> projectIdFromCwd da basura -> sin context.md
      // -> el resume del binario es la unica fuente de <ultron-memory-resume>.
      const fakeCwd = join(sb.ultron, ".tmp", "kirkardo", "nonexistent-project-xyz");
      const r = spawnHook(
        RESUME_HOOK,
        { cwd: fakeCwd, source: "startup", hook_event_name: "SessionStart" },
        { env: { ULTRON_MEMORY_BIN: fwd(fakeBin) } },
      );
      const after = sb.countLines("hook-errors.jsonl");
      const out = (r.stdout ?? "").trim();
      const ac = hookAdditionalContext(out);
      // (a) no crashea: exit 0 + JSON valido. El bloque resume PUEDE existir con
      // head/nota (fuentes independientes del sidecar), pero si el recall del sidecar
      // fallo el hook debe DECLARARLO (marca DEGRADED) en vez de emitir un resume que
      // parece normal (mand.11). El diseno viejo asumia "sidecar = unica fuente".
      const hasResumeBlock = ac !== null && ac.includes("<ultron-memory-resume");
      const marksDegraded = ac !== null && /DEGRADED/i.test(ac);
      const safe = r.status === 0 && ac !== null && (!hasResumeBlock || marksDegraded);
      // (b) RUIDOSO: dejo rastro accionable (>=1 linea nueva en hook-errors.jsonl)
      const noisy = after > before;
      return {
        pass: safe && noisy,
        detail: safe
          ? `fail-safe OK (exit 0, degradacion ${marksDegraded ? "declarada" : "sin bloque"}) + RUIDO=${noisy} (hook-errors.jsonl ${before}->${after})`
          : `fail-safe ROTO: exit=${r.status} ac_null=${ac === null} resumeBlock=${hasResumeBlock} marksDegraded=${marksDegraded} (el recall caido debe declararse DEGRADED)`,
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
        { realBin: true },
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
    desc: "orchestrate_prompt tiene un invoke() REAL en el frontend (no comentarios ni tests)",
    auto: true,
    check() {
      // Antes contaba cualquier mencion, comentarios incluidos: "5 referencias"
      // para un unico invoke (auditoria 2026-10-23, medidor-5).
      const calls = invokeCallsites("orchestrate_prompt");
      return {
        pass: calls.length >= 1,
        detail: `${calls.length} invoke real(es) de orchestrate_prompt` + (calls.length ? ` (${calls.map((c) => c.file.split(/[/\\]/).pop()).join(", ")})` : ""),
      };
    },
  },
  {
    id: "10.2",
    desc: ">= 90% comandos registrados en handlers.rs (incluido finance) tienen caller en el frontend de produccion (sin tests ni comentarios)",
    auto: true,
    check() {
      // Mismo parser que 8.1. Los tests no cuentan como llamante: un
      // expect(...).not.toHaveBeenCalledWith('x') daba x por consumido
      // (auditoria 2026-10-23, frontend-e2e-10).
      const libRs = join(CC_TAURI, "handlers.rs");
      if (!fileExists(libRs)) return { pass: false, detail: "handlers.rs no encontrado" };
      const parsed = P.parseGenerateHandler(readFileSync(libRs, "utf8"));
      if (!parsed) return { pass: false, detail: "no se encontro el bloque generate_handler! en handlers.rs" };
      const handlers = [...parsed.registered, ...parsed.finance];
      if (handlers.length === 0) return { pass: false, detail: "0 handlers extraidos de handlers.rs" };
      const quoted = new Set();
      for (const m of grepInFiles(/["'`][a-z_][a-z0-9_]*["'`]/, CC_SRC, [".tsx", ".ts"])) {
        if (P.isTestPath(m.file) || P.isCommentLine(m.text)) continue;
        for (const q of m.text.matchAll(/["'`]([a-z_][a-z0-9_]*)["'`]/g)) quoted.add(q[1]);
      }
      const noCaller = handlers.filter((h) => !quoted.has(h));
      const matched = handlers.length - noCaller.length;
      const pct = (matched / handlers.length) * 100;
      return {
        pass: pct >= 90,
        detail: `${matched}/${handlers.length} comandos con caller (${pct.toFixed(1)}%)` + (noCaller.length ? `; sin caller: ${noCaller.slice(0, 6).join(", ")}${noCaller.length > 6 ? ", ..." : ""}` : ""),
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
    desc: "0 agentes fantasma en lo que el codigo delega: cada paso de los workflows (workflows.rs) es un agente activo o de plugin, y cada preferred_specialists (ranking.rs) existe en ~/.claude/agents o plugins",
    auto: true,
    check() {
      // Rediseno (2026-10-23, ronda 2): el check viejo leia agent-catalog.json
      // (borrado en c534c159, sin consumidor) y los rosters de proyecto (0 en
      // disco) y daba skip/verde por vacuidad. Ahora lee los nombres que el
      // codigo de verdad usa: delegate_task lanza los WorkflowStep por
      // subagent_type (tiene que estar ACTIVO) y preferred_specialists solo
      // potencia (basta con que exista, aunque este .md.disabled).
      const wfPath = join(CC_TAURI, "agent_orchestration", "workflows.rs");
      const rkPath = join(CC_TAURI, "orchestrator", "ranking.rs");
      if (!fileExists(wfPath) || !fileExists(rkPath)) return { pass: false, detail: "no medible: falta workflows.rs o ranking.rs" };
      const specialists = R2.specialistAgents(readFileSync(rkPath, "utf8"));
      if (specialists === null) return { pass: false, detail: "no medible: fn preferred_specialists no encontrada en ranking.rs" };
      const files = existsSync(AGENTS_DIR) ? readdirSync(AGENTS_DIR) : [];
      const active = new Set(files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)));
      const disabled = new Set(files.filter((f) => f.endsWith(".md.disabled")).map((f) => f.slice(0, -12)));
      return R2.agentRefsVerdict(
        { workflow: R2.workflowAgents(readFileSync(wfPath, "utf8")), specialists },
        { active, disabled, plugin: pluginIndex().agentNames },
      );
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
