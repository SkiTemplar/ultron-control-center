// adjuntos-ignorados.selftest.mjs — los adjuntos de ULTRON Sessions
// (`adjuntos/<fecha>/…`, capturas y ficheros del usuario) nunca entran en el
// repo: el .gitignore raíz los ignora, igual que las tareas de motores que
// guarda en `cockpit/sesiones/`. Sin las reglas, falla.
//
// Uso: node scripts/adjuntos-ignorados.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Código de salida de `git check-ignore -q <ruta>`: 0 = ignorada, 1 = no. */
function checkIgnore(path) {
  const r = spawnSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: ROOT, encoding: 'utf8' });
  if (r.error) throw r.error;
  return r.status;
}

test('un adjunto guardado por Sessions queda ignorado', () => {
  assert.equal(checkIgnore('adjuntos/2026-01-01/x.png'), 0);
  assert.equal(checkIgnore('adjuntos/2026-01-01/captura de pantalla.jpeg'), 0);
});

test('las tareas de motores guardadas por Sessions quedan ignoradas', () => {
  assert.equal(checkIgnore('cockpit/sesiones/motores.json'), 0);
});

test('la regla solo cubre la carpeta raíz de adjuntos (caso negativo)', () => {
  assert.equal(checkIgnore('control-center/src/sesiones/adjuntos.ts'), 1);
  assert.equal(checkIgnore('control-center/src-tauri/src/sesiones/adjuntos.rs'), 1);
});
