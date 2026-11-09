#!/usr/bin/env node
// hooks/scripts/pupus-permission.js — hook PermissionRequest (2026-10-27).
//
// Lleva cada petición de permiso de Claude Code en terminal o VS Code al
// bocadillo de Pupus (POST /v1/permission del puente de la mascota, ver
// control-center/src-tauri/src/mascot/permission.rs) y devuelve su respuesta.
//
// El diálogo de la terminal se pinta a la vez que corre este hook (medido con
// Claude Code 2.1.311) y una decisión tardía lo cierra: gana quien conteste
// antes. Si el usuario contesta en la terminal, Claude Code corta el hook y la
// conexión cerrada retira la tarjeta del bocadillo.
//
// Sin decisión no se escribe nada y manda el diálogo de la terminal: ULTRON
// cerrado, Pupus oculto, nadie contesta o cualquier error. Nunca deniega por
// no poder preguntar.
//
// Las sesiones de ULTRON Sessions (`ULTRON_SESION_ID`) no pasan por aquí:
// sus preguntas ya las enseña el bocadillo desde el broker de Sessions.
//
// writer_path = NONE. Opt-out: CLAUDE_NO_HOOKS=1 o PUPUS_PERMISSION_DISABLED=1.

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { observe, logHookError } = require('./lib/hook-obs');

const HOOK_ID = 'pupus-permission';
/** Algo más que la espera del bocadillo (10 min en permission.rs). */
const REQUEST_TIMEOUT_MS = 11 * 60 * 1000;
const MAX_STDIN = 4 * 1024 * 1024;

function bridgeFile(home = os.homedir()) {
  return path.join(home, '.ultron', 'cockpit', 'mascot-bridge.json');
}

/** ¿Debe preguntar a Pupus? Puro: entorno y entrada del hook. */
function shouldAsk(env, input) {
  if (env.CLAUDE_NO_HOOKS === '1' || env.PUPUS_PERMISSION_DISABLED === '1') return false;
  if (env.ULTRON_SESION_ID) return false;
  return !!input && typeof input === 'object' && typeof input.tool_name === 'string';
}

/** Puerto y token del puente, o null si no hay ULTRON escuchando. */
function readBridge(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    const port = Number(v.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || typeof v.token !== 'string' || !v.token) return null;
    return { port, token: v.token };
  } catch {
    return null;
  }
}

/** Lo que se escribe en stdout: la decisión, o nada. Puro. */
function outputFor(body) {
  const hso = body && body.hookSpecificOutput;
  const behavior = hso && hso.decision && hso.decision.behavior;
  if (hso && hso.hookEventName === 'PermissionRequest' && (behavior === 'allow' || behavior === 'deny')) {
    return JSON.stringify({ hookSpecificOutput: hso });
  }
  return '';
}

function post(bridge, raw) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: bridge.port,
        path: '/v1/permission',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(raw),
          'x-ultron-token': bridge.token,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('sin respuesta del puente')));
    req.on('error', reject);
    req.end(raw);
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (raw.length < MAX_STDIN) raw += c;
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}

async function main() {
  observe(HOOK_ID);
  const raw = await readStdin();
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!shouldAsk(process.env, input)) return;
  const bridge = readBridge(bridgeFile());
  if (!bridge) return;
  try {
    const out = outputFor(await post(bridge, raw));
    if (out) process.stdout.write(out);
  } catch (e) {
    // ULTRON cerrado (ECONNREFUSED) es lo normal: no es un error del hook.
    if (e && e.code !== 'ECONNREFUSED') logHookError(HOOK_ID, e);
  }
}

if (require.main === module) {
  main().finally(() => process.exit(0));
}

module.exports = { shouldAsk, readBridge, outputFor, bridgeFile };
