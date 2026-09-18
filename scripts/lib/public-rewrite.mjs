/**
 * public-rewrite.mjs — reapunta al espejo publico las URLs del repo privado.
 *
 * Por que existe (2026-09-18): el espejo publico se publica como volcado literal
 * de HEAD, asi que se llevaba tal cual las URLs de `SkiTemplar/ultron` — un repo
 * PRIVADO. Quien clonaba el espejo se encontraba con que el one-liner de
 * bootstrap, el instalador y el auto-updater de Tauri apuntaban a un repositorio
 * que le devuelve 404. El privado, en cambio, SI debe seguir apuntando a si
 * mismo: sus releases (v15.7.0) viven ahi y es de donde se autoactualiza esta
 * maquina. Por eso la reescritura ocurre solo en el arbol que se publica, nunca
 * en el arbol de trabajo.
 *
 * Solo se tocan los ficheros que un tercero ejecuta o consume: los scripts de
 * arranque, la configuracion del updater y los documentos de instalacion. El
 * historico (docs/audits/) se deja intacto: reescribir un informe fechado seria
 * falsearlo.
 */

const PRIVADO = 'SkiTemplar/ultron';
const PUBLICO = 'SkiTemplar/ultron-control-center';

/** Ficheros del arbol publicado cuyas URLs se reapuntan. */
export const FICHEROS_REESCRITOS = [
  'bootstrap.ps1',
  'bootstrap.sh',
  'install.ps1',
  'install.sh',
  'INSTALL.md',
  'README.md',
  'CONTRIBUTING.md',
  'control-center/src-tauri/tauri.conf.json',
];

// `ultron` seguido de algo que continue el nombre (guion, letra, digito) ya es
// otro repositorio: `ultron-control-center` o `ultron-skills` no se tocan.
const PRIVADO_RE = new RegExp(`${PRIVADO.replace('/', '\\/')}(?![-\\w])`, 'g');

/**
 * Reapunta las referencias al repo privado dentro de un contenido.
 * @param {string} contenido
 * @returns {{texto: string, cambios: number}}
 */
export function reapuntarRepo(contenido) {
  const texto = String(contenido ?? '');
  const cambios = (texto.match(PRIVADO_RE) || []).length;
  return { texto: cambios ? texto.replace(PRIVADO_RE, PUBLICO) : texto, cambios };
}
