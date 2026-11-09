// Plantillas de encargo de Motores: rellenan el prompt para no reescribirlo
// cada vez. Las que acaban en «: » esperan que el usuario complete el objeto.

export interface EngineTemplate {
  id: string;
  label: string;
  description: string;
  text: string;
}

export const ENGINE_TEMPLATES: EngineTemplate[] = [
  {
    id: "diff",
    label: "Revisa el diff",
    description: "Bugs y riesgos del git diff actual",
    text: "Revisa el `git diff` actual de este repositorio: bugs, regresiones y riesgos concretos, con fichero y línea. No modifiques ficheros.",
  },
  {
    id: "bug",
    label: "Busca el bug",
    description: "Causa y arreglo mínimo, sin tocar nada",
    text: "Busca la causa de este bug y propón el arreglo mínimo con fichero y línea, sin modificar ficheros: ",
  },
  {
    id: "explica",
    label: "Explica un fichero",
    description: "Qué hace, de qué depende y qué es frágil",
    text: "Explica qué hace este fichero, de qué depende y cuáles son sus puntos frágiles: ",
  },
  {
    id: "tests",
    label: "Escribe tests",
    description: "Con el estilo del repo y un caso negativo",
    text: "Escribe tests para lo siguiente, con el estilo de los tests del repositorio y al menos un caso negativo: ",
  },
];

/** Prompt tras aplicar una plantilla: sustituye el borrador vacío o lo añade detrás. */
export function applyTemplate(draft: string, template: EngineTemplate): string {
  const actual = draft.trim();
  if (!actual) return template.text;
  return template.text.endsWith(": ") ? `${template.text}${actual}` : `${template.text}\n\n${actual}`;
}
