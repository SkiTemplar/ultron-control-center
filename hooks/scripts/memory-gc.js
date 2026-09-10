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
// el siguiente cierre de sesion en vez de perder la semana.
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

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');
const { appendJsonl } = require('./lib/jsonl-log');
const { findBinary } = require('./lib/ultron-memory-cli');
observe('memory-gc');

const HOME = os.homedir();
const LOG_PATH = process.env.MEMORY_GC_LOG || path.join(HOME, '.ultron', 'logs', 'memory-gc.jsonl');
const STATE_PATH = process.env.MEMORY_GC_STATE || path.join(HOME, '.ultron', '.tmp', 'memory-gc-last.json');
// Ventana del mantenimiento (dias) y cadencia minima entre ejecuciones.
const GC_DAYS = 90;
const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// Margen bajo el timeout=120s del hook: deja ~10s para el arranque de node y el
// registro. El caso caro es un VACUUM de 126 MB.
const GC_TIMEOUT_MS = 110000;

function readState() {
  try {
    const v = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (v && Number.isFinite(v.last_run_ms)) return v;
  } catch (_) {
    /* sin estado previo o ilegible: toca ejecutar */
  }
  return null;
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

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.MEMORY_GC_DISABLED === '1') return;

  const ahora = Date.now();
  const estado = readState();
  if (estado && ahora - estado.last_run_ms < INTERVAL_MS) {
    const restante = INTERVAL_MS - (ahora - estado.last_run_ms);
    appendJsonl(LOG_PATH, {
      skipped: 'cadencia',
      next_in_h: Math.round((restante / 3600000) * 10) / 10,
    });
    return;
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
    appendJsonl(LOG_PATH, { ok: false, error: String(e && e.message).slice(0, 200) });
    return;
  }
  const ms = Date.now() - empezado;

  if (!res || res.status !== 0) {
    // Sin sellar el estado: se reintenta al cerrar la proxima sesion.
    appendJsonl(LOG_PATH, {
      ok: false,
      ms,
      status: res ? res.status : null,
      stderr: res && res.stderr ? String(res.stderr).replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, 300) : null,
    });
    return;
  }

  let out = null;
  try {
    out = JSON.parse(String(res.stdout || '').trim());
  } catch (_) {
    out = null;
  }
  if (!out || typeof out !== 'object') {
    appendJsonl(LOG_PATH, { ok: false, ms, error: 'salida no es JSON' });
    return;
  }

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
  });
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
