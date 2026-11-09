/**
 * launcher.mjs - resuelve el ejecutable real de un CLI para lanzarlo con
 * `spawn(file, args)` SIN shell.
 *
 * Por que sin shell: con un string para cmd.exe o sh, un modelo o una ruta con
 * `"`, `&`, `%VAR%` o `$(...)` ejecutaba comandos (las comillas no protegen en
 * cmd.exe). Con un array de argumentos no hay interprete de por medio.
 *
 * En Windows, un `.exe` se lanza tal cual. Un shim `.cmd` de npm no se puede
 * lanzar sin shell, asi que se lee su destino (`"%dp0%\...\x.js"` o
 * `"%dp0%\...\x.exe"`) y se ejecuta directamente: el `.js` con el node actual,
 * como hace hooks/scripts/lib/codex-exec.js. Un `.cmd` que no tiene esa forma
 * no se lanza (cuenta como no instalado): nunca se cae a la shell.
 */

import { readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

const NODE_SCRIPT = /\.(c|m)?js$/i;
const SHIM_TARGET = /"%dp0%\\([^"%]+)"/gi;

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Destino de un shim `.cmd` de npm: `{ file, prefixArgs }` o null si no se
 * reconoce. Se toma el ultimo `"%dp0%\..."` que no sea el propio node.exe.
 */
export function shimTarget(cmdFile) {
  let text;
  try {
    text = readFileSync(cmdFile, 'utf8');
  } catch {
    return null;
  }
  const targets = [...text.matchAll(SHIM_TARGET)].map((m) => m[1]).filter((rel) => !/(^|\\)node\.exe$/i.test(rel));
  const rel = targets.pop();
  if (!rel) return null;
  const abs = join(dirname(cmdFile), ...rel.split('\\'));
  if (!isFile(abs)) return null;
  if (NODE_SCRIPT.test(abs)) return { file: process.execPath, prefixArgs: [abs] };
  if (/\.exe$/i.test(abs)) return { file: abs, prefixArgs: [] };
  return null;
}

/**
 * Lanzador de `bin` segun el PATH: `{ file, prefixArgs }` o null.
 * Windows: en cada directorio, `bin.exe` y luego el shim `bin.cmd`.
 */
export function resolveLauncher(bin, env = process.env) {
  const dirs = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  for (const d of dirs) {
    if (process.platform !== 'win32') {
      if (isFile(join(d, bin))) return { file: join(d, bin), prefixArgs: [] };
      continue;
    }
    if (isFile(join(d, `${bin}.exe`))) return { file: join(d, `${bin}.exe`), prefixArgs: [] };
    if (isFile(join(d, `${bin}.cmd`))) {
      const target = shimTarget(join(d, `${bin}.cmd`));
      if (target) return target;
    }
  }
  return null;
}
