#!/usr/bin/env node
// Resumen del registro de incidentes de Sessions.
//
//   node scripts/sesiones-incidentes.mjs                 grupos por patrón (todo el registro)
//   node scripts/sesiones-incidentes.mjs --desde 2026-10-16
//   node scripts/sesiones-incidentes.mjs --ver N         incidente N entero: estado y pantalla
//   node scripts/sesiones-incidentes.mjs --fichero RUTA  otro registro (por defecto, el de la app)
//
// El registro lo escribe ULTRON en %LOCALAPPDATA%\io.github.skitemplar.ultron\logs.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agrupar, filtrarDesde, parsear } from './lib/sesiones-incidentes.mjs';

const APP_IDENTIFIER = 'io.github.skitemplar.ultron';

function rutaPorDefecto() {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return join(base, APP_IDENTIFIER, 'logs', 'sesiones-incidentes.jsonl');
}

function argumento(nombre) {
  const i = process.argv.indexOf(nombre);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

function verIncidente(inc, indice) {
  console.log(`#${indice} ${inc.ts} · ${inc.origen}/${inc.nivel} · sesión ${inc.sesion ?? '(global)'} · app ${inc.app}`);
  console.log(`texto: ${inc.texto}`);
  if (inc.info) console.log(`sesión: ${inc.info.title ?? ''} · ${inc.info.status ?? ''} · cwd ${inc.info.cwd ?? ''}`);
  if (inc.maquina) console.log(`máquina: ${JSON.stringify(inc.maquina, null, 2)}`);
  if (inc.pantalla?.length) {
    console.log('pantalla:');
    for (const fila of inc.pantalla) console.log(`  │ ${fila}`);
  }
}

function main() {
  const ruta = argumento('--fichero') ?? rutaPorDefecto();
  if (!existsSync(ruta)) {
    console.log(`Sin incidentes: no existe ${ruta}`);
    return 0;
  }
  const { incidentes, corruptas } = parsear(readFileSync(ruta, 'utf8'));
  const ver = argumento('--ver');
  if (ver !== null) {
    const n = Number(ver);
    if (!Number.isInteger(n) || !incidentes[n]) {
      console.error(`No hay incidente #${ver} (hay ${incidentes.length}).`);
      return 1;
    }
    verIncidente(incidentes[n], n);
    return 0;
  }
  const lista = filtrarDesde(incidentes, argumento('--desde'));
  console.log(`${lista.length} incidentes en ${ruta}${corruptas ? ` (${corruptas} líneas corruptas)` : ''}`);
  for (const g of agrupar(lista)) {
    console.log(`${String(g.veces).padStart(4)} × [${g.origen}] ${g.patron}  (última ${g.ultima}; ver: --ver ${incidentes.indexOf(lista[g.ejemplo])})`);
  }
  return 0;
}

process.exit(main());
