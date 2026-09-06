/**
 * Selftest del gate de intencion del dispatcher v3.
 *
 * La regla que se prueba: DOMINIO NO ES INTENCION. Que un turno hable de
 * finanzas no lo convierte en una consulta para el asesor financiero; si lo que
 * se pide es arreglar codigo, la persona sobra y ademas cuesta entre 1.797 y
 * 2.791 tokens inyectarla.
 *
 * Los casos vienen de la bateria del 2026-08-28 sobre prompts reales: de 57
 * sugerencias, 19 eran personas y solo acerto la que llamaba a la persona por
 * su nombre.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const v3 = require('./routing-dispatcher.v3.js');

let fallos = 0;
const comprueba = (nombre, real, esperado) => {
  if (JSON.stringify(real) !== JSON.stringify(esperado)) {
    fallos++;
    console.error(`FALLO  ${nombre}\n       esperado=${JSON.stringify(esperado)} real=${JSON.stringify(real)}`);
  } else {
    console.log(`ok     ${nombre}`);
  }
};

const nombres = (prompt, lista) => v3.filtrarNombresPersona(lista, prompt);

// --- el caso que lo motivo -------------------------------------------------
comprueba('un bug en finanzas NO es para el asesor financiero',
  nombres('hay un bug en el dashboard de finanzas, no carga los movimientos', ['tio-gilito', 'debugger']),
  ['debugger']);

comprueba('preguntar por el dinero SI es para el asesor',
  nombres('como van mis finanzas este mes, cuanto me queda', ['tio-gilito', 'warren']),
  ['tio-gilito', 'warren']);

comprueba('llamarla por su nombre gana aunque el turno sea tecnico',
  nombres('Tio Gilito, hay un bug en tus cuentas del mes pasado', ['tio-gilito', 'debugger']),
  ['tio-gilito', 'debugger']);

// --- regresiones medidas el 2026-08-28 -------------------------------------
// Sin señal lexica el gate no puede saber que es trabajo tecnico, asi que la
// segunda linea de defensa es el floor: una persona que llega por similitud
// floja se cae igual. Los hits del denso vienen con score.
comprueba('persona con score de ruido se cae aunque no haya señal tecnica',
  nombres('detectar fotos rectas o torcidas, el umbral de caras da valores raros',
    [{ name: 'mike-tyson', score: 0.81 }, { name: 'python-pro', score: 0.83 }])
    .map((h) => h.name || h),
  ['python-pro']);

comprueba('persona con score alto de verdad si pasa',
  nombres('quiero rehacer la paleta de color y la jerarquia visual del panel',
    [{ name: 'mike-tyson', score: 0.91 }]).map((h) => h.name || h),
  ['mike-tyson']);

comprueba('un fichero .py en el prompt basta para marcar turno tecnico',
  nombres('revisa dashboard.py que algo no cuadra', ['tio-gilito']),
  []);

// --- el gate no se pasa de listo -------------------------------------------
comprueba('sin señales tecnicas no filtra nada',
  nombres('necesito consejo sobre como invertir mis ahorros', ['warren', 'tio-gilito']),
  ['warren', 'tio-gilito']);

comprueba('las skills tecnicas nunca se tocan',
  nombres('arregla el bug del parser', ['debugger', 'systematic-debugging', 'python-pro']),
  ['debugger', 'systematic-debugging', 'python-pro']);

comprueba('lista vacia no rompe', nombres('arregla el bug', []), []);
comprueba('null no rompe', nombres('arregla el bug', null), []);

// --- ranking del determinista ----------------------------------------------
const rank = v3.filtrarPersonas(
  [{ id: 'tio-gilito', kind: 'persona' }, { id: 'debugger', kind: 'plugin' }],
  'arregla el error de la query de movimientos',
);
comprueba('filtrarPersonas limpia el ranking determinista',
  rank.map((c) => c.id), ['debugger']);

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo verde');
process.exit(fallos ? 1 : 0);
