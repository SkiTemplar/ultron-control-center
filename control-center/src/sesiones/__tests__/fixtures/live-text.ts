// Respuesta sintética de unos 10 KB para medir el texto en vivo: párrafos,
// listas, código, tablas y citas, como una respuesta larga de Claude.

const SECTION = (i: number) => `## Sección ${i}

Este es el párrafo ${i} de la respuesta en vivo, con **negrita**, \`código en línea\` y una ruta \`src/sesiones/stream.ts:${i}\`. Sigue un poco más de texto para que el párrafo tenga un tamaño realista.

- primer punto de la lista ${i}
- segundo punto con *cursiva*
- tercer punto ✓

\`\`\`ts
export function ejemplo${i}(x: number): number {
  return x * ${i};
}
\`\`\`

| Columna | Valor |
| --- | --- |
| a${i} | ${i * 3} |
| b${i} | ${i * 7} |

> Una cita breve número ${i}.

`;

/** Texto de unos `kb` KB hecho de secciones completas. */
export function liveText(kb = 10): string {
  let out = "";
  for (let i = 1; out.length < kb * 1024; i += 1) out += SECTION(i);
  return out;
}

/** Deltas de `size` caracteres que suman el texto completo (el puente emite unos 40-80 por cada 80 ms). */
export function deltas(text: string, size = 60): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
