/**
 * kirkardo/predicates-r3.mjs — predicados PUROS de la ronda 3 (2026-10-28,
 * docs/audits/audit-2026-10-28-kirkardo-criterio.md, plan P1-P9).
 *
 * Misma convencion que predicates.mjs: { pass, detail }, { skip: true, detail }
 * o { manual: true, detail }. Sin disco, red ni procesos: los prueba
 * scripts/kirkardo/selftest-r3.mjs (invocado desde kirkardo-eval.selftest.mjs).
 */

// ---------------------------------------------------------------------------
// P1 · "no arranco" frente a "fallo"
// ---------------------------------------------------------------------------

// Solo un fallo real de arranque es infraestructura (auditoria 2026-11-01): el
// proceso no llego a ejecutar su codigo. Un timeout o un crash (0xC0000005,
// senal, sin codigo de salida) son del producto: el proceso arranco y se colgo o
// se cayo, asi que el check da rojo. Antes salian manual y una sonda colgada
// puntuaba mejor que una sonda en rojo.
const START_FAILURE_CODES = new Map([
  [0xc0000142, "0xC0000142 STATUS_DLL_INIT_FAILED (no se pudo crear el proceso)"],
]);
// spawnSync informa en r.error tanto un spawn fallido como la muerte de un
// proceso que ya corria: estos dos codigos son lo segundo.
const RAN_THEN_KILLED = new Set(["ETIMEDOUT", "ENOBUFS"]);

function unsigned(code) {
  return typeof code === "number" && code < 0 ? code >>> 0 : code;
}

/**
 * Causa de infraestructura de un resultado de spawnSync, o null si el proceso
 * llego a arrancar. r = { status, signal, error }.
 */
export function spawnInfraCause(r) {
  if (!r) return "sin resultado del proceso";
  if (r.error && !RAN_THEN_KILLED.has(r.error.code)) {
    return `no se pudo lanzar el proceso (${r.error.code || String(r.error.message ?? r.error).slice(0, 60)})`;
  }
  return START_FAILURE_CODES.get(unsigned(r.status)) ?? null;
}

/**
 * Fallo del producto de un proceso que si arranco: timeout, crash NTSTATUS o
 * muerte sin codigo de salida. null si termino con un codigo propio o si no
 * llego a arrancar. No excusa el rojo: solo lo explica en el detalle.
 */
export function spawnProductFault(r) {
  if (!r || spawnInfraCause(r)) return null;
  if (r.error?.code === "ETIMEDOUT") return "timeout: el proceso no termino en su tope";
  if (r.error?.code === "ENOBUFS") return "salida por encima del tope de buffer";
  const st = unsigned(r.status);
  if (st === null || st === undefined) return `sin codigo de salida${r.signal ? ` (senal ${r.signal})` : ""}`;
  return st >= 0xc0000000 ? `crash 0x${st.toString(16).toUpperCase()}` : null;
}

/** Solo se reintenta lo que no llego a arrancar (un timeout no se repite). */
export function isRetryableInfra(r) {
  return spawnInfraCause(r) !== null;
}

/**
 * Registro de causas tras un spawn. Un proceso posterior que arranca vacia el
 * registro: la causa debe venir del ultimo proceso del check, el que decide su
 * veredicto, y no de un auxiliar anterior que ya no explica el rojo.
 */
export function nextInfraLog(log, label, cause) {
  return cause ? [...log, `${String(label).slice(0, 60)}: ${cause}`] : [];
}

/**
 * Veredicto final de un check. Un rojo cuyo ultimo proceso no arranco sale
 * manual con la causa, nunca verde ni rojo del producto. Un rojo con un proceso
 * colgado o caido sigue rojo, con el fallo en el detalle. Un verde o un
 * skip/manual se respetan.
 */
export function applyInfra(result, infraCauses, productFaults = []) {
  if (result?.pass || result?.skip || result?.manual) return result;
  if (infraCauses?.length) {
    const causes = [...new Set(infraCauses)].slice(0, 2).join("; ");
    return { manual: true, infra: true, detail: `no ejecutable (infraestructura, no fallo del producto): ${causes} | detalle del check: ${String(result?.detail ?? "").slice(0, 120)}` };
  }
  if (!productFaults?.length) return result;
  const faults = [...new Set(productFaults)].slice(0, 2).join("; ");
  return { ...result, detail: `${result?.detail ?? ""} [proceso colgado o caido: ${faults}]` };
}

// ---------------------------------------------------------------------------
// P3 · nota ponderada por areas
// ---------------------------------------------------------------------------

/**
 * checks = [{ area, status }] de toda la corrida; areas = [{ id, name, weight }].
 * Nota de area = pass/total*10 si tiene >= minChecks medidos; si no, "sin
 * medir" (nota 0 en la media y laggard). overall = media ponderada de las
 * areas con peso; overall_core = media simple de esas mismas areas. Las areas
 * de peso 0 se informan y pueden ser laggard informativo, pero no gatean.
 */
export function areaSummary(checks, areas, { threshold = 9.5, minChecks = 5 } = {}) {
  const rows = areas.map((a) => {
    const mine = checks.filter((c) => c.area === a.id);
    const pass = mine.filter((c) => c.status === "pass").length;
    const total = mine.filter((c) => c.status === "pass" || c.status === "fail").length;
    const measured = total >= minChecks;
    const nota = measured ? (pass / total) * 10 : 0;
    return {
      id: a.id, name: a.name, weight: a.weight, pass, total, measured,
      manual: mine.filter((c) => c.status === "manual").length,
      nota: Number(nota.toFixed(2)),
    };
  });
  const weighted = rows.filter((r) => r.weight > 0);
  const wSum = weighted.reduce((s, r) => s + r.weight, 0);
  const overall = wSum > 0 ? weighted.reduce((s, r) => s + r.nota * r.weight, 0) / wSum : 0;
  const overallCore = weighted.length ? weighted.reduce((s, r) => s + r.nota, 0) / weighted.length : 0;
  const lag = (r) => !r.measured || r.nota < threshold;
  const toLag = (r) => ({ area: r.id, name: r.name, nota: r.nota, ...(r.measured ? {} : { unmeasured: true }) });
  return {
    areas: rows,
    overall: Number(overall.toFixed(2)),
    overall_core: Number(overallCore.toFixed(2)),
    gate: weighted.filter(lag).map(toLag).sort((a, b) => a.nota - b.nota),
    informative: rows.filter((r) => r.weight === 0 && lag(r)).map(toLag),
  };
}

// ---------------------------------------------------------------------------
// S7 · binario de la app compilado desde HEAD o posterior
// ---------------------------------------------------------------------------

// Contrato con build_stamp::APP_STAMP (src-tauri/src/build_stamp.rs).
const APP_STAMP_RE = /ULTRON_BUILD_STAMP:sha=([0-9a-f]{4,40}|unknown);dirty=(true|false|unknown);/;

/** Sello de la app en los bytes del .exe: { sha, dirty }, o null si no lo lleva. */
export function parseAppStamp(binaryLatin1) {
  const m = String(binaryLatin1 ?? "").match(APP_STAMP_RE);
  return m ? { sha: m[1], dirty: m[2] === "unknown" ? null : m[2] === "true" } : null;
}

/**
 * Misma regla que el sidecar (7.10): un binario con dirty=true no identifica un
 * commit, y dirty desconocido tampoco se da por limpio. commitsSince = commits
 * que tocan control-center/ entre el SHA del sello y HEAD (null = no calculable).
 */
export function binaryFreshnessVerdict({ stamp, headSha, commitsSince }) {
  if (!stamp) return { pass: false, detail: `el .exe no lleva sello de compilacion (HEAD ${headSha}): binario anterior a build_stamp::APP_STAMP; recompilar con npm run build:local` };
  if (stamp.sha === "unknown") return { pass: false, detail: "el .exe se compilo sin git: sello sha=unknown" };
  if (stamp.dirty !== false) return { pass: false, detail: `binario de ${stamp.sha} con dirty=${stamp.dirty}: compilado con cambios sin commitear o sin saberlo, no identifica un commit (HEAD ${headSha})` };
  if (commitsSince === null || commitsSince === undefined) return { pass: false, detail: `no medible: no se pudieron contar los commits ${stamp.sha}..${headSha}` };
  return {
    pass: commitsSince === 0,
    detail: commitsSince === 0
      ? `binario de ${stamp.sha} (dirty=false); 0 commits en control-center/ hasta HEAD ${headSha}`
      : `binario de ${stamp.sha}; ${commitsSince} commit(s) en control-center/ posteriores sin recompilar (HEAD ${headSha})`,
  };
}

// ---------------------------------------------------------------------------
// S5 · persistencia viva de Sessions
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;

/** file = { exists, parses } de abiertas.json; bads = [{ name, mtimeMs }] de la carpeta. */
export function sessionsPersistenceVerdict({ file, bads }, nowMs, days = 7) {
  const recent = bads.filter((b) => /^abiertas\..*json\.bad$/.test(b.name) && nowMs - b.mtimeMs <= days * DAY_MS);
  if (!file.exists) return { skip: true, detail: "abiertas.json ausente (Sessions sin sesiones abiertas guardadas)" };
  return {
    pass: file.parses && recent.length === 0,
    detail: `abiertas.json parsea=${file.parses}; .json.bad de los ultimos ${days} dias=${recent.length}${recent.length ? ` [${recent.map((b) => b.name).slice(0, 3).join(",")}]` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// K1 / M2 · sondas de hooks
// ---------------------------------------------------------------------------

/** Decision de un hook a partir de su stdout: "deny" | "ask" | "allow" | null (no decide). */
export function hookDecision(stdout) {
  const raw = String(stdout ?? "").trim();
  if (!raw) return null;
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  const h = j?.hookSpecificOutput ?? {};
  return h.permissionDecision ?? h.decision?.behavior ?? (j?.decision === "block" ? "deny" : null);
}

/**
 * probes = [{ label, expect: "deny"|"block"|"pass", got, ms, code }]. Verde si cada
 * sonda decide lo esperado, hay al menos una positiva y una de control, y
 * ninguna sale con exit != 0. "pass" acepta null o allow.
 */
export function hookProbesVerdict(probes) {
  if (!probes?.length) return { pass: false, detail: "no medible: 0 sondas" };
  // "block" acepta deny o ask (el hook frena y pide permiso); "deny" exige deny.
  const blocks = (p) => p.expect === "deny" || p.expect === "block";
  const okGot = (p) => (p.expect === "deny" ? p.got === "deny" : p.expect === "block" ? p.got === "deny" || p.got === "ask" : p.got === null || p.got === "allow");
  const ok = (p) => p.code === 0 && okGot(p);
  const wrong = probes.filter((p) => !ok(p));
  const pos = probes.filter(blocks).length;
  return {
    pass: wrong.length === 0 && pos > 0 && pos < probes.length,
    detail: `${probes.length - wrong.length}/${probes.length} sondas como se espera (${pos} de bloqueo, ${probes.length - pos} control)` +
      (wrong.length ? `; mal: ${wrong.map((p) => `${p.label}=>${p.got ?? "sin decision"} exit=${p.code}`).join(" | ")}` : ""),
  };
}

/**
 * M2 · pupus-permission nunca bloquea: sin puente y con el puente caido sale
 * con exit 0, sin decision y en < maxMs; con un puente falso que responde
 * deny, la salida lleva deny (control positivo).
 */
export function pupusPermissionVerdict({ noBridge, deadBridge, denyBridge }, maxMs = 2000) {
  const quiet = (p) => p && p.code === 0 && p.got === null && p.ms < maxMs;
  const bad = [];
  if (!quiet(noBridge)) bad.push(`sin puente: exit=${noBridge?.code} decision=${noBridge?.got} ${noBridge?.ms}ms`);
  if (!quiet(deadBridge)) bad.push(`puente caido: exit=${deadBridge?.code} decision=${deadBridge?.got} ${deadBridge?.ms}ms`);
  if (denyBridge?.got !== "deny") bad.push(`control positivo: el puente respondio deny y el hook dio ${denyBridge?.got ?? "nada"}`);
  return {
    pass: bad.length === 0,
    detail: bad.length ? bad.join(" | ") : `sin puente ${noBridge.ms}ms y puente caido ${deadBridge.ms}ms sin decision (< ${maxMs}ms); puente que deniega -> deny`,
  };
}

// ---------------------------------------------------------------------------
// G1 · ficheros referenciados por el codigo y sin trackear
// ---------------------------------------------------------------------------

/** Destinos relativos de include_str!/include_bytes!/#[path] y `mod x;` de un fuente Rust. */
export function rustRefTargets(text) {
  const src = String(text ?? "");
  const out = [];
  for (const m of src.matchAll(/\binclude_(?:str|bytes)!\s*\(\s*"([^"]+)"\s*\)/g)) out.push({ kind: "include", target: m[1] });
  const pathed = new Set();
  for (const m of src.matchAll(/#\[path\s*=\s*"([^"]+)"\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g)) {
    out.push({ kind: "path", target: m[1] });
    pathed.add(m[2]);
  }
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*\/\//.test(line)) continue;
    const m = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/);
    if (m && !pathed.has(m[1])) out.push({ kind: "mod", target: m[1] });
  }
  return out;
}

/** Imports relativos ('./x', '../y') de un fuente TS/JS, sin los de tipo puro. */
export function tsImportTargets(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'"\n;]*?from\s+["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
    out.push(m[1] ?? m[2]);
  }
  return out;
}

/** refs = [{ from, to }] con `to` ya resuelto a ruta relativa del repo; untracked = Set de rutas. */
export function untrackedRefsVerdict(refs, untracked, { exclude = [] } = {}) {
  const skip = (p) => exclude.some((e) => p.startsWith(e));
  const hits = refs.filter((r) => untracked.has(r.to) && !skip(r.to) && !skip(r.from) && !untracked.has(r.from));
  const uniq = [...new Map(hits.map((h) => [h.to, h])).values()];
  if (refs.length === 0) return { pass: false, detail: "no medible: 0 referencias extraidas del codigo" };
  return {
    pass: uniq.length === 0,
    detail: `${refs.length} referencias desde ficheros trackeados; destinos sin trackear=${uniq.length}` +
      (uniq.length ? `: ${uniq.slice(0, 6).map((h) => `${h.to} (desde ${h.from})`).join(", ")}` : ""),
  };
}

// ---------------------------------------------------------------------------
// P5 · tombstones y secretos en JSON de configuracion
// ---------------------------------------------------------------------------

/** sources = [{ label, text }]; patterns = [{ id, re, in? }] (in = etiquetas donde cuenta). Verde con 0 reapariciones. */
export function tombstonesVerdict(sources, patterns) {
  if (!sources.length) return { pass: false, detail: "no medible: 0 fuentes leidas" };
  const hits = [];
  for (const p of patterns) {
    for (const s of sources) {
      if (p.in && !p.in.includes(s.label)) continue;
      if (s.text && p.re.test(s.text)) hits.push(`${p.id}@${s.label}`);
    }
  }
  return {
    pass: hits.length === 0,
    detail: `${patterns.length} lapidas en ${sources.length} fuentes; reintroducidas=${hits.length}${hits.length ? `: ${hits.slice(0, 6).join(", ")}` : ""}`,
  };
}

const KEY_RES = [
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}/, /\bgsk_[A-Za-z0-9]{20,}/, /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bxai-[A-Za-z0-9]{20,}/, /\bnvapi-[A-Za-z0-9_-]{20,}/,
];

/** files = [{ name, text }]: ficheros con un patron de clave en claro. */
export function configSecretHits(files) {
  return files.filter((f) => KEY_RES.some((re) => re.test(String(f.text ?? "")))).map((f) => f.name);
}

/**
 * D3 · paridad JS/Rust de la configuracion de delegacion. js = status --json
 * sin delegation.json; def = delegation.default.json (el que incrusta Rust);
 * badChain = cadena que muestra status con un delegation.json invalido (un
 * tier sin start). Verde si la cadena coincide, los tiers (si status los
 * expone) coinciden y la configuracion invalida NO se adopta.
 */
export function delegationParityVerdict(js, def, { badChain = null, badFixtureChain = [] } = {}) {
  if (!js || !def) return { pass: false, detail: `no medible: status JS=${!!js} default=${!!def}` };
  const chain = (c) => (c?.chain ?? []).map((e) => (typeof e === "string" ? e : e.id ?? e.engine)).join(">");
  const starts = (c) => Object.entries(c.tiers ?? {}).map(([k, v]) => `${k}:${v?.start ?? "?"}`).sort().join(",");
  const sameChain = chain(js) !== "" && chain(js) === chain(def);
  const sameTiers = !js.tiers || starts(js) === starts(def);
  const adoptedBad = badChain !== null && badChain.join(">") === badFixtureChain.join(">");
  return {
    pass: sameChain && sameTiers && !adoptedBad,
    detail: `cadena JS=[${chain(js)}] default=[${chain(def)}]${js.tiers ? `; tiers JS={${starts(js)}} default={${starts(def)}}` : ""}; config invalida adoptada por JS=${adoptedBad}`,
  };
}

// ---------------------------------------------------------------------------
// 6.6 · rutas citadas en la documentacion
// ---------------------------------------------------------------------------

// Una linea que cuenta una retirada cita rutas que ya no existen a proposito.
const HISTORIC_LINE = /retir|borrad|elimin|jubil|ya no |antes|desconect|obsolet|recuperar|legacy|sustitu|troce/i;
const PATH_LIKE = /^[\w.@-]+(?:\/[\w.@-]+)*\/?$/;
const FILE_EXT = /\.(?:rs|tsx?|m?js|json|py|ps1|sh|toml|ya?ml|md|html)$/;
// Rutas de la maquina del usuario, no del repo.
const RUNTIME_PATH = /^(?:\.claude\/|_disabled\/)/;

/**
 * Rutas de codigo citadas entre comillas invertidas en un .md. Solo cuenta lo
 * inequivoco (con directorio y extension conocida, o directorio con barra final);
 * sin ~/, globs, placeholders ni lineas que narran una retirada.
 */
export function citedPaths(markdown) {
  const out = [];
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    if (HISTORIC_LINE.test(line)) continue;
    for (const m of line.matchAll(/`([^`\s]+)`/g)) {
      const raw = m[1].replace(/::.*$/, "").replace(/:\d+$/, "");
      if (!raw.includes("/") || !PATH_LIKE.test(raw) || RUNTIME_PATH.test(raw)) continue;
      if (FILE_EXT.test(raw) || raw.endsWith("/")) out.push(raw);
    }
  }
  return [...new Set(out)];
}

/** docs = [{ name, paths }]; exists(ruta) resuelve contra las raices del repo. */
export function citedPathsVerdict(docs, exists) {
  const total = docs.reduce((s, d) => s + d.paths.length, 0);
  if (total === 0) return { pass: false, detail: "no medible: 0 rutas citadas" };
  const broken = docs.flatMap((d) => d.paths.filter((p) => !exists(p)).map((p) => `${d.name}: ${p}`));
  return {
    pass: broken.length === 0,
    detail: `${total} rutas citadas en ${docs.length} documentos; inexistentes=${broken.length}${broken.length ? `: ${broken.slice(0, 6).join(", ")}` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// S4 · Playwright
// ---------------------------------------------------------------------------

/** Salida de `playwright test --reporter=line`: exit 0, 0 failed y >= minPassed passed. */
export function playwrightVerdict({ code, output }, { minPassed = 1 } = {}) {
  // Sin colores ni movimientos de cursor del reporter line (\x1b[1A\x1b[2K).
  const out = String(output ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const passed = Number((out.match(/^\s*(\d+) passed/m) || [])[1] ?? 0);
  const failed = Number((out.match(/^\s*(\d+) failed/m) || [])[1] ?? 0);
  const flaky = Number((out.match(/^\s*(\d+) flaky/m) || [])[1] ?? 0);
  if (!passed && !failed) {
    const firstErr = (out.match(/^Error:[^\n]*/m) || [""])[0];
    return { pass: false, detail: `exit=${code} sin resumen de playwright: ${(firstErr || out.trim().split(/\r?\n/).slice(-2).join(" ")).slice(0, 140)}` };
  }
  const firstFail = (out.match(/^\s*\d+\)\s[^\n]*/m) || [""])[0].trim();
  return {
    pass: code === 0 && failed === 0 && passed >= minPassed,
    detail: `${passed} passed, ${failed} failed, ${flaky} flaky (minimo ${minPassed}), exit=${code}${firstFail ? `; primero: ${firstFail.slice(0, 110)}` : ""}`,
  };
}

/** Selftest con resumen "N ok, M fallos": exit 0, M == 0 y N >= minOk. */
export function okFallosVerdict({ code, output }, { minOk = 1 } = {}) {
  const m = String(output ?? "").match(/(\d+) ok, (\d+) fallos?/);
  if (!m) return { pass: false, detail: `exit=${code} sin resumen 'N ok, M fallos': ${String(output ?? "").trim().split(/\r?\n/).slice(-1)[0]?.slice(0, 120) ?? ""}` };
  const [okN, bad] = [Number(m[1]), Number(m[2])];
  return { pass: code === 0 && bad === 0 && okN >= minOk, detail: `${okN} ok, ${bad} fallos (minimo ${minOk}), exit=${code}` };
}
