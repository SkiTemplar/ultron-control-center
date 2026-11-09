#!/usr/bin/env node
// hooks/scripts/memory-gc.js — SessionEnd hook (F1.8, decision del 2026-09-11).
//
// Dispara el mantenimiento a 90 dias de brain.db como MUCHO una vez por semana:
//
//   ultron-memory gc --days 90
//
// El binario hace el trabajo, con tres reglas a 90 dias: decaimiento a stale de
// los ACTIVE sin recall ni cambios, poda de los memory_events de items
// deprecated/rejected y poda de los eventos que ya no cuelgan de ningun item
// (memory_id NULL o item inexistente). Aqui solo vive la cadencia, el registro y
// la garantia de no molestar. El escritor de memoria sigue siendo MemoryService
// dentro del sidecar: este hook no toca brain.db.
//
// Cadencia: estado en ~/.ultron/.tmp/memory-gc-last.json (last_run_ms). Solo se
// sella tras una ejecucion con exit 0, asi que un binario roto se reintenta en
// vez de perder la semana.
//
// Fallos (H26, 2026-10-17): entre el 2026-10-02 y el 2026-10-17 el gc murió por
// timeout en los 134 cierres de sesión y el log solo decía `status: null`. Ahora
// cada fallo deja en el log la causa (error del spawn, señal, exit, stderr) y en
// el estado `fail_count`, `last_fail_ms` y `last_error`; el reintento espera un
// backoff exponencial (6 h, 12 h, 24 h… con tope en la cadencia semanal) en vez
// de pagar 110 s en cada cierre. `ultron-memory doctor` (check `gc`) lee ese
// estado y avisa: el hook es async y su salida no la ve nadie.
//
// NO-OP-SAFE: cualquier fallo sale con 0. Un hook de cierre que rompe la sesion
// es peor que un mantenimiento aplazado. El presupuesto es timeout=120 en
// ~/.claude/settings.json (async: su stdout se descarta, solo cuentan sus
// efectos a fichero).
//
// Opt-out: CLAUDE_NO_HOOKS=1 o MEMORY_GC_DISABLED=1.
// Seams de test (el selftest no toca ni brain.db ni el binario real):
//   ULTRON_MEMORY_BIN  binario a ejecutar (stub en el selftest)
//   MEMORY_GC_STATE    ruta del fichero de estado
//   MEMORY_GC_LOG      ruta del log JSONL
//   MEMORY_GC_TIMEOUT_MS  timeout del binario (por defecto 110000)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');
const { appendJsonl } = require('./lib/jsonl-log');
const { findBinary, projectIdFromCwd } = require('./lib/ultron-memory-cli');
observe('memory-gc');

const HOME = os.homedir();
const LOG_PATH = process.env.MEMORY_GC_LOG || path.join(HOME, '.ultron', 'logs', 'memory-gc.jsonl');
const STATE_PATH = process.env.MEMORY_GC_STATE || path.join(HOME, '.ultron', '.tmp', 'memory-gc-last.json');
// Ventana del mantenimiento (dias) y cadencia minima entre ejecuciones.
const GC_DAYS = 90;
const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// Margen bajo el timeout=120s del hook: deja ~10s para el arranque de node y el
// registro. El caso caro es un VACUUM de 126 MB.
const GC_TIMEOUT_MS = Number(process.env.MEMORY_GC_TIMEOUT_MS) > 0 ? Number(process.env.MEMORY_GC_TIMEOUT_MS) : 110000;
// Primer escalón del backoff tras un fallo; se dobla con cada fallo seguido.
const BACKOFF_BASE_MS = 6 * 60 * 60 * 1000;

/** Espera mínima antes de reintentar tras `fallos` fallos seguidos. */
function backoffMs(fallos) {
  if (!(fallos > 0)) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (fallos - 1), INTERVAL_MS);
}

function readState() {
  try {
    const v = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (v && typeof v === 'object') return v;
  } catch (_) {
    /* sin estado previo o ilegible: toca ejecutar */
  }
  return null;
}

/** Causa legible de un spawn fallido: error del spawn, señal, exit o stderr. */
function causaDelFallo(res) {
  if (!res) return 'sin resultado del spawn';
  if (res.error) {
    const code = res.error.code || String(res.error.message || res.error).slice(0, 120);
    const timeout = code === 'ETIMEDOUT' ? ` (timeout de ${Math.round(GC_TIMEOUT_MS / 1000)} s)` : '';
    return `${code}${timeout}${res.signal ? `, señal ${res.signal}` : ''}`;
  }
  if (res.signal) return `señal ${res.signal}`;
  const stderr = res.stderr ? String(res.stderr).replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, 160) : '';
  return `exit ${res.status}${stderr ? `: ${stderr}` : ''}`;
}

/**
 * Registra un fallo: línea en el log con la causa y estado con el contador de
 * fallos seguidos. `last_run_ms` (último éxito) se conserva tal cual.
 */
function registrarFallo(estado, ahora, entrada, causa) {
  const previos = estado && Number.isFinite(estado.fail_count) ? estado.fail_count : 0;
  const fail_count = previos + 1;
  appendJsonl(LOG_PATH, {
    ok: false,
    ...entrada,
    cause: causa,
    fail_count,
    retry_in_h: Math.round((backoffMs(fail_count) / 3600000) * 10) / 10,
  });
  writeState({
    ...(estado || {}),
    fail_count,
    last_fail_ms: ahora,
    last_fail_iso: new Date(ahora).toISOString(),
    last_error: causa,
  });
}

/** Sella la ejecucion. Escritura atomica (tmp + rename); nunca lanza. */
function writeState(record) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_PATH);
  } catch (_) {
    /* el estado es una optimizacion de cadencia, no un dato critico */
  }
}

/**
 * Caducidad de la auto-memoria del proyecto que se cierra (scripts/memory-verify.mjs):
 * comprueba por script, sin LLM, las ramas y rutas que citan sus memorias y
 * deja el informe en cockpit/projects/<id>/memory-stale.json. Va en cada
 * cierre, fuera de la cadencia semanal del gc: es barato (un `git branch` y
 * unas decenas de ficheros) y se lanza desacoplado. Nunca lanza.
 */
function launchMemoryVerify() {
  if (process.env.MEMORY_VERIFY_DISABLED === '1') return;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const cwd = (raw.trim() ? JSON.parse(raw) : {}).cwd || process.cwd();
    const project = projectIdFromCwd(cwd);
    if (!project) return;
    const script = path.join(HOME, '.ultron', 'scripts', 'memory-verify.mjs');
    const child = spawn(process.execPath, [script, '--project', project], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (_) {
    /* sin payload o sin proyecto: no hay nada que comprobar */
  }
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.MEMORY_GC_DISABLED === '1') return;
  launchMemoryVerify();

  const ahora = Date.now();
  const estado = readState();
  if (estado && Number.isFinite(estado.last_run_ms) && ahora - estado.last_run_ms < INTERVAL_MS) {
    const restante = INTERVAL_MS - (ahora - estado.last_run_ms);
    appendJsonl(LOG_PATH, {
      skipped: 'cadencia',
      next_in_h: Math.round((restante / 3600000) * 10) / 10,
    });
    return;
  }

  // Backoff tras fallos seguidos: no se paga el timeout en cada cierre.
  const fallos = estado && Number.isFinite(estado.fail_count) ? estado.fail_count : 0;
  if (fallos > 0 && Number.isFinite(estado.last_fail_ms)) {
    const espera = backoffMs(fallos) - (ahora - estado.last_fail_ms);
    if (espera > 0) {
      appendJsonl(LOG_PATH, {
        skipped: 'backoff',
        fail_count: fallos,
        last_error: estado.last_error || null,
        next_in_h: Math.round((espera / 3600000) * 10) / 10,
      });
      return;
    }
  }

  const bin = findBinary();
  if (!bin) {
    appendJsonl(LOG_PATH, { skipped: 'sin binario ultron-memory' });
    return;
  }

  const empezado = Date.now();
  let res;
  try {
    res = spawnSync(bin, ['gc', '--days', String(GC_DAYS)], {
      encoding: 'utf8',
      timeout: GC_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (e) {
    registrarFallo(estado, ahora, { ms: Date.now() - empezado }, `spawn: ${String(e && e.message).slice(0, 160)}`);
    return;
  }
  const ms = Date.now() - empezado;

  if (!res || res.status !== 0) {
    // Sin sellar last_run_ms: se reintenta pasado el backoff.
    registrarFallo(
      estado,
      ahora,
      {
        ms,
        status: res ? res.status : null,
        signal: res && res.signal ? res.signal : null,
        error: res && res.error ? res.error.code || String(res.error.message).slice(0, 200) : null,
        stderr: res && res.stderr ? String(res.stderr).replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, 300) : null,
      },
      causaDelFallo(res),
    );
    return;
  }

  let out = null;
  try {
    out = JSON.parse(String(res.stdout || '').trim());
  } catch (_) {
    out = null;
  }
  if (!out || typeof out !== 'object') {
    registrarFallo(estado, ahora, { ms, error: 'salida no es JSON' }, 'salida no es JSON');
    return;
  }

  const deadlines = out.deprecation_deadlines && typeof out.deprecation_deadlines === 'object' ? out.deprecation_deadlines : null;
  appendJsonl(LOG_PATH, {
    ok: true,
    ms,
    days: out.days,
    stale_marked: out.stale_marked,
    events_deleted: out.events_deleted,
    events_deleted_by_rule: out.events_deleted_by_rule,
    bytes_before: out.bytes_before,
    bytes_after: out.bytes_after,
    vacuumed: out.vacuumed,
    vacuum_skipped: out.vacuum_skipped || null,
    // Fallos por item: el gc termina bien aunque algunos items no se tocaran.
    failed: Array.isArray(out.failed) ? out.failed.length : null,
    deadlines_archived: deadlines ? deadlines.archived : null,
    deadlines_failed: deadlines && Array.isArray(deadlines.failed) ? deadlines.failed.length : null,
  });
  // Estado nuevo sin los campos de fallo: el éxito pone el contador a cero.
  writeState({
    last_run_ms: ahora,
    last_run_iso: new Date(ahora).toISOString(),
    stale_marked: out.stale_marked,
    events_deleted: out.events_deleted,
    bytes_after: out.bytes_after,
  });
}

try {
  main();
} catch (e) {
  logHookError('memory-gc', e);
} finally {
  process.exitCode = 0;
}
