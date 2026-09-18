// hooks/scripts/lib/maria-home.js — donde vive todo, para los hooks.
//
// Espejo en JavaScript de `maria_paths.rs`. Mismo orden de resolucion:
//   1. MARIA_HOME / ULTRON_HOME  (variable de entorno)
//   2. ~/.maria                  (nombre nuevo, si existe)
//   3. ~/.ultron                 (nombre heredado)
//
// Por que existe: la carpeta raiz paso a llamarse `.maria` el 2026-09-18. La
// migracion deja un enlace de directorio en `.ultron`, asi que los hooks que
// siguen diciendo `.ultron` no se rompen — pero los que se toquen a partir de
// ahora preguntan aqui y apuntan directamente al nombre bueno.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR_NUEVO = '.maria';
const DIR_HEREDADO = '.ultron';

/**
 * Elige la raiz. Puro salvo por los dos parametros inyectables, que es lo que
 * permite probar los tres caminos sin crear carpetas.
 *
 * @param {string|undefined} envHome  valor de MARIA_HOME/ULTRON_HOME
 * @param {string} home               carpeta del usuario
 * @param {(p: string) => boolean} existe
 */
function elegirRaiz(envHome, home, existe) {
  const env = String(envHome || '').trim();
  if (env) return env;
  const nuevo = path.join(home, DIR_NUEVO);
  if (existe(nuevo)) return nuevo;
  const heredado = path.join(home, DIR_HEREDADO);
  if (existe(heredado)) return heredado;
  // Instalacion nueva: estrena el nombre nuevo.
  return nuevo;
}

/** Raiz de mar.ia en esta maquina. */
function mariaHome() {
  return elegirRaiz(
    process.env.MARIA_HOME || process.env.ULTRON_HOME,
    os.homedir(),
    (p) => fs.existsSync(p),
  );
}

module.exports = { elegirRaiz, mariaHome, DIR_NUEVO, DIR_HEREDADO };
