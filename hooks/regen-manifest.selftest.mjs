/**
 * Selftest de hooks/regen-manifest.js (2026-10-23).
 *
 * Fija tres propiedades del gate de paridad:
 *   - los checksums se calculan sobre los ficheros de ESTE repo (un worktree
 *     no puede dar por buenos los scripts del checkout principal);
 *   - un cambio en una libreria local que el hook carga cambia el manifest
 *     (hooks-12: antes solo contaba el script de entrada);
 *   - el settings.json de origen se puede fijar con --settings o
 *     ULTRON_HOOKS_SETTINGS para regenerar un cableado propuesto.
 *
 * Hermetico: solo fixtures en un directorio temporal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const rm = require('./regen-manifest.js');

let fallos = 0;
function comprueba(nombre, real, esperado) {
  if (real === esperado) {
    console.log(`ok     ${nombre}`);
  } else {
    fallos++;
    console.error(`FALLO  ${nombre}\n       esperado=${esperado} real=${real}`);
  }
}

const repoRoot = path.resolve(here, '..');

// --- ruta dentro del repo ---------------------------------------------------
comprueba(
  'un script de ~/.ultron se hashea en este repo',
  rm.repoPathOf(path.join(os.homedir(), '.ultron', 'hooks', 'scripts', 'x.js')),
  path.join(repoRoot, 'hooks', 'scripts', 'x.js'),
);
comprueba(
  'con barras / tambien',
  rm.repoPathOf(os.homedir().replace(/\\/g, '/') + '/.ultron/hooks/scripts/x.js'),
  path.join(repoRoot, 'hooks', 'scripts', 'x.js'),
);
comprueba('un script fuera de ~/.ultron se deja como esta', rm.repoPathOf('/opt/otro/hook.js'), '/opt/otro/hook.js');

// --- dependencias locales -----------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-manifest-'));
try {
  fs.mkdirSync(path.join(tmp, 'lib'));
  fs.writeFileSync(path.join(tmp, 'hook.js'), "require('./lib/a');\nrequire('fs');\n");
  fs.writeFileSync(path.join(tmp, 'lib', 'a.js'), "require('./b.js');\nmodule.exports = 1;\n");
  fs.writeFileSync(path.join(tmp, 'lib', 'b.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(tmp, 'solo.js'), "require('os');\n");

  const deps = rm.localDeps(path.join(tmp, 'hook.js')).map((d) => path.basename(d));
  comprueba('sigue las dependencias transitivas', deps.join(','), 'a.js,b.js');
  const antes = rm.depsChecksum(path.join(tmp, 'hook.js'));
  comprueba('hay checksum de dependencias', typeof antes === 'string' && antes.length === 64, true);
  fs.writeFileSync(path.join(tmp, 'lib', 'b.js'), 'module.exports = 3;\n');
  comprueba('cambiar una libreria transitiva cambia el checksum', rm.depsChecksum(path.join(tmp, 'hook.js')) !== antes, true);
  fs.writeFileSync(path.join(tmp, 'lib', 'b.js'), 'module.exports = 3;\r\n');
  const crlf = rm.depsChecksum(path.join(tmp, 'hook.js'));
  fs.writeFileSync(path.join(tmp, 'lib', 'b.js'), 'module.exports = 3;\n');
  comprueba('los finales de linea no cambian el checksum', rm.depsChecksum(path.join(tmp, 'hook.js')), crlf);
  comprueba('sin dependencias locales no hay checksum', rm.depsChecksum(path.join(tmp, 'solo.js')), null);
  comprueba('un script que no existe no rompe', rm.depsChecksum(path.join(tmp, 'nada.js')), null);

  // Ciclo a <-> b: no puede colgarse.
  fs.writeFileSync(path.join(tmp, 'lib', 'b.js'), "require('./a');\n");
  comprueba('un ciclo de requires termina', rm.localDeps(path.join(tmp, 'hook.js')).length, 2);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- settings de origen -------------------------------------------------------
comprueba('--settings manda', rm.settingsPath(['node', 'x', '--settings', '/s/a.json'], {}), path.resolve('/s/a.json'));
comprueba(
  'ULTRON_HOOKS_SETTINGS si no hay --settings',
  rm.settingsPath(['node', 'x'], { ULTRON_HOOKS_SETTINGS: '/s/b.json' }),
  path.resolve('/s/b.json'),
);
comprueba(
  'por defecto el settings.json vivo',
  rm.settingsPath(['node', 'x'], {}),
  path.join(os.homedir(), '.claude', 'settings.json'),
);

// --- plantilla ------------------------------------------------------------------
{
  const home = os.homedir().replace(/\\/g, '/');
  const t = rm.buildTemplate(
    {
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `node ${home}/.ultron/hooks/scripts/a.js`, timeout: 9, async: true }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'node /opt/ajeno.js' }] }],
      },
    },
    null,
  );
  comprueba('la plantilla tokeniza el home', t.hooks.Stop[0].hooks[0].command, 'node {USERPROFILE}/.ultron/hooks/scripts/a.js');
  comprueba('la plantilla conserva timeout y async', `${t.hooks.Stop[0].hooks[0].timeout}/${t.hooks.Stop[0].hooks[0].async}`, '9/true');
  comprueba('la plantilla no lleva hooks ajenos a ~/.ultron', 'Notification' in t.hooks, false);
  // hooks-8: una entrada legada `disabled-command` no corre ni puede ir al instalador.
  const legado = rm.buildTemplate(
    { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'disabled-command', command: `node ${home}/.ultron/hooks/scripts/a.js` }] }] } },
    null,
  );
  comprueba('la plantilla no lleva entradas disabled-command', 'Stop' in legado.hooks, false);
  comprueba('liveEntries deja las command', rm.liveEntries({ hooks: [{ type: 'command' }, { type: 'disabled-command' }] }).length, 1);
}

// --- metadatos y documento (auditoria 2026-11-01) --------------------------------
{
  comprueba('writer_path permitido pasa',
    rm.invalidWriters({ writer_paths_allowed: ['NONE'], hooks: [{ id: 'a', writer_path: 'NONE' }] }).length, 0);
  comprueba('writer_path fuera de la lista se detecta',
    rm.invalidWriters({ writer_paths_allowed: ['NONE'], hooks: [{ id: 'a', writer_path: 'otro' }] })[0], 'a');

  // docs/hooks-coverage.md declaro PermissionRequest como descartado estando cableado.
  const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(raiz, 'hooks', 'manifest.json'), 'utf8'));
  const doc = fs.readFileSync(path.join(raiz, 'docs', 'hooks-coverage.md'), 'utf8');
  const fila = (etiqueta) => (doc.match(new RegExp(`^\\| ${etiqueta} \\(\\d+\\) \\|(.*)$`, 'm')) || ['', ''])[1];
  const nombres = (texto) => [...texto.matchAll(/`(\w+)`/g)].map((m) => m[1]);
  const cableados = [...new Set(manifest.hooks.map((h) => h.event))].sort();
  comprueba('documento: la fila Cableados coincide con el manifest',
    nombres(fila('Cableados')).sort().join(), cableados.join());
  const descartados = nombres(fila('Descartados con motivo'));
  comprueba('documento: la fila Descartados no lleva ningun evento cableado',
    descartados.filter((e) => cableados.includes(e)).join(), '');
  for (const h of manifest.hooks) {
    const seccion = doc.match(new RegExp(`^\\| \`${h.event}\` \\|(.*)$`, 'm'));
    comprueba(`documento: ${h.event} nombra ${h.id}`, Boolean(seccion) && seccion[1].includes(h.id), true);
  }
}

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo verde');
process.exit(fallos ? 1 : 0);
