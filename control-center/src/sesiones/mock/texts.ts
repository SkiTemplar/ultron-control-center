// Textos largos de la demo (markdown completo) y la imagen de ejemplo.

export const ANSWER_CAUSE = `## Causa: ancho fijo de la columna de ritmo

La fila usaba \`width: 38\` y, por debajo de 100 columnas, el texto del límite se salía del panel. Ahora la columna se adapta a \`bodyColumns\` y el texto largo pasa a una segunda línea.

| Ancho | Antes | Después |
|------:|-------|---------|
| 80 col | cortado | 2 líneas |
| 120 col | cortado | 1 línea |
| 180 col | bien | 1 línea |

\`\`\`ts
// mods/ultron-uso/hooks/view.tsx
const width = Math.min(38, Math.max(20, e.props.bodyColumns - 42)) // antes: 38 fijo
return h(Box, { width, flexWrap: "wrap" }, label)
\`\`\`

### Qué he tocado

- \`view.tsx\`: ancho calculado y salto de línea en el texto del límite.
- \`narrow.test.ts\`: tres casos nuevos (80, 120 y 180 columnas).
- **No** he tocado \`format.ts\` ni el cálculo del ritmo.

> **Verificado:** 9/9 tests del mod y \`claude plugin validate\` sin errores.
> El revisor sigue trabajando; te aviso si encuentra algo.

1. Revisión de \`code-reviewer\` en curso.
2. Segunda opinión de Codex en paralelo.
3. Commit cuando ambos den el visto bueno.`;

export const STREAM_80_COLS = `Con 80 columnas el panel queda así: el ritmo baja a la segunda línea y la barra conserva el ancho mínimo de **20** celdas.

\`\`\`text
 5 h  ████████░░░░░░░░░░░░  12 %   reset 03:40
      ritmo: 1,4 %/h · holgado
 sem  ██████████░░░░░░░░░░  51 %   reset lun
      ritmo: 7,1 %/día · justo
\`\`\`

He renderizado los tres anchos con el script de vista previa y los he comparado con la captura:

| Ancho | Filas | Desborde |
|------:|------:|----------|
| 80 col | 4 | no |
| 100 col | 3 | no |
| 120 col | 2 | no |

- El texto del reset ya no empuja la barra.
- La columna de ritmo se recorta con elipsis si no cabe ni en dos líneas.

> Si prefieres ocultar el ritmo por debajo de 72 columnas, es un cambio de una línea en \`view.tsx\`.`;

export const REVIEW_ANSWER = `## Revisión adversarial del PR #41

He leído el diff completo (\`git diff main...HEAD\`, 6 ficheros). Dos hallazgos y una sugerencia:

| Severidad | Fichero | Hallazgo |
|-----------|---------|----------|
| HIGH | \`puente/http.rs\` | El token se compara con \`==\`; usar comparación en tiempo constante. |
| MEDIUM | \`sesiones/pty.rs\` | \`resize\` no limita filas: un 0 bloquea la TUI. |
| LOW | \`docs/CONTRATO.md\` | Falta la nota del evento \`ask-resolved\`. |

\`\`\`rust
// propuesta para puente/http.rs
use subtle::ConstantTimeEq;
let ok = token.as_bytes().ct_eq(expected.as_bytes()).into();
\`\`\`

He preparado el arreglo del primero. Necesito permiso para hacer el commit.`;

export const PRACTICA_ANSWER = `Las sombras ya no tienen *acné*: el sesgo depende ahora de la pendiente de la superficie.

\`\`\`glsl
float bias = max(0.005 * (1.0 - dot(normal, lightDir)), 0.0005);
float shadow = currentDepth - bias > closestDepth ? 1.0 : 0.0;
\`\`\`

- PCF de 3×3 para suavizar los bordes.
- \`GL_CLAMP_TO_BORDER\` con borde blanco para que fuera del frustum no haya sombra.`;

export function replyFor(prompt: string): string {
  const short = prompt.length > 80 ? `${prompt.slice(0, 77)}…` : prompt;
  return `Recibido: «${short}».

### Plan

1. Leo los ficheros implicados y localizo el punto exacto.
2. Aplico el cambio mínimo y ejecuto los tests del módulo.
3. Te enseño el resultado antes de hacer commit.

\`\`\`bash
npm test -- --run sesiones
\`\`\`

> Los tests pasan (**31/31**). Para cerrar necesito tu permiso para el commit.`;
}

const USAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<rect width="640" height="360" fill="#0d1013"/>
<rect x="36" y="40" width="568" height="280" rx="10" fill="#161b20" stroke="#2a333a"/>
<text x="60" y="78" fill="#c8875e" font-family="monospace" font-size="18" letter-spacing="3">USO DEL PLAN</text>
<text x="60" y="128" fill="#8b979f" font-family="monospace" font-size="15">5 h</text>
<rect x="110" y="114" width="380" height="18" fill="#2a333a"/><rect x="110" y="114" width="150" height="18" fill="#7fae8f"/>
<text x="60" y="188" fill="#8b979f" font-family="monospace" font-size="15">sem</text>
<rect x="110" y="174" width="380" height="18" fill="#2a333a"/><rect x="110" y="174" width="290" height="18" fill="#d4a35a"/>
<text x="60" y="248" fill="#8b979f" font-family="monospace" font-size="15">opus</text>
<rect x="110" y="234" width="380" height="18" fill="#2a333a"/><rect x="110" y="234" width="470" height="18" fill="#d0605e"/>
<ellipse cx="560" cy="243" rx="50" ry="34" fill="none" stroke="#d0605e" stroke-width="4"/>
<text x="60" y="296" fill="#5d686f" font-family="monospace" font-size="13">ritmo: 7,1 %/día · reset lun 09:00 · el texto se sale del panel →</text>
</svg>`;

export const USAGE_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(USAGE_SVG)}`;
