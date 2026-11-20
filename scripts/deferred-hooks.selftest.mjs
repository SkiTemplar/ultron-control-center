/**
 * deferred-hooks.selftest.mjs — selftest HERMÉTICO de la cola de SessionEnd
 * (hooks/scripts/lib/deferred-hooks.js).
 *
 * La cola vive en un temporal (ULTRON_DEFERRED_DIR); nada toca ~/.ultron.
 *
 * Casos:
 *   A) payload por stdin -> se encola, takePayload devuelve null
 *   B) ULTRON_DEFER_SESSION_END=0 -> se procesa en línea, sin cola
 *   C) stdin vacío -> nada que encolar
 *   D) --from-queue <fichero> -> devuelve su contenido
 *   E) drain: de la más antigua a la más reciente, con el flag y el fichero,
 *      borra cada entrada y respeta el tope por pasada
 *   F) entrada caducada -> se descarta sin ejecutar
 *   G) integración: lesson-distill.js como hook encola en vez de procesar
 *
 * Uso: node scripts/deferred-hooks.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, "..", "hooks", "scripts");
const Q = require(join(HOOKS, "lib", "deferred-hooks.js"));

const TMP = mkdtempSync(join(tmpdir(), "deferred-hooks-selftest-"));
const env = (extra = {}) => ({ ...process.env, ULTRON_DEFERRED_DIR: join(TMP, "cola"), ...extra });
const entradas = (hook, e) => {
  const dir = join(Q.queueRoot(e), hook);
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
};

let fail = 0;
const A = (cond, nombre, detalle = "") => {
  if (cond) console.log(`  [PASS] ${nombre}`);
  else {
    fail++;
    console.log(`  [FAIL] ${nombre}${detalle ? `\n         -> ${detalle}` : ""}`);
  }
};

try {
  console.log("A) payload por stdin: se encola");
  {
    const e = env();
    const r = Q.takePayload("hook-a", () => '{"session_id":"s1"}', ["node", "hook.js"], e);
    const lista = entradas("hook-a", e);
    A(r === null, "devuelve null (no se procesa ahora)", String(r));
    A(lista.length === 1, "una entrada en la cola", JSON.stringify(lista));
    A(lista.length === 1 && readFileSync(join(Q.queueRoot(e), "hook-a", lista[0]), "utf8") === '{"session_id":"s1"}',
      "la entrada guarda el payload tal cual");
  }

  console.log("B) ULTRON_DEFER_SESSION_END=0: en línea");
  {
    const e = env({ ULTRON_DEFER_SESSION_END: "0" });
    const r = Q.takePayload("hook-b", () => '{"x":1}', ["node", "hook.js"], e);
    A(r === '{"x":1}', "devuelve el payload", String(r));
    A(entradas("hook-b", e).length === 0, "sin entradas en la cola");
  }

  console.log("C) stdin vacío: nada que encolar");
  {
    const e = env();
    A(Q.takePayload("hook-c", () => "", ["node", "hook.js"], e) === "", "devuelve vacío");
    A(entradas("hook-c", e).length === 0, "sin entradas en la cola");
  }

  console.log("D) --from-queue: lee el fichero");
  {
    const f = join(TMP, "payload.json");
    writeFileSync(f, '{"desde":"cola"}', "utf8");
    const r = Q.takePayload("hook-d", () => "no debe leerse", ["node", "hook.js", Q.FROM_QUEUE_FLAG, f], env());
    A(r === '{"desde":"cola"}', "devuelve el contenido del fichero", String(r));
  }

  console.log("E) drain: orden, argumentos, borrado y tope");
  {
    const e = env();
    const dir = join(Q.queueRoot(e), "hook-e");
    mkdirSync(dir, { recursive: true });
    const ahora = Date.now();
    for (const ms of [ahora - 3000, ahora - 1000, ahora - 2000]) writeFileSync(join(dir, `${ms}-1.json`), "{}", "utf8");
    const llamadas = [];
    const fake = (_cmd, args) => {
      llamadas.push(args);
      return { status: 0, signal: null };
    };
    const r1 = Q.drain([{ id: "hook-e", script: "hook-e.js" }], { spawnSync: fake, max: 2, env: e, now: ahora });
    A(r1.length === 2 && llamadas.length === 2, "respeta el tope de 2", JSON.stringify(r1));
    A(llamadas[0][0] === "hook-e.js" && llamadas[0][1] === Q.FROM_QUEUE_FLAG && llamadas[0][2].endsWith(`${ahora - 3000}-1.json`),
      "empieza por la más antigua con --from-queue", JSON.stringify(llamadas[0]));
    A(entradas("hook-e", e).length === 1, "borra las ejecutadas y deja la pendiente", JSON.stringify(entradas("hook-e", e)));
    const r2 = Q.drain([{ id: "hook-e", script: "hook-e.js" }], { spawnSync: fake, env: e, now: ahora });
    A(r2.length === 1 && entradas("hook-e", e).length === 0, "la pasada siguiente vacía la cola");
  }

  console.log("F) entrada caducada: se descarta sin ejecutar");
  {
    const e = env();
    const dir = join(Q.queueRoot(e), "hook-f");
    mkdirSync(dir, { recursive: true });
    const ahora = Date.now();
    writeFileSync(join(dir, `${ahora - Q.MAX_AGE_MS - 1000}-1.json`), "{}", "utf8");
    let llamadas = 0;
    const r = Q.drain([{ id: "hook-f", script: "x.js" }], { spawnSync: () => { llamadas++; return { status: 0 }; }, env: e, now: ahora });
    A(llamadas === 0 && r.length === 1 && r[0].dropped === "caducada", "no la ejecuta y lo registra", JSON.stringify(r));
    A(entradas("hook-f", e).length === 0, "la borra");
  }

  console.log("G) integración: lesson-distill.js encola en vez de procesar");
  {
    const e = env({ ULTRON_SELFTEST: "1", LESSON_DISTILL_LOG: join(TMP, "lesson.jsonl") });
    const payload = JSON.stringify({ session_id: "sess-g", transcript_path: join(TMP, "no-existe.jsonl"), cwd: TMP });
    const r = spawnSync(process.execPath, [join(HOOKS, "lesson-distill.js")], { input: payload, env: e, encoding: "utf8" });
    const lista = entradas("lesson-distill", e);
    A(r.status === 0, "el hook sale con 0", `status=${r.status} stderr=${r.stderr}`);
    A(lista.length === 1, "deja una entrada en la cola", JSON.stringify(lista));
    A(!existsSync(join(TMP, "lesson.jsonl")), "no procesa en línea (sin línea en su log)");
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(fail === 0 ? "\ndeferred-hooks selftest: VERDE" : `\ndeferred-hooks selftest: ${fail} FALLO(S)`);
process.exit(fail === 0 ? 0 : 1);
