#!/usr/bin/env node
/**
 * ensure-qdrant.js — guard de arranque de Qdrant para SessionStart.
 *
 * Sustituye el hot path de ensure-qdrant.ps1 (Kirkardo Pass3 HIGH 2026-06-10):
 * el .ps1 tardaba 3.5-3.9s INCLUSO con Qdrant ya vivo (spawn de powershell
 * ~600ms + Get-NetTCPConnection ~1.1s + Invoke-WebRequest) y bloqueaba CADA
 * SessionStart. Este hook hace GET /healthz con timeout corto (~80ms en
 * caliente). Solo si Qdrant esta caido delega el relanzamiento al .ps1
 * original (logica de arranque intacta) y espera hasta ~3s a que sane.
 */

'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');
observe('ensure-qdrant');

const HEALTHZ = { host: 'localhost', port: 6333, path: '/healthz', timeout: 700 };
// (2026-08-10) El relanzamiento delega en el WATCHDOG, no en el launcher a
// secas: mismo relaunch (via ensure-qdrant.ps1) pero con verificacion
// post-launch real + evento en logs/qdrant-watchdog.jsonl. El spawn directo
// del launcher era fire-and-forget CIEGO: nada comprobaba si el relaunch
// funciono (audit 2026-08-09, causa raiz de las caidas silenciosas).
const WATCHDOG = path.join(
  os.homedir(),
  '.ultron',
  'scripts',
  'qdrant',
  'qdrant-watchdog.ps1'
);

function healthz() {
  return new Promise((resolve) => {
    const req = http.get(HEALTHZ, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function main() {
  if (await healthz()) {
    console.log('ensure-qdrant: healthz OK -- Qdrant operativo');
    return;
  }

  // Caido: disparar el WATCHDOG detached y RETORNAR YA — el hook no espera
  // (memory-session-resume lee SQLite, el daemon E5 no necesita Qdrant, y el
  // recall denso cae a sparse via el gate healthz mientras Qdrant levanta).
  // El watchdog relanza via ensure-qdrant.ps1, VERIFICA healthz post-launch
  // (~30s de margen) y deja el veredicto en logs/qdrant-watchdog.jsonl.
  const child = spawn(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', WATCHDOG],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();
  console.log(
    'ensure-qdrant: Qdrant caido -- watchdog disparado en background (relaunch + verificacion en logs/qdrant-watchdog.jsonl)'
  );
}

main().catch((e) => {
  // cat9.5: deja rastro del fallo top-level sin romper el fail-safe.
  logHookError('ensure-qdrant', e);
  // Nunca romper el SessionStart.
  process.exit(0);
});
