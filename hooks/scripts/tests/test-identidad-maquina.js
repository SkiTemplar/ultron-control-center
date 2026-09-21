#!/usr/bin/env node
// Pruebas de la identidad de maquina de `ensure-project.js`.
//
// Lo que se cubre: que las raices de trabajo se DEDUZCAN del registro de esta
// maquina en vez de estar clavadas a las del autor original
// (`PERSONAL`/`CARRERA`/`PROFESIONAL`), que una carpeta con un solo proyecto
// no cuente como raiz, y que sin senal propia no se de nada de alta.
//
// Ejecutar:  node hooks/scripts/tests/test-identidad-maquina.js

const assert = require('assert');
const { raicesDelRegistro, bajoRaizPropia, remotePropio } = require('../ensure-project.js');

const HOME = 'C:\\Users\\yo';

function reg(...rutas) {
  return rutas.map((path) => ({ path }));
}

// --- raicesDelRegistro -----------------------------------------------------

{
  // Dos proyectos bajo Documents y dos bajo trabajo: ambas son raices de trabajo.
  const raices = raicesDelRegistro(
    reg(
      'C:\\Users\\yo\\Documents\\GitHub\\a',
      'C:\\Users\\yo\\Documents\\GitHub\\b',
      'C:\\trabajo\\portfolio\\c',
      'C:\\trabajo\\curso3\\d',
    ),
    HOME,
  );
  assert.deepStrictEqual(raices.sort(), ['documents', 'trabajo']);
}

{
  // Caso negativo: una carpeta con UN solo proyecto no es una raiz de trabajo.
  // Sin este filtro, cualquier repo suelto convertiria a su padre en raiz y
  // media maquina pasaria a darse de alta sola.
  const raices = raicesDelRegistro(reg('C:\\Users\\yo\\Escritorio\\prueba'), HOME);
  assert.deepStrictEqual(raices, []);
}

{
  // Caso negativo: registro vacio -> ninguna raiz.
  assert.deepStrictEqual(raicesDelRegistro([], HOME), []);
  assert.deepStrictEqual(raicesDelRegistro([{ path: null }], HOME), []);
}

{
  // El home entero registrado (`__home`) no puede generar una raiz.
  assert.deepStrictEqual(raicesDelRegistro(reg(HOME, HOME), HOME), []);
}

// --- bajoRaizPropia --------------------------------------------------------

assert.strictEqual(bajoRaizPropia('C:\\trabajo\\portfolio\\maria', ['trabajo']), true);
// La comparacion ignora mayusculas por los dos lados: en Windows la misma
// carpeta se escribe de varias formas y una raiz no puede fallar por eso.
assert.strictEqual(bajoRaizPropia('C:/trabajo/portfolio/maria', ['TRABAJO']), true);
assert.strictEqual(bajoRaizPropia('C:\\otra\\cosa', ['trabajo']), false);
// Caso negativo: sin raices configuradas ni deducidas, nada es propio.
assert.strictEqual(bajoRaizPropia('C:\\trabajo\\portfolio', []), false);
assert.strictEqual(bajoRaizPropia('C:\\trabajo\\portfolio', null), false);

// --- remotePropio ----------------------------------------------------------

// Caso negativo: sin cuentas configuradas NO se lanza git siquiera y no hay
// coincidencia. Antes esto comparaba contra una cuenta clavada que en esta
// maquina no acertaba jamas.
assert.strictEqual(remotePropio(process.cwd(), []), null);
assert.strictEqual(remotePropio(process.cwd(), null), null);

console.log('test-identidad-maquina: OK');
