/**
 * sync-public-gate.mjs — gate de datos personales del espejo público.
 *
 * Lo usa scripts/sync-public.mjs. Vive aparte para poder probarlo sin clonar el
 * espejo (scripts/lib/sync-public-gate.selftest.mjs).
 *
 * Tres agujeros que cierra (auditoría del 2026-10-17):
 *   - H31: el escáner lista con `git ls-files` del clon. Si se ejecuta antes del
 *     `git add -A`, los ficheros nuevos no están en el índice y no se leen; el
 *     log decía «HIGH=0» sobre un árbol que no había analizado. Aquí el
 *     `git add -A` va SIEMPRE antes del escáner y se comprueba que el número de
 *     ficheros analizados coincide con el índice.
 *   - H31: los binarios (imágenes, PDF…) y lo que cuelga de directorios como
 *     `build/` o `dist/` el escáner no los lee. Un fichero así nuevo o
 *     modificado no se publica sin revisión explícita.
 *   - H32: los patrones de email y handle personales solo existen si alguien los
 *     configura (no pueden ir en el código: el script viaja al espejo). Sin
 *     ellos el gate no publica, y se verifica que el escáner los ha cargado.
 *
 * Los patrones salen de la variable ULTRON_PII_EXTRA (separados por comas) y del
 * fichero gitignorado `.publicpii` de la raíz del repo (uno por línea, `#`
 * comenta). Se usan los dos si existen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const FICHERO_PII = '.publicpii';
export const VAR_PII = 'ULTRON_PII_EXTRA';
export const VAR_EMAIL_PUBLICO = 'ULTRON_PUBLIC_GIT_EMAIL';
export const CLAVE_EMAIL_PUBLICO = 'ultron.publicEmail';
export const SCRIPT_GATE = 'scripts/cockpit/audit_personal_data.py';

const RE_EMAIL = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;
const RE_NOREPLY = /@users\.noreply\.github\.com$/i;
const LONGITUD_MINIMA = 3;

/**
 * Extensiones que el escáner NO lee: copia de BINARY_EXT de
 * audit_personal_data.py. El selftest falla si las dos listas divergen.
 */
export const EXT_BINARIAS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf',
  '.zip', '.tar', '.gz', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib',
  '.woff', '.woff2', '.ttf', '.otf',
  '.db', '.sqlite', '.sqlite3', '.wal',
  '.pyd', '.pyc', '.pyo',
]);

/**
 * Segmentos de ruta que el escáner salta enteros: copia de SKIP_PATH_PARTS de
 * audit_personal_data.py (el selftest falla si divergen). Un fichero bajo un
 * directorio `build/` o `dist/` se publica sin que nadie lo haya leído.
 */
export const PARTES_SIN_ANALIZAR = new Set([
  '.git', 'node_modules', 'target', '.venv', '__pycache__', 'dist', 'build',
  '.uv-cache-rescue', 'qdrant_storage', 'backups', '.pytest_cache',
]);

const limpiar = (lista) => [...new Set(lista.map((t) => t.trim()).filter(Boolean))];

/**
 * Patrones personales configurados en la máquina de publicación.
 * Devuelve `{ tokens, origenes }`; nunca lanza (un fichero ilegible cuenta como
 * ausente y la validación posterior decide).
 */
export function leerPatronesPii({ env = process.env, fichero = null } = {}) {
  const origenes = [];
  const deEntorno = limpiar(String(env[VAR_PII] || '').split(','));
  if (deEntorno.length) origenes.push(`variable ${VAR_PII}`);
  let deFichero = [];
  if (fichero && fs.existsSync(fichero)) {
    try {
      deFichero = limpiar(
        fs
          .readFileSync(fichero, 'utf8')
          .split(/\r?\n/)
          .filter((l) => !l.trim().startsWith('#')),
      );
    } catch {
      deFichero = [];
    }
    if (deFichero.length) origenes.push(fichero);
  }
  return { tokens: limpiar([...deEntorno, ...deFichero]), origenes };
}

/** Problemas que impiden publicar con estos patrones (lista vacía = válidos). */
export function validarPatronesPii(tokens) {
  const lista = Array.isArray(tokens) ? tokens : [];
  if (!lista.length) {
    return [`no hay patrones personales configurados (${VAR_PII} ni ${FICHERO_PII})`];
  }
  const problemas = [];
  for (const t of lista) {
    if (t.includes(',')) problemas.push(`el patrón "${t}" contiene una coma y no se puede pasar al escáner`);
    if (t.length < LONGITUD_MINIMA) problemas.push(`el patrón "${t}" es demasiado corto (mínimo ${LONGITUD_MINIMA} caracteres)`);
  }
  if (!lista.some((t) => RE_EMAIL.test(t))) problemas.push('falta al menos un email personal');
  if (!lista.some((t) => !t.includes('@'))) problemas.push('falta al menos un handle o usuario personal');
  return problemas;
}

/**
 * Lee la línea de resumen del escáner:
 *   [audit-personal-data] scope=head HIGH=0 MEDIUM=3 FILES=120 UNREAD=0 EXTRA=2
 * Devuelve null si falta algún campo (escáner antiguo o salida rota).
 */
export function interpretarSalidaGate(salida) {
  const texto = String(salida || '');
  const campo = (nombre) => {
    const m = texto.match(new RegExp(`\\b${nombre}=(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const veredicto = {
    high: campo('HIGH'),
    medium: campo('MEDIUM'),
    ficheros: campo('FILES'),
    ilegibles: campo('UNREAD'),
    extra: campo('EXTRA'),
  };
  return Object.values(veredicto).some((v) => v === null) ? null : veredicto;
}

function gitEn(cwd, argv) {
  return spawnSync('git', ['-c', 'core.quotepath=off', ...argv], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Indexa el clon (`git add -A`) y pasa el escáner sobre el índice resultante.
 * Lanza Error con el motivo si el gate no puede dar un veredicto fiable; si lo
 * da, devuelve `{ high, medium, ficheros, ilegibles, extra, salida }` y quien
 * llama decide con `high`.
 */
export function ejecutarGatePii({ clon, tokens, python = ['uv', 'run', 'python'], informe = null }) {
  const alta = gitEn(clon, ['add', '-A']);
  if (alta.status !== 0) throw new Error(`git add -A falló en el clon:\n${alta.stderr || ''}`);
  const indice = gitEn(clon, ['ls-files', '-z']);
  if (indice.status !== 0) throw new Error(`git ls-files falló en el clon:\n${indice.stderr || ''}`);
  const esperados = indice.stdout.split('\0').filter(Boolean).length;

  const [cmd, ...previos] = python;
  const argv = [...previos, SCRIPT_GATE, ...(informe ? ['--out', informe] : [])];
  const r = spawnSync(cmd, argv, {
    cwd: clon,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, [VAR_PII]: tokens.join(',') },
  });
  const salida = `${r.stdout || ''}${r.stderr || ''}`;
  const veredicto = interpretarSalidaGate(salida);
  if (!veredicto) throw new Error(`el gate PII no devolvió un veredicto legible:\n${salida.slice(-400)}`);
  if (veredicto.extra !== tokens.length) {
    throw new Error(`el gate PII cargó ${veredicto.extra} de ${tokens.length} patrones personales`);
  }
  if (veredicto.ficheros !== esperados) {
    throw new Error(`el gate PII listó ${veredicto.ficheros} ficheros y el índice del clon tiene ${esperados}`);
  }
  if (veredicto.ilegibles > 0) {
    throw new Error(`el gate PII no pudo leer ${veredicto.ilegibles} fichero(s) del árbol a publicar`);
  }
  return { ...veredicto, salida };
}

/**
 * Parte la salida de `git diff --cached --name-status -z` en filas
 * `[estado, ruta]` o, en renombrados y copias, `[estado, origen, destino]`.
 *
 * Con `-z` git no cita las rutas: sin él, un nombre no ASCII sale entre comillas
 * y con escapes octales (`"c\303\241ptura.png"`), su extensión deja de casar y
 * el binario se publicaba sin pasar por la revisión. Lanza Error si la salida
 * está truncada, para no decidir sobre una lista incompleta.
 */
export function parsearNameStatusZ(salida) {
  const campos = String(salida || '').split('\0');
  if (campos[campos.length - 1] === '') campos.pop();
  const filas = [];
  let i = 0;
  while (i < campos.length) {
    const estado = campos[i];
    const rutas = /^[RC]/.test(estado) ? 2 : 1;
    const fila = campos.slice(i, i + 1 + rutas);
    if (!estado || fila.length !== 1 + rutas || fila.some((c) => !c)) {
      throw new Error(`salida de git diff --name-status -z ilegible cerca de "${estado}"`);
    }
    filas.push(fila);
    i += 1 + rutas;
  }
  return filas;
}

/** true si el escáner no lee esta ruta: extensión binaria o segmento que salta. */
export function rutaSinAnalizar(ruta) {
  if (EXT_BINARIAS.has(path.extname(ruta).toLowerCase())) return true;
  return ruta.split(/[\\/]/).some((parte) => PARTES_SIN_ANALIZAR.has(parte.toLowerCase()));
}

/**
 * Rutas nuevas o modificadas de un `git diff --cached --name-status` ya partido
 * en columnas (parsearNameStatusZ) que el escáner no lee: binarios y ficheros
 * bajo directorios que salta. Nadie las ha revisado.
 */
export function binariosSinAnalizar(filas) {
  return (filas || [])
    .filter((f) => Array.isArray(f) && f.length >= 2 && /^[AMRC]/.test(f[0]))
    .map((f) => f[f.length - 1])
    .filter(rutaSinAnalizar);
}

/** true si la ruta existe, aunque sea un enlace roto (existsSync sigue enlaces). */
export function existeRuta(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Borrado recursivo con unlinkSync/rmdirSync, que sí aceptan rutas no ASCII. */
function borrarAMano(p) {
  if (fs.lstatSync(p).isDirectory()) {
    for (const e of fs.readdirSync(p)) borrarAMano(path.join(p, e));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

/**
 * Borra un fichero o directorio y lanza Error si sigue ahí. En Node 24 sobre
 * Windows, fs.rmSync de una ruta no ASCII vuelve sin error y no borra nada
 * (papercuts.md, 2026-10-17): una exclusión de .publicignore con un nombre así
 * se habría publicado. Si rmSync no basta, se borra a mano.
 */
export function borrarVerificado(p) {
  fs.rmSync(p, { recursive: true, force: true });
  if (!existeRuta(p)) return;
  try {
    borrarAMano(p);
  } catch (err) {
    throw new Error(`no se pudo borrar ${p}: ${err.message}`);
  }
  if (existeRuta(p)) throw new Error(`${p} sigue en disco después de borrarlo`);
}

/**
 * Email con el que se firma el commit del espejo. Los metadatos del commit son
 * públicos y el escáner no los ve, así que se exige un email explícito para el
 * espejo (variable o `git config ultron.publicEmail`) o un noreply de GitHub, y
 * que no sea ninguno de los emails personales. Devuelve `{ email }` o `{ error }`.
 */
export function emailDelEspejo({ emailPublico = '', emailRepo = '', tokens = [] }) {
  const explicito = String(emailPublico || '').trim();
  const email = explicito || String(emailRepo || '').trim();
  if (!email) return { error: 'no hay email para firmar el commit del espejo' };
  if (!explicito && !RE_NOREPLY.test(email)) {
    return {
      error:
        'el commit del espejo se firmaría con el email de este repo, que no es un noreply de GitHub. ' +
        `Configura el del espejo con: git config ${CLAVE_EMAIL_PUBLICO} <id>+<usuario>@users.noreply.github.com ` +
        `(o la variable ${VAR_EMAIL_PUBLICO})`,
    };
  }
  // Solo se comparan los emails: el noreply de GitHub lleva el usuario dentro a
  // propósito y es el mecanismo de privacidad que GitHub ofrece para esto.
  const minus = email.toLowerCase();
  const emails = tokens.filter((t) => t.includes('@')).map((t) => t.toLowerCase());
  if (emails.some((t) => minus.includes(t))) {
    return { error: 'el email configurado para el espejo es uno de los emails personales' };
  }
  return { email };
}

// Ruta bajo el perfil de un usuario (`C:\Users\<x>`, `/home/<x>`).
const RE_RUTA_USUARIO = /[a-z]:[\\/]+users[\\/]+[^\\/\s]+|\/home\/[^/\s]+/i;

/**
 * Mensaje del commit del espejo (seguridad MEDIUM de la auditoría 2026-10-17).
 * El mensaje es público y el gate PII no lo lee. En `--auto` ya no se copia el
 * asunto del último commit privado (puede nombrar rutas, personas o trabajo que
 * no se publica): va un texto genérico con el SHA corto. Un `-m` explícito se
 * publica tal cual, salvo que contenga un patrón personal o una ruta de usuario.
 */
export function mensajeDelEspejo({ auto = false, msg = null, head = '', tokens = [] }) {
  const explicito = String(msg ?? '').trim();
  const texto = explicito || (auto ? `sync: espejo de ${head}`.trim() : '');
  if (!texto) return { error: '--apply exige un mensaje con -m "sync: que ha cambiado".' };
  const minus = texto.toLowerCase();
  if (tokens.some((t) => t && minus.includes(String(t).toLowerCase()))) {
    return { error: 'el mensaje del commit del espejo contiene un patrón personal del gate PII' };
  }
  if (RE_RUTA_USUARIO.test(texto)) {
    return { error: 'el mensaje del commit del espejo contiene una ruta de usuario' };
  }
  return { mensaje: texto };
}
