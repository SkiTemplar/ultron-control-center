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

/// Raices bajo las que viven los proyectos del usuario (verificado contra
/// projects.json el 2026-08-22: PERSONAL 8, CARRERA 5, PROFESIONAL 2).
const RAICES_PROPIAS = ['PERSONAL', 'CARRERA', 'PROFESIONAL'];
/// Cuenta de GitHub del usuario: un remote suyo marca el repo como propio.
const CUENTA_GIT = 'SkiTemplar';
/// Carpetas que NUNCA son proyecto aunque cumplan lo demas.
const NUNCA = [/\\AppData\\/i, /\\Temp\\/i, /\\node_modules\\/i, /\\\.git$/i, /^[A-Z]:\\Windows/i];

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

/** ¿Algun remote apunta a la cuenta del usuario? */
function remotePropio(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'remote', '-v'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new RegExp(`[/:]${CUENTA_GIT}/`, 'i').test(out);
  } catch {
    return false;
  }
}

/** ¿La ruta cuelga de una de las raices de trabajo del usuario? */
function bajoRaizPropia(cwd) {
  const partes = norm(cwd).split(/[\\/]/);
  return RAICES_PROPIAS.some((r) => partes.includes(r.toLowerCase()));
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
  if (remotePropio(cwd)) return { esProyecto: true, motivo: `repo git con remote de ${CUENTA_GIT}` };
  if (bajoRaizPropia(cwd)) return { esProyecto: true, motivo: 'repo git bajo una raiz de trabajo propia' };
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

try {
  main();
} catch (e) {
  logHookError('ensure-project', e);
  try { emit(''); } catch { /* ignore */ }
}
process.exitCode = 0;
