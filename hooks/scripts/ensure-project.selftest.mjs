/**
 * Selftest de ensure-project. Sin framework, como el resto de selftests de
 * hooks: `node ensure-project.selftest.mjs`, exit 1 si algo falla.
 *
 * QUE FIJA (2026-09-22). ensure-project corre en SessionStart con matcher "*",
 * o sea en cada arranque, /clear, compactacion y fork, en LA CARPETA QUE SEA.
 * Hasta hoy el gate de `decidir()` solo protegia el alta en el Control Center:
 * el aviso de «este proyecto no tiene CLAUDE.md» y el `codegraph init .` se
 * ejecutaban fuera de el, asi que en un repo ajeno o en un directorio temporal
 * se pedia un CLAUDE.md que ahi no pinta nada y se spawneaba un indexador que
 * habria escrito `.codegraph/` en casa de otro. Y como en esta maquina
 * codegraph no esta instalado, el spawn fallaba en silencio mientras el hook
 * seguia afirmando «estara disponible en los proximos turnos» — para siempre.
 *
 * HERMETICO: HOME/USERPROFILE y MARIA_HOME apuntan a carpetas temporales y el
 * PATH va vacio, asi que ni el registro de proyectos ni git ni codegraph de la
 * maquina real entran en la prueba. El hook se ejecuta como subproceso porque
 * lo que se mide es su SALIDA de verdad (additionalContext), no una funcion
 * suelta.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const AQUI = dirname(fileURLToPath(import.meta.url));
const HOOK = join(AQUI, 'ensure-project.js');
const require = createRequire(import.meta.url);
const { indexadorDisponible } = require('./ensure-project.js');

const temporales = [];
function carpetaTemporal(prefijo) {
  const dir = mkdtempSync(join(tmpdir(), prefijo));
  temporales.push(dir);
  return dir;
}

let fallos = 0;
function comprueba(nombre, real, esperado) {
  if (real === esperado) {
    console.log(`ok     ${nombre}`);
  } else {
    fallos++;
    console.error(`FALLO  ${nombre}\n       esperado=${esperado} real=${real}`);
  }
}

/**
 * Corre el hook con un HOME y un MARIA_HOME de mentira y devuelve el
 * additionalContext que emite.
 *
 * @param {{cwd:string, mariaHome:string, home:string}} entorno
 */
function contextoDelHook({ cwd, mariaHome, home }) {
  const r = spawnSync(process.execPath, [HOOK], {
    cwd,
    input: '',
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MARIA_HOME: mariaHome,
      // Sin PATH no se encuentran ni git ni codegraph: la prueba no puede
      // depender de lo que este instalado en la maquina que la corre.
      PATH: '',
      Path: '',
    },
  });
  if (r.status !== 0) return `EXIT_${r.status}`;
  try {
    return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  } catch (e) {
    return `SALIDA_ILEGIBLE(${String(e)}): ${r.stdout}`;
  }
}

/** HOME + MARIA_HOME nuevos; `proyectos` se escribe tal cual en el registro. */
function escenario(proyectos) {
  const home = carpetaTemporal('ensure-project-home-');
  const mariaHome = carpetaTemporal('ensure-project-maria-');
  mkdirSync(join(mariaHome, 'cockpit'), { recursive: true });
  writeFileSync(join(mariaHome, 'cockpit', 'projects.json'), JSON.stringify(proyectos || []));
  return { home, mariaHome };
}

// --- el indexador: ¿esta instalado? -----------------------------------------
const SIN_NADA = carpetaTemporal('ensure-project-vacio-');
comprueba('sin shim npm y sin PATH, el indexador NO esta',
  indexadorDisponible(SIN_NADA, { PATH: '' }), false);

const CON_SHIM = carpetaTemporal('ensure-project-shim-');
const SHIM = join(CON_SHIM, 'AppData', 'Roaming', 'npm', 'node_modules', '@colbymchenry', 'codegraph');
mkdirSync(SHIM, { recursive: true });
writeFileSync(join(SHIM, 'npm-shim.js'), '// shim de mentira\n');
comprueba('con el shim npm de codegraph, el indexador SI esta',
  indexadorDisponible(CON_SHIM, { PATH: '' }), true);

const EN_PATH = carpetaTemporal('ensure-project-path-');
writeFileSync(join(EN_PATH, 'codegraph'), '#!/bin/sh\n');
comprueba('con codegraph en el PATH, el indexador SI esta',
  indexadorDisponible(SIN_NADA, { PATH: EN_PATH }), true);

// --- carpeta que NO es un proyecto de alta -----------------------------------
// El caso que rompia: aqui el hook no tiene nada que decir y, sobre todo, no
// puede lanzar un indexador que escriba en una carpeta ajena.
{
  const { home, mariaHome } = escenario([]);
  const cwd = carpetaTemporal('ensure-project-ajena-');
  const ctx = contextoDelHook({ cwd, mariaHome, home });
  comprueba('carpeta sin dar de alta: el hook calla', ctx, '');
}

// --- proyecto de alta, sin CLAUDE.md y sin indexador -------------------------
{
  const cwd = carpetaTemporal('ensure-project-alta-');
  const { home, mariaHome } = escenario([{ id: 'proyecto-de-prueba', path: cwd }]);
  const ctx = contextoDelHook({ cwd, mariaHome, home });
  comprueba('proyecto de alta: SI se pide el CLAUDE.md que falta',
    ctx.includes('no tiene CLAUDE.md'), true);
  comprueba('sin codegraph instalado: NO se promete un indice que nadie construye',
    ctx.includes('CodeGraph'), false);
}

// --- proyecto de alta con el indexador instalado -----------------------------
// El gate no puede pasarse de frenada: con el indexador presente el aviso
// vuelve a salir. (El spawn de `codegraph init .` sale detached y sin PATH: el
// shell no lo encuentra, no escribe nada y el hook no se entera, que es justo
// su contrato de fire-and-forget.)
{
  const cwd = carpetaTemporal('ensure-project-indexa-');
  const { home, mariaHome } = escenario([{ id: 'proyecto-de-prueba', path: cwd }]);
  const shim = join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@colbymchenry', 'codegraph');
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, 'npm-shim.js'), '// shim de mentira\n');
  const ctx = contextoDelHook({ cwd, mariaHome, home });
  comprueba('con codegraph instalado: SI se avisa del indexado',
    ctx.includes('indexando en segundo plano'), true);
}

// --- proyecto de alta ya completo --------------------------------------------
{
  const cwd = carpetaTemporal('ensure-project-completo-');
  writeFileSync(join(cwd, 'CLAUDE.md'), '# normas\n');
  mkdirSync(join(cwd, '.codegraph'), { recursive: true });
  const { home, mariaHome } = escenario([{ id: 'proyecto-de-prueba', path: cwd }]);
  comprueba('proyecto con CLAUDE.md e indice: el hook calla',
    contextoDelHook({ cwd, mariaHome, home }), '');
}

for (const dir of temporales) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    /* limpieza best-effort */
  }
}

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo verde');
process.exit(fallos ? 1 : 0);
