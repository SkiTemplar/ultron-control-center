#!/usr/bin/env node
// Selftest de ensure-project: decision de alta y resolucion del proyecto padre.
//
// Regresion 2026-10-18: la "Señal 1" daba de ALTA cualquier subdirectorio de un
// proyecto registrado (`src-tauri`, `control-center`, `sesiones`, `variants`...)
// y las carpetas bajo `.tmp` o `.claude` (`cwd`, `skills-ultron`). Ahora un
// subdirectorio se resuelve al proyecto que lo contiene, sin alta nueva.
//
// Hermetico: solo funciones puras con un registro en memoria y git simulado;
// no lee ni escribe el projects.json real.
// Ejecutar: node hooks/scripts/ensure-project.selftest.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// HOME sintetico (no se toca el disco): con el HOME real bajo %TEMP% (p. ej.
// `run-selftests.mjs --fake-home`) todas las rutas caian en `rutaExcluida` y el
// test fallaba por entorno. ensure-project.js lee os.homedir() al cargarse, asi
// que se fija antes del require.
const SYNTH_HOME = process.platform === 'win32' ? 'C:\\Users\\selftest' : '/home/selftest';
process.env.HOME = SYNTH_HOME;
process.env.USERPROFILE = SYNTH_HOME;
// Identidad de auto-alta (L4): sin fichero de raices ni variables, vacia.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-project-'));
process.env.ULTRON_PROJECT_ROOTS_OVERRIDE = path.join(TMP, 'no-existe', 'project-roots.json');
delete process.env.ULTRON_GIT_ACCOUNTS;
delete process.env.ULTRON_ROOT_SEGMENTS;

const require = createRequire(import.meta.url);
const ep = require('./ensure-project.js');

const home = os.homedir();
assert.equal(home, SYNTH_HOME, 'el HOME sintetico se aplica');
const ultron = path.join(home, '.ultron');
const tortunabo = path.join(home, 'PERSONAL', 'Tortunabo');
const registro = [
  { id: '__home', path: home },
  { id: 'ultron', path: ultron },
  { id: 'tortunabo', path: tortunabo },
  { id: 'tortu-variants-real', path: path.join(tortunabo, 'Engine', 'Sub') },
];

// Git simulado: todo es repo propio. Si la decision llegara a la señal git en
// un subdirectorio o en una ruta excluida, devolveria alta y el test fallaria.
// remotePropio recibe las cuentas y devuelve la que casa con `git remote -v`.
const conRemotes = (salida) => ({
  raizGit: (cwd) => cwd,
  remotePropio: (_cwd, cuentas) => ep.cuentaEnRemotes(salida, cuentas),
});
const gitPropio = conRemotes('origin\thttps://github.com/MiCuenta/repo.git (fetch)');
const gitAjeno = conRemotes('origin\thttps://github.com/Ajeno/repo.git (fetch)');
const sinGit = { raizGit: () => null, remotePropio: () => null };
// Identidad explicita de los casos clasicos (antes fija en el hook).
const ID = { gitAccounts: ['MiCuenta'], rootSegments: ['PERSONAL', 'CARRERA', 'PROFESIONAL'] };
const VACIA = { gitAccounts: [], rootSegments: [] };

let asserts = 0;
const check = (fn) => { fn(); asserts += 1; };

// 1. Subcarpeta de un proyecto registrado -> ese proyecto, sin alta.
const srcTauri = path.join(ultron, 'control-center', 'src-tauri');
check(() => assert.equal(ep.decidir(srcTauri, registro, gitPropio, ID).esProyecto, false,
  'un subdirectorio de ultron no se da de alta'));
check(() => assert.equal(ep.proyectoQueContiene(srcTauri, registro).id, 'ultron',
  'src-tauri se resuelve a ultron'));
check(() => assert.match(ep.decidir(srcTauri, registro, gitPropio, ID).motivo, /"ultron"/,
  'el motivo nombra el proyecto padre'));
const variants = path.join(tortunabo, 'Assets', 'variants');
check(() => assert.equal(ep.decidir(variants, registro, gitPropio, ID).esProyecto, false,
  'subcarpeta de Tortunabo bajo raiz propia: sin alta'));
check(() => assert.equal(ep.proyectoQueContiene(variants, registro).id, 'tortunabo',
  'variants se resuelve a tortunabo'));

// 2. Gana el proyecto registrado mas profundo; `__home` nunca es padre.
const profundo = path.join(tortunabo, 'Engine', 'Sub', 'x');
check(() => assert.equal(ep.proyectoQueContiene(profundo, registro).id, 'tortu-variants-real',
  'el padre es el proyecto mas profundo que contiene la ruta'));
check(() => assert.equal(ep.proyectoQueContiene(path.join(home, 'Descargas', 'algo'), registro), null,
  '__home (el home entero) no cuenta como proyecto padre'));
check(() => assert.equal(ep.proyectoQueContiene(ultron, registro), null,
  'la raiz del proyecto no es subdirectorio de si misma'));
check(() => assert.equal(ep.proyectoQueContiene(ultron + 'x', registro), null,
  'prefijo de nombre (".ultronx") no es subdirectorio'));

// 3. El contexto nombra al padre solo en un subdirectorio.
const padreUltron = registro[1];
check(() => assert.match(ep.avisoProyectoPadre(srcTauri, padreUltron), /proyecto "ultron"/,
  'el aviso nombra el proyecto padre'));
check(() => assert.equal(ep.avisoProyectoPadre(ultron, padreUltron), null,
  'en la raiz del proyecto no hay aviso de subdirectorio'));
check(() => assert.equal(ep.avisoProyectoPadre(srcTauri, null), null,
  'sin proyecto no hay aviso'));

// 4. Rutas bajo .tmp o .claude -> nada (ni alta ni proyecto).
const rutasExcluidas = [
  path.join(ultron, '.tmp', 'pupus-hooktest', 'cwd'),
  path.join(ultron, '.tmp'),
  path.join(home, '.claude', 'skills', 'ultron'),
  path.join(home, '.claude'),
  // Tareas programadas de Claude Desktop: cada ejecución abre sesión ahí.
  path.join(home, 'Documents', 'Claude', 'Scheduled', 'blackboard-morning-sync'),
];
for (const r of rutasExcluidas) {
  check(() => assert.equal(ep.rutaExcluida(r), true, `ruta excluida: ${r}`));
  check(() => assert.equal(ep.decidir(r, registro, gitPropio, ID).esProyecto, false, `sin alta: ${r}`));
}
check(() => assert.equal(ep.rutaExcluida(path.join(ultron, 'tmpx')), false,
  '"tmpx" no es ".tmp"'));

// 5. Caso positivo: carpeta nueva bajo una raiz propia -> alta.
const nuevo = path.join(home, 'PERSONAL', 'ProyectoNuevo');
check(() => assert.equal(ep.decidir(nuevo, registro, gitAjeno, ID).esProyecto, true,
  'repo nuevo bajo PERSONAL se da de alta'));
const conRemote = path.join(home, 'OtraCarpeta', 'Repo');
check(() => assert.equal(ep.decidir(conRemote, registro, gitPropio, ID).esProyecto, true,
  'repo nuevo con remote propio se da de alta'));
check(() => assert.equal(ep.decidir(conRemote, registro, gitAjeno, ID).esProyecto, false,
  'repo ajeno fuera de raiz propia: sin alta'));
check(() => assert.equal(ep.decidir(nuevo, registro, sinGit, ID).esProyecto, false,
  'carpeta sin git: sin alta'));

// 6. Identidad de auto-alta fuera del codigo (L4).
check(() => assert.deepEqual(ep.cargarIdentidad(), VACIA,
  'sin project-roots.json ni variables la identidad esta vacia'));
check(() => assert.equal(ep.decidir(nuevo, registro, gitAjeno, VACIA).esProyecto, false,
  'sin identidad, PERSONAL no da de alta (no hay raices fijas en el codigo)'));
check(() => assert.match(ep.decidir(nuevo, registro, gitAjeno, VACIA).motivo, /autoAlta/,
  'sin identidad el motivo dice que falta configurarla'));
check(() => assert.equal(ep.decidir(nuevo, registro, gitPropio, VACIA).esProyecto, false,
  'sin identidad, un remote cualquiera no da de alta'));
const soloTrabajo = { gitAccounts: [], rootSegments: ['TRABAJO'] };
check(() => assert.equal(ep.decidir(path.join(home, 'TRABAJO', 'Repo'), registro, gitAjeno, soloTrabajo).esProyecto, true,
  'raiz configurada TRABAJO da de alta'));
check(() => assert.equal(ep.decidir(nuevo, registro, gitAjeno, soloTrabajo).esProyecto, false,
  'PERSONAL ya no es raiz si la identidad no la incluye'));
const otra = conRemotes('origin\thttps://github.com/OtraCuenta/x.git (fetch)');
const dOtra = ep.decidir(conRemote, registro, otra, { gitAccounts: ['OtraCuenta'], rootSegments: [] });
check(() => assert.equal(dOtra.esProyecto, true, 'remote de la cuenta configurada da de alta'));
check(() => assert.match(dOtra.motivo, /OtraCuenta/, 'el motivo nombra la cuenta que caso'));
check(() => assert.equal(ep.cuentaEnRemotes('origin git@github.com:a.b/x.git (push)', ['a.b']), 'a.b',
  'la cuenta se escapa en la regex'));
check(() => assert.equal(ep.cuentaEnRemotes('origin https://github.com/aXb/x.git', ['a.b']), null,
  'un punto de la cuenta no casa con cualquier caracter'));
const rootsFile = path.join(TMP, 'project-roots.json');
fs.writeFileSync(rootsFile, JSON.stringify({ roots: [], autoAlta: { gitAccounts: ['Fich'], rootSegments: ['R1'] } }));
process.env.ULTRON_PROJECT_ROOTS_OVERRIDE = rootsFile;
check(() => assert.deepEqual(ep.cargarIdentidad(), { gitAccounts: ['Fich'], rootSegments: ['R1'] },
  'la identidad se lee de autoAlta en project-roots.json'));
process.env.ULTRON_GIT_ACCOUNTS = 'Env1, Env2';
check(() => assert.deepEqual(ep.cargarIdentidad(), { gitAccounts: ['Env1', 'Env2'], rootSegments: ['R1'] },
  'ULTRON_GIT_ACCOUNTS manda sobre el fichero'));
delete process.env.ULTRON_GIT_ACCOUNTS;
fs.writeFileSync(rootsFile, '{no es json');
check(() => assert.deepEqual(ep.cargarIdentidad(), VACIA, 'project-roots.json ilegible: identidad vacia'));

// 7. Presupuesto del hook (L3): todo cabe en el timeout_s del manifest.
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const entradaManifest = manifest.hooks.find((h) => h.id === 'ensure-project');
const timeoutS = Number(entradaManifest && entradaManifest.timeout_s);
check(() => assert.ok(Number.isFinite(timeoutS) && timeoutS > 0, 'timeout_s de ensure-project en el manifest'));
check(() => assert.ok(typeof ep.plazoRestante === 'function' && Number.isFinite(ep.PLAZO_HOOK_MS),
  'plazoRestante y PLAZO_HOOK_MS exportados'));
check(() => assert.ok(ep.PLAZO_HOOK_MS < timeoutS * 1000, 'el plazo interno es menor que timeout_s'));
const g1 = ep.plazoRestante(0, 0, 3000);
const g2 = ep.plazoRestante(0, 3000, 3000);
const alta = ep.plazoRestante(0, 6000, 15000);
check(() => assert.ok(g1 === 3000 && g2 === 3000, 'los git conservan su tope de 3 s con plazo de sobra'));
check(() => assert.ok(alta !== null && 6000 + alta <= ep.PLAZO_HOOK_MS,
  `peor caso git+git+alta cabe en el plazo (${6000 + alta} <= ${ep.PLAZO_HOOK_MS})`));
check(() => assert.equal(ep.plazoRestante(0, 11000, 15000), null, 'sin plazo suficiente no hay alta'));
check(() => assert.equal(ep.plazoRestante(0, 20000, 3000), null, 'plazo vencido: null'));
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`ensure-project.selftest: OK (${asserts} asserts)`);
