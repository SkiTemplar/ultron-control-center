#!/usr/bin/env node
/**
 * sync-public-auto.mjs — sincronizacion automatica con el espejo publico.
 *
 * Lo lanza git-hooks/pre-push en segundo plano al empujar `main` al repo
 * privado. pre-push corre ANTES de que el push llegue, asi que aqui se espera a
 * que origin/main apunte al commit empujado; si el push falla o tarda mas de
 * ESPERA_MAX_MS, no se publica nada (fail-closed).
 *
 * Despues delega en `sync-public.mjs --auto`: publica solo si no hay ficheros
 * nuevos; con altas deja una alerta en Notifications y espera revision manual.
 *
 * Solo actua en la maquina que tiene `.publicignore` (gitignorado): en un clon
 * del espejo publico el hook existe pero sale sin hacer nada.
 *
 * Salida en ~/.ultron/cockpit/scheduler-logs/sync-public.log.
 *
 * Uso (desde el hook): node scripts/sync-public-auto.mjs <sha-empujado>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const RAIZ = path.resolve(path.join(import.meta.dirname, '..'));
const LOG = path.join(os.homedir(), '.ultron', 'cockpit', 'scheduler-logs', 'sync-public.log');
const ESPERA_MAX_MS = 5 * 60 * 1000;
const INTERVALO_MS = 5000;

function registrar(linea) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${linea}\n`);
  } catch {
    // Sin log no hay a quien avisar; el proceso corre desacoplado del push.
  }
}

function shaRemoto() {
  try {
    const salida = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
      cwd: RAIZ,
      encoding: 'utf8',
      windowsHide: true,
    });
    return salida.split(/\s+/)[0] || '';
  } catch {
    return '';
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const sha = process.argv[2] || '';
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    registrar(`sha invalido: "${sha}". Nada que hacer.`);
    return;
  }
  if (!fs.existsSync(path.join(RAIZ, '.publicignore'))) return; // no es la maquina de publicacion

  const limite = Date.now() + ESPERA_MAX_MS;
  while (shaRemoto() !== sha) {
    if (Date.now() > limite) {
      registrar(`origin/main no llego a ${sha.slice(0, 7)} en ${ESPERA_MAX_MS / 1000} s: push fallido o lento, no se publica.`);
      return;
    }
    await esperar(INTERVALO_MS);
  }

  registrar(`push ${sha.slice(0, 7)} confirmado; lanzando sync-public --auto`);
  const r = spawnSync('node', [path.join(RAIZ, 'scripts', 'sync-public.mjs'), '--auto'], {
    cwd: RAIZ,
    encoding: 'utf8',
    windowsHide: true,
  });
  registrar(`${(r.stdout || '').trim()}\n${(r.stderr || '').trim()}\nexit=${r.status}`);
}

main().catch((err) => registrar(`error: ${err.stack || err}`));
