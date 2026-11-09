/**
 * memory-gc.selftest.mjs — check conductual del hook SessionEnd `memory-gc`
 * (F1.8, mantenimiento a 90 dias de brain.db).
 *
 * Hermetico: ULTRON_MEMORY_BIN apunta a un STUB que registra el argv recibido y
 * devuelve un JSON fijo. Ni brain.db, ni el binario real, ni el estado/log de
 * produccion se tocan (MEMORY_GC_STATE y MEMORY_GC_LOG van al temporal).
 *
 * Como se construye el stub sin tocar el hook: el binario es el propio
 * `node` (ejecutable real, spawneable en Windows y POSIX por igual — un .cmd
 * no lo es desde Node 18.20) y el comportamiento lo pone un modulo precargado
 * con NODE_OPTIONS=--require. El precargado se activa SOLO cuando node arranca
 * con el "script" `gc`, es decir en la llamada que hace el hook; en el proceso
 * del hook (script memory-gc.js) se aparta y no hace nada. Asi el spawn que se
 * prueba es el real, sin seams de test en el codigo de produccion.
 *
 * Casos:
 *   A) sin estado previo -> ejecuta `gc --days 90`, log ok con las cifras del
 *      stub y estado sellado con last_run_ms.
 *   B) estado recien sellado -> no vuelve a ejecutar (skipped=cadencia) y el
 *      estado no cambia.
 *   C) estado de hace 8 dias -> vuelve a ejecutar y resella.
 *   D) el binario falla (exit 1) -> log ok:false con el stderr y la causa;
 *      last_run_ms intacto y fail_count=1 con last_error en el estado.
 *   F) cierre inmediato tras el fallo -> backoff: no ejecuta (skipped=backoff).
 *   G) pasado el backoff -> reintenta; si vuelve a fallar, fail_count=2.
 *   H) el binario se cuelga -> timeout: el log registra ETIMEDOUT y la señal (el
 *      caso real de H26, que dejaba status:null sin causa).
 *   I) éxito tras fallos -> estado sellado sin fail_count (contador a cero).
 *   E) MEMORY_GC_DISABLED=1 -> ni ejecucion, ni log, ni estado.
 *
 * Uso: node scripts/memory-gc.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..");
const HOOK = join(ULTRON, "hooks", "scripts", "memory-gc.js");
const TMPDIR = join(ULTRON, "logs", "_selftest-memory-gc");
const STATE = join(TMPDIR, "memory-gc-last.json");
const LOG = join(TMPDIR, "memory-gc.jsonl");
const ARGS = join(TMPDIR, "stub-args.txt");
const STUB = join(TMPDIR, "stub.cjs");
const DIA_MS = 86400000;

// Salida que el stub finge devolver: las mismas claves que imprime `gc`.
const SALIDA = '{"days":90,"stale_marked":25,"events_deleted":54574,"events_deleted_by_rule":{"status_dead":1853,"no_item":45013,"orphan":7708},"bytes_before":127737856,"bytes_after":78000128,"freelist_bytes":49737728,"vacuumed":true,"dry_run":false,"failed":[]}';

rmSync(TMPDIR, { recursive: true, force: true });
mkdirSync(TMPDIR, { recursive: true });

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

// Modulo precargado que hace de `ultron-memory`. fs.writeSync (no console) para
// que la salida llegue entera antes del process.exit en Windows.
writeFileSync(
  STUB,
  `'use strict';
const fs = require('fs');
const path = require('path');
// Solo suplanta al binario: en el proceso del hook (memory-gc.js) se aparta.
if (path.basename(process.argv[1] || '') !== 'gc') return;
fs.appendFileSync(process.env.MEMORY_GC_STUB_ARGS, process.argv.slice(1).join(' ') + '\\n');
if (process.env.MEMORY_GC_STUB_HANG === '1') {
  // Bloqueo síncrono: si el precargado volviera, node intentaría cargar el
  // script "gc" y saldría al instante con error.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  process.exit(0);
}
if (process.env.MEMORY_GC_STUB_FAIL === '1') {
  fs.writeSync(2, 'gc: base bloqueada por otro proceso\\n');
  process.exit(1);
}
fs.writeSync(1, ${JSON.stringify(SALIDA)} + '\\n');
process.exit(0);
`,
  "utf8",
);

function correr({ falla = false, cuelga = false, extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [HOOK], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `--require "${STUB.split("\\").join("/")}"`,
      ULTRON_MEMORY_BIN: process.execPath,
      MEMORY_GC_STATE: STATE,
      MEMORY_GC_LOG: LOG,
      MEMORY_GC_STUB_ARGS: ARGS,
      MEMORY_GC_STUB_FAIL: falla ? "1" : "0",
      MEMORY_GC_STUB_HANG: cuelga ? "1" : "0",
      MEMORY_GC_TIMEOUT_MS: cuelga ? "1500" : "",
      CLAUDE_NO_HOOKS: "0",
      MEMORY_GC_DISABLED: "0",
      ...extraEnv,
    },
  });
}

function leerLog() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function leerEstado() {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
}
function llamadas() {
  if (!existsSync(ARGS)) return [];
  return readFileSync(ARGS, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
}
function limpiarTraza() {
  for (const f of [LOG, ARGS]) rmSync(f, { force: true });
}

console.log("A) primera ejecucion: llama al binario y sella el estado");
{
  const r = correr();
  const log = leerLog();
  const est = leerEstado();
  const calls = llamadas();
  A(r.status === 0, "el hook sale con 0", `status=${r.status} stderr=${r.stderr}`);
  A(calls.length === 1, "una sola llamada al binario", `calls=${JSON.stringify(calls)}`);
  A(/(^|[\\/\s])gc(\s|$)/.test(calls[0] || "") && /--days\s+90/.test(calls[0] || ""),
    "invoca `gc --days 90`", `argv=${calls[0]}`);
  A(!/--dry-run/.test(calls[0] || ""), "la ejecucion programada NO es dry-run", `argv=${calls[0]}`);
  A(log.length === 1 && log[0].ok === true, "log con ok:true", JSON.stringify(log));
  A(log[0] && log[0].stale_marked === 25 && log[0].events_deleted === 54574,
    "el log propaga las cifras del binario", JSON.stringify(log[0]));
  A(log[0] && log[0].events_deleted_by_rule
    && log[0].events_deleted_by_rule.status_dead === 1853
    && log[0].events_deleted_by_rule.no_item === 45013
    && log[0].events_deleted_by_rule.orphan === 7708,
    "el log propaga el desglose por regla", JSON.stringify(log[0]));
  A(log[0] && log[0].vacuumed === true, "el log declara si se compacto", JSON.stringify(log[0]));
  A(est && Number.isFinite(est.last_run_ms), "estado sellado con last_run_ms", JSON.stringify(est));
}

console.log("B) segunda ejecucion inmediata: cadencia semanal, no ejecuta");
{
  const antes = leerEstado();
  limpiarTraza();
  correr();
  const log = leerLog();
  A(llamadas().length === 0, "no invoca el binario", JSON.stringify(llamadas()));
  A(log.length === 1 && log[0].skipped === "cadencia", "log con skipped=cadencia", JSON.stringify(log));
  A(typeof log[0].next_in_h === "number" && log[0].next_in_h > 0, "declara cuanto falta", JSON.stringify(log[0]));
  A(JSON.stringify(leerEstado()) === JSON.stringify(antes), "el estado no cambia", "estado alterado");
}

console.log("C) estado de hace 8 dias: vuelve a ejecutar");
{
  const viejo = Date.now() - 8 * DIA_MS;
  writeFileSync(STATE, JSON.stringify({ last_run_ms: viejo, last_run_iso: new Date(viejo).toISOString() }), "utf8");
  limpiarTraza();
  correr();
  const log = leerLog();
  A(llamadas().length === 1, "invoca el binario pasada la semana", JSON.stringify(llamadas()));
  A(log.length === 1 && log[0].ok === true, "log con ok:true", JSON.stringify(log));
  A((leerEstado() || {}).last_run_ms > viejo, "resella el estado", JSON.stringify(leerEstado()));
}

console.log("D) el binario falla: se registra y NO se sella el estado");
{
  const viejo = Date.now() - 8 * DIA_MS;
  writeFileSync(STATE, JSON.stringify({ last_run_ms: viejo, last_run_iso: new Date(viejo).toISOString() }), "utf8");
  limpiarTraza();
  const r = correr({ falla: true });
  const log = leerLog();
  A(r.status === 0, "el hook sigue saliendo con 0", `status=${r.status}`);
  A(llamadas().length === 1, "lo intento de verdad", JSON.stringify(llamadas()));
  A(log.length === 1 && log[0].ok === false, "log con ok:false", JSON.stringify(log));
  A(log[0] && typeof log[0].stderr === "string" && log[0].stderr.includes("bloqueada"),
    "el log conserva la causa (stderr del binario)", JSON.stringify(log[0]));
  A(log[0] && typeof log[0].cause === "string" && log[0].cause.includes("exit 1") && log[0].cause.includes("bloqueada"),
    "el log resume la causa (exit + stderr)", JSON.stringify(log[0]));
  A(log[0] && log[0].fail_count === 1, "el log cuenta el fallo", JSON.stringify(log[0]));
  const est = leerEstado() || {};
  A(est.last_run_ms === viejo, "last_run_ms intacto (no se sella el fallo)", JSON.stringify(est));
  A(est.fail_count === 1 && Number.isFinite(est.last_fail_ms), "estado con fail_count=1 y last_fail_ms", JSON.stringify(est));
  A(typeof est.last_error === "string" && est.last_error.includes("exit 1"), "estado con last_error", JSON.stringify(est));
}

console.log("F) cierre inmediato tras el fallo: backoff, no reintenta");
{
  const antes = leerEstado();
  limpiarTraza();
  const r = correr({ falla: true });
  const log = leerLog();
  A(r.status === 0, "el hook sale con 0", `status=${r.status}`);
  A(llamadas().length === 0, "no invoca el binario dentro del backoff", JSON.stringify(llamadas()));
  A(log.length === 1 && log[0].skipped === "backoff" && log[0].fail_count === 1,
    "log con skipped=backoff y el contador", JSON.stringify(log));
  A(log[0] && log[0].next_in_h > 5 && log[0].next_in_h <= 6, "primer escalon de 6 h", JSON.stringify(log[0]));
  A(JSON.stringify(leerEstado()) === JSON.stringify(antes), "el estado no cambia", JSON.stringify(leerEstado()));
}

console.log("G) pasado el backoff: reintenta y, si falla, dobla la espera");
{
  const viejo = Date.now() - 8 * DIA_MS;
  writeFileSync(STATE, JSON.stringify({ last_run_ms: viejo, fail_count: 1, last_fail_ms: Date.now() - 7 * 3600000, last_error: "exit 1" }), "utf8");
  limpiarTraza();
  correr({ falla: true });
  const log = leerLog();
  A(llamadas().length === 1, "reintenta pasadas 6 h", JSON.stringify(llamadas()));
  A(log.length === 1 && log[0].ok === false && log[0].fail_count === 2 && log[0].retry_in_h === 12,
    "segundo fallo: fail_count=2 y espera de 12 h", JSON.stringify(log));
  A((leerEstado() || {}).fail_count === 2 && (leerEstado() || {}).last_run_ms === viejo,
    "estado con fail_count=2 y el ultimo exito intacto", JSON.stringify(leerEstado()));
}

console.log("H) el binario se cuelga: timeout con causa registrada");
{
  rmSync(STATE, { force: true });
  limpiarTraza();
  const r = correr({ cuelga: true });
  const log = leerLog();
  A(r.status === 0, "el hook sale con 0 tras matar al binario", `status=${r.status}`);
  A(log.length === 1 && log[0].ok === false, "log con ok:false", JSON.stringify(log));
  A(log[0] && log[0].error === "ETIMEDOUT", "el log registra ETIMEDOUT (antes: status:null sin causa)", JSON.stringify(log[0]));
  A(log[0] && typeof log[0].signal === "string" && log[0].signal.length > 0, "el log registra la senal", JSON.stringify(log[0]));
  A(log[0] && /ETIMEDOUT.*timeout de 2 s/.test(log[0].cause || ""), "la causa nombra el timeout", JSON.stringify(log[0]));
  A((leerEstado() || {}).fail_count === 1, "estado con fail_count=1", JSON.stringify(leerEstado()));
}

console.log("I) exito tras fallos: el contador vuelve a cero");
{
  const viejo = Date.now() - 8 * DIA_MS;
  writeFileSync(STATE, JSON.stringify({ last_run_ms: viejo, fail_count: 3, last_fail_ms: Date.now() - 8 * DIA_MS, last_error: "ETIMEDOUT" }), "utf8");
  limpiarTraza();
  correr();
  const est = leerEstado() || {};
  A(llamadas().length === 1, "reintenta pasado el tope semanal del backoff", JSON.stringify(llamadas()));
  A(leerLog()[0] && leerLog()[0].ok === true, "log con ok:true", JSON.stringify(leerLog()));
  A(est.last_run_ms > viejo && est.fail_count === undefined && est.last_error === undefined,
    "estado sellado sin campos de fallo", JSON.stringify(est));
}

console.log("E) opt-out MEMORY_GC_DISABLED=1: silencio total");
{
  rmSync(STATE, { force: true });
  limpiarTraza();
  correr({ extraEnv: { MEMORY_GC_DISABLED: "1" } });
  A(llamadas().length === 0, "no invoca el binario", JSON.stringify(llamadas()));
  A(leerLog().length === 0, "no escribe log", JSON.stringify(leerLog()));
  A(leerEstado() === null, "no crea estado", JSON.stringify(leerEstado()));
}

rmSync(TMPDIR, { recursive: true, force: true });
console.log(fail === 0 ? "\nmemory-gc selftest: VERDE" : `\nmemory-gc selftest: ${fail} FALLO(S)`);
process.exit(fail === 0 ? 0 : 1);
