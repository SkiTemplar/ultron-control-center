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

const HEALTHZ = { host: 'localhost', port: 6333, path: '/healthz', timeout: 700 };
const LAUNCHER = path.join(os.homedir(), '.ultron', 'scripts', 'ensure-qdrant.ps1');

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

  // Caido: disparar el arranque del .ps1 DETACHED y RETORNAR YA (fire-and-forget).
  // Antes el hook esperaba hasta 3s (MAX_WAIT_MS) a que Qdrant sanara -> cold-start
  // de ~957ms que bloqueaba CADA SessionStart con Qdrant caido (cat9.3 FAIL). No hay
  // que esperar aqui: memory-session-resume lee SQLite (no Qdrant), el daemon E5 no
  // necesita Qdrant para arrancar, y el recall denso (UserPromptSubmit) cae a sparse
  // mientras Qdrant termina de levantar en background.
  const child = spawn(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', LAUNCHER],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();
  console.log(
    'ensure-qdrant: Qdrant caido -- relanzamiento disparado en background (no se bloquea el arranque)'
  );
}

main().catch(() => {
  // Nunca romper el SessionStart.
  process.exit(0);
});
