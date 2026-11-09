// kirkardo/hook-io.mjs — E/S compartida: hooks de resume/orchestrate y lectura de brain.db.
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HOOKS_SCRIPTS, ULTRON, ULTRON_MEM, spawnHook, spawnTracked } from "./core.mjs";

// ---------------------------------------------------------------------------
// E/S compartida de hooks y brain.db (la usan varias categorias)
// ---------------------------------------------------------------------------
// Desde el 2026-10-23 todos estos spawns van por spawnHook (HOME aislado): el
// rastro de 9.3 se cuenta en el hook-errors.jsonl del sandbox.
export const ORCH_HOOK = join(HOOKS_SCRIPTS, "memory-orchestrate.js");

// ---------------------------------------------------------------------------
// cat19 e2e — el ARTEFACTO real, no el binario a mano
// ---------------------------------------------------------------------------
// runResume() llama al binario directamente; eso NO es lo que el usuario recibe.
// Lo que llega a su contexto lo produce el hook memory-session-resume.js
// (lee cwd via stdin -> projectIdFromCwd -> render -> additionalContext).
// cat19 debe ejecutar ESE hook y aseverar sobre su salida. (Sprint 2026-06-24,
// causa raiz: cat19=10/10 mientras el resume inyectado llegaba PODRIDO.)
export const RESUME_HOOK = join(HOOKS_SCRIPTS, "memory-session-resume.js");

// Ejecuta el HOOK real con stdin {cwd} y devuelve el additionalContext + el
// bloque <ultron-memory-resume> parseado por secciones.
// HOME aislado con el sidecar real (el resume solo lee) y sin session_id: nada
// que resumir ni fusionar en la bitacora de produccion.
export function runResumeHook(cwd) {
  const r = spawnHook(RESUME_HOOK, { cwd, source: "startup", hook_event_name: "SessionStart" }, { realBin: true });
  if (r.error) return { ok: false, raw: String(r.error) };
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
    // Un bloque anidado (<project-state>, la bitacora) o una clave ajena
    // (memorias_por_revisar:, head:) cierra la seccion. Sin esto, todo lo que
    // seguia a next_action se le concatenaba y 19.4 juzgaba el texto de la
    // bitacora ("commitear el diff") como si fuera el next_action.
    if (!h && (/^<\/?[a-z-]+/i.test(line) || /^[a-z_]+:\s/i.test(line))) {
      section = null;
      continue;
    }
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

export const BRAIN_DB = join(ULTRON, "brain.db");

// Ejecuta `sql` (SELECT) sobre brain.db INLINE (mismo patron probado que
// readCodegraphDb en cat2: node:sqlite via getBuiltinModule, sincrono). El
// subproceso base64 anterior petaba con "statement has been finalized".
// Devuelve { rows } | { err } | { nodata } (BD ausente: clon limpio/CI). NUNCA lanza.
export function sql20(sql) {
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

// ---------------------------------------------------------------------------
// 20.4 / 20.5 contra una brain.db TEMPORAL (2026-10-28, P8 de la auditoria del
// criterio): antes creaban candidatos en la brain.db de produccion y los
// rechazaban despues, con rastro si el proceso moria a mitad. Con
// ULTRON_BRAIN_DB el sidecar no usa el daemon y crea el esquema en la ruta
// pedida (la misma costura que 21.3). Devuelve { candidate(payload) ->
// { id, out, infra }, query(sql) -> rows }; el directorio se borra al salir.
// ---------------------------------------------------------------------------
export function withTempBrain(fn) {
  const dir = mkdtempSync(join(tmpdir(), "kirkardo-brain-"));
  const db = join(dir, "brain.db");
  const env = { ...process.env, ULTRON_BRAIN_DB: db };
  const mem = (args, input) =>
    spawnTracked(ULTRON_MEM, args, { env, input, encoding: "utf8", timeout: 30000, windowsHide: true, cwd: dir }, `ultron-memory ${args[0]}`);
  try {
    const st = mem(["stats"]);
    if (st.infra) return { manual: true, detail: `no ejecutable (infraestructura): ultron-memory stats -> ${st.infra}` };
    if (!existsSync(db)) return { pass: false, detail: `no medible: el sidecar no creo la brain.db temporal (exit=${st.status})` };
    const candidate = (payload) => {
      const r = mem(["candidate"], JSON.stringify(payload));
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      return { id: (out.match(/"candidate_id"\s*:\s*"([0-9a-f-]+)"/i) || [])[1] ?? null, out, infra: r.infra };
    };
    const query = (sql) => {
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
      const h = new DatabaseSync(db, { readOnly: true });
      try { return h.prepare(sql).all(); } finally { h.close(); }
    };
    return fn({ candidate, query });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
