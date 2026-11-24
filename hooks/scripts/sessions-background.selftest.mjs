/**
 * Selftest de sessions-background.js: solo actua en sesiones de Sessions
 * contra loopback, recorta la entrada y manda tambien la lista vacia (es la
 * que limpia el estado). Puro: no abre red ni lee el entorno real.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { configFrom, bodyFrom, hasPayload } = require('./sessions-background.js');

let fallos = 0;
function comprueba(nombre, real, esperado) {
  const a = JSON.stringify(real);
  const b = JSON.stringify(esperado);
  if (a === b) console.log(`ok     ${nombre}`);
  else {
    fallos++;
    console.error(`FALLO  ${nombre}\n       esperado=${b}\n       real=${a}`);
  }
}

const ENV = { ULTRON_PUENTE_URL: 'http://127.0.0.1:4567/', ULTRON_PUENTE_TOKEN: 't', ULTRON_SESION_ID: 's1' };

comprueba('config de una sesion de Sessions', configFrom(ENV), { url: 'http://127.0.0.1:4567', token: 't', sesionId: 's1' });
comprueba('fuera de Sessions no actua', configFrom({}), null);
comprueba('sin token no actua', configFrom({ ...ENV, ULTRON_PUENTE_TOKEN: '' }), null);
comprueba('una URL no local no recibe nada', configFrom({ ...ENV, ULTRON_PUENTE_URL: 'https://example.com' }), null);
comprueba('opt-out', configFrom({ ...ENV, SESSIONS_BACKGROUND_DISABLED: '1' }), null);
comprueba('CLAUDE_NO_HOOKS', configFrom({ ...ENV, CLAUDE_NO_HOOKS: '1' }), null);

const input = {
  background_tasks: [
    { id: 'b1', type: 'shell', status: 'running', description: '', command: 'x'.repeat(1000), extra: 'fuera' },
    'basura',
  ],
  session_crons: [{ id: 'c1', schedule: '5 9 24 11 *', recurring: false, prompt: 'mira el CI' }],
};
const body = bodyFrom(input, 's1');
comprueba('solo los campos que lee el puente', Object.keys(body.backgroundTasks[0]), ['id', 'type', 'status', 'description', 'command']);
comprueba('recorta el comando', body.backgroundTasks[0].command.length, 300);
comprueba('descarta entradas que no son objetos', body.backgroundTasks.length, 1);
comprueba('conserva el booleano recurring', body.sessionCrons[0], { id: 'c1', schedule: '5 9 24 11 *', recurring: false, prompt: 'mira el CI' });

comprueba('la lista vacia se manda (limpia el estado)', hasPayload({ background_tasks: [], session_crons: [] }), true);
comprueba('un Stop sin los campos no manda nada', hasPayload({ stop_hook_active: false }), false);
comprueba('sin entrada no manda nada', hasPayload(null), false);

if (fallos > 0) {
  console.error(`\n${fallos} fallo(s)`);
  process.exit(1);
}
console.log('\nsessions-background: todo ok');
