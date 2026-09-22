#!/usr/bin/env node
// hooks/scripts/memory-orchestrate.js — UserPromptSubmit hook ("Ultron" auto-route).
//
// Routes the prompt through the canonical orchestrator (`ultron-memory
// orchestrate`): intent -> workflow -> specialist agents to DELEGATE to ->
// relevant memories, injected as additionalContext. FAIL-SAFE: emits empty
// context (never blocks the prompt) if the binary is missing or anything fails.

const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { runCli, projectIdFromCwd, daemonRequest, spawnDetached, findBinary, readDaemonLock } = require('./lib/ultron-memory-cli');
const { appendJsonl } = require('./lib/jsonl-log');
const { observe, annotate, logHookError } = require('./lib/hook-obs');
const { isSystemTurnPrompt } = require('./lib/system-turn');
const { detectForPrompt, loadPersonality } = require('./lib/tone-detect');
// F-resume (2026-09-11): entrega diferida del resumen de la sesion anterior si
// SessionStart no llego a tiempo (ver lib/session-summary-delivery.js).
const lastSession = require('./lib/last-session');
const sessionSummaryDelivery = require('./lib/session-summary-delivery');
observe('memory-orchestrate');

// Hot path budget for the resident daemon (E5 warm -> sub-second). The one-shot
// spawn fallback keeps the wider colchon for cold-hit E5 (see runCli call below).
// (2026-08-13) Subido de 3000 a 6000 por el RERANK SELECTIVO: los prompts
// tecnicos ahora pasan por el cross-encoder (+2-2.4s) para doblar el recall
// (0.491 -> 0.810 medido). Con 3000 esos turnos vencian el plazo SIEMPRE y
// caian al one-shot, que es peor (E5 frio, cap de 6s). El coste real del cambio
// es solo cuando el daemon esta colgado de verdad: 6s en vez de 3s antes de
// degradar. La charla no paga nada: no se rerankea (ver orchestrate.rs).
// (2026-08-17) Subido de 6000 a 9000: el primer prompt tras una pausa larga
// pilla al daemon VIVO pero con los modelos soltados por idle; recargar E5
// (~2-5s) + resolver pasaba de los 6s por decimas (12 fallos medidos a
// 6159-6219ms) y el prompt entraba SIN memoria. Con 9s ese prompt espera la
// recarga y llega con recall; el precio real es solo con daemon colgado de
// verdad (9s antes de degradar, caso raro). Presupuesto total abajo.
// (2026-09-22) 9000 -> 4000. Los 9s se justificaban por la recarga de E5 tras
// el idle, pero el dato del dia dice otra cosa: en 19 ejecuciones medidas, las
// fases daemon_ms que NO acabaron en respuesta valen 409, 1.605, 3.031 y
// 3.153 ms — ninguna se acerca a 9s. O sea: o el daemon contesta antes de 4s,
// o no va a contestar, y el resto del presupuesto se gastaba esperando a un
// mudo. Ademas ya no es el ultimo recurso: detras vienen el relanzamiento y el
// sparse. Lo que se pierde es la recarga de E5 mas lenta de todas; lo que se
// gana es que ese turno degrade en ~5s en vez de bloquear el prompt 15.
const DAEMON_TIMEOUT_MS = 4000;
// Check 1.5 (2026-07-22): con pack cacheado FRESCO del proyecto, el peor caso
// del hook queda ~1200 (daemon) + 800 (one-shot cap) + overhead < 3000ms POR
// CONSTRUCCION. Sin cache fresco se mantiene el colchon completo de 3000ms
// porque no hay red de seguridad si el daemon tarda.
// Subido de 1200 a 4000 por el mismo motivo: con pack cacheado fresco el
// presupuesto era mas corto que el propio rerank, asi que un turno tecnico se
// servia SIEMPRE del cache stale en vez de esperar al pack bueno.
// (2026-08-17) 4000 -> 6000: medido en el harness (22.1/22.2), un prompt
// tecnico con rerank quedaba AL LIMITE de los 4s y caia al cache stale de
// forma reproducible (route de otro prompt, sin directiva). 6s = el mismo
// presupuesto que sin cache; el cache fresco sigue siendo la red si el daemon
// esta colgado de verdad.
// (2026-09-22) 6000 -> 3000, por el mismo recorte de DAEMON_TIMEOUT_MS: con un
// pack cacheado fresco por debajo hay respuesta util garantizada, asi que este
// es el caso donde MENOS sentido tiene esperar a un daemon que no contesta.
const DAEMON_TIMEOUT_CACHED_MS = 3000;

// HOOKS-04 (auditoria 2026-07-16, decidido por el usuario 2026-07-17): el
// respaldo local + pack cacheado. Medido entonces: daemon HIT p50=562ms, MISS
// p50=4145ms (35% de prompts). (2026-09-07) El one-shot de 800/6000 ms que
// cargaba E5 se sustituye por `orchestrate --sparse` (SPARSE_MIN_CAP_MS,
// mas abajo): ver alli el porque. SessionStart ademas precalienta el daemon.
// OJO al presupuesto TOTAL contra el timeout del hook en settings.json (10s
// desde 2026-09-22) — cualquier overhead que lo venza hace que Claude Code
// DESCARTE todo el prefetch en silencio (visto 2026-08-14 con 12s/12s).
// Peores casos (2026-09-22, presupuesto recortado a 8s):
//   Qdrant caido:   sonda healthz 0,3s + sparse 3s = 3,3s (se salta el denso)
//   daemon muerto:  0s (sin lockfile) + relanzamiento 2,5s + sparse 3s = 5,5s
//   daemon mudo:    DAEMON_TIMEOUT_MS 4s + relanzamiento (le queda 1s) + sparse 2,5s = 6,5s
//   busy:           2,5s + BUSY_RETRY_BUDGET_MS 2s + sparse dinamico 3s = 7,5s
//   daemon en boot: DAEMON_BOOT_WAIT_MS 4s + relanzamiento + sparse = 6,5s
//   primer prompt:  FIRST_PROMPT_DAEMON_WAIT_MS 4s + relanzamiento + sparse = 6,5s
// El relanzamiento NO se suma a las esperas previas: tiene DOS techos, uno
// relativo (DAEMON_RELAUNCH_BUDGET_MS, lo que se le da a la sonda) y otro
// absoluto desde t0 (DAEMON_RELAUNCH_DEADLINE_MS); manda el que venza antes.
const ORCH_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

// HOOKS-05 (2026-08-15, decidido por el usuario): espera extendida en ARRANQUE
// FRIO. Sintoma medido: el primer prompt tras un arranque llegaba con el daemon
// recien spawneado (memory-warmup) pero E5 aun cargando -> timeout de 6s ->
// one-shot compitiendo por CPU con el warmup -> tambien fallaba -> prompt SIN
// memoria (hook-errors.jsonl: 2026-08-15T09:17, 4 casos el 08-14). Cura: si el
// lockfile es JOVEN (<BOOT_WINDOW: daemon en warmup, no colgado), poll al daemon
// hasta agotar BOOT_WAIT (presupuesto TOTAL desde t0). Un lock viejo que no
// responde sigue degradando de inmediato (daemon colgado de verdad).
// Presupuesto peor caso con espera: BOOT_WAIT (12s, incluye los 6s del primer
// intento) + ONE_SHOT_CAP_UNCACHED_MS (6s) = 18s < 20s del timeout del hook.
// (2026-09-22) BOOT_WAIT 12s -> 4s (es una deadline ABSOLUTA desde t0, asi que
// con DAEMON_TIMEOUT_MS ya en 4s esta espera solo anade poll fino) y el poll de
// 1.500 -> 500 ms: con presupuestos de 2-4 s un poll de 1,5 s gastaba el tramo
// entero en dos sondas y podia no llegar a ninguna.
const DAEMON_BOOT_WINDOW_MS = 90_000;
const DAEMON_BOOT_WAIT_MS = 4_000;
const DAEMON_BOOT_POLL_MS = 500;

// HOOKS-06 (2026-08-22): "busy" NO es un daemon caido. El daemon responde
// {error:"busy"} cuando su lock global sigue ocupado tras ORCH_LOCK_WAIT (2,5s)
// — otra sesion embebiendo, o E5 recargandose tras el idle-release. El codigo
// anterior lo metia en el mismo saco que "sin respuesta" y disparaba el
// fallback one-shot, que carga OTRA copia de E5 (~1,5 GB) y compite por CPU con
// quien ya la estaba cargando. Con 5 sesiones abiertas eso son 5 cargas
// simultaneas del mismo modelo: 15s medidos (9000 daemon + 6000 one-shot),
// 5/5 prompts degradados. Ante "busy" se reintenta contra el MISMO daemon
// dentro de este presupuesto y NUNCA se spawnea competencia.
// Peor caso: 2500 (busy del daemon) + 6000 (reintentos) = 8,5s < 20s del hook.
// (2026-09-22) 6000 -> 2000: "busy" significa que hay OTRA sesion embebiendo,
// y esa espera es tiempo del prompt de ESTE usuario. Con 2s siguen entrando 4
// reintentos (poll 400 ms) — suficiente para un lock que se suelta — y el peor
// caso del tramo baja de 8,5s a 4,5s.
const BUSY_RETRY_BUDGET_MS = 2000;
const BUSY_RETRY_POLL_MS = 400;

/** ¿La respuesta es un "busy" del daemon (vivo pero con el lock ocupado)? */
function isDaemonBusy(resp) {
  return Boolean(resp && typeof resp.error === 'string' && resp.error === 'busy');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function orchCachePath(project) {
  const safe = String(project || 'default').replace(/[^A-Za-z0-9_-]/g, '-');
  return path.join(os.homedir(), '.ultron', '.tmp', `orch-cache-${safe}.json`);
}

function readOrchCache(project) {
  try {
    const p = orchCachePath(project);
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > ORCH_CACHE_MAX_AGE_MS) return null;
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return obj && obj.ctx ? obj.ctx : null;
  } catch {
    return null;
  }
}

function writeOrchCache(project, ctx) {
  try {
    // MEM-AUD-07: write-then-rename (atomico en el mismo volumen) — un lector
    // concurrente nunca ve el JSON a medio escribir.
    const p = orchCachePath(project);
    const tmp = p + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ts: Date.now(), ctx }));
    fs.renameSync(tmp, p);
  } catch {
    /* cache best-effort — nunca bloquea el prompt */
  }
}

// Live Session Monitor feed: persiste cada orquestacion para que la UI de
// ULTRON muestre EN VIVO que skills/agentes/memorias propuso el orquestador
// para la sesion activa. Append-only JSONL; fail-safe (nunca bloquea el prompt).
const ORCH_LOG = path.join(os.homedir(), '.claude', 'logs', 'orchestrate.jsonl');
const FAST_LANE_LOG = path.join(os.homedir(), '.ultron', 'logs', 'fast-lane.jsonl');
const { decide: decideLane, markPrompt, readState: readLaneState } = require('./lib/fast-lane');

// Presupuesto TOTAL del hook: el `timeout` de UserPromptSubmit en
// settings.json. Si el hook lo vence, Claude Code descarta TODA su salida en
// silencio, asi que cada espera nueva se resta de aqui, nunca se suma encima.
// (2026-09-22, manana) Por que este presupuesto SEGUIA en 20 s: no habia
// reparto por fase, y sin saber en que se iban los 9,5 s de p95 elegir entre
// recortar o irse a `asyncRewake` era tirar una moneda.
//
// (2026-09-22, tarde) Ya hay reparto: 19 ejecuciones con el campo `fases`
// dicen p50 9 ms, p90 9.132 ms, p95 15.693 ms, y las dos fases que mandan son
// daemon_ms (409 / 1.605 / 3.031 / 3.153 ms) y relanzamiento_ms (3.261 y
// 9.116 ms). Conclusiones y recorte 20 s -> 8 s:
//
//   1. Con el daemon vivo el hook cuesta 9 ms: el presupuesto no entra en juego
//      en la mitad de los prompts, asi que recortarlo no cuesta nada ahi.
//   2. Los peores daemon_ms se quedan en 3,2 s: esperar 9 s a un daemon que no
//      ha contestado en 4 era regalar 5 s por turno.
//   3. El relanzamiento de 9,1 s es el sintoma mas caro y el menos util: ese
//      daemon no llega a servir ESE turno. Con 2,5 s se lanza igual y el prompt
//      SIGUIENTE ya lo encuentra vivo, que es lo que de verdad arregla.
//   4. La opcion `asyncRewake` sigue descartada por lo mismo de siempre: en
//      modo asincrono el stdout se descarta y todo lo que produce este hook
//      viaja por `additionalContext` en stdout.
//
// Objetivo declarado del recorte: p50 sin cambio con el daemon vivo y p95 <= 5 s
// con Qdrant o el daemon caidos. El timeout de la plantilla baja de 20 a 10 s
// (tiene que ser MAYOR que este presupuesto o Claude Code descarta la salida).
const HOOK_BUDGET_MS = 8_000;
// Colchon reservado para lo que viene DESPUES de la ultima espera: render,
// token-meter, escritura del cache y del log, mas el arranque de node. El hook
// tiene que terminar por debajo del presupuesto, no rozarlo.
const SAFETY_MARGIN_MS = 1_500;

// Primer prompt de la sesion (2026-09-07, decidido por el usuario: "el primero
// siempre deberia ser tocho"): es el que mas memoria necesita y el que entraba
// vacio (2026-09-07 08:34: daemon mudo 9 s + one-shot 6 s = 15,1 s y nada).
// Se le da UNA espera larga al daemon en vez de dos cortas con un one-shot en
// medio que carga otra copia de E5 y compite por la CPU con el daemon que se
// esta recuperando.
// (2026-09-10) 15 s -> 12 s: esta espera ya no es el ultimo recurso. Detras
// viene la recuperacion del daemon (HOOKS-07) y solo despues el sparse, asi que
// el encadenado tiene que caber igual en HOOK_BUDGET_MS.
// (2026-09-22) 12 s -> 4 s, forzado por el presupuesto de 8 s: una espera de
// 12 s no cabe en el, y dejarla habria hecho que el primer prompt de CADA
// sesion sin daemon bloqueara mas que el propio timeout del hook (o sea, su
// salida descartada entera). El primer prompt conserva lo que de verdad le
// daba ventaja: UNA sola espera larga, sin reintentos de "busy" en medio que
// carguen otra copia de E5 compitiendo por CPU.
const FIRST_PROMPT_DAEMON_WAIT_MS = 4_000;

// Respaldo cuando el daemon no ha contestado: `orchestrate --sparse` (FTS5 +
// reglas, sin E5, sin volver a esperar al daemon). Antes el one-shot esperaba
// al daemon otros 30 s por dentro y cargaba E5 si no: con el daemon vivo pero
// lento nunca llegaba a resolver dentro de su cap de 6 s.
// (2026-09-10) El cap pasa a ser DINAMICO entre estos dos limites: con el
// daemon muerto de golpe sobra presupuesto y con el daemon lento falta. Medido
// ese dia: el one-shot sparse tarda 626 ms aislado en frio, pero 3101/3126/3102
// ms — o sea, TIMEOUT con el cap fijo de 3 s — cuando compite por CPU con el
// daemon recien relanzado cargando E5. Con el cap dinamico esos turnos disponen
// de hasta SPARSE_MAX_CAP_MS.
// (2026-09-22) [3.000, 6.000] -> [1.500, 3.000]: el sparse aislado en frio
// tarda 626 ms; los 3.100 ms medidos eran contencion con el daemon recien
// relanzado cargando E5, y ese relanzamiento ahora dura 2,5 s en vez de 9. Con
// el tope en 3 s el peor caso del tramo cabe en el presupuesto de 8 s.
const SPARSE_MIN_CAP_MS = 1_500;
const SPARSE_MAX_CAP_MS = 3_000;

// HOOKS-07 (2026-09-10): recuperacion del daemon MUERTO. Sintoma medido en
// logs/hook-timing.jsonl y logs/capture.jsonl: sin daemon, daemonRequest
// devuelve null al instante, el hook hacia spawnDetached(['serve']) y caia YA
// al sparse; el daemon relanzado no llegaba a servir nada a ese turno y encima
// su carga de E5 ahogaba al one-shot (3101/3126/3102 ms contra un cap de
// 3000 ms) — tres prompts seguidos con "[memoria degradada]" tras 3,1 s.
// Ahora el turno ESPERA al daemon nuevo: el presupuesto se gasta en el unico
// camino que trae recall de verdad. La deadline es absoluta desde t0 y reserva
// SPARSE_MIN_CAP_MS + SAFETY_MARGIN_MS para que el sparse siga siendo posible
// si el daemon sigue mudo.
const DAEMON_RELAUNCH_DEADLINE_MS = HOOK_BUDGET_MS - SPARSE_MIN_CAP_MS - SAFETY_MARGIN_MS;
// (2026-09-22) Techo RELATIVO del tramo, ademas de la deadline absoluta: se
// lanza `serve` y se le sondea como mucho esto. Medido en hook-timing.jsonl,
// los dos relanzamientos reales costaron 3.261 y 9.116 ms y NINGUNO de los dos
// llego a servir el turno que los pago — el daemon nuevo tarda mas que
// cualquier presupuesto razonable en cargar E5. Lo que si arregla el
// relanzamiento es el prompt SIGUIENTE, y eso se consigue igual con spawn +
// 2,5 s de sonda: si dentro de esa ventana ya contesta (daemon a medio
// arrancar), el turno se lleva recall de verdad; si no, sparse y a otra cosa.
const DAEMON_RELAUNCH_BUDGET_MS = 2_500;
// Sonda minima contra el daemon nuevo: por debajo de esto no le da tiempo ni a
// aceptar la conexion, asi que no se lanza una sonda mas corta.
// (2026-09-22) 1.000 -> 700 para que quepan mas sondas en los 2,5 s del tramo.
const DAEMON_RELAUNCH_MIN_PROBE_MS = 700;

// ---------------------------------------------------------------------------
// Puerta de Qdrant (2026-09-22)
// ---------------------------------------------------------------------------
// Sin Qdrant no hay recall DENSO: el daemon puede estar vivo y aun asi tardar
// segundos intentando consultar un Qdrant que no esta, que es una de las colas
// largas medidas. La sonda es la misma que usa ensure-qdrant.js (GET /healthz,
// ~2 ms en loopback caliente) y decide UNA cosa: si Qdrant no contesta, este
// turno no gasta nada en el camino denso — va directo al respaldo sparse
// (FTS5, que no necesita Qdrant) y lo DICE en el aviso, en vez de bloquear el
// prompt esperando a un denso imposible.
// Puerto por entorno para poder probarlo en seco (el selftest levanta su propio
// healthz); por defecto el de Qdrant.
const QDRANT_PROBE_TIMEOUT_MS = 300;
const QDRANT_PORT = Number(process.env.ULTRON_QDRANT_PORT) || 6333;

/** GET /healthz contra Qdrant. true = vivo; cualquier otra cosa = false. */
function qdrantVivo() {
  return new Promise((resolve) => {
    let req;
    try {
      req = http.get(
        { host: '127.0.0.1', port: QDRANT_PORT, path: '/healthz', timeout: QDRANT_PROBE_TIMEOUT_MS },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );
    } catch (_) {
      resolve(false);
      return;
    }
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Desglose por FASE (2026-09-22)
// ---------------------------------------------------------------------------
// Medido sobre 5.731 lineas de hook-timing.jsonl: n=146, p50=442 ms,
// p95=9.561 ms, max=18.529 ms. O sea: la mitad de los prompts no nota nada y
// una cola de ~5% se come casi diez segundos ANTES de que el turno arranque.
//
// Lo que NO se sabia: en QUE se van esos 9,5 s. La atribucion que circulaba
// ("es la recarga de los modelos tras el idle de 30 min") encaja con
// CLAUDE.md, pero era una inferencia: hook-timing.jsonl guarda un unico
// elapsed_ms por ejecucion, sin desglose. Y sin saber que fase manda, elegir
// entre recortar el presupuesto o irse a `asyncRewake` es tirar una moneda.
//
// Por eso, antes de tocar ningun presupuesto, cada espera se cronometra por
// separado y el desglose viaja a los dos sitios que ya tienen lector:
// hook-timing.jsonl (via annotate -> la ficha del hook en la app) y
// orchestrate.jsonl (el Live Session Monitor). Con eso, la proxima decision
// se toma con el reparto real delante.
const fases = {
  qdrant_ms: 0, // sonda healthz de Qdrant (decide si hay camino denso)
  daemon_ms: 0, // espera al daemon residente (camino rapido)
  busy_ms: 0, // reintentos con el daemon VIVO pero con el lock ocupado
  boot_ms: 0, // daemon en warmup (lockfile joven)
  relanzamiento_ms: 0, // daemon muerto: relanzar `serve` y esperarle
  sparse_ms: 0, // respaldo FTS5 sin E5
};

/** Cronometra `fn` y suma lo que tarde a la fase indicada. */
async function medir(fase, fn) {
  const t = Date.now();
  try {
    return await fn();
  } finally {
    fases[fase] += Date.now() - t;
  }
}

/** La fase que mas tiempo se llevo, para explicar una espera larga en una palabra. */
function faseDominante() {
  let mejor = null;
  for (const [k, v] of Object.entries(fases)) {
    if (v > 0 && (!mejor || v > fases[mejor])) mejor = k;
  }
  return mejor;
}

/** Rastro de un prompt servido por el carril rapido (sin orchestrate). */
function logFastLane({ sessionId, project, prompt, lane, elapsedMs }) {
  try {
    appendJsonl(FAST_LANE_LOG, {
      ts: new Date().toISOString(),
      session_id: sessionId,
      project,
      prompt: String(prompt).slice(0, 120),
      class: lane.class,
      reason: lane.reason,
      elapsed_ms: elapsedMs,
    });
  } catch {
    /* rastro best-effort */
  }
}

// F-resume: bloque del resumen de la sesion anterior, resuelto UNA vez por
// sesion en main() ANTES de cualquier salida temprana. Vive fuera de emit()
// para que TODO camino de salida de este hook (fast-lane, turno de sistema,
// prompt vacio, degradado, normal) lo entregue por igual — es el unico punto
// por el que pasan todas las llamadas a emit(), asi que ningun early-return
// puede tragarselo en silencio.
let pendingDeliveryBlock = '';

function emit(additionalContext) {
  const prefix = pendingDeliveryBlock ? pendingDeliveryBlock + '\n' : '';
  const ctx = prefix + (additionalContext || '');
  // Pilar 1: contabiliza lo que este hook inyecta al CLI (antes a ciegas).
  try { require('./lib/token-meter').meterInjection('memory-orchestrate', ctx); } catch {}
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: ctx,
      },
    })
  );
}

// Personalities v1 (2026-08-13): lineas de tono. Se emiten ANTES que el resto:
// son una orden de registro para TODA la respuesta, no una sugerencia de routing.
// Viven fuera de render() porque el camino de memoria DEGRADADA (sin contexto)
// tambien debe entregar el tono: la deteccion es local y no depende del sidecar.
/**
 * Tono por defecto del sistema (`default_tone` de personality.json).
 *
 * `detectForPrompt` devuelve null cuando ningun tono gana, porque el default
 * "ya es la base" (vive en el CLAUDE.md global). La practica dice otra cosa: sin
 * la directiva viajando CON el prompt, el registro se diluye turno a turno
 * — el usuario lo reclamo cinco veces entre julio y agosto de 2026. Asi que el
 * default se inyecta siempre, en todos los proyectos, con la version compacta
 * de la directiva.
 *
 * Ojo al tocar esto: la POLITICA vive aqui, no en lib/tone-detect.js. La
 * deteccion tiene un gate de paridad JS<->Rust (_tone_parity.js) y meterle el
 * fallback la haria divergir del detector del sidecar, que responde a otra
 * pregunta ("que tono pide este prompt", no "con que tono respondo").
 */
function defaultTone() {
  try {
    const file = loadPersonality();
    if (!file || !file.default_tone) return null;
    const tone = (file.tones || []).find((t) => t.id === file.default_tone);
    if (!tone) return null;
    return {
      id: tone.id,
      name: tone.name,
      lang: tone.lang,
      style_guide: tone.style_guide,
      profanity: tone.profanity,
      is_default: true,
    };
  } catch (_) {
    return null;
  }
}

/** Tono detectado en el prompt; si no hay, el default del sistema. */
function toneForPrompt(prompt) {
  return detectForPrompt(prompt) || defaultTone();
}

function toneLines(t) {
  const out = [];
  if (!t || !t.id) return out;

  // El default viaja en TODOS los turnos, asi que se paga en todos: se emite la
  // guia de estilo completa y el limite de ambito, sin el bloque de conviccion
  // que necesita un tono elegido a proposito (~90 tokens frente a ~350).
  if (t.is_default) {
    // ULTRON 4 7.1 (Q4b): UNA linea. La directiva larga (5 frases + ejemplo)
    // viajaba en cada prompt y se diluia igual; la corta cabe en una lectura.
    out.push(
      `tone [${t.id}, defecto, solo chat, ${t.lang || 'es'}]: ${t.style_guide || ''} ` +
        `(codigo, commits, docs y prompts a subagentes: tono tecnico, ortografia completa; datos EXACTOS).`
    );
    return out;
  }

  if (t.id) {
    out.push(`tone_detected: ${t.name} [${t.id}] — ${t.reason || ''}`);
    // Feedback del usuario 2026-08-13: "a good chunk of personality, not a
    // couple of words here and there" — la directiva exige compromiso TOTAL,
    // no salpicar slang sobre una respuesta de oficina.
    out.push(
      `tone_directive: AMBITO (limite duro): el tono viste SOLO la conversacion ` +
        `directa con el usuario. NUNCA sale de ahi: ni codigo, ni comentarios, ni ` +
        `mensajes de commit, ni PRs, ni issues, ni documentacion, ni README, ni ` +
        `CHANGELOG, ni texto del TFG, ni prompts a subagentes, ni ningun artefacto ` +
        `que persista o que pueda leer un tercero — ahi rige el tono tecnico ` +
        `profesional con ortografia completa, aunque el tono este activo en este ` +
        `mismo turno. Dentro del chat, en cambio: ` +
        `LA PERSONALIDAD ES LA VOZ DE TODA LA RESPUESTA — cada frase, ` +
        `la gramatica, el ritmo y la actitud salen en este registro; PROHIBIDO espolvorear ` +
        `dos palabras de slang sobre una respuesta neutra. Los datos tecnicos se mantienen ` +
        `EXACTOS (cambia la voz, nunca el contenido). TEST FINAL antes de responder: si tu ` +
        `borrador podria salir de un asistente corporativo neutro, REESCRIBELO entero en el ` +
        `registro — el usuario ELIGIO esta voz y entregarla descafeinada es fallarle. ` +
        `Iguala el nivel del EJEMPLO DE VOZ de la guía, nunca por debajo. ` +
        (t.lang === 'es' && t.id !== 'ultron'
          ? `EXCEPCION ORTOGRAFICA: la regla de "ortografia completa del español" ` +
            `describe el registro POR DEFECTO y NO aplica mientras este tono este activo. ` +
            `Las elisiones y grafias deformadas del registro (q, ke, khe, po zi, pa, to, ` +
            `-ao por -ado) SON el tono: escribirlo en español pulcro es entregarlo roto. ` +
            `Los identificadores de codigo y los datos tecnicos se mantienen intactos. `
          : '') +
        `Idioma: ${t.lang || 'es'}; insultos: ${t.profanity || 'none'}. Guía: ${t.style_guide || ''}`
    );
  }
  return out;
}

// 2026-09-06 (ahorro de tokens): resúmenes de sesión cuyo "tema inicial" es
// la salida de /context no aportan nada al turno; y 12 memorias por prompt se
// quedan en el contexto para siempre. Tope 6 tras filtrar.
const JUNK_MEMORY_RE = /^Sesi[oó]n cerrada \(|## Context Usage/;
const MAX_MEMORIES_PER_TURN = 6;
const MAX_SKILLS_PER_TURN = 3;

function usefulMemories(memories) {
  if (!Array.isArray(memories)) return [];
  return memories
    .filter((m) => !JUNK_MEMORY_RE.test(String((m && m.summary) || '')))
    .slice(0, MAX_MEMORIES_PER_TURN);
}

function render(ctx) {
  const tone = toneLines(ctx.tone);
  // 7.1: el tono por defecto va FUERA del bloque de orquestacion (primera linea,
  // sola); un tono elegido a proposito sigue dentro con su bloque de conviccion.
  const out = ctx.tone && ctx.tone.is_default ? [...tone] : [];
  out.push(`<orchestration-context route="${ctx.route || ''}" trust="system">`);
  if (!(ctx.tone && ctx.tone.is_default)) out.push(...tone);
  if (ctx.workflow) out.push(`workflow: ${ctx.workflow.id} — ${ctx.workflow.label}`);
  // cat13.4 (2026-06-19): cuando el routing propone un GRUPO (workflow multi-paso),
  // cada paso/agente lleva su PROPIO encuadre derivado del sub-intent de su rol —
  // no solo el encuadre global del turno. Esto cierra "optimiza el prompt del paso".
  if (Array.isArray(ctx.step_plans) && ctx.step_plans.length > 1) {
    out.push('step_plans (encuadre optimizado por paso del grupo):');
    for (const sp of ctx.step_plans.slice(0, 6)) {
      const frame = String(sp.frame || '');
      const short = frame.length > 90 ? frame.slice(0, 90) + '…' : frame;
      out.push(`  - ${sp.agent} [${sp.sub_intent}]: ${short}`);
    }
  }
  if (ctx.delegation_directive) {
    // 2026-06-23: delegación automática (plano chat). La directiva SUSTITUYE al
    // advisory: es una ORDEN, no una sugerencia. El agente la ejecuta con Agent().
    const d = ctx.delegation_directive;
    // calidad>tokens (feedback 2026-06-24): el especialista delegado nunca cae a
    // haiku; si el sidecar no sugiere modelo, default de calidad = sonnet.
    const model = d.model_hint || 'sonnet';
    out.push('<orchestration-directive trust="system">');
    out.push('DELEGA AHORA — no hagas este trabajo en el contexto principal.');
    out.push(`agent: ${d.agent}`);
    out.push(`objetivo: ${d.objective || ''}`);
    out.push(`devuelve: ${d.return_format || ''}`);
    out.push(`modelo: ${model}`);
    out.push(`motivo: ${d.reason || ''}`);
    out.push(
      `Accion: usa la herramienta Agent (subagent_type="${d.agent}", model="${model}") con ese ` +
        'objetivo. Si delegar es contraproducente (ya tienes el resultado, o la tarea resulto ' +
        'trivial), dilo en UNA linea y hazlo inline — nunca ignores la directiva en silencio.'
    );
    out.push('</orchestration-directive>');
  } else if (Array.isArray(ctx.delegate_agents) && ctx.delegate_agents.length) {
    out.push('delegate_to (specialist agents, by similarity):');
    for (const a of ctx.delegate_agents.slice(0, 4)) {
      out.push(`  - ${a.name} (${Number(a.score || 0).toFixed(2)})`);
    }
  }
  if (Array.isArray(ctx.delegate_skills) && ctx.delegate_skills.length) {
    out.push('consider_skills (by similarity):');
    for (const s of ctx.delegate_skills.slice(0, MAX_SKILLS_PER_TURN)) {
      const k = s.kind ? `, ${s.kind}` : '';
      out.push(`  - ${s.name} (${Number(s.score || 0).toFixed(2)}${k})`);
    }
  }
  const memories = usefulMemories(ctx.memories);
  if (memories.length) {
    out.push('relevant_memories:');
    for (const m of memories) out.push(`  - [${m.scope || ''}] ${m.summary || ''}`);
  }
  // ULTRON 4 F1.3: lecciones de OTROS proyectos que encajan con el sintoma del
  // turno (solo llegan en turnos bug_fix/debug). Una linea por leccion.
  if (Array.isArray(ctx.lessons) && ctx.lessons.length) {
    out.push('lessons_cross_project (lecciones de otros proyectos que encajan con este fallo — aplicar antes de investigar de cero):');
    for (const l of ctx.lessons.slice(0, 3)) {
      const origen = l.project_id ? `[${l.project_id}] ` : '';
      const detalle = l.symptom_cause ? ` — ${l.symptom_cause}` : '';
      out.push(`  - ${origen}${l.rule || ''}${detalle}`);
    }
  }
  if (Array.isArray(ctx.constraints) && ctx.constraints.length) {
    out.push(`constraints: ${ctx.constraints.join(' | ')}`);
  }
  if (Array.isArray(ctx.warnings) && ctx.warnings.length) {
    out.push(`warnings: ${ctx.warnings.join('; ')}`);
  }
  // cat13 (2026-06-10): paso de mejora de prompt del sidecar. Solo el ENCUADRE
  // y el modo (el prompt literal ya esta en el turno del usuario — no se
  // duplica para no gastar tokens). Las preguntas solo si el prompt era vago.
  const plan = ctx.prompt_plan;
  if (plan && typeof plan === 'object') {
    if (plan.suggested_mode) out.push(`suggested_mode: ${plan.suggested_mode}`);
    const frame = String(plan.improved_prompt || '');
    const idx = frame.indexOf('[encuadre');
    if (idx >= 0) out.push(`prompt_frame: ${frame.slice(idx)}`);
    if (Array.isArray(plan.clarifying_questions) && plan.clarifying_questions.length) {
      out.push(`clarify_first: ${plan.clarifying_questions.join(' | ')}`);
    }
    if (Array.isArray(plan.success_criteria) && plan.success_criteria.length) {
      out.push(`success_criteria: ${plan.success_criteria.join(' | ')}`);
    }
  }
  out.push('</orchestration-context>');
  return out.join('\n');
}

function buildLogEntry(ctx, prompt, project, sessionId, elapsedMs, usedDaemon, desglose) {
  return {
    ts: new Date().toISOString(),
    // cat15.1: latencia de la orquestacion (hot path UserPromptSubmit) para el
    // LiveSessionMonitor y para diagnosticar la latencia del prompt.
    elapsed_ms: typeof elapsedMs === 'number' ? elapsedMs : null,
    // 2026-09-22: reparto de esa latencia por fase. Sin esto, el p95 de 9,5 s
    // era un numero sin causa: no se sabia si era esperar al daemon, el lock
    // ocupado, el arranque o el respaldo sparse.
    fases: desglose || null,
    // cat9.4: traza si el hot path uso el daemon TCP (sub-segundo) o el spawn
    // one-shot de fallback (cold E5 ~3.5s). Util para diagnosticar si el daemon
    // murio entre sesiones y cuantos prompts pagaron el coste completo.
    daemon_hit: usedDaemon === true,
    session_id: sessionId || null,
    project: project || null,
    prompt: String(prompt || '').slice(0, 280),
    route: ctx.route || null,
    // 2026-09-06: el daemon re-rankea por ruta (todo menos general); se traza
    // para poder medir latencia y utilidad con y sin re-rank sobre tráfico real.
    rerank_hot: ctx.rerank_hot === true,
    workflow: ctx.workflow ? { id: ctx.workflow.id, label: ctx.workflow.label } : null,
    step_plans: (Array.isArray(ctx.step_plans) ? ctx.step_plans : [])
      .slice(0, 6)
      .map((sp) => ({ agent: sp.agent, sub_intent: sp.sub_intent })),
    agents: (Array.isArray(ctx.delegate_agents) ? ctx.delegate_agents : [])
      .slice(0, 6)
      .map((a) => ({ name: a.name, score: Number(a.score || 0) })),
    skills: (Array.isArray(ctx.delegate_skills) ? ctx.delegate_skills : [])
      .slice(0, 6)
      .map((s) => ({ name: s.name, kind: s.kind || '', score: Number(s.score || 0) })),
    memories: (Array.isArray(ctx.memories) ? ctx.memories : [])
      .slice(0, 8)
      .map((m) => ({ scope: m.scope || '', summary: String(m.summary || '').slice(0, 160) })),
    cross_project: !!ctx.cross_project,
    warnings: Array.isArray(ctx.warnings) ? ctx.warnings : [],
    // Personalities v1: tono detectado (Live Monitor + telemetría de acierto).
    tone: ctx.tone ? { id: ctx.tone.id, explicit: !!ctx.tone.explicit } : null,
    // 2026-06-23: traza de delegación automática para medir la tasa efectiva
    // (directivas emitidas vs delegaciones realmente ejecutadas por el agente).
    directive_emitted: !!ctx.delegation_directive,
    directive_agent: ctx.delegation_directive ? ctx.delegation_directive.agent : null,
  };
}

function logOrchestration(ctx, prompt, project, sessionId, elapsedMs, usedDaemon, desglose) {
  // 2026-09-06 (F1.6): sin session_id no es un turno de la persona, es el harness
  // (kirkardo-eval manda {prompt, hook_event_name} a pelo). 42 líneas sintéticas
  // ("hola que tal como estas hoy" x9, "microservicio en golang" x7...) inflaban
  // el audit de tráfico real un 4,6 %. El log mide tráfico REAL; el harness no.
  if (!sessionId) return;
  try {
    // cat15.4: JSONL acotado (rota a 1 MiB) via helper compartido.
    appendJsonl(
      ORCH_LOG,
      buildLogEntry(ctx, prompt, project, sessionId, elapsedMs, usedDaemon, desglose)
    );
  } catch (_) {
    /* never block the prompt */
  }
}

async function main() {
  const t0 = Date.now();
  let prompt = '';
  let cwd = process.cwd();
  let sessionId = null;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const inp = JSON.parse(raw || '{}');
    prompt = inp.prompt || '';
    if (inp.cwd) cwd = inp.cwd;
    sessionId = inp.session_id || inp.sessionId || null;
  } catch {
    /* no stdin / bad json */
  }
  const project = projectIdFromCwd(cwd);
  // F-resume: si SessionStart dejo un resumen pendiente (session-summary-
  // delivery) para ESTA sesion, se resuelve aqui, antes de cualquier salida
  // temprana. emit() lo antepone siempre (ver arriba); coste tras resolverse:
  // un solo fs.existsSync por prompt.
  if (sessionId) {
    try {
      // sinceMs = inicio de la espera: un summary.md mas viejo que eso ya
      // existia antes del pending y no es el que genero ESTE resumidor.
      const delivered = sessionSummaryDelivery.resolveDelivery(sessionId, (sinceMs) =>
        lastSession.latestSummary(project, sessionId, { sinceMs })
      );
      // renderLastSessionLines() ya envuelve el contenido en su propia
      // etiqueta trust="session-summary" (lo escribio un modelo, no el
      // sistema) -- ningun wrapper adicional aqui.
      if (delivered) pendingDeliveryBlock = lastSession.renderLastSessionLines(delivered).join('\n');
    } catch {
      /* fail-safe: el prompt sigue igual sin la entrega diferida */
    }
  }
  if (!prompt.trim()) {
    emit('');
    return;
  }
  // Turno de SISTEMA (notificacion de tarea background): no orquestar — rutear
  // su XML como si fuera un prompt humano inyecta skills/memorias sin sentido.
  if (isSystemTurnPrompt(prompt)) {
    emit('');
    return;
  }

  // Doble velocidad (2026-09-07, decidido por el usuario): un ack o una
  // continuacion corta no paga el orchestrate (recall + routing + tono). El
  // primer prompt de la sesion y las preguntas de estado van siempre
  // completos; tras una racha de rapidos o 15 min sin completo, vuelve el
  // completo aunque parezca un ack (ver lib/fast-lane.js). Se deja rastro en
  // logs/fast-lane.jsonl (aparte de orchestrate.jsonl, que solo lleva
  // orquestaciones reales para el audit de trafico).
  const lane = decideLane({ prompt, sessionId });
  if (lane.lane === 'fast') {
    markPrompt(sessionId, { full: false });
    logFastLane({ sessionId, project, prompt, lane, elapsedMs: Date.now() - t0 });
    emit('');
    return;
  }
  const laneState = readLaneState(sessionId);
  const firstPrompt = !laneState || laneState.prompts === 0;
  markPrompt(sessionId, { full: true });

  // Cache leida ANTES del daemon: con pack fresco (<30 min) el presupuesto del
  // daemon baja a DAEMON_TIMEOUT_CACHED_MS — el fallback cacheado garantiza
  // respuesta util aunque el daemon este contendido.
  const cached = readOrchCache(project);

  // Puerta de Qdrant (2026-09-22): sin Qdrant no hay recall denso, asi que este
  // turno no gasta NI UN MILISEGUNDO del presupuesto esperando al daemon —
  // salta directo al respaldo sparse, que no lo necesita. Coste de la puerta:
  // un GET a loopback (ver qdrantVivo).
  const qdrantOk = await medir('qdrant_ms', qdrantVivo);

  // FAST PATH: ask the resident daemon (E5 warm) over TCP loopback. Drops the
  // hot path from ~3.5s (cold model load every spawn) to sub-second.
  // Primer prompt de la sesion: una sola espera larga (ver FIRST_PROMPT_DAEMON_WAIT_MS).
  const daemonWaitMs = firstPrompt
    ? FIRST_PROMPT_DAEMON_WAIT_MS
    : cached
      ? DAEMON_TIMEOUT_CACHED_MS
      : DAEMON_TIMEOUT_MS;
  let ctx = qdrantOk
    ? await medir('daemon_ms', () =>
        daemonRequest({ cmd: 'orchestrate', prompt, project: project || undefined }, daemonWaitMs)
      )
    : null;
  // HOOKS-06: separar "busy" (daemon VIVO, lock ocupado) de "caido/roto". Solo
  // el segundo justifica el fallback one-shot; ante el primero se espera al
  // mismo daemon, que es justo lo que evita la estampida de cargas de E5.
  let daemonBusy = isDaemonBusy(ctx);
  if (ctx && ctx.error) ctx = null; // daemon answered but failed -> fall back

  // (primer prompt: la espera larga ya ha consumido su presupuesto; sin reintentos)
  if (!ctx && daemonBusy && !firstPrompt) {
    await medir('busy_ms', async () => {
      const busyDeadline = Date.now() + BUSY_RETRY_BUDGET_MS;
      while (Date.now() + BUSY_RETRY_POLL_MS < busyDeadline) {
        await sleep(BUSY_RETRY_POLL_MS);
        const retry = await daemonRequest(
          { cmd: 'orchestrate', prompt, project: project || undefined },
          Math.max(1000, busyDeadline - Date.now())
        );
        daemonBusy = isDaemonBusy(retry);
        if (retry && !retry.error) {
          ctx = retry;
          break;
        }
        // Un error que NO es "busy" (o silencio) sí es daemon roto: se abandona
        // el reintento y se cae al camino de degradación de abajo.
        if (!daemonBusy) break;
      }
    });
  }

  // HOOKS-05: daemon en warmup (lock joven) -> poll hasta DAEMON_BOOT_WAIT_MS
  // en vez de degradar al one-shot (que compite por CPU con la carga de E5).
  if (!ctx && !firstPrompt && qdrantOk) {
    const lock = readDaemonLock();
    const bootAge =
      lock && Number.isFinite(lock.started_at) ? Date.now() - lock.started_at : Infinity;
    if (bootAge >= 0 && bootAge < DAEMON_BOOT_WINDOW_MS) {
      await medir('boot_ms', async () => {
        const deadline = t0 + DAEMON_BOOT_WAIT_MS;
        while (!ctx && Date.now() + DAEMON_BOOT_POLL_MS < deadline) {
          await sleep(DAEMON_BOOT_POLL_MS);
          ctx = await daemonRequest(
            { cmd: 'orchestrate', prompt, project: project || undefined },
            Math.max(1000, deadline - Date.now())
          );
          if (ctx && ctx.error) ctx = null;
        }
      });
    }
  }

  // HOOKS-07: daemon MUERTO (sin lockfile, o con lockfile pero mudo y sin decir
  // "busy") -> relanzarlo y ESPERARLE dentro del presupuesto, en vez de caer al
  // sparse de inmediato y competir con su carga de E5. "busy" queda fuera a
  // proposito: ahi el daemon esta VIVO y ya se le ha reintentado arriba.
  if (!ctx && !daemonBusy && qdrantOk) {
    const relaunchT0 = Date.now();
    await medir('relanzamiento_ms', async () => {
      spawnDetached(['serve']); // idempotente: sale al momento si ya hay uno vivo
      // Manda el techo que venza antes: el relativo del tramo o el absoluto del
      // presupuesto del hook (ver DAEMON_RELAUNCH_BUDGET_MS).
      const deadline = Math.min(
        t0 + DAEMON_RELAUNCH_DEADLINE_MS,
        relaunchT0 + DAEMON_RELAUNCH_BUDGET_MS
      );
      while (
        !ctx &&
        Date.now() + DAEMON_BOOT_POLL_MS + DAEMON_RELAUNCH_MIN_PROBE_MS <= deadline
      ) {
        await sleep(DAEMON_BOOT_POLL_MS);
        // Sin lockfile el daemon nuevo todavia no escucha: no se gasta un connect.
        if (!readDaemonLock()) continue;
        const resp = await daemonRequest(
          { cmd: 'orchestrate', prompt, project: project || undefined },
          deadline - Date.now()
        );
        // "busy" durante el arranque = vivo pero cargando: se sigue esperando.
        if (isDaemonBusy(resp)) continue;
        if (resp && !resp.error) ctx = resp;
      }
    });
    if (ctx) {
      if (!Array.isArray(ctx.warnings)) ctx.warnings = [];
      ctx.warnings.push(
        `daemon relanzado en ${Date.now() - relaunchT0} ms — este turno lo sirve el daemon nuevo`
      );
    }
  }

  const usedDaemon = ctx !== null;

  let staleFromCache = false;
  if (!ctx) {
    // HOOKS-06: si el daemon sigue diciendo "busy", está VIVO — solo saturado.
    // Ni spawn (ya hay uno) ni one-shot: este último cargaría otra copia de E5
    // compitiendo con quien ya la está cargando, que es exactamente la
    // estampida que degradó 5/5 prompts el 2026-08-22. Se cae directo a la red
    // de seguridad de abajo (pack cacheado, o degradación marcada).
    // Daemon caido o mudo: ya se ha relanzado y esperado arriba (HOOKS-07), asi
    // que aqui no se vuelve a spawnear nada — con "busy" el daemon esta VIVO y
    // con silencio el relanzamiento ya salio. ESTE turno se resuelve en local
    // SIN E5 (`--sparse`): el sparse no carga modelo, asi que no hay estampida
    // que evitar. El pack cacheado sigue de red por debajo (HOOKS-04).
    const args = ['orchestrate', prompt, '--sparse'];
    if (project) args.push('--project', project);
    const daemonWaitedMs = Date.now() - t0;
    // Cap DINAMICO: lo que queda del presupuesto del hook menos el colchon,
    // acotado a [SPARSE_MIN_CAP_MS, SPARSE_MAX_CAP_MS].
    const sparseCapMs = Math.min(
      SPARSE_MAX_CAP_MS,
      Math.max(SPARSE_MIN_CAP_MS, HOOK_BUDGET_MS - daemonWaitedMs - SAFETY_MARGIN_MS)
    );
    const sparseT0 = Date.now();
    ctx = runCli(args, { timeoutMs: sparseCapMs });
    fases.sparse_ms += Date.now() - sparseT0;
    if (ctx && typeof ctx === 'object') {
      if (!Array.isArray(ctx.warnings)) ctx.warnings = [];
      ctx.warnings.push(
        `respaldo sparse (FTS5, sin E5, cap ${sparseCapMs} ms): ` +
          (qdrantOk
            ? `el daemon no respondio en ${daemonWaitedMs} ms`
            : `Qdrant no responde en /healthz (puerto ${QDRANT_PORT}) — recall DENSO saltado, ` +
              'este turno va solo con FTS5') +
          (firstPrompt ? ' (primer prompt de la sesion)' : '')
      );
    }
    if (ctx === null && cached) {
      // Pack del prompt ANTERIOR del mismo proyecto (<30 min): mejor un pack
      // stale marcado que 4-5s de bloqueo o que nada. El route/step_plans
      // pueden no encajar con ESTE prompt — el warning lo deja claro.
      ctx = cached;
      staleFromCache = true;
      if (!Array.isArray(ctx.warnings)) ctx.warnings = [];
      ctx.warnings.push('context pack CACHEADO de un prompt anterior (daemon frio) — route/steps pueden no aplicar a este prompt');
      // (2026-08-17, medido en el harness 22.2/22.5) La DIRECTIVA de delegacion
      // es especifica del prompt que la genero: servirla stale ordenaba delegar
      // "consolida la memoria" a rust-engineer y ponia sonnet a un analisis de
      // arquitectura — el motor decide bien, el cache re-emitia la decision de
      // OTRO prompt. Las memorias stale ayudan; una orden de delegar stale
      // desinforma. Se anula junto a los step_plans (misma naturaleza).
      ctx.delegation_directive = null;
      ctx.directive = null;
      ctx.step_plans = null;
    }
    // cat9 (mandamiento 11: prohibido el no-op silencioso). Si ni el daemon ni el
    // spawn one-shot devolvieron orquestacion, es FALLO real del sidecar (no hay
    // "vacio legitimo" aqui: un prompt no vacio sano siempre produce un objeto de
    // ruta). Deja rastro accionable ADEMAS del fail-safe emit('') de abajo.
    if (ctx === null) {
      const reason = findBinary()
        ? 'sidecar orchestrate FALLO (binario presente pero status!=0 / timeout / JSON no parseable)'
        : 'sidecar orchestrate FALLO (binario ultron-memory ausente: no instalado / ULTRON_MEMORY_BIN invalido)';
      logHookError('memory-orchestrate', reason);
    }
  }
  // El tono se detecta SIEMPRE en local sobre ESTE prompt y pisa lo que traiga el
  // pack: si el pack venia cacheado, su `tone` es el del prompt anterior (o null)
  // y aplicarlo era la causa medida de "el tono apenas se aplica" (2026-08-14).
  const localTone = toneForPrompt(prompt);

  if (!ctx) {
    // Aviso visible al modelo (mismo patron que el resume degradado): sin esto el
    // fallo era 100% silencioso y el usuario no podia saber que la memoria no aporto.
    // El tono SI se entrega: no depende del sidecar.
    // 2026-09-22: el aviso dice ADEMAS en que fase se fue la espera. "Tardo 9 s
    // y no trajo nada" sin causa no es accionable; "se fueron 9 s esperando al
    // daemon" si lo es.
    annotate({ fases, degradado: true, fase_dominante: faseDominante(), qdrant: qdrantOk });
    emit(
      [
        ...toneLines(localTone),
        '[memoria degradada] orchestrate sin respuesta (daemon/Qdrant caido o timeout) — ' +
          'este prompt va SIN recall de memoria. Si se repite, revisar: bin/ultron-memory.exe doctor',
        // 2026-09-22: si la puerta de Qdrant fue la que cerro el camino denso,
        // se dice con nombre y puerto — "revisa el doctor" no es accionable
        // cuando lo que pasa es que Qdrant no esta escuchando.
        ...(qdrantOk
          ? []
          : [
              `[memoria degradada] Qdrant no responde en /healthz (puerto ${QDRANT_PORT}): ` +
                'recall denso saltado sin esperar al daemon; el watchdog de ensure-qdrant ' +
                'lo relanza en segundo plano',
            ]),
        `[memoria degradada] reparto de la espera: ${Object.entries(fases)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ') || 'sin esperas medibles'}`,
      ].join('\n')
    );
    return;
  }
  annotate({ fases, degradado: false, fase_dominante: faseDominante(), qdrant: qdrantOk });
  ctx.tone = localTone;
  if (!staleFromCache) {
    // Sin `tone` en el cache: es del prompt que lo genero y servirlo stale seria
    // reintroducir el bug por la puerta de atras si alguien deja de sobreescribirlo.
    writeOrchCache(project, { ...ctx, tone: null });
    // Solo orquestaciones FRESCAS al Live Session Monitor — un pack cacheado
    // re-loggeado duplicaria la entrada original con datos de otro prompt.
    logOrchestration(ctx, prompt, project, sessionId, Date.now() - t0, usedDaemon, { ...fases });
  }
  emit(render(ctx));
}

if (require.main === module) {
  main()
    .catch((e) => {
      // cat9.5: deja rastro del fallo top-level sin romper el fail-safe.
      try {
        appendJsonl(path.join(os.homedir(), '.ultron', 'logs', 'hook-errors.jsonl'), {
          hook: 'memory-orchestrate',
          error: String((e && e.message) || e),
        });
      } catch { /* ignore */ }
      try { emit(''); } catch { /* ignore */ }
    })
    .finally(() => {
      process.exitCode = 0;
    });
} else {
  // Exportadas para test (patrón require.main, como en stop-compress-session.js).
  module.exports = { render, logOrchestration, buildLogEntry };
}
