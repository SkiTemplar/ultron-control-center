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
const { estadoIndice, accionPara } = require('./lib/codegraph-index');
observe('ensure-project');

const ULTRON = path.join(os.homedir(), '.ultron');
const REGISTRY = path.join(ULTRON, 'cockpit', 'projects.json');

/// Presupuesto del hook (L3, 2026-10-26): timeout_s en hooks/manifest.json es
/// 15 s. Se dejan ~3 s para el arranque de node y la lectura del registro; los
/// git y el alta comparten estos 12 s en lugar de sumar 3 + 3 + 15 s fijos.
/// Supuesto sin medir: si node tarda mas de 3 s en frio, hay que bajarlo.
const PLAZO_HOOK_MS = 12000;
/// Por debajo de esto no se lanza la operacion: un project-new.mjs cortado a
/// medias deja el kanban sin crear. La siguiente sesion reintenta el alta
/// (project-new.mjs es idempotente).
const MIN_ALTA_MS = 2000;

/**
 * Timeout para la siguiente operacion: lo que quede del plazo del hook, con
 * `topeMs` como maximo. null si queda menos de MIN_ALTA_MS (no lanzar).
 *
 * @param {number} inicioMs  arranque del hook
 * @param {number} ahoraMs
 * @param {number} topeMs    timeout propio de la operacion
 * @returns {number|null}
 */
function plazoRestante(inicioMs, ahoraMs, topeMs) {
  const t = Math.min(topeMs, PLAZO_HOOK_MS - (ahoraMs - inicioMs));
  return t < MIN_ALTA_MS ? null : Math.floor(t);
}

/// Identidad de auto-alta (L4, 2026-10-26): las raices de trabajo y las cuentas
/// de git del usuario ya no viven en el codigo (repo publico). Salen de la clave
/// opcional `autoAlta: { gitAccounts, rootSegments }` de
/// cockpit/project-roots.json (personal, ignorado por git; respeta
/// ULTRON_PROJECT_ROOTS_OVERRIDE como scripts/lib/project-create/roots.mjs) o de
/// ULTRON_GIT_ACCOUNTS / ULTRON_ROOT_SEGMENTS (CSV), que mandan sobre el
/// fichero. Sin ninguna, las señales por remote y por raiz no dan de alta nada
/// y queda rastro en hook-errors.jsonl.
const MOTIVO_SIN_IDENTIDAD = 'identidad de auto-alta sin configurar (autoAlta en project-roots.json)';

function listaCsv(valor) {
  return String(valor).split(',').map((x) => x.trim()).filter(Boolean);
}

function listaDeStrings(valor) {
  if (!Array.isArray(valor)) return [];
  return valor.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
}

/** @returns {{ gitAccounts: string[], rootSegments: string[] }} */
function cargarIdentidad() {
  let autoAlta = {};
  try {
    const ruta = process.env.ULTRON_PROJECT_ROOTS_OVERRIDE || path.join(ULTRON, 'cockpit', 'project-roots.json');
    if (fs.existsSync(ruta)) {
      const raw = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      if (raw && raw.autoAlta && typeof raw.autoAlta === 'object') autoAlta = raw.autoAlta;
    }
  } catch {
    autoAlta = {};
  }
  const envCuentas = process.env.ULTRON_GIT_ACCOUNTS;
  const envRaices = process.env.ULTRON_ROOT_SEGMENTS;
  return {
    gitAccounts: envCuentas ? listaCsv(envCuentas) : listaDeStrings(autoAlta.gitAccounts),
    rootSegments: envRaices ? listaCsv(envRaices) : listaDeStrings(autoAlta.rootSegments),
  };
}
/// Carpetas que NUNCA son proyecto aunque cumplan lo demas.
// `~/.claude/` guarda skills, agentes y config: nunca es un proyecto aunque
// alguna carpeta sea un repo git propio (caso real: `~/.claude/skills/ultron`
// se dio de alta y duplico el proyecto ULTRON; fusionado el 2026-09-02).
//
// `.tmp` (2026-10-18): carpetas de pruebas manuales como
// `~/.ultron/.tmp/pupus-hooktest/cwd` se daban de alta al abrir una sesion
// dentro; un directorio temporal nunca es un proyecto. `\.claude` y `\.tmp`
// tambien casan como ultimo segmento (la propia carpeta, no solo lo de dentro).
//
// `Documents\Claude\Scheduled` (2026-10-18): cada tarea programada de Claude
// Desktop abre sesion en su carpeta y se daba de alta como proyecto.
const NUNCA = [
  /\\Documents\\Claude\\Scheduled(\\|$)/i,
  /\\\.claude(\\|$)/i,
  /\\AppData\\/i,
  /\\Temp\\/i,
  /\\\.tmp(\\|$)/i,
  /\\node_modules\\/i,
  /\\\.git$/i,
  /^[A-Z]:\\Windows/i,
];

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

/** Raiz del repo git que contiene cwd, o null si no hay repo o no hay plazo. */
function raizGit(cwd, timeoutMs = 3000) {
  if (timeoutMs == null) return null;
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() ? path.normalize(out.trim()) : null;
  } catch {
    return null;
  }
}

/** Cuenta de `cuentas` a la que apunta algun remote de `salidaRemotes` (`git remote -v`), o null. */
function cuentaEnRemotes(salidaRemotes, cuentas) {
  const escapar = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (cuentas || []).find((c) => new RegExp(`[/:]${escapar(c)}/`, 'i').test(salidaRemotes)) || null;
}

/** Cuenta del usuario a la que apunta algun remote, o null (sin cuentas, sin repo o sin plazo). */
function remotePropio(cwd, cuentas, timeoutMs = 3000) {
  if (!cuentas || !cuentas.length || timeoutMs == null) return null;
  try {
    const out = execFileSync('git', ['-C', cwd, 'remote', '-v'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return cuentaEnRemotes(out, cuentas);
  } catch {
    return null;
  }
}

/** ¿La ruta cuelga de una de las raices de trabajo del usuario? */
function bajoRaizPropia(cwd, segmentos) {
  const partes = norm(cwd).split(/[\\/]/);
  return (segmentos || []).some((r) => partes.includes(r.toLowerCase()));
}

/**
 * Proyecto registrado que CONTIENE `cwd` (el mas profundo), o null.
 *
 * Un padre solo cuenta si es un proyecto de verdad y no una raiz generica: el
 * registro tiene una entrada cuyo path es el home ENTERO (`__home`), y sin este
 * filtro cualquier carpeta bajo el home seria "subdirectorio de un proyecto".
 */
function proyectoQueContiene(cwd, registro) {
  const objetivo = norm(cwd);
  const home = norm(os.homedir());
  const profundidadHome = home.split(/[\\/]/).length;
  const padreValido = (r) => r && r !== home && r.split(/[\\/]/).length > profundidadHome;
  let mejor = null;
  for (const p of registro) {
    const r = norm(p.path);
    if (!padreValido(r)) continue;
    if (!(objetivo.startsWith(r + '\\') || objetivo.startsWith(r + '/'))) continue;
    if (!mejor || r.length > norm(mejor.path).length) mejor = p;
  }
  return mejor;
}

/**
 * ¿Es un proyecto del usuario? Memoria primero, git de respaldo.
 * Devuelve { esProyecto, motivo } — el motivo queda en el log para poder
 * auditar por que se dio (o no) de alta algo.
 */
/** ¿Ruta que nunca es proyecto ni parte de uno (.claude, .tmp, Temp...)? */
function rutaExcluida(cwd) {
  return NUNCA.some((re) => re.test(cwd));
}

function decidir(cwd, registro, git = { raizGit, remotePropio }, identidad = cargarIdentidad()) {
  if (rutaExcluida(cwd)) return { esProyecto: false, motivo: 'ruta excluida' };

  // Señal 1 (memoria): si el Control Center ya conoce un proyecto que CONTIENE
  // esta ruta, la carpeta es parte de ese proyecto y NO un proyecto nuevo.
  // Hasta el 2026-10-18 esta señal daba de ALTA el subdirectorio: abrir una
  // sesion en `~/.ultron/control-center/src-tauri` creaba los proyectos
  // `src-tauri`, `control-center` y `sesiones`, duplicados de `ultron`.
  const padre = proyectoQueContiene(cwd, registro);
  if (padre) return { esProyecto: false, motivo: `subdirectorio del proyecto "${padre.id}"` };

  // Señal 2 (git determinista): cubre el proyecto NUEVO, que la memoria no
  // puede conocer todavia.
  const raiz = git.raizGit(cwd);
  if (!raiz) return { esProyecto: false, motivo: 'no es repo git' };
  const cuentas = identidad.gitAccounts || [];
  const segmentos = identidad.rootSegments || [];
  if (!cuentas.length && !segmentos.length) {
    return { esProyecto: false, motivo: MOTIVO_SIN_IDENTIDAD, sinIdentidad: true };
  }
  const cuenta = git.remotePropio(cwd, cuentas);
  if (cuenta) return { esProyecto: true, motivo: `repo git con remote de ${cuenta}` };
  if (bajoRaizPropia(cwd, segmentos)) return { esProyecto: true, motivo: 'repo git bajo una raiz de trabajo propia' };
  return { esProyecto: false, motivo: 'repo git ajeno (sin remote propio ni raiz propia)' };
}

/** Aviso que nombra el proyecto padre cuando la sesion se abre en un subdirectorio suyo. */
function avisoProyectoPadre(cwd, proyecto) {
  if (!proyecto || norm(proyecto.path) === norm(cwd)) return null;
  return `Sesión abierta en un subdirectorio del proyecto "${proyecto.id}" (${proyecto.path}): pertenece a ese proyecto, no es un proyecto aparte.`;
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
function darDeAlta(cwd, id, timeoutMs) {
  execFileSync(
    process.execPath,
    [path.join(ULTRON, 'scripts', 'project-new.mjs'), '--name', path.basename(cwd), '--path', cwd, '--id', id],
    { timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }
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
/**
 * Solo se indexa una carpeta dada de alta como proyecto, sin indice previo y
 * fuera de la carpeta temporal del sistema. Antes se indexaba CUALQUIER cwd: una
 * sesion headless con cwd=%TEMP% dejo un indice de 364 MB sobre los temporales
 * (2026-09-11), que ademas hacia creer a los demas hooks que todo lo que cuelga
 * de %TEMP% tiene indice.
 */
/**
 * Accion de CodeGraph que necesita el proyecto: 'init' (sin indice), 'index'
 * (indice a medias) o null. Antes bastaba con que existiera la carpeta
 * `.codegraph`: un init interrumpido no se reintentaba nunca (auditoria
 * 2026-10-23). La carpeta personal no se indexa nunca (lib/codegraph-index).
 */
function accionCodegraph(cwd, idProyecto, tmpDir, home = os.homedir()) {
  if (!idProyecto) return null;
  const tmp = norm(path.resolve(tmpDir)).replace(/\\/g, '/');
  const dir = norm(path.resolve(cwd)).replace(/\\/g, '/');
  if (dir === tmp || dir.startsWith(`${tmp}/`)) return null;
  return accionPara(estadoIndice(cwd, home).estado);
}

function debeIndexarCodegraph(cwd, idProyecto, tmpDir, home = os.homedir()) {
  return accionCodegraph(cwd, idProyecto, tmpDir, home) !== null;
}

/** Argumentos literales de cada accion (con shell no se escapan: nada variable). */
const ARGS_CODEGRAPH = { init: ['init', '--yes', '.'], index: ['index', '.'] };

function indexarCodegraph(cwd, accion) {
  const hijo = spawn('codegraph', ARGS_CODEGRAPH[accion], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: true,
  });
  hijo.unref();
}

function main() {
  const inicio = Date.now();
  try { fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }

  const cwd = process.cwd();
  // Ruta excluida: ni alta, ni proyecto padre, ni avisos de CLAUDE.md o
  // CodeGraph. Una carpeta temporal o de configuracion no es un proyecto.
  if (rutaExcluida(cwd)) {
    emit('');
    return;
  }
  const registro = leerRegistro();
  const avisos = [];

  const entrada = yaDeAlta(cwd, registro);
  if (!entrada) {
    const gitConPlazo = {
      raizGit: (c) => raizGit(c, plazoRestante(inicio, Date.now(), 3000)),
      remotePropio: (c, cuentas) => remotePropio(c, cuentas, plazoRestante(inicio, Date.now(), 3000)),
    };
    const { esProyecto, motivo, sinIdentidad } = decidir(cwd, registro, gitConPlazo);
    if (sinIdentidad) logHookError('ensure-project', `${MOTIVO_SIN_IDENTIDAD}: sin auto-alta para "${cwd}"`);
    const id = esProyecto ? idLibre(cwd, registro) : null;
    const plazoAlta = esProyecto && id ? plazoRestante(inicio, Date.now(), 15000) : null;
    if (esProyecto && id && plazoAlta === null) {
      logHookError('ensure-project', 'alta aplazada: sin plazo dentro del timeout del hook');
    } else if (esProyecto && id) {
      try {
        darDeAlta(cwd, id, plazoAlta);
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
  // desde el registro (la entrada ya existente, la recien creada o el proyecto
  // que contiene la carpeta si la sesion se abrio en un subdirectorio).
  const registroFinal = leerRegistro();
  const proyecto = yaDeAlta(cwd, registroFinal) || proyectoQueContiene(cwd, registroFinal);
  const idProyecto = proyecto ? proyecto.id : undefined;
  // CLAUDE.md y CodeGraph se comprueban en la raiz del proyecto, no en el
  // subdirectorio donde se abrio la sesion.
  const raizProyecto = proyecto ? proyecto.path : cwd;
  const avisoPadre = avisoProyectoPadre(cwd, proyecto);
  if (avisoPadre) avisos.push(avisoPadre);
  if (idProyecto) {
    const tablero = path.join(ULTRON, 'cockpit', 'projects', idProyecto, 'kanban.json');
    if (fs.existsSync(tablero)) {
      avisos.push(`Kanban de este proyecto: id "${idProyecto}". Añadir tarjeta: node ~/.ultron/scripts/kanban.mjs add ${idProyecto} todo "titulo" "descripcion". No buscar el tablero a mano.`);
    }
  }

  // CLAUDE.md: el hook NO lo genera con plantilla. Las normas de un repo salen
  // de lo que se hable en la sesion, no de un molde; se avisa para que se
  // redacte con criterio.
  if (!fs.existsSync(path.join(raizProyecto, 'CLAUDE.md'))) {
    avisos.push('Este proyecto no tiene CLAUDE.md. Proponer crearlo con las normas reales del repo (stack, convenciones, comandos), no una plantilla generica.');
  }

  // CodeGraph: indexar es lo caro, asi que va detached y solo si falta o
  // quedo a medias.
  const accionCg = accionCodegraph(raizProyecto, idProyecto, os.tmpdir());
  if (accionCg) {
    try {
      indexarCodegraph(raizProyecto, accionCg);
      const que = accionCg === 'init' ? 'ausente' : 'incompleto';
      avisos.push(`Indice CodeGraph ${que}: indexando en segundo plano (codegraph ${accionCg}). Estara disponible en los proximos turnos.`);
    } catch (e) {
      logHookError('ensure-project', `codegraph init fallido: ${e && e.message}`);
    }
  }

  emit(avisos.length ? `## Estado del proyecto (ensure-project)\n\n- ${avisos.join('\n- ')}` : '');
}

// Solo corre el hook cuando se invoca directamente; al importarse (tests)
// expone las funciones puras sin leer stdin ni tocar el registro.
if (require.main === module) {
  try {
    main();
  } catch (e) {
    logHookError('ensure-project', e);
    try { emit(''); } catch { /* ignore */ }
  }
  process.exitCode = 0;
} else {
  module.exports = { PLAZO_HOOK_MS, plazoRestante, cargarIdentidad, cuentaEnRemotes, accionCodegraph, debeIndexarCodegraph, decidir, proyectoQueContiene, rutaExcluida, avisoProyectoPadre };
}
