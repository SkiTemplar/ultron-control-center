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
const RETRY_MS = 300;
const MAX_WAIT_MS = 3000;

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

  // Caido: delegar el arranque al .ps1 (detached, sin bloquear el hook mas
  // de MAX_WAIT_MS). El .ps1 conserva toda la logica de lanzamiento.
  const child = spawn(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', LAUNCHER],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RETRY_MS));
    if (await healthz()) {
      console.log('ensure-qdrant: Qdrant relanzado y operativo');
      return;
    }
  }
  // Fail-safe: no bloquear la sesion; el launcher sigue corriendo detached y
  // memory-session-resume tiene su propio timeout + fail-safe.
  console.log('ensure-qdrant: WARN Qdrant no respondio en 3s (relanzamiento sigue en background)');
}

main().catch(() => {
  // Nunca romper el SessionStart.
  process.exit(0);
});
