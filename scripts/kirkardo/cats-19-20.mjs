// kirkardo/cats-19-20.mjs — categorias 19 (resume de arranque) y 20 (write-path).
// Extraido de scripts/kirkardo-eval.mjs (2026-10-23) sin cambios de logica.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as P from "./predicates.mjs";
import { BIN, CC_TAURI, COCKPIT, RESUME_PROJECT, ULTRON, ULTRON_MEM, cat, fwd, grepCount, run } from "./core.mjs";
import { runResumeHook, sql20, withTempBrain } from "./hook-io.mjs";


// ---------------------------------------------------------------------------
// CAT 19 — Session-Start fidelity (resume VIVO, del proyecto, no nota podrida)
// ---------------------------------------------------------------------------
// Verifica el BINARIO real `ultron-memory resume --project ultron`: que
// open_tasks/decisions sean 100% del proyecto (0 cross-project/globales) y que
// next_action coincida con el estado VIVO (card In-Progress / Backlog-top del
// kanban, o el ultimo commit) — NO una nota vieja en pasado.
// (RESUME_PROJECT se define arriba, con las rutas canonicas.)

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

// Verbos/estados que delatan una tarea ya hecha (no debe seguir viva en el resume).
const COMPLETED_MARKERS =
  /\b(actualizad[oa]|commite?ar|complet(ad[oa]|e)|hech[oa]|listo|finalizad[oa]|rebuild|tauri build|se ha (realizado|hecho)|ya hecho)\b/i;

// Titulos de cards VIVAS (doing/todo/blocked) del kanban del proyecto. null si no
// hay kanban (clon limpio / CI): el check degrada a N/A explicito, no a pass falso.
function liveCardTitles(project) {
  const p = join(COCKPIT, "projects", project, "kanban.json");
  if (!existsSync(p)) return null;
  let doc;
  try {
    doc = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  const liveCols = new Set(
    (doc.columns ?? []).filter((c) => ["doing", "todo", "blocked"].includes(c.role)).map((c) => c.id),
  );
  return (doc.cards ?? [])
    .filter((c) => liveCols.has(c.column_id))
    .map((c) => (c.title ?? "").trim())
    .filter(Boolean);
}

const normResume = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[`*#_~\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// ¿El string de tarea corresponde a alguna card viva? (inclusion bidireccional con
// un prefijo significativo, tolerante a recortes del render).
function mapsToLiveCard(taskStr, titles) {
  const t = normResume(taskStr);
  if (!t) return false;
  const key = t.slice(0, 40);
  return titles.some((title) => {
    const n = normResume(title);
    return n.includes(key) || t.includes(n.slice(0, 40));
  });
}

// Similitud Jaccard de tokens (split por espacio/barra/coma para cazar
// "Rust y Tauri" vs "Tauri/Rust" como near-duplicados).
function jaccardTokens(a, b) {
  const A = new Set(normResume(a).split(/[\s/,]+/).filter(Boolean));
  const B = new Set(normResume(b).split(/[\s/,]+/).filter(Boolean));
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
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

// cat19 PIVOTADA a e2e (2026-06-24): ejecuta el HOOK real
// (memory-session-resume.js) y asevera sobre el additionalContext que de verdad
// llega al modelo, NO sobre 'ultron-memory.exe resume' invocado a mano. La version
// anterior media el binario y daba 10/10 mientras el resume inyectado llegaba
// podrido (open_tasks muertas, markdown crudo, project_context duplicado).
// TODO(siguiente incremento): 19.6 recent_decisions con ventana de frescura (<7d),
// 19.7 L0-scratch gate (mtime>24h no inyecta / fresco si, clipeado 2000).
cat(19, "Session-Start fidelity (e2e hook)", [
  {
    id: "19.1",
    desc: "el hook real emite resume con project correcto (cwd->projectId) + next_action presente",
    auto: true,
    check() {
      const h = runResumeHook(ULTRON);
      if (!h.ok) return { pass: false, detail: "hook no emitio resume: " + (h.raw ?? "") };
      const P = h.parsed;
      const pmatch = P.project === RESUME_PROJECT;
      const hasNA = P.next_action.trim() !== "";
      return {
        pass: pmatch && hasNA,
        detail: `project=${P.project || "?"} (esperado ${RESUME_PROJECT}) next_action_present=${hasNA}`,
      };
    },
  },
  {
    id: "19.2",
    desc: "open_tasks inyectadas = card viva del kanban y NO completadas (0 podridas)",
    auto: true,
    check() {
      const h = runResumeHook(ULTRON);
      if (!h.ok) return { pass: false, detail: "hook no emitio resume: " + (h.raw ?? "") };
      const titles = liveCardTitles(RESUME_PROJECT);
      // Sin kanban o sin open_tasks no hay nada que juzgar: skip, no verde.
      if (!titles) return { skip: true, detail: "N/A (sin kanban local; clon limpio/CI)" };
      const tasks = h.parsed.open_tasks;
      if (tasks.length === 0) return { skip: true, detail: "el resume no trae open_tasks: nada que cruzar con el kanban" };
      const bad = tasks.filter((t) => !mapsToLiveCard(t, titles) || COMPLETED_MARKERS.test(t));
      return {
        pass: bad.length === 0,
        detail:
          bad.length === 0
            ? `${tasks.length} open_tasks, todas = card viva`
            : `${bad.length}/${tasks.length} podridas (no-card o completada): ${bad.map((b) => b.slice(0, 28)).slice(0, 4).join(" | ")}`,
      };
    },
  },
  {
    id: "19.3",
    desc: "render limpio: 0 summaries con salto de linea/markdown crudo + 0 ruido en listas",
    auto: true,
    check() {
      const h = runResumeHook(ULTRON);
      if (!h.ok) return { pass: false, detail: "hook no emitio resume: " + (h.raw ?? "") };
      const bin = runResume(RESUME_PROJECT);
      const binTasks = (bin.json?.open_tasks ?? []).map((t) => t.summary ?? "");
      const dirty = binTasks.filter((s) => s.includes("\n") || /^\s*#/.test(s));
      const noise = Object.values(h.parsed.list_noise).reduce((a, b) => a + b, 0);
      const listed = h.parsed.open_tasks.length + h.parsed.recent_decisions.length + h.parsed.project_context.length;
      if (binTasks.length === 0 && listed === 0 && noise === 0) {
        return { skip: true, detail: "resume sin listas (0 open_tasks del binario, 0 items en el bloque): nada cuyo render juzgar" };
      }
      return {
        pass: dirty.length === 0 && noise === 0,
        detail: `summaries_multilinea_o_md=${dirty.length} lineas_ruido_en_listas=${noise}`,
      };
    },
  },
  {
    id: "19.4",
    desc: "next_action inyectado = card viva o 'ultimo commit:' y NO una nota completada",
    auto: true,
    check() {
      const h = runResumeHook(ULTRON);
      if (!h.ok) return { pass: false, detail: "hook no emitio resume: " + (h.raw ?? "") };
      const na = h.parsed.next_action;
      if (!na.trim()) return { pass: false, detail: "next_action vacio en el artefacto inyectado" };
      const titles = liveCardTitles(RESUME_PROJECT);
      const isCommit = /^(último|ultimo) commit:/i.test(na);
      const completed = COMPLETED_MARKERS.test(na);
      if (!titles) {
        return { pass: isCommit && !completed, detail: `N/A sin kanban; isCommit=${isCommit} completed=${completed}` };
      }
      const nk = normResume(na);
      const isCard = titles.some(
        (tt) => normResume(tt).includes(nk.slice(0, 40)) || nk.includes(normResume(tt).slice(0, 40)),
      );
      return {
        pass: (isCard || isCommit) && !completed,
        detail: `isCard=${isCard} isCommit=${isCommit} completed=${completed}: "${na.slice(0, 50)}"`,
      };
    },
  },
  {
    id: "19.5",
    desc: "project_context inyectado <=6 lineas y sin near-duplicados (ruido bajo control)",
    auto: true,
    check() {
      const h = runResumeHook(ULTRON);
      if (!h.ok) return { pass: false, detail: "hook no emitio resume: " + (h.raw ?? "") };
      const pc = h.parsed.project_context;
      // render() ya no emite project_context: con 0 lineas el check era verde
      // por vacuidad (auditoria 2026-10-23). Skip hasta que vuelva a haber.
      if (pc.length === 0) return { skip: true, detail: "el resume no trae project_context: 0 lineas que juzgar" };
      const MAX = 6;
      const JT = 0.5;
      let dups = 0;
      for (let i = 0; i < pc.length; i++) {
        for (let j = i + 1; j < pc.length; j++) {
          if (jaccardTokens(pc[i], pc[j]) > JT) dups++;
        }
      }
      return {
        pass: pc.length <= MAX && dups === 0,
        detail: `lineas=${pc.length} (max ${MAX}) near_dups=${dups}`,
      };
    },
  },
]);

// ---------------------------------------------------------------------------
// CAT 20 — Write-path real (dedupe + PII + sink + ledger)
// ---------------------------------------------------------------------------
// e2e del WRITE-PATH de memoria: cada check EJECUTA SQL real contra brain.db o
// el binario `candidate` y asevera sobre el dato persistido (no sobre codigo).
// Las consultas a brain.db corren en un subproceso `node --input-type=module`
// (node:sqlite es experimental -> aislado del proceso del harness); el SQL viaja
// por STDIN y la ruta de la BD por argv, evitando todo problema de quoting.

cat(20, "Write-path real (dedupe + PII + sink + ledger)", [
  {
    id: "20.1",
    desc: "dedupe activo: ningun content_hash con > 3 copias 'active' que siga sumando copias en los ultimos 14 dias",
    auto: true,
    check() {
      // Ventana (2026-10-28, P8): un duplicado historico que ya no crece no
      // dice nada del dedupe actual y dejaba el check en rojo para siempre.
      // Cuenta todas las copias del hash, pero solo si alguna es de la ventana.
      const since = Date.now() - 14 * 86400000;
      const q = sql20(
        "SELECT content_hash, COUNT(*) c FROM memory_items " +
          "WHERE status='active' AND content_hash IS NOT NULL AND content_hash<>'' " +
          `GROUP BY content_hash HAVING c>1 AND MAX(created_at) >= ${since} ORDER BY c DESC LIMIT 1`,
      );
      if (q.nodata) return { pass: false, detail: "no medible: brain.db ausente (clon limpio/CI)" };
      if (q.err) return { pass: false, detail: `no medible: ${q.err}` };
      const max = q.rows.length ? q.rows[0].c : 0;
      // KNOWN_RED: dedupe es advisory (create_candidate marca Merge pero no fusiona).
      // Medido 2026-06-24: max=211 (mismo error WebFetch repetido) -> FAIL honesto.
      return { pass: max <= 3, detail: `max copias activas de un content_hash con copias en 14 dias=${max} (umbral <=3)` };
    },
  },
  {
    id: "20.2",
    desc: "posttoolfail rate-limit: total/distinct < 3 en capture_source='posttoolfail-capture' (inundacion de ruido)",
    auto: true,
    check() {
      const q = sql20(
        "SELECT COUNT(*) total, COUNT(DISTINCT content_hash) distinct_h FROM memory_items " +
          "WHERE status='active' AND capture_source='posttoolfail-capture'",
      );
      if (q.nodata) return { pass: false, detail: "no medible: brain.db ausente (clon limpio/CI)" };
      if (q.err) return { pass: false, detail: `no medible: ${q.err}` };
      const total = q.rows[0]?.total ?? 0;
      const distinct = q.rows[0]?.distinct_h ?? 0;
      if (total === 0) return { skip: true, detail: "0 items posttoolfail-capture: nada cuyo rate-limit juzgar" };
      const ratio = distinct > 0 ? total / distinct : Infinity;
      // KNOWN_RED: medido 244/10 = 24.4x -> FAIL (sin rate-limit por hash).
      return {
        pass: ratio < 3,
        detail: `posttoolfail total/distinct=${total}/${distinct}=${ratio.toFixed(1)}x (umbral <3)`,
      };
    },
  },
  {
    id: "20.3",
    desc: "sink de decisiones con consumidor: decisions-pending.jsonl no debe crecer append-only sin drenador en src-tauri",
    auto: true,
    check() {
      // El sink vive por proyecto: cockpit/projects/<proj>/decisions-pending.jsonl.
      const sinkUltron = join(COCKPIT, "projects", "ultron", "decisions-pending.jsonl");
      const sinkLegacy = join(COCKPIT, "decisions-pending.jsonl");
      const sink = existsSync(sinkUltron) ? sinkUltron : existsSync(sinkLegacy) ? sinkLegacy : null;
      // Sin sink no hay nada que drenar (el pipeline se enterro el 2026-07-01):
      // skip, no verde por vacuidad.
      if (!sink) return { skip: true, detail: "sin decisions-pending.jsonl: nada que drenar" };
      // Consumidor real = codigo Rust en src-tauri que LEE/drena el fichero.
      const consumers = grepCount(/decisions[-_]pending/, CC_TAURI, [".rs"]);
      const lines = (() => {
        try {
          return readFileSync(sink, "utf8").split("\n").filter(Boolean).length;
        } catch {
          return -1;
        }
      })();
      // KNOWN_RED: grep en src-tauri = 0 (sink muerto que crece sin sumidero). El check
      // 17.4 viejo pasaba VERDE por existir el fichero (premiaba el sintoma de la enfermedad).
      return {
        pass: consumers > 0,
        detail:
          consumers > 0
            ? `decisions-pending.jsonl tiene ${consumers} consumidor(es) Rust`
            : `decisions-pending.jsonl existe (${lines} lineas) SIN consumidor en src-tauri (grep=0) -> sink muerto`,
      };
    },
  },
  {
    id: "20.4",
    desc: "redaction PII e2e (brain.db temporal): candidato con email/telefono/ruta C:/Users queda redactado en el item persistido",
    auto: true,
    check() {
      if (!existsSync(ULTRON_MEM)) return { pass: false, detail: "no medible: ultron-memory.exe ausente" };
      const marker = `kirkardo_pii_${Date.now()}`;
      const email = "redacttest@example.com";
      const phoneDigits = "698 123 456";
      const winPath = "C:/Users/TestUser/secreto_pii.txt"; // ruta sintetica, NO username real (audit 2026-06-25)
      const payload = JSON.stringify({
        type: "fact",
        scope: "session",
        title: marker,
        summary: `contacto ${email} tel +34 ${phoneDigits} ruta ${winPath}`,
        confidence: 0.9,
        project: "__kirkardo_test__", // scope efimero aislado del corpus productivo (audit 2026-06-25)
      });
      // Crea el candidato por la ruta real del binario (write-path productivo),
      // contra una brain.db temporal: produccion no se toca.
      return withTempBrain(({ candidate, query }) => {
        const c = candidate(JSON.parse(payload));
        if (c.infra) return { manual: true, detail: `no ejecutable (infraestructura): ultron-memory candidate -> ${c.infra}` };
        if (!c.id) return { pass: false, detail: `candidate no devolvio id: ${c.out.slice(0, 120)}` };
        const ps = query(`SELECT proposed_summary ps FROM memory_candidates WHERE id='${c.id}'`)[0]?.ps ?? "";
        const leaks = [
          ps.includes(email) && "email",
          ps.includes(phoneDigits) && "telefono",
          /C:[\\/]Users[\\/]/i.test(ps) && "ruta",
        ].filter(Boolean);
        // KNOWN_RED: medido 2026-06-24 -> proposed_summary persiste TODO verbatim
        // (la redaction solo cubre credenciales con prefijo, NO PII de usuario).
        return {
          pass: leaks.length === 0,
          detail:
            leaks.length === 0
              ? "email/telefono/ruta redactados en el item persistido"
              : `PII sin redactar en proposed_summary: ${leaks.join(", ")}`,
        };
      });
    },
  },
  {
    id: "20.5",
    desc: "redaction de campos codegraph e2e (brain.db temporal): file_path/signature con token (ghp_/sk-) quedan redactados",
    auto: true,
    check() {
      if (!existsSync(ULTRON_MEM)) return { pass: false, detail: "no medible: ultron-memory.exe ausente" };
      const marker = `kirkardo_cg_${Date.now()}`;
      const fp = "C:/Users/TestUser/secret/ghp_AAAABBBBCCCCDDDDEEEE.rs"; // ruta sintetica, NO username real (audit 2026-06-25)
      const sig = 'fn leak() { let t = "sk-abcdef1234567890"; }';
      const payload = JSON.stringify({
        type: "fact",
        scope: "session",
        title: marker,
        summary: "codegraph probe",
        file_path: fp,
        signature: sig,
        confidence: 0.9,
        project: "__kirkardo_test__", // scope efimero aislado del corpus productivo (audit 2026-06-25)
      });
      return withTempBrain(({ candidate, query }) => {
        const c = candidate(JSON.parse(payload));
        if (c.infra) return { manual: true, detail: `no ejecutable (infraestructura): ultron-memory candidate -> ${c.infra}` };
        if (!c.id) return { pass: false, detail: `candidate no devolvio id: ${c.out.slice(0, 120)}` };
        const row = query(`SELECT proposed_file_path fp, proposed_signature sig FROM memory_candidates WHERE id='${c.id}'`)[0] ?? {};
        const gotFp = row.fp ?? "";
        const gotSig = row.sig ?? "";
        const leaks = [
          /ghp_[A-Za-z0-9]/.test(gotFp) && "ghp_token",
          /sk-[a-z0-9]{6,}/i.test(gotSig) && "sk_token",
          /C:[\\/]Users[\\/]/i.test(gotFp) && "ruta",
        ].filter(Boolean);
        // KNOWN_RED: solo se mapean los campos; ninguna redaction sobre
        // proposed_file_path/proposed_signature -> tokens persisten verbatim.
        return {
          pass: leaks.length === 0,
          detail:
            leaks.length === 0
              ? "campos codegraph redactados"
              : `secreto sin redactar en campos codegraph: ${leaks.join(", ")}`,
        };
      });
    },
  },
  {
    id: "20.6",
    desc: "integridad ledger single-writer: 0 items 'active' sin NINGUN evento (escritura que salto MemoryService)",
    auto: true,
    check() {
      // No uso 'NOT EXISTS created' (sobre-cuenta: muchos items legitimos entran via
      // event_type='imported', no 'created' -> daria ~3139 falsos positivos). El hallazgo
      // honesto (audit 2026-06-24) es el item activo SIN evento de ningun tipo: prueba de
      // una escritura que esquivo el ledger del MemoryService (sin redaction/dedupe).
      const q = sql20(
        "SELECT COUNT(*) n FROM memory_items i WHERE i.status='active' " +
          "AND NOT EXISTS (SELECT 1 FROM memory_events e WHERE e.memory_id=i.id)",
      );
      if (q.nodata) return { pass: false, detail: "no medible: brain.db ausente (clon limpio/CI)" };
      if (q.err) return { pass: false, detail: `no medible: ${q.err}` };
      const orphans = q.rows[0]?.n ?? -1;
      // KNOWN_RED: medido 2026-06-24 -> 1 item activo huerfano (regla de oro ya violada).
      return { pass: orphans === 0, detail: `items 'active' sin evento alguno=${orphans} (regla single-writer)` };
    },
  },
]);
