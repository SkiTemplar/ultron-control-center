#!/usr/bin/env node
// hooks/scripts/ensure-project.js — SessionStart hook.
//
// PROBLEMA (2026-08-22): tres normas del usuario se aplicaban a mano y por
// tanto casi nunca:
//   1. Todo proyecto debe estar de alta en el Control Center. Un proyecto que
//      existe en disco pero no en cockpit/projects.json es invisible para el
//      resto del sistema (Projects, kanban, sesiones, resume).
//   2. Todo proyecto debe tener su CLAUDE.md con las normas del repo. Sin el,
//      cada sesion arranca solo con las globales e improvisa convenciones.
//   3. Todo proyecto debe tener indice CodeGraph. Sin el, la exploracion cae a
//      Glob/Grep a ciegas: cientos de tokens por busqueda y peores respuestas.
//
// CRITERIO DE ALTA (decidido por el usuario): memoria primero, git como
// respaldo. La memoria sabe reconocer lo que YA conoce, pero es ciega ante un
// proyecto nuevo — que es justo cuando hace falta el alta — asi que no puede
// ser juez unico. El respaldo determinista cubre ese hueco.
//
// COSTE: el hook inyecta como mucho dos lineas de contexto. Indexar CodeGraph
// se lanza DETACHED (puede tardar) y jamas bloquea el arranque de la sesion.
//
// FAIL-SAFE: cualquier error se registra y se emite contexto vacio. Este hook
// nunca puede impedir que una sesion arranque.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');
observe('ensure-project');

const ULTRON = path.join(os.homedir(), '.ultron');
const REGISTRY = path.join(ULTRON, 'cockpit', 'projects.json');

/// Identidad de ESTA maquina: bajo que carpetas vive el trabajo del usuario y
/// con que cuentas de git publica.
///
/// Antes esto estaba clavado en el codigo con los valores del autor original
/// (`PERSONAL`/`CARRERA`/`PROFESIONAL` y la cuenta `SkiTemplar`). En cualquier
/// otro ordenador ninguna de las dos senales acertaba nunca, asi que el alta
/// automatica de proyectos no funcionaba (reportado por el usuario el
/// 2026-09-18: "ajustes que siguen siendo solo validos para el sistema de
/// archivos de mi companero").
///
/// Orden de resolucion:
///   1. `cockpit/maria/identidad.json` — lo que el usuario haya puesto a mano.
///   2. Derivado del registro de proyectos de ESTA maquina.
///   3. Vacio: sin senal propia se cae a "no es proyecto", que es el lado
///      seguro (mejor no dar de alta que dar de alta medio disco).
const IDENTIDAD = path.join(ULTRON, 'cockpit', 'maria', 'identidad.json');

/** Lee la identidad configurada a mano. `{}` si no existe o es ilegible. */
function identidadGuardada() {
  try {
    const raw = JSON.parse(fs.readFileSync(IDENTIDAD, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * Raices de trabajo deducidas del registro de proyectos.
 *
 * Se toma el primer segmento por DEBAJO del home de cada proyecto registrado
 * (`C:\Users\yo\Documents\GitHub\x` -> `documents`) y se queda con los que
 * se repiten al menos dos veces: una carpeta con un solo proyecto dentro no es
 * una raiz de trabajo, es un proyecto suelto. Pura salvo por el registro que
 * recibe, asi que se puede probar.
 */
function raicesDelRegistro(registro, home) {
  const homePartes = norm(home).split(/[\\/]/).filter(Boolean);
  const cuenta = new Map();
  for (const p of registro) {
    const partes = norm(p && p.path).split(/[\\/]/).filter(Boolean);
    if (partes.length <= homePartes.length) continue;
    const bajoHome = homePartes.every((seg, i) => partes[i] === seg);
    const primera = bajoHome ? partes[homePartes.length] : partes[1];
    if (!primera) continue;
    cuenta.set(primera, (cuenta.get(primera) || 0) + 1);
  }
  return [...cuenta.entries()]
    .filter(([, n]) => n >= 2)
    .map(([r]) => r);
}

/** Cuentas de git propias: solo las configuradas a mano (no se adivinan). */
function cuentasGit() {
  const guardada = identidadGuardada();
  const lista = Array.isArray(guardada.cuentas_git) ? guardada.cuentas_git : [];
  return lista.map((c) => String(c).trim()).filter(Boolean);
}
/// Carpetas que NUNCA son proyecto aunque cumplan lo demas.
// `~/.claude/` guarda skills, agentes y config: nunca es un proyecto aunque
// alguna carpeta sea un repo git propio (caso real: `~/.claude/skills/ultron`
// se dio de alta y duplico el proyecto ULTRON; fusionado el 2026-09-02).
const NUNCA = [/\\\.claude\\/i, /\\AppData\\/i, /\\Temp\\/i, /\\node_modules\\/i, /\\\.git$/i, /^[A-Z]:\\Windows/i];

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: additionalContext || '',
      },
    })
  );
}

/** Registro de proyectos del Control Center -> array (vacio si ilegible). */
function leerRegistro() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    return Array.isArray(raw) ? raw : raw.projects || [];
  } catch {
    return [];
  }
}

/** Normaliza una ruta para comparar sin sufrir por mayusculas ni barra final. */
function norm(p) {
  return String(p || '')
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

/** ¿Esta ya dado de alta? Devuelve la entrada o null. */
function yaDeAlta(cwd, registro) {
  const objetivo = norm(cwd);
  return registro.find((p) => norm(p.path) === objetivo) || null;
}

/** Raiz del repo git que contiene cwd, o null si no hay repo. */
function raizGit(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() ? path.normalize(out.trim()) : null;
  } catch {
    return null;
  }
}

/** ¿Algun remote apunta a una cuenta propia? Sin cuentas configuradas, no. */
function remotePropio(cwd, cuentas) {
  if (!cuentas || cuentas.length === 0) return null;
  try {
    const out = execFileSync('git', ['-C', cwd, 'remote', '-v'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return cuentas.find((c) => new RegExp(`[/:]${c}/`, 'i').test(out)) || null;
  } catch {
    return null;
  }
}

/** ¿La ruta cuelga de una de las raices de trabajo de ESTA maquina? */
function bajoRaizPropia(cwd, raices) {
  if (!raices || raices.length === 0) return false;
  const partes = norm(cwd).split(/[\\/]/);
  return raices.some((r) => partes.includes(String(r).toLowerCase()));
}

/**
 * ¿Es un proyecto del usuario? Memoria primero, git de respaldo.
 * Devuelve { esProyecto, motivo } — el motivo queda en el log para poder
 * auditar por que se dio (o no) de alta algo.
 */
function decidir(cwd, registro) {
  if (NUNCA.some((re) => re.test(cwd))) return { esProyecto: false, motivo: 'ruta excluida' };

  // Señal 1 (memoria): el Control Center ya conoce un proyecto que CONTIENE
  // esta ruta, asi que es un subdirectorio suyo.
  //
  // Un padre solo cuenta si es un proyecto de verdad y no una raiz generica:
  // el registro tiene una entrada cuyo path es el home ENTERO (`__home`), y sin
  // este filtro cualquier carpeta bajo el home pasaba por "subdirectorio de
  // proyecto registrado" — es decir, alta automatica de media maquina.
  // Cazado por scratchpad/test-decidir.js antes de registrar el hook.
  const objetivo = norm(cwd);
  const home = norm(os.homedir());
  const padreValido = (r) => r && r !== home && r.split(/[\\/]/).length > home.split(/[\\/]/).length;
  const conocidoPorMemoria = registro.some((p) => {
    const r = norm(p.path);
    return padreValido(r) && (objetivo.startsWith(r + '\\') || objetivo.startsWith(r + '/'));
  });
  if (conocidoPorMemoria) return { esProyecto: true, motivo: 'subdirectorio de un proyecto ya registrado' };

  // Señal 2 (git determinista): cubre el proyecto NUEVO, que la memoria no
  // puede conocer todavia.
  const raiz = raizGit(cwd);
  if (!raiz) return { esProyecto: false, motivo: 'no es repo git' };

  const guardada = identidadGuardada();
  const raices = (
    Array.isArray(guardada.raices) && guardada.raices.length > 0
      ? guardada.raices
      : raicesDelRegistro(registro, os.homedir())
  ).map((r) => String(r).toLowerCase());

  const cuenta = remotePropio(cwd, cuentasGit());
  if (cuenta) return { esProyecto: true, motivo: `repo git con remote de ${cuenta}` };
  if (bajoRaizPropia(cwd, raices)) {
    return { esProyecto: true, motivo: 'repo git bajo una raiz de trabajo propia' };
  }
  return { esProyecto: false, motivo: 'repo git ajeno (sin remote propio ni raiz propia)' };
}

/** Slug de id a partir del nombre de la carpeta. */
function slug(nombre) {
  return String(nombre)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'proyecto';
}

/**
 * Id libre para `cwd`, sin pisar una entrada existente.
 *
 * project-new.mjs es idempotente POR ID: si el id ya existe, ACTUALIZA esa
 * entrada. Con el id derivado solo del nombre de carpeta, dos rutas distintas
 * que se llamen igual colisionan y la segunda sobrescribe a la primera —
 * reproducido al probar el hook: `~/.ultron` reclamo el id `ultron` y
 * reescribio el proyecto que apuntaba a `~/.claude/skills/ultron`. Se recupera
 * del `.bak`, pero el hook no debe provocarlo.
 */
function idLibre(cwd, registro) {
  const base = slug(path.basename(cwd));
  const ocupado = (id) => registro.some((p) => p.id === id && norm(p.path) !== norm(cwd));
  if (!ocupado(base)) return base;

  const conPadre = slug(`${path.basename(path.dirname(cwd))}-${path.basename(cwd)}`);
  if (!ocupado(conPadre)) return conPadre;

  for (let n = 2; n < 50; n++) {
    if (!ocupado(`${base}-${n}`)) return `${base}-${n}`;
  }
  return null; // sin hueco: mejor no dar de alta que pisar algo
}

/** Alta en el Control Center reutilizando el script canonico (idempotente). */
function darDeAlta(cwd, id) {
  execFileSync(
    process.execPath,
    [path.join(ULTRON, 'scripts', 'project-new.mjs'), '--name', path.basename(cwd), '--path', cwd, '--id', id],
    { timeout: 15000, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }
  );
}

/**
 * Lanza el indexado de CodeGraph en segundo plano (puede tardar).
 *
 * `shell: true` hace falta en Windows porque `codegraph` es un `.cmd`, y con
 * shell los argumentos se CONCATENAN sin escapar. Por eso la ruta NO viaja como
 * argumento: se pasa como directorio de trabajo y el argumento es el literal
 * ".". Asi una carpeta con `&`, espacios o comillas en el nombre no puede
 * inyectar nada en la linea de comandos.
 */
function indexarCodegraph(cwd) {
  const hijo = spawn('codegraph', ['init', '.'], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: true,
  });
  hijo.unref();
}

function main() {
  try { fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }

  const cwd = process.cwd();
  const registro = leerRegistro();
  const avisos = [];

  const entrada = yaDeAlta(cwd, registro);
  if (!entrada) {
    const { esProyecto, motivo } = decidir(cwd, registro);
    const id = esProyecto ? idLibre(cwd, registro) : null;
    if (esProyecto && id) {
      try {
        darDeAlta(cwd, id);
        // Confirmar contra el registro releido: decir "alta creada" sin
        // comprobarlo es exactamente el no-op silencioso que hay que evitar.
        const creado = leerRegistro().some((p) => p.id === id && norm(p.path) === norm(cwd));
        if (creado) {
          avisos.push(`Alta creada en el Control Center como "${id}" (${motivo}). Baja: node ~/.ultron/scripts/project-remove.mjs ${id}`);
        } else {
          logHookError('ensure-project', `alta no confirmada en el registro para id="${id}" path="${cwd}"`);
        }
      } catch (e) {
        logHookError('ensure-project', `alta fallida: ${e && e.message}`);
      }
    } else if (esProyecto && !id) {
      logHookError('ensure-project', `sin id libre para dar de alta "${cwd}"`);
    }
  }

  // Ubicacion del kanban: sin esto, "actualiza el kanban" obligaba a buscar en
  // que id del Control Center vive el tablero de esta carpeta. Se resuelve
  // desde el registro (la entrada ya existente o la recien creada).
  const idProyecto = (yaDeAlta(cwd, leerRegistro()) || {}).id;
  if (idProyecto) {
    const tablero = path.join(ULTRON, 'cockpit', 'projects', idProyecto, 'kanban.json');
    if (fs.existsSync(tablero)) {
      avisos.push(`Kanban de este proyecto: id "${idProyecto}". Añadir tarjeta: node ~/.ultron/scripts/kanban.mjs add ${idProyecto} todo "titulo" "descripcion". No buscar el tablero a mano.`);
    }
  }

  // CLAUDE.md: el hook NO lo genera con plantilla. Las normas de un repo salen
  // de lo que se hable en la sesion, no de un molde; se avisa para que se
  // redacte con criterio.
  if (!fs.existsSync(path.join(cwd, 'CLAUDE.md'))) {
    avisos.push('Este proyecto no tiene CLAUDE.md. Proponer crearlo con las normas reales del repo (stack, convenciones, comandos), no una plantilla generica.');
  }

  // CodeGraph: indexar es lo caro, asi que va detached y solo si falta.
  if (!fs.existsSync(path.join(cwd, '.codegraph'))) {
    try {
      indexarCodegraph(cwd);
      avisos.push('Indice CodeGraph ausente: indexando en segundo plano (codegraph init). Estara disponible en los proximos turnos.');
    } catch (e) {
      logHookError('ensure-project', `codegraph init fallido: ${e && e.message}`);
    }
  }

  emit(avisos.length ? `## Estado del proyecto (ensure-project)\n\n- ${avisos.join('\n- ')}` : '');
}

// Solo se ejecuta como hook, no al importarlo: la prueba requiere este
// fichero para probar las funciones puras, y sin este guardia cada `require`
// lanzaba una indexacion de CodeGraph en segundo plano.
if (require.main === module) {
  try {
    main();
  } catch (e) {
    logHookError('ensure-project', e);
    try { emit(''); } catch { /* ignore */ }
  }
  process.exitCode = 0;
}

// Se exporta lo puro para las pruebas (`tests/test-identidad-maquina.js`).
module.exports = { raicesDelRegistro, bajoRaizPropia, remotePropio };
