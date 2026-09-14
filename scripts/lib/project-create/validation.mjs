// validation.mjs — validacion de nombres, segmentos y rutas del creador de
// proyectos. Sin efectos secundarios: solo lanza CliError o devuelve valores.

import { resolve, relative, isAbsolute } from 'node:path';
import { CliError } from './errors.mjs';

export const RESERVED_WINDOWS_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);
export const FORBIDDEN_NAME_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/;
export const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function slugify(text) {
  const slug = String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!slug) throw new CliError('INVALID_NAME', `no se pudo derivar un identificador a partir de "${text}"`);
  return slug;
}

export function validateName(name) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new CliError('INVALID_NAME', 'el nombre no puede estar vacio');
  }
  if (name.length > 80) {
    throw new CliError('INVALID_NAME', `nombre demasiado largo (${name.length} > 80): ${name}`);
  }
  if (FORBIDDEN_NAME_CHARS_RE.test(name)) {
    throw new CliError('INVALID_NAME', `el nombre contiene caracteres no permitidos (< > : " / \\ | ? * o de control): ${name}`);
  }
  if (/[. ]$/.test(name)) {
    throw new CliError('INVALID_NAME', `el nombre no puede terminar en punto o espacio: "${name}"`);
  }
  // El nombre acaba como argumento de generadores externos: sin guion inicial
  // (se leeria como flag) ni metacaracteres de cmd.exe (defensa en profundidad
  // frente a CVE-2024-27980 si algun generador pasara por un .cmd).
  if (name.startsWith('-')) {
    throw new CliError('INVALID_NAME', `el nombre no puede empezar por guion: "${name}"`);
  }
  if (/[&%^!`]/.test(name)) {
    throw new CliError('INVALID_NAME', `el nombre contiene caracteres no permitidos (& % ^ ! \`): ${name}`);
  }
  const base = name.split('.')[0].toUpperCase();
  if (RESERVED_WINDOWS_NAMES.has(base)) {
    throw new CliError('INVALID_NAME', `"${name}" es un nombre reservado de Windows`);
  }
}

/**
 * Cada segmento de `--sub` es una carpeta existente o por crear: mismas reglas
 * de sistema de ficheros que un nombre (el primero se interpola en plantillas
 * como `{{subject}}`). ".." lo rechaza despues `resolveWithinRoot`.
 */
export function validateSubSegments(sub) {
  for (const seg of String(sub || '').split(/[\\/]+/).filter(Boolean)) {
    if (seg === '..' || seg === '.') continue;
    if (FORBIDDEN_NAME_CHARS_RE.test(seg) || /[. ]$/.test(seg)) {
      throw new CliError('INVALID_NAME', `segmento de --sub no permitido: "${seg}"`);
    }
  }
}

/** Resuelve `sub` (relativo) dentro de `rootPath`, rechazando ".." y rutas absolutas. */
export function resolveWithinRoot(rootPath, sub) {
  const rootAbs = resolve(rootPath);
  const target = sub ? resolve(rootAbs, sub) : rootAbs;
  const rel = relative(rootAbs, target);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new CliError('PATH_OUTSIDE_ROOT', `la ruta queda fuera de la raiz: ${sub}`);
  }
  return target;
}
