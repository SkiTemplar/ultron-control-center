/**
 * kirkardo/predicates.mjs — predicados PUROS de los checks del harness Kirkardo.
 *
 * Cada funcion decide pass/fail/skip a partir de datos ya leidos (salida de un
 * comando, lineas de un log, contenido de ficheros). No tocan disco, red ni
 * procesos: el selftest los prueba con fixtures, con casos positivos y
 * negativos, sin depender de la maquina (scripts/kirkardo-eval.selftest.mjs).
 *
 * Convencion de retorno: { pass: boolean, detail } o { skip: true, detail }.
 * skip = no medible aqui o sin elementos que juzgar: no puntua, pero sale en el
 * informe. Nunca verde por vacuidad.
 */

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** Mediana (promedio de las centrales si par); Infinity con el array vacio. */
export function median(arr) {
  if (!arr.length) return Infinity;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Ultimas `n` lineas no vacias de un texto. */
export function tailLines(text, n) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(-n)
    .join("\n");
}

/** Antepone `set -o pipefail` para que una tuberia devuelva el fallo de cualquier etapa. */
export function withPipefail(cmd) {
  return `set -o pipefail; ${cmd}`;
}

/** Linea de comentario JS/TS/Rust (//, /*, * de JSDoc). */
export function isCommentLine(text) {
  return /^\s*(\/\/|\/\*|\*)/.test(String(text ?? ""));
}

/** Fichero de test o e2e (no cuenta como consumidor de produccion). */
export function isTestPath(p) {
  return /(^|[/\\])(__tests__|__mocks__|e2e|tests?)([/\\])|\.(test|spec)\.[cm]?[jt]sx?$/i.test(String(p ?? ""));
}

// ---------------------------------------------------------------------------
// Comandos: codigo de salida real (7.1, 7.2, 3.1)
// ---------------------------------------------------------------------------

/**
 * 7.1. clippy con -D warnings: exit 0 y ningun diagnostico de error. Un lint
 * elevado a error sale como "error: ..." sin codigo E, asi que se busca en
 * cualquier linea (flag m), no solo al principio de la cola.
 */
export function clippyVerdict({ code, output }) {
  const out = String(output ?? "");
  if (code === null || code === undefined) {
    return { pass: false, detail: `clippy sin codigo de salida (timeout o no lanzado): ${tailLines(out, 3).slice(0, 160)}` };
  }
  const errLine = out.split(/\r?\n/).find((l) => /^error(\[E\d+\])?:/.test(l.trim()));
  const pass = code === 0 && !errLine;
  return {
    pass,
    detail: pass ? `exit 0, 0 errores (${tailLines(out, 1).slice(0, 120)})` : `exit=${code}: ${(errLine ?? tailLines(out, 2)).slice(0, 180)}`,
  };
}

/** 7.2. tsc --noEmit: exit 0 y ninguna linea "error TSnnnn". */
export function tscVerdict({ code, output }) {
  const out = String(output ?? "");
  const errors = out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
  const pass = code === 0 && errors.length === 0;
  return {
    pass,
    detail: pass ? "exit 0, 0 errores TS" : `exit=${code}, ${errors.length} error(es) TS: ${(errors[0] ?? tailLines(out, 2)).slice(0, 160)}`,
  };
}

/** 3.1. `<cli> --version`: exit 0 y la primera linea con una version semver. */
export function cliVersionVerdict({ code, output }, name = "claude") {
  const first = String(output ?? "").trim().split(/\r?\n/)[0] ?? "";
  const pass = code === 0 && /\b\d+\.\d+\.\d+\b/.test(first);
  return { pass, detail: pass ? first.slice(0, 80) : `${name} --version exit=${code}: ${first.slice(0, 80) || "(sin salida)"}` };
}

/** 7.5. cargo test: exit 0, >=1 linea "test result: ok" y ninguna FAILED. */
export function cargoTestVerdict({ code, output }) {
  const out = String(output ?? "");
  const results = [...out.matchAll(/test result: (ok|FAILED)\.\s*(\d+) passed;\s*(\d+) failed/g)];
  const failed = results.some((m) => m[1] === "FAILED" || Number(m[3]) > 0) || /^error(\[E\d+\])?:/m.test(out);
  const passed = results.reduce((a, m) => a + Number(m[2]), 0);
  const pass = code === 0 && results.length > 0 && !failed && passed > 0;
  return {
    pass,
    detail: pass
      ? `${results.length} binario(s) de test, ${passed} passed, 0 failed`
      : `exit=${code} resultados=${results.length} passed=${passed} failed=${failed}: ${tailLines(out, 2).slice(0, 160)}`,
  };
}

// ---------------------------------------------------------------------------
// 8.3 Finance
// ---------------------------------------------------------------------------

/** El modulo Finance existe como finance.rs o como directorio finance/ (mod.rs). */
export function financeSourcePresent(exists, join, tauriSrc) {
  return exists(join(tauriSrc, "finance.rs")) || exists(join(tauriSrc, "finance", "mod.rs"));
}

// ---------------------------------------------------------------------------
// 2.6 Consumo de codegraph en transcripts
// ---------------------------------------------------------------------------

const CODE_EXT = /\.(rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|swift|c|cc|cpp|h|hpp|cs|vue)$/i;

/** Llamadas de exploracion y uso de codegraph en las lineas JSONL de un transcript. */
export function transcriptToolUsage(lines) {
  let exploreCalls = 0;
  let usedCg = false;
  for (const ln of lines) {
    if (!ln || !ln.trim()) continue;
    let o;
    try { o = JSON.parse(ln); } catch { continue; }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || c.type !== "tool_use") continue;
      const nm = c.name || "";
      if (/codegraph/i.test(nm)) usedCg = true;
      if (nm === "Grep" || nm === "Glob") exploreCalls++;
      if (nm === "Read" && CODE_EXT.test(c.input?.file_path || "")) exploreCalls++;
    }
  }
  return { exploreCalls, usedCg };
}

/**
 * Ratio de sesiones que exploraron codigo (>= minExplore llamadas) y usaron
 * codegraph. El numerador solo cuenta sesiones del denominador.
 */
export function codegraphConsumption(usages, minExplore = 3) {
  const code = usages.filter((u) => u.exploreCalls >= minExplore);
  const cg = code.filter((u) => u.usedCg).length;
  const outside = usages.filter((u) => u.exploreCalls < minExplore && u.usedCg).length;
  if (code.length === 0) return { skip: true, detail: `sin sesiones que exploraran codigo (>=${minExplore} llamadas) en ${usages.length} transcripts` };
  const ratio = cg / code.length;
  return {
    pass: ratio >= 0.8,
    ratio,
    detail: `consumo codegraph: ${cg}/${code.length} sesiones de codigo (ratio ${ratio.toFixed(2)} vs >=0.80); ${outside} con codegraph sin explorar (fuera del ratio)`,
  };
}

// ---------------------------------------------------------------------------
// 6.1 Rutas personales
// ---------------------------------------------------------------------------

/** Ficheros (relativos) cuyo contenido casa alguno de los patrones. */
export function personalPathHits(files, patterns, allowedBasenames = []) {
  const hits = [];
  for (const f of files) {
    const base = f.path.split("/").pop();
    if (allowedBasenames.includes(base)) continue;
    if (patterns.some((p) => p.test(f.content))) hits.push(f.path);
  }
  return hits;
}

/** Heuristica de binario: un NUL en los primeros 8 KB. */
export function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 6.2 / 6.4
// ---------------------------------------------------------------------------

/** HIGH=<n> de la linea resumen de audit_personal_data.py; null si no aparece. */
export function auditHighCount(output) {
  const m = String(output ?? "").match(/\[audit-personal-data\][^\n]*\bHIGH=(\d+)/);
  return m ? Number(m[1]) : null;
}

/** 6.4: CLAUDE.md manda build:local para el escritorio Y desaconseja build:app para el escritorio. */
export function buildLocalDocVerdict(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const local = lines.some((l) => /build:local/.test(l) && /escritorio/i.test(l));
  const app = lines.some((l) => /build:app/.test(l) && /(no usar|p[uú]blico|sin finance)/i.test(l));
  return { pass: local && app, detail: `build:local+escritorio=${local}, build:app desaconsejado para escritorio=${app}` };
}

// ---------------------------------------------------------------------------
// 8.1 / 10.2 generate_handler!
// ---------------------------------------------------------------------------

/**
 * Comandos del bloque generate_handler![ ... ] de handlers.rs. La ultima
 * componente de cada ruta es el nombre; las precedidas de
 * #[cfg(feature = "finance")] van aparte. null si no hay bloque.
 */
export function parseGenerateHandler(text) {
  const src = String(text ?? "");
  const gs = src.indexOf("generate_handler![");
  if (gs < 0) return null;
  const rel = src.slice(gs).search(/\r?\n\s*\]\s*\)?;?\s*\r?\n/);
  if (rel < 0) return null;
  const registered = new Set();
  const finance = new Set();
  let gate = false;
  for (const raw of src.slice(gs, gs + rel).split("\n")) {
    const line = raw.trim();
    if (line.includes('feature = "finance"')) { gate = true; continue; }
    if (line.startsWith("//") || line.includes("generate_handler")) continue;
    const m = line.match(/^(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Za-z_][A-Za-z0-9_]*)\s*,?$/);
    if (!m) { gate = false; continue; }
    (gate ? finance : registered).add(m[1]);
    gate = false;
  }
  return { registered, finance };
}

// ---------------------------------------------------------------------------
// Gate de categorias
// ---------------------------------------------------------------------------

/**
 * Gate del GOAL: toda categoria con nota < threshold es laggard. Una categoria
 * sin checks medidos (total=0) NO sale del gate: cuenta como laggard con
 * unmeasured=true (nota 0).
 */
export function gateSummary(results, threshold) {
  const rated = results.filter((c) => c.total > 0);
  const unrated = results.filter((c) => !(c.total > 0));
  const worst = rated.length ? rated.reduce((m, c) => (c.nota < m.nota ? c : m)) : null;
  const laggards = [
    ...rated.filter((c) => c.nota < threshold).map((c) => ({ cat: c.cat, name: c.name, nota: Number(c.nota.toFixed(1)) })),
    ...unrated.map((c) => ({ cat: c.cat, name: c.name, nota: 0, unmeasured: true })),
  ].sort((a, b) => a.nota - b.nota || a.cat - b.cat);
  return { rated, unrated, worst, laggards, allCatsPass: laggards.length === 0 };
}

/** Icono del informe de texto: OK solo si la categoria pasa el gate. */
export function reportIcon(cat, threshold) {
  if (!(cat.total > 0)) return "??";
  if (cat.nota >= threshold) return "OK";
  return cat.nota >= 5 ? ".." : "!!";
}

/** Nombre del JSON de salida: un run acotado no pisa el canonico. */
export function reportFileName(isScoped) {
  return isScoped ? "kirkardo-eval.scoped.json" : "kirkardo-eval.json";
}

/**
 * Clasifica un check frente a la vigencia de su decision. statusOf(id) ->
 * { inForce, evidence }. Devuelve { kind: "retired"|"inactive"|"measure", note }.
 */
export function classifyByDecision(check, statusOf) {
  if (check.retiredBy) {
    const st = statusOf(check.retiredBy);
    if (st.inForce) return { kind: "retired", decision: check.retiredBy, status: st };
    return { kind: "measure", note: ` [decision ${check.retiredBy} FUERA de vigor (${st.evidence}): se mide]` };
  }
  if (check.onlyWhile) {
    const st = statusOf(check.onlyWhile);
    if (!st.inForce) return { kind: "inactive", decision: check.onlyWhile, status: st };
  }
  return { kind: "measure", note: "" };
}

// ---------------------------------------------------------------------------
// 12.6 CI de main
// ---------------------------------------------------------------------------

/**
 * Conclusion del ultimo run de CI en main (gh run list --json conclusion,status).
 * Rojo si no es success; skip si gh no esta disponible, no hay red o el run
 * sigue en curso. Con `head` ({ sha, timeMs }, ronda 2): rojo tambien si el run
 * es de otro commit y anterior a HEAD (el verde es de un main que ya no es el
 * que se mide).
 */
export function ciMainVerdict({ ok, stdout, stderr }, head = null) {
  const raw = `${stdout ?? ""}${stderr ?? ""}`.trim();
  if (!ok) return { skip: true, detail: `gh no disponible o sin red: ${raw.slice(0, 120) || "(sin salida)"}` };
  let arr;
  try { arr = JSON.parse(String(stdout ?? "").trim()); } catch { return { skip: true, detail: `gh devolvio JSON no parseable: ${raw.slice(0, 120)}` }; }
  if (!Array.isArray(arr) || arr.length === 0) return { pass: false, detail: "0 runs de CI en main" };
  const r = arr[0];
  const id = `${r.workflowName ?? "?"} #${r.databaseId ?? "?"} (${String(r.headSha ?? "").slice(0, 8)})`;
  if (r.status && r.status !== "completed") return { skip: true, detail: `${id} en curso (status=${r.status}); no medible ahora` };
  const success = r.conclusion === "success";
  if (!head) return { pass: success, detail: `${id} conclusion=${r.conclusion || "(vacia)"}` };
  const sameSha = !!head.sha && String(r.headSha ?? "").startsWith(head.sha);
  const created = Date.parse(r.createdAt ?? "");
  const after = sameSha || (Number.isFinite(created) && Number.isFinite(head.timeMs) && created >= head.timeMs);
  return {
    pass: success && after,
    detail: `${id} conclusion=${r.conclusion || "(vacia)"}; ${after ? "posterior a" : "ANTERIOR a"} HEAD ${String(head.sha ?? "?").slice(0, 8)} (run ${r.createdAt ?? "?"})`,
  };
}

// ---------------------------------------------------------------------------
// Ventanas moviles (3.4, 15.3, 16.5)
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;

/** ¿Alguna fecha YYYY-MM-DD (o ISO) cae en los ultimos `days` dias respecto a now? */
export function anyDateWithin(dates, nowMs, days) {
  return dates.some((d) => {
    const t = Date.parse(String(d ?? "").length === 10 ? `${d}T23:59:59Z` : d);
    return Number.isFinite(t) && nowMs - t <= days * DAY_MS && t - nowMs <= DAY_MS;
  });
}

/**
 * 15.3: el router deja {zona, modelo, proveedor, resultado} por decision.
 * Ventana movil de `days` dias sobre logs/route-decisions.jsonl.
 */
export function routeDecisionsVerdict(lines, nowMs, days) {
  const rows = [];
  for (const l of lines) {
    try { rows.push(JSON.parse(l)); } catch { /* linea rota: no cuenta */ }
  }
  const recent = rows.filter((r) => Number.isFinite(Date.parse(r.ts)) && nowMs - Date.parse(r.ts) <= days * DAY_MS);
  if (recent.length === 0) return { pass: false, detail: `0 decisiones de ruta en los ultimos ${days} dias (${rows.length} en el log)` };
  const complete = recent.filter((r) => r.zone && r.model && r.provider_id && typeof r.used_fallback === "boolean");
  const zones = [...new Set(recent.map((r) => r.zone))].join(",");
  return {
    pass: complete.length === recent.length,
    detail: `${recent.length} decisiones en ${days} dias (zonas=${zones}); completas {zona,modelo,proveedor,fallback}=${complete.length}/${recent.length}; los fallos totales de ruta no se registran`,
  };
}

/**
 * Muestras de trafico real de un hook en hook-tokens.jsonl: ventana movil de
 * `days` dias y fuera las rafagas (entradas a menos de burstMs de otra del
 * mismo hook), que son corridas del harness o de un selftest, no prompts.
 */
export function realTrafficSamples(entries, hook, { nowMs, days, burstMs }) {
  const rows = entries
    .filter((e) => e && e.hook === hook && typeof e.est_tokens === "number" && Number.isFinite(Date.parse(e.ts)))
    .map((e) => ({ t: Date.parse(e.ts), v: e.est_tokens }))
    .sort((a, b) => a.t - b.t);
  const inBurst = (i) =>
    (i > 0 && rows[i].t - rows[i - 1].t < burstMs) || (i + 1 < rows.length && rows[i + 1].t - rows[i].t < burstMs);
  return rows.filter((r, i) => nowMs - r.t <= days * DAY_MS && !inBurst(i)).map((r) => r.v);
}

// ---------------------------------------------------------------------------
// 21.3 TTL con control positivo
// ---------------------------------------------------------------------------

/**
 * El recall debe devolver el item de control (sin caducidad) y NO el caducado.
 * Sin el control, el recall no ha demostrado funcionar: no medible.
 */
export function ttlProbeVerdict(entries, { controlTitle, expiredTitle }) {
  const text = (e) => `${e?.title ?? ""} ${e?.summary ?? ""}`;
  const control = entries.some((e) => text(e).includes(controlTitle));
  const expired = entries.some((e) => text(e).includes(expiredTitle));
  if (!control) return { pass: false, detail: `no medible: el control positivo (item vigente) no sale en el recall (${entries.length} entries)` };
  return {
    pass: !expired,
    detail: expired
      ? `el item con expires_at pasado SALE en el recall junto al control (${entries.length} entries): TTL no honrado`
      : `control vigente recuperado y caducado excluido (${entries.length} entries): TTL honrado`,
  };
}

// ---------------------------------------------------------------------------
// 7.9 hooks del manifest
// ---------------------------------------------------------------------------

/**
 * Scripts unicos de hooks/manifest.json con el primer evento que los declara.
 * `repo` (opcional): raiz del codigo medido; los `~/.ultron/...` se resuelven
 * ahi, asi un worktree mide SUS hooks y no los del checkout principal.
 */
export function manifestHookScripts(manifest, home, repo = null) {
  const seen = new Map();
  for (const h of manifest?.hooks ?? []) {
    if (!h?.script) continue;
    const raw = repo ? h.script.replace(/^~[/\\]\.ultron(?=[/\\])/, repo) : h.script;
    const p = raw.replace(/^~/, home).replace(/\\/g, "/");
    if (!seen.has(p)) seen.set(p, h.event ?? "");
  }
  return [...seen.entries()].map(([script, event]) => ({ script, event }));
}

// ---------------------------------------------------------------------------
// 4.9 modelos de agentes y alias
// ---------------------------------------------------------------------------

const ALLOWED_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "inherit"]);
const ALIAS_TARGET = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };

/** `model:` y `maxTurns:` del frontmatter YAML de un agente. */
export function agentFrontmatter(text) {
  const fm = String(text ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = fm ? fm[1] : "";
  const val = (k) => (body.match(new RegExp(`^${k}:\\s*(.+)$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "") ?? null;
  return { model: val("model"), maxTurns: val("maxTurns") };
}

/**
 * Agentes de usuario (activos y activables) solo con la familia 5.5 y con
 * maxTurns; los alias opus/sonnet/haiku del env fijados a su modelo 5.5.
 */
export function agentModelVerdict(agents, env) {
  const aliasBad = Object.entries(ALIAS_TARGET)
    .filter(([a, target]) => env?.[`ANTHROPIC_DEFAULT_${a.toUpperCase()}_MODEL`] !== target)
    .map(([a]) => `${a}->${env?.[`ANTHROPIC_DEFAULT_${a.toUpperCase()}_MODEL`] ?? "(ausente)"}`);
  const aliasOk = (m) => ALIAS_TARGET[m] && !aliasBad.some((b) => b.startsWith(`${m}->`));
  const badModel = agents.filter((a) => a.model && !ALLOWED_MODELS.has(a.model) && !aliasOk(a.model));
  const noTurns = agents.filter((a) => !a.maxTurns);
  if (agents.length === 0) return { skip: true, detail: "0 agentes de usuario en ~/.claude/agents" };
  const fmt = (xs) => xs.slice(0, 4).map((a) => `${a.name}${a.disabled ? "(off)" : ""}=${a.model ?? "-"}`).join(", ");
  return {
    pass: aliasBad.length === 0 && badModel.length === 0 && noTurns.length === 0,
    detail: `${agents.length} agentes: modelo fuera de 5.5=${badModel.length}${badModel.length ? ` [${fmt(badModel)}]` : ""}; sin maxTurns=${noTurns.length}; alias mal fijados=${aliasBad.join(",") || 0}`,
  };
}

// ---------------------------------------------------------------------------
// 11.6 secretos en la config de MCP
// ---------------------------------------------------------------------------

const SECRET_RES = [
  /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bgsk_[A-Za-z0-9]{20,}/, /\bAIza[0-9A-Za-z_-]{30,}/,
];

/** Servidores MCP con un token en claro en args/env/headers/url. */
export function mcpSecretHits(servers) {
  const hits = [];
  for (const [name, conf] of Object.entries(servers ?? {})) {
    const txt = JSON.stringify(conf ?? {});
    if (SECRET_RES.some((re) => re.test(txt))) hits.push(name);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 11.5 cadena de llamadas Rust hasta la escritura a disco
// ---------------------------------------------------------------------------

/** Cuerpos de las fn de un fuente Rust: Map nombre -> cuerpo (llaves balanceadas). */
export function rustFnBodies(text) {
  const src = String(text ?? "");
  const out = new Map();
  const re = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>{]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf("{", m.index);
    if (open < 0) break;
    const semi = src.indexOf(";", m.index);
    if (semi >= 0 && semi < open) continue; // declaracion sin cuerpo (trait)
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) { end = i; break; }
    }
    if (end < 0) break;
    if (!out.has(m[1])) out.set(m[1], src.slice(open + 1, end));
  }
  return out;
}

const PERSIST_RE = /\bfs::(write|rename)\b|\bwrite_private\s*\(|\bsettings_save_inner\s*\(/;

/**
 * Camino de llamadas desde `start` hasta una primitiva de escritura a disco
 * (fs::write/rename, write_private, settings_save_inner), sobre los cuerpos
 * conocidos. null si no llega en maxDepth saltos.
 */
export function persistencePath(bodies, start, maxDepth = 5) {
  const queue = [[start]];
  const seen = new Set([start]);
  while (queue.length) {
    const path = queue.shift();
    const body = bodies.get(path[path.length - 1]);
    if (body === undefined) continue;
    if (PERSIST_RE.test(body)) return path;
    if (path.length > maxDepth) continue;
    for (const c of body.matchAll(/\b([a-z_][a-z0-9_]*)\s*(?:::<[^>]*>)?\s*\(/g)) {
      if (bodies.has(c[1]) && !seen.has(c[1])) {
        seen.add(c[1]);
        queue.push([...path, c[1]]);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2.8 indice por proyecto
// ---------------------------------------------------------------------------

/** Proyectos con codigo y sin indice codegraph util (ausente o 0 ficheros). */
export function projectIndexVerdict(projects) {
  const withCode = projects.filter((p) => p.codeFiles > 0);
  if (withCode.length === 0) return { skip: true, detail: `0 proyectos registrados con codigo (de ${projects.length})` };
  const missing = withCode.filter((p) => !(p.indexedFiles > 0));
  return {
    pass: missing.length === 0,
    detail: `${withCode.length - missing.length}/${withCode.length} proyectos con codigo indexados` +
      (missing.length ? `; sin indice util: ${missing.slice(0, 6).map((p) => `${p.id}(${p.indexedFiles === null ? "sin .codegraph" : "0 ficheros"})`).join(", ")}` : ""),
  };
}

// ---------------------------------------------------------------------------
// 17.5 compactacion
// ---------------------------------------------------------------------------

/**
 * Contenido real de un compact.json: decisions/next/bugs no vacios o
 * facts_extracted > 0. arch_delta NO cuenta: es el git log de los ultimos
 * commits y esta siempre lleno.
 */
export function compactContent(j) {
  const nonEmpty = (v) => Array.isArray(v) && v.length > 0;
  const arrays = ["decisions", "next", "bugs"].filter((k) => nonEmpty(j?.[k]));
  const facts = Number(j?.machine?.facts_extracted ?? j?.facts_extracted ?? 0);
  return { pass: arrays.length > 0 || facts > 0, arrays, facts };
}
