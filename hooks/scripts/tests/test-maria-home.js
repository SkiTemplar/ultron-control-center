#!/usr/bin/env node
// Pruebas del resolutor de la raiz de mar.ia en los hooks.
//
// Ejecutar:  node hooks/scripts/tests/test-maria-home.js

const assert = require('assert');
const path = require('path');
const { elegirRaiz, mariaHome, DIR_NUEVO, DIR_HEREDADO } = require('../lib/maria-home.js');

const HOME = path.join('C:', 'Users', 'x');
const nada = () => false;
const todo = () => true;

// La variable de entorno manda, exista o no la carpeta.
assert.strictEqual(elegirRaiz('D:/otra/maria', HOME, nada), 'D:/otra/maria');

// Caso negativo: una variable en blanco es "sin configurar", no la raiz del
// disco. Sin este filtro, MARIA_HOME="" mandaba la instalacion a ninguna parte.
assert.strictEqual(elegirRaiz('   ', HOME, nada), path.join(HOME, DIR_NUEVO));
assert.strictEqual(elegirRaiz(undefined, HOME, nada), path.join(HOME, DIR_NUEVO));

// Prefiere el nombre nuevo cuando existe.
const nuevo = path.join(HOME, DIR_NUEVO);
assert.strictEqual(elegirRaiz(undefined, HOME, (p) => p === nuevo), nuevo);

// Una instalacion sin migrar sigue arrancando contra el nombre heredado.
const heredado = path.join(HOME, DIR_HEREDADO);
assert.strictEqual(elegirRaiz(undefined, HOME, (p) => p === heredado), heredado);

// Tras la migracion existen los dos (.ultron es un enlace): gana el nuevo.
assert.strictEqual(elegirRaiz(undefined, HOME, todo), nuevo);

// En esta maquina tiene que resolver a algo real.
const real = mariaHome();
assert.ok(real && real.length > 0, 'mariaHome() devolvio vacio');
assert.ok(
  real.endsWith(DIR_NUEVO) || real.endsWith(DIR_HEREDADO) || path.isAbsolute(real),
  `raiz inesperada: ${real}`,
);

console.log('test-maria-home: OK ->', real);
