#!/usr/bin/env node
/**
 * stop-compress-compact.selftest.mjs — compact.json acumula entre pasadas
 * (auditoria 2026-11-01, check Kirkardo 17.5). Una sesion se comprime en varias
 * pasadas y una sin captura pisaba con un stub los hechos de la anterior. Solo
 * funciones puras: no toca el disco ni lanza el sidecar.
 *
 * Limite: esto no pone en verde el 17.5. De 263 capturas medidas, 255 acabaron en
 * `router_error->skip`: la causa esta en la cadena del router, fuera de este hook.
 *
 * Uso: node hooks/scripts/stop-compress-compact.selftest.mjs   (exit 0 = verde)
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeCompact, captureStatusOf } = require('./stop-compress-session.js');

const pasada = (over = {}) => ({
  schema_version: 1,
  session_id: 's',
  human: 'ultima',
  machine: { turns_total: 2, facts_extracted: 0, ai_used: false, capture: 'throttled' },
  decisions: [],
  next: [],
  bugs: [],
  arch_delta: ['c1'],
  ...over,
});

const conHechos = pasada({
  human: 'primera',
  machine: { turns_total: 1, facts_extracted: 2, ai_used: true, capture: 'router' },
  decisions: [{ text: 'usar SQLite', origin: 'origin:user' }],
  next: ['migrar el lector'],
});

// Sin previo: la pasada tal cual.
assert.deepEqual(mergeCompact(null, conHechos), conHechos);
assert.deepEqual(mergeCompact('roto', conHechos), conHechos);

// Una pasada sin captura no borra los hechos de la anterior.
const trasStub = mergeCompact(conHechos, pasada());
assert.deepEqual(trasStub.decisions, conHechos.decisions);
assert.deepEqual(trasStub.next, conHechos.next);
assert.equal(trasStub.machine.facts_extracted, 2);
assert.equal(trasStub.machine.ai_used, true);

// Lo que describe la pasada es de la ultima.
assert.equal(trasStub.human, 'ultima');
assert.equal(trasStub.machine.turns_total, 2);
assert.equal(trasStub.machine.capture, 'throttled');

// Las secciones se unen sin repetir y los contadores acumulan.
const segunda = pasada({
  machine: { turns_total: 3, facts_extracted: 1, ai_used: true, capture: 'router' },
  decisions: [{ text: 'usar SQLite', origin: 'origin:user' }, { text: 'sin ORM', origin: 'origin:user' }],
  next: ['migrar el lector', 'borrar el viejo'],
});
const unidas = mergeCompact(conHechos, segunda);
assert.deepEqual(unidas.decisions.map((d) => d.text), ['usar SQLite', 'sin ORM']);
assert.deepEqual(unidas.next, ['migrar el lector', 'borrar el viejo']);
assert.equal(unidas.machine.facts_extracted, 3);

// Caso negativo: dos stubs siguen siendo un stub, no se inventa contenido.
const dosStubs = mergeCompact(pasada(), pasada());
assert.deepEqual(dosStubs.decisions, []);
assert.equal(dosStubs.machine.facts_extracted, 0);
assert.equal(dosStubs.machine.ai_used, false);

// Un previo con forma rara no revienta ni contamina.
const raro = mergeCompact({ decisions: 'x', machine: null }, conHechos);
assert.deepEqual(raro.decisions, conHechos.decisions);
assert.equal(raro.machine.facts_extracted, 2);

// Estado de la captura: distingue no intentada, sin informe y lo que diga el sidecar.
assert.equal(captureStatusOf(null, false), 'throttled');
assert.equal(captureStatusOf(null, true), 'no_report');
assert.equal(captureStatusOf({ strategy: 'router_error->skip' }, true), 'router_error->skip');

console.log('SELFTEST stop-compress-compact: VERDE');
