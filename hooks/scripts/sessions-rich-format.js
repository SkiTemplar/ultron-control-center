#!/usr/bin/env node
// hooks/scripts/sessions-rich-format.js — SessionStart hook.
//
// El chat de ULTRON Sessions renderiza callouts, tablas ordenables, diagramas,
// KaTeX y otros recursos que una terminal no pinta. Este hook fija ese formato
// como estilo diario de las sesiones lanzadas por Sessions (ULTRON_SESION_ID).
// Fuera de Sessions no emite nada, porque el recurso saldria como texto crudo.
//
// SessionStart tambien se dispara tras /clear y tras compactar, de modo que la
// instruccion sobrevive a ambos. No se dispara dentro de un subagente.
//
// LIMITE: un `claude -p` lanzado desde una sesion hereda ULTRON_SESION_ID y
// recibe tambien este contexto; lo que pida su prompt sigue mandando.
//
// Sintaxis completa: skill `rico` (~/.claude/skills/rico/SKILL.md).
//
// Opt-out: CLAUDE_NO_HOOKS=1 o SESSIONS_RICH_FORMAT_DISABLED=1.
//
// FAIL-SAFE: un fallo no puede impedir que la sesion arranque.

const { observe, logHookError } = require('./lib/hook-obs');

const FORMAT_CONTEXT = `## Formato del chat (ULTRON Sessions)

Esta sesión se muestra en el renderizador de Sessions, no en una terminal. Redacta todas las respuestas del chat aprovechando su formato enriquecido como estilo diario. Más formato no significa más palabras: la concisión manda y una respuesta de una línea sigue siendo una línea.

- Uso habitual, cuando aporte: callouts \`> [!TIP]\`, \`[!NOTE]\`, \`[!IMPORTANT]\`, \`[!WARNING]\` y \`[!CAUTION]\` (etiqueta en la primera línea de la cita); tablas; ✓ y ✗; \`<kbd>\`; \`<mark>\`; \`<details><summary>\` para el detalle prescindible; bloques \`diff\`; bloques \`json\` y \`yaml\`; rutas absolutas, que se abren en VS Code.
- Uso cuando el contenido tenga esa forma: \`mermaid\` (flujos, secuencias, estados, \`gantt\`), \`dot\` (dependencias), \`chart\` (Vega-Lite con \`data.values\` en línea), KaTeX \`$…$\` y \`$$…$$\`, \`html\` y \`svg\` (vista previa).
- Ni callout ni gráfica son obligatorios: un mensaje sin estructura va en prosa. Máximo dos o tres piezas grandes por mensaje. Las cifras de una gráfica salen de datos verificados en la sesión.
- Mermaid: sin HTML ni \`<br>\` en los nodos; texto con tildes entre comillas (\`A["Decisión"]\`); sintaxis conservadora.
- HTML permitido: \`details\`, \`summary\`, \`kbd\`, \`mark\`, \`sub\`, \`sup\` y \`br\`. Sin \`style\`, \`class\` ni \`<script>\` fuera de un bloque \`html\`.
- Solo afecta a los mensajes del chat. Commits, PR, código, documentación, TFG y prompts a subagentes conservan su formato normal.

Antes de una pieza compleja, carga la skill \`rico\` para la sintaxis completa; \`/rico\` pide el tratamiento visual completo.`;

/**
 * @param {Record<string, string | undefined>} env
 * @returns {boolean} true si la sesión la lanzó Sessions y no hay opt-out.
 */
function shouldInject(env) {
  if (env.CLAUDE_NO_HOOKS === '1' || env.SESSIONS_RICH_FORMAT_DISABLED === '1') return false;
  return Boolean(env.ULTRON_SESION_ID);
}

function main() {
  if (!shouldInject(process.env)) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: FORMAT_CONTEXT },
    }),
  );
}

if (require.main === module) {
  observe('sessions-rich-format');
  try {
    main();
  } catch (err) {
    logHookError('sessions-rich-format', err);
  }
}

module.exports = { shouldInject, FORMAT_CONTEXT };
