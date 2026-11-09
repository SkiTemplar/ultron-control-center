#!/usr/bin/env node
// code-size-budget.selftest.mjs — guardia de tamano de codigo (L8, 2026-10-26;
// cobertura real desde 2026-11-01: antes medía hooks/scripts y scripts, el 15 % del codigo).
//
// Mide TODOS los fuentes con seguimiento o nuevos (git ls-files, sin los ignorados)
// de budget.extensions, salvo budget.exclude (terceros vendorizados y datos de prueba):
//   - Un fichero fuera de fileExceptions no puede pasar de maxFileLines (800).
//   - Un fichero de fileExceptions no puede pasar de su `max`: la lista es la deuda
//     existente y solo puede bajar. Si baja de maxFileLines, o desaparece, hay que
//     quitarlo de la lista (el guardia falla para que la lista no se quede vieja).
//   - Una funcion de la linea base no puede pasar de su tope (trinquete).
//
// La longitud de una funcion se mide emparejando llaves desde su declaracion,
// saltando strings y comentarios. No entiende regex literales con llaves: por
// eso solo se aplica a las funciones de la linea base, no a todo el repo.
//
// Hermetico: lee el arbol versionado. Incluye casos sinteticos en un repositorio
// temporal para probar que el guardia no es un no-op.
// Uso: node scripts/code-size-budget.selftest.mjs   (exit 0 = verde)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');

function countLines(text) {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** Fuentes del arbol segun git (con seguimiento y nuevos, sin ignorados), con ruta posix. */
function sourceFiles(root, budget) {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error(`git ls-files fallo: ${r.error ? r.error.message : r.stderr}`);
  const excluded = (f) => (budget.exclude ?? []).some((p) => f.startsWith(p));
  return [...new Set(r.stdout.split('\0').filter(Boolean))]
    .filter((f) => budget.extensions.includes(path.extname(f)) && !excluded(f) && fs.existsSync(path.join(root, f)));
}

/** Indice del cierre (`)` o `}`) del par abierto en `open`, saltando strings y comentarios; -1 si no cierra. */
function matchBrace(src, open) {
  const [abre, cierra] = src[open] === '(' ? ['(', ')'] : ['{', '}'];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && next === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return -1; i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === abre) depth++;
    else if (c === cierra && --depth === 0) return i;
  }
  return -1;
}

/**
 * Lineas de la funcion `name` (declaracion `function name(`), o null si no esta.
 * El cuerpo es la primera llave tras cerrar los parametros: un parametro
 * desestructurado (`{ sessionId }`) no cuenta como cuerpo. Un tipo de retorno
 * con llaves (`): { a: T } {`) sigue sin entenderse.
 */
function functionLines(src, name) {
  const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${name}\\s*\\(`, 'm');
  const m = re.exec(src);
  if (!m) return null;
  const params = matchBrace(src, m.index + m[0].length - 1);
  if (params < 0) return null;
  const open = src.indexOf('{', params + 1);
  const close = open < 0 ? -1 : matchBrace(src, open);
  if (close < 0) return null;
  return countLines(src.slice(m.index, close + 1));
}

/** Violaciones del presupuesto en `root` (rutas del budget relativas a `root`). */
export function checkBudget(root, budget) {
  const violations = [];
  const exceptions = budget.fileExceptions ?? {};
  const files = sourceFiles(root, budget);
  const measured = new Map(files.map((f) => [f, countLines(fs.readFileSync(path.join(root, f), 'utf8'))]));
  for (const [file, n] of measured) {
    const cap = exceptions[file]?.max ?? budget.maxFileLines;
    if (n > cap) violations.push(`${file}: ${n} > ${cap} lineas${exceptions[file] ? ' (excepcion: no puede crecer)' : ''}`);
  }
  for (const file of Object.keys(exceptions)) {
    const n = measured.get(file);
    if (n === undefined) violations.push(`${file}: excepcion de un fichero que ya no existe; quitala de la lista`);
    else if (n <= budget.maxFileLines) violations.push(`${file}: ${n} lineas, ya dentro del limite; quita la excepcion`);
  }
  for (const f of budget.functions) {
    const full = path.join(root, f.file);
    const src = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
    const n = functionLines(src, f.name);
    if (n === null) violations.push(`${f.file} ${f.name}: funcion no encontrada`);
    else if (n > f.max) violations.push(`${f.file} ${f.name}: ${n} > ${f.max}`);
  }
  return violations;
}

let fail = 0;
const A = (c, n, d) => {
  if (c) console.log(`  [PASS] ${n}`);
  else { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); }
};

// 1. Arbol real contra la linea base.
const budget = JSON.parse(fs.readFileSync(path.join(here, 'code-size-budget.json'), 'utf8'));
const real = checkBudget(REPO, budget);
A(real.length === 0, `arbol real dentro del presupuesto (${sourceFiles(REPO, budget).length} fuentes, ${Object.keys(budget.fileExceptions).length} excepciones)`, real.join('; '));

// 2. Caso sintetico: el guardia detecta lo que debe (no es un no-op).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-size-budget-'));
try {
  const fn = (bodyLines) => `function main() {\n${'  x();\n'.repeat(bodyLines - 2)}}\n`;
  const relleno = (total, head) => head + '// relleno\n'.repeat(total - countLines(head));
  const sint = {
    maxFileLines: 800, extensions: ['.js'], exclude: ['vendor/'],
    functions: [{ file: 'src/a.js', name: 'main', max: 50 }],
  };
  const init = spawnSync('git', ['init', '-q'], { cwd: tmp, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`git init fallo: ${init.stderr}`);
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'a.js'), relleno(801, fn(51)));
  const malo = checkBudget(tmp, sint);
  A(malo.length === 2, 'sintetico 801 lineas + funcion de 51 (tope 50) -> 2 violaciones', JSON.stringify(malo));
  fs.writeFileSync(path.join(tmp, 'src', 'a.js'), relleno(800, fn(50)));
  const bueno = checkBudget(tmp, sint);
  A(bueno.length === 0, 'sintetico 800 lineas + funcion de 50 -> sin violaciones', JSON.stringify(bueno));
  fs.writeFileSync(path.join(tmp, 'src', 'a.js'), 'function main() {\n  const s = "}}}"; // }\n  /* } */\n}\n');
  A(functionLines(fs.readFileSync(path.join(tmp, 'src', 'a.js'), 'utf8'), 'main') === 4,
    'llaves dentro de strings y comentarios no cierran la funcion', 'emparejamiento de llaves roto');
  const desestructurado = 'function C({ id }: { id: string }) {\n  const a = 1;\n  return a;\n}\n';
  A(functionLines(desestructurado, 'C') === 4,
    'un parametro desestructurado no se toma por el cuerpo', String(functionLines(desestructurado, 'C')));
  A(checkBudget(tmp, { ...sint, functions: [{ file: 'src/a.js', name: 'otra', max: 5 }] }).length === 1,
    'funcion de la linea base que desaparece -> violacion (no pasa en silencio)', 'no detectada');
  // Excepciones: tope que no crece, limpieza obligatoria y exclusion de terceros.
  const sinFn = { ...sint, functions: [] };
  const conExcepcion = (max) => ({ ...sinFn, fileExceptions: { 'src/a.js': { max, reason: 'prueba' } } });
  fs.writeFileSync(path.join(tmp, 'src', 'a.js'), relleno(900, '// inicio\n'));
  A(checkBudget(tmp, sinFn).length === 1, 'fichero nuevo de 900 lineas sin excepcion -> violacion', 'no detectado');
  A(checkBudget(tmp, conExcepcion(900)).length === 0, 'excepcion con tope 900 y 900 lineas -> verde', 'falso positivo');
  const crecido = checkBudget(tmp, conExcepcion(899));
  A(crecido.length === 1 && crecido[0].includes('no puede crecer'), 'excepcion que supera su tope -> violacion', JSON.stringify(crecido));
  fs.writeFileSync(path.join(tmp, 'src', 'a.js'), relleno(800, '// inicio\n'));
  const vieja = checkBudget(tmp, conExcepcion(900));
  A(vieja.length === 1 && vieja[0].includes('quita la excepcion'), 'excepcion ya innecesaria -> hay que retirarla', JSON.stringify(vieja));
  const fantasma = checkBudget(tmp, { ...sinFn, fileExceptions: { 'src/no-existe.js': { max: 900, reason: 'prueba' } } });
  A(fantasma.length === 1 && fantasma[0].includes('ya no existe'), 'excepcion de un fichero borrado -> violacion', JSON.stringify(fantasma));
  fs.mkdirSync(path.join(tmp, 'vendor'));
  fs.writeFileSync(path.join(tmp, 'vendor', 'b.js'), relleno(900, '// inicio\n'));
  A(checkBudget(tmp, sinFn).length === 0, 'terceros en exclude -> no cuentan', 'exclude ignorado');
  fs.writeFileSync(path.join(tmp, '.gitignore'), 'generado.js\n');
  fs.writeFileSync(path.join(tmp, 'generado.js'), relleno(900, '// inicio\n'));
  A(checkBudget(tmp, sinFn).length === 0, 'fichero ignorado por git -> no cuenta', 'ignorado medido');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fail === 0 ? '\nSELFTEST code-size-budget: VERDE' : `\nSELFTEST code-size-budget: ROJO (${fail})`);
process.exit(fail === 0 ? 0 : 1);
