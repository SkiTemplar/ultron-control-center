/**
 * Selftest de guardrails-post. El riesgo aqui son los FALSOS POSITIVOS: un
 * README tecnico normal no puede disparar el aviso de tono, o el hook se
 * vuelve ruido que se acaba ignorando.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const g = require('./guardrails-post.js');

let fallos = 0;
const comprueba = (nombre, real, esperado) => {
  if (real !== esperado) { fallos++; console.error(`FALLO  ${nombre}\n       esperado=${esperado} real=${real}`); }
  else console.log(`ok     ${nombre}`);
};
const avisos = (ruta, texto) => g.analiza(ruta, texto).length;

const README_TECNICO = `# Routing dispatcher

El juez LLM elige sobre el catalogo completo. Si el proveedor no responde
dentro del presupuesto, la rama cae al retriever denso y el hint sale igual.`;

comprueba('README tecnico no dispara nada',
  avisos('C:/repo/README.md', README_TECNICO), 0);
comprueba('codigo normal no dispara nada',
  avisos('C:/repo/src/index.ts', 'export function suma(a: number, b: number) { return a + b; }'), 0);
comprueba('conteo fuera de la skill ULTRON no dispara',
  avisos('C:/repo/README.md', 'El sistema tiene 93 skills instaladas.'), 0);
comprueba('conteo dentro de la skill ULTRON avisa',
  avisos('C:/Users/x/.claude/skills/ultron/SKILL.md', 'Enruta sobre 93 skills y 77 agentes.'), 1);
comprueba('CLAUDE.md queda excluido',
  avisos('C:/Users/x/.claude/skills/ultron/CLAUDE.md', 'Nada de conteos: 93 skills.'), 0);
comprueba('scratchpad queda excluido',
  avisos('C:/tmp/scratchpad/nota.md', 'ke pasa illo, po zi'), 0);
comprueba('texto vacio no dispara', avisos('C:/repo/README.md', '   '), 0);
comprueba('registro coloquial en un doc publico avisa',
  avisos('C:/repo/docs/guia.md', 'ozu killo, po zi que esto va to fino, mi arma'), 1);
comprueba('registro coloquial en codigo avisa',
  avisos('C:/repo/src/api.ts', '// ke pasa illo, po zi que aqui va el parseo, mi arma'), 1);

comprueba('Write extrae content', g.textoNuevo('Write', { content: 'hola' }), 'hola');
comprueba('Edit extrae new_string', g.textoNuevo('Edit', { new_string: 'hola' }), 'hola');
comprueba('otra tool no aporta texto', g.textoNuevo('Read', { content: 'hola' }), '');

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo verde');
process.exit(fallos ? 1 : 0);
