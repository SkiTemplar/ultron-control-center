/**
 * kirkardo/predicates-r2.mjs — predicados PUROS de los checks de la ronda 2
 * (2026-10-23): miden lo que arreglo la primera ronda de la auditoria.
 *
 * Misma convencion que predicates.mjs: { pass, detail }, { skip: true, detail }
 * o { manual: true, detail } (no ejecutable aqui por una causa de entorno:
 * sin toolchain, la compilacion falla). Un timeout es rojo, no manual
 * (2026-11-01). Nunca verde por vacuidad.
 * Sin disco, red ni procesos: los prueba scripts/kirkardo-eval.selftest.mjs.
 */

import { isCommentLine, rustFnBodies, tailLines } from "./predicates.mjs";

// ---------------------------------------------------------------------------
// cargo test con filtro (1.11-1.13, 3.5-3.7, 13.2, 14.7, 14.8, 14.10)
// ---------------------------------------------------------------------------

const COMPILE_ERR = /^error(\[E\d+\])?:|could not compile/m;

/**
 * Veredicto de un `cargo test <filtro>`. Sin toolchain, sin el modulo finance o
 * con la compilacion rota: manual con la causa. Sin exit (timeout o un test
 * colgado): rojo, el proceso arranco (si no llego a arrancar, lo convierte en
 * manual R3.applyInfra con la causa registrada). Con resultados: rojo si algo
 * falla o si el filtro ejecuto menos de `minPassed` tests (un filtro que no casa
 * nada da "0 passed" con exit 0).
 */
export function cargoFilterVerdict({ code, output, toolchain = true, finance = true }, { minPassed = 1 } = {}) {
  const out = String(output ?? "");
  if (!toolchain) return { manual: true, detail: `sin toolchain de Rust (cargo --version no responde): ${tailLines(out, 1).slice(0, 100)}` };
  if (!finance) return { manual: true, detail: "modulo finance ausente: el check exige --features finance (enlazar src/finance en el worktree)" };
  const results = [...out.matchAll(/test result: (ok|FAILED)\.\s*(\d+) passed;\s*(\d+) failed/g)];
  if (code === null || code === undefined) {
    return { pass: false, detail: `cargo test sin codigo de salida (timeout o test colgado): ${tailLines(out, 2).slice(0, 140)}` };
  }
  if (results.length === 0 && COMPILE_ERR.test(out)) {
    const line = out.split(/\r?\n/).find((l) => COMPILE_ERR.test(l)) ?? "";
    return { manual: true, detail: `no compila: ${line.trim().slice(0, 160)}` };
  }
  const passed = results.reduce((a, m) => a + Number(m[2]), 0);
  const failed = results.reduce((a, m) => a + Number(m[3]), 0);
  if (results.length === 0) return { pass: false, detail: `exit=${code} sin linea 'test result': ${tailLines(out, 2).slice(0, 140)}` };
  const pass = code === 0 && failed === 0 && passed >= minPassed;
  return {
    pass,
    passed,
    detail: pass
      ? `${passed} passed, 0 failed (>= ${minPassed})`
      : `exit=${code} passed=${passed} failed=${failed} (minimo ${minPassed}): ${tailLines(out, 2).slice(0, 140)}`,
  };
}

// ---------------------------------------------------------------------------
// 3.4 ventana reciente del router
// ---------------------------------------------------------------------------

/**
 * recent_outcomes (primary|fallback|failed) de metrics.json: la tasa de rutas
 * sin respuesta del primary (fallback + failed) por debajo de maxRate con al
 * menos minRoutes rutas. La ventana booleana vieja (recent_routes) no ve los
 * fallos totales: sin recent_outcomes no es medible.
 */
export function routerRecentVerdict(metrics, { minRoutes = 10, maxRate = 0.1 } = {}) {
  const win = metrics?.recent_outcomes;
  if (!Array.isArray(win)) {
    const legacy = Array.isArray(metrics?.recent_routes) ? ` (solo la ventana vieja recent_routes, ${metrics.recent_routes.length} rutas)` : "";
    return { pass: false, detail: `no medible: metrics.json sin recent_outcomes${legacy}: lo escribio un binario anterior al 2026-10-23` };
  }
  if (win.length < minRoutes) return { pass: false, detail: `no medible: recent_outcomes con ${win.length} rutas (< ${minRoutes})` };
  const fb = win.filter((o) => o === "fallback").length;
  const failed = win.filter((o) => o === "failed").length;
  const rate = (fb + failed) / win.length;
  return {
    pass: rate < maxRate,
    rate,
    detail: `fallback+failed=${(rate * 100).toFixed(1)}% (${fb} fallback + ${failed} failed de ${win.length}; < ${maxRate * 100}%)`,
  };
}

// ---------------------------------------------------------------------------
// Referencias de codigo sin comentarios (13.1, 10.6, 14.8, 18.6)
// ---------------------------------------------------------------------------

/** Lineas de codigo (no comentario) que casan `re` en un texto. */
export function codeRefLines(text, re) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => !isCommentLine(l) && re.test(l.replace(/\/\/.*$/, "")));
}

// ---------------------------------------------------------------------------
// 10.4 agentes que el codigo delega
// ---------------------------------------------------------------------------

/** Agentes de los WorkflowStep de workflows.rs (`agent: "x".to_string()`). */
export function workflowAgents(text) {
  return [...String(text ?? "").matchAll(/\bagent:\s*"([A-Za-z0-9:_-]+)"\.to_string\(\)/g)].map((m) => m[1]);
}

/** Nombres de las listas de preferred_specialists (cuerpo de la fn en ranking.rs). */
export function specialistAgents(text) {
  const body = rustFnBodies(text).get("preferred_specialists");
  if (body === undefined) return null;
  const names = [];
  for (const arr of body.matchAll(/&\[([^\]]*)\]/g)) {
    for (const s of arr[1].matchAll(/"([A-Za-z0-9:_-]+)"/g)) names.push(s[1]);
  }
  return [...new Set(names)];
}

/**
 * Los workflows delegan por subagent_type: cada paso debe ser un agente ACTIVO
 * (o de plugin). preferred_specialists solo potencia: basta con que el agente
 * exista, aunque este desactivado (.md.disabled). Sin nombres, no medible.
 */
export function agentRefsVerdict({ workflow, specialists }, { active, disabled, plugin }) {
  const isActive = (n) => active.has(n) || plugin.has(n.toLowerCase());
  const exists = (n) => isActive(n) || disabled.has(n);
  if (!workflow.length && !specialists.length) return { pass: false, detail: "no medible: 0 agentes extraidos de workflows.rs y ranking.rs (forma del codigo cambio)" };
  const wfBad = [...new Set(workflow.filter((n) => !isActive(n)))];
  const spBad = specialists.filter((n) => !exists(n));
  return {
    pass: wfBad.length === 0 && spBad.length === 0,
    detail: `workflows: ${new Set(workflow).size} agentes, ${wfBad.length} no activos${wfBad.length ? ` [${wfBad.join(",")}]` : ""}; preferred_specialists: ${specialists.length}, ${spBad.length} inexistentes${spBad.length ? ` [${spBad.slice(0, 6).join(",")}]` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// 4.10 referencias fantasma en las skills activas
// ---------------------------------------------------------------------------

// Linea que declara la ausencia (no es una orden de delegar a algo vivo).
const DECLARES_ABSENT = /deshabilitad|desactivad|disabled|retirad|desinstalad|no existe|no instalad|uninstalled|placeholder/i;
// Prefijos que no son plugins: esquemas, builtins de node, namespaces XML.
const NOT_PLUGIN_NS = new Set(["http", "https", "file", "node", "mcp", "npm", "git", "std", "w", "xml", "namespace", "plugin"]);

/** Referencias a agentes (subagent_type) y a skills/agentes de plugin (`ns:nombre`) de un .md. */
export function skillRefs(text) {
  const agents = [];
  const namespaced = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (DECLARES_ABSENT.test(line)) continue;
    for (const m of line.matchAll(/subagent_type["']?\s*[:=]\s*["'`]?([A-Za-z0-9:_-]+)/g)) agents.push(m[1]);
    for (const m of line.matchAll(/`([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)`/g)) {
      if (!NOT_PLUGIN_NS.has(m[1])) namespaced.push(`${m[1]}:${m[2]}`);
    }
  }
  return { agents, namespaced };
}

const BUILTIN_AGENTS = new Set(["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide", "output-style-setup"]);

/**
 * refs = [{ file, agents, namespaced }]; resolver = { activeAgents:Set,
 * pluginItem(ns, name) -> bool }. Fantasma = ni agente activo, ni builtin, ni
 * item de un plugin habilitado.
 */
export function skillRefsVerdict(refs, { activeAgents, pluginItem }) {
  const ghosts = [];
  let total = 0;
  for (const r of refs) {
    for (const a of r.agents) {
      total++;
      const [ns, name] = a.includes(":") ? a.split(":") : [null, a];
      const ok = ns ? pluginItem(ns, name) : BUILTIN_AGENTS.has(a) || activeAgents.has(a);
      if (!ok) ghosts.push(`${r.file}:${a}`);
    }
    for (const n of r.namespaced) {
      total++;
      const [ns, name] = n.split(":");
      if (!pluginItem(ns, name)) ghosts.push(`${r.file}:${n}`);
    }
  }
  if (refs.length === 0) return { pass: false, detail: "no medible: 0 ficheros de skills activas leidos" };
  const uniq = [...new Set(ghosts)];
  return {
    pass: uniq.length === 0,
    detail: `${total} referencias en ${refs.length} ficheros de skills activas; fantasma=${uniq.length}${uniq.length ? `: ${uniq.slice(0, 10).join(", ")}` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// 7.11 comandos Tauri sincronos con E/S
// ---------------------------------------------------------------------------

const BLOCKING_IO = /\bCommand::new\b|\breqwest::|\bureq::|\bTcpStream::|\bread_dir\s*\(/;

/** `#[tauri::command]` no async cuyo cuerpo hace E/S bloqueante directa. */
export function syncIoCommands(text) {
  const src = String(text ?? "");
  const bodies = rustFnBodies(src);
  const out = [];
  for (const m of src.matchAll(/#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(pub(?:\([^)]*\))?\s+)?(async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (m[2]) continue;
    const body = bodies.get(m[3]);
    if (body !== undefined && BLOCKING_IO.test(body)) out.push(m[3]);
  }
  return out;
}

/** `let _ = fs::write(...)` / `let _ = std::fs::write(...)`: escritura con el error tragado. */
export function swallowedWrites(text) {
  return codeRefLines(text, /\blet\s+_\s*=\s*(std::)?fs::write\s*\(/).length;
}

// ---------------------------------------------------------------------------
// Resumenes de suites (12.7, 12.8, 14.11, 18.5)
// ---------------------------------------------------------------------------

/** "N/M <noun> en verde" de run-selftests / run-mod-tests: exit 0, N == M y M >= minTotal. */
export function suiteSummaryVerdict({ code, output }, { noun, minTotal = 1 }) {
  const m = String(output ?? "").match(new RegExp(`(\\d+)/(\\d+) ${noun} en verde`));
  if (!m) return { pass: false, detail: `exit=${code} sin resumen 'N/M ${noun} en verde': ${tailLines(output, 2).slice(0, 140)}` };
  const [ok, total] = [Number(m[1]), Number(m[2])];
  const pass = code === 0 && ok === total && total >= minTotal;
  return { pass, detail: `${ok}/${total} ${noun} en verde (minimo ${minTotal}), exit=${code}` };
}

/** Salida de vitest: exit 0, 0 failed y >= minTests tests pasados. */
export function vitestVerdict({ code, output }, { minTests = 1 } = {}) {
  // Sin los colores ANSI que vitest emite aun sin TTY.
  const out = String(output ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const line = out.split(/\r?\n/).find((l) => /^\s*Tests\s+/.test(l)) ?? "";
  const passed = Number((line.match(/(\d+) passed/) || [])[1] ?? 0);
  const failed = Number((line.match(/(\d+) failed/) || [])[1] ?? 0);
  // Errores no capturados (2026-10-28): vitest sale con 1 aunque todos los
  // tests pasen; el detalle lo dice para no confundirlo con un test rojo.
  const errors = Number((out.match(/^\s*Errors\s+(\d+) error/m) || [])[1] ?? 0);
  const pass = code === 0 && failed === 0 && errors === 0 && passed >= minTests;
  const errTxt = errors ? `; ${errors} error(es) no capturado(s): ${(out.match(/^(?:TypeError|Error|ReferenceError)[^\n]*/m) || [""])[0].slice(0, 90)}` : "";
  return { pass, detail: line ? `${line.trim()} exit=${code} (minimo ${minTests})${errTxt}` : `exit=${code} sin linea 'Tests': ${tailLines(out, 2).slice(0, 140)}` };
}

/** node --test: exit 0, "pass N" >= minPass y "fail 0". */
export function nodeTestVerdict({ code, output }, { minPass = 1 } = {}) {
  const out = String(output ?? "");
  const pass = Number((out.match(/^(?:#|ℹ) pass (\d+)/m) || [])[1] ?? -1);
  const fail = Number((out.match(/^(?:#|ℹ) fail (\d+)/m) || [])[1] ?? -1);
  if (pass < 0 || fail < 0) return { pass: false, detail: `exit=${code} sin resumen pass/fail de node --test: ${tailLines(out, 2).slice(0, 140)}` };
  const ok = code === 0 && fail === 0 && pass >= minPass;
  return { pass: ok, detail: `${pass} pass, ${fail} fail (minimo ${minPass}), exit=${code}` };
}

// ---------------------------------------------------------------------------
// 14.9 freno del puente de Pupus
// ---------------------------------------------------------------------------

/** cases = [{ command, expectRisky, risky }]: el freno clasifica cada sonda como se espera. */
export function brakeVerdict(cases) {
  if (!cases?.length) return { pass: false, detail: "no medible: 0 sondas clasificadas" };
  const wrong = cases.filter((c) => c.risky !== c.expectRisky);
  const pos = cases.filter((c) => c.expectRisky).length;
  return {
    pass: wrong.length === 0 && pos > 0 && pos < cases.length,
    detail: `${cases.length - wrong.length}/${cases.length} sondas bien clasificadas (${pos} de riesgo, ${cases.length - pos} de control)` +
      (wrong.length ? `; mal: ${wrong.map((c) => `${c.command.slice(0, 40)}=>${c.risky}`).join(" | ")}` : ""),
  };
}

// ---------------------------------------------------------------------------
// 2.10 / 2.11 / 2.9 CodeGraph
// ---------------------------------------------------------------------------

/** "N de M proyectos necesitan indexado." de codegraph-index-projects.mjs. */
export function indexPendingVerdict({ code, output }) {
  const m = String(output ?? "").match(/(\d+) de (\d+) proyectos necesitan indexado/);
  if (!m) return { pass: false, detail: `exit=${code} sin resumen 'N de M proyectos': ${tailLines(output, 2).slice(0, 140)}` };
  const [n, total] = [Number(m[1]), Number(m[2])];
  if (total === 0) return { skip: true, detail: "0 proyectos en el registro" };
  return { pass: code === 0 && n === 0, detail: `${n} de ${total} proyectos necesitan indexado (exit=${code})` };
}

/**
 * agents = [{ name, tools }] activos; tools = linea `tools:` del frontmatter
 * o null (sin lista hereda todas las herramientas, MCP incluido). Verde si los
 * que no llevan codegraph son un subconjunto de `allowed`.
 */
export function agentsCodegraphVerdict(agents, allowed) {
  if (!agents.length) return { skip: true, detail: "0 agentes activos" };
  const lacking = agents.filter((a) => a.tools !== null && !/codegraph/i.test(a.tools)).map((a) => a.name);
  const extra = lacking.filter((n) => !allowed.includes(n));
  return {
    pass: extra.length === 0,
    detail: `${agents.length} agentes activos; sin codegraph=${lacking.length} [${lacking.join(",") || "-"}]; fuera de los permitidos (${allowed.join(",")})=${extra.length}${extra.length ? ` [${extra.join(",")}]` : ""}`,
  };
}

/** Cada comando registrado en generate_handler! y con >= 1 invoke real. */
export function commandsWiredVerdict(cmds, registered, invokeCount) {
  const notReg = cmds.filter((c) => !registered.has(c));
  const noInvoke = cmds.filter((c) => !(invokeCount(c) > 0));
  return {
    pass: notReg.length === 0 && noInvoke.length === 0,
    detail: `${cmds.length} comandos: sin registrar=${notReg.join(",") || 0}; sin invoke real=${noInvoke.join(",") || 0}`,
  };
}

// ---------------------------------------------------------------------------
// 1.14 bitacora sin autorizaciones de sesion
// ---------------------------------------------------------------------------

const SESSION_SCOPED = /\bautoriz|\bNo hacer commits\b/i;

/** <project-state> del resume: 0 decisiones vigentes que sean permisos o restricciones de un turno. */
export function resumeSessionScopedVerdict(ac) {
  const m = String(ac ?? "").match(/<project-state[^>]*>([\s\S]*?)<\/project-state>/);
  if (!m) return { pass: false, detail: "no medible: el resume no trae <project-state>" };
  const hits = m[1].split(/\r?\n/).filter((l) => /^\s{2}-\s/.test(l) && SESSION_SCOPED.test(l));
  return {
    pass: hits.length === 0,
    detail: hits.length === 0 ? "0 autorizaciones o restricciones de sesion en <project-state>" : `${hits.length} en <project-state>: ${hits[0].trim().slice(0, 100)}`,
  };
}

// ---------------------------------------------------------------------------
// 7.10 sello dirty del sidecar
// ---------------------------------------------------------------------------

/** `ultron-memory version` (JSON): campo dirty presente y false. */
export function versionDirtyVerdict(output) {
  let j;
  try { j = JSON.parse(String(output ?? "").trim()); } catch { j = null; }
  if (!j || typeof j !== "object") return { pass: false, detail: `version no devuelve JSON: ${String(output ?? "").trim().slice(0, 80)}` };
  if (!("dirty" in j)) return { pass: false, detail: `binario sin sello dirty (anterior al build.rs del 2026-10-23): redeploy; git_sha=${j.git_sha ?? "?"}` };
  if (j.dirty === null) return { pass: false, detail: "dirty=null: binario compilado sin git, no se sabe si el arbol estaba limpio" };
  return { pass: j.dirty === false, detail: `dirty=${j.dirty} git_sha=${j.git_sha ?? "?"}` };
}

// ---------------------------------------------------------------------------
// 5.5 retencion / 18.6 tarea de backup
// ---------------------------------------------------------------------------

/** Copias de projects.json (.bak y .bak-*) y logs de backup fechados por tipo. */
export function retentionCounts(cockpitNames, logNames) {
  const bak = cockpitNames.filter((n) => n === "projects.json.bak" || n.startsWith("projects.json.bak-")).length;
  const backup = logNames.filter((n) => /^backup-\d{4}-\d{2}-\d{2}\.log(\.gz)?$/.test(n)).length;
  const robocopy = logNames.filter((n) => /^backup-\d{4}-\d{2}-\d{2}\.robocopy\.log(\.gz)?$/.test(n)).length;
  return { bak, backup, robocopy };
}

export function retentionVerdict({ bak, backup, robocopy }, { maxBak = 10, maxLogs = 8 } = {}) {
  const pass = bak <= maxBak && backup <= maxLogs && robocopy <= maxLogs;
  return { pass, detail: `projects.json.bak=${bak} (<=${maxBak}) backup-*.log=${backup} robocopy=${robocopy} (<=${maxLogs} por tipo)` };
}

/** Tarea vieja del backup: 0 referencias de codigo y no registrada (query null = no medible en este SO). */
export function staleBackupTaskVerdict({ codeRefs, taskRegistered }) {
  if (taskRegistered === null) return { skip: true, detail: `schtasks no disponible; referencias de codigo=${codeRefs}` };
  return {
    pass: codeRefs === 0 && taskRegistered === false,
    detail: `referencias de codigo a UltronBackup-Weekly=${codeRefs}; tarea registrada=${taskRegistered}`,
  };
}
