// Lógica pura del resumen del registro de incidentes de Sessions
// (`sesiones-incidentes.jsonl`, lo escribe control-center/src-tauri/src/sesiones/incidentes.rs).

/** Texto del aviso sin lo que cambia entre repeticiones (cifras, ids, rutas). */
export function normalizar(texto) {
  return String(texto ?? '')
    .replace(/[A-Za-z]:[\\/][^\s«»"')]+/g, '<ruta>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, '<uuid>')
    .replace(/\btoolu_[A-Za-z0-9]+/g, '<tool>')
    .replace(/\d+([.,]\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Líneas del JSONL parseadas; las corruptas se cuentan aparte. */
export function parsear(contenido) {
  const incidentes = [];
  let corruptas = 0;
  for (const linea of String(contenido).split(/\r?\n/)) {
    if (!linea.trim()) continue;
    try {
      incidentes.push(JSON.parse(linea));
    } catch {
      corruptas += 1;
    }
  }
  return { incidentes, corruptas };
}

/**
 * Grupos por (origen, texto normalizado), del más frecuente al menos, con la
 * primera y la última vez y el índice del último ejemplo.
 */
export function agrupar(incidentes) {
  const grupos = new Map();
  incidentes.forEach((inc, indice) => {
    const clave = `${inc.origen}|${normalizar(inc.texto)}`;
    const g = grupos.get(clave) ?? { origen: inc.origen, patron: normalizar(inc.texto), veces: 0, primera: inc.ts, ultima: inc.ts, ejemplo: indice };
    grupos.set(clave, { ...g, veces: g.veces + 1, ultima: inc.ts, ejemplo: indice });
  });
  return [...grupos.values()].sort((a, b) => b.veces - a.veces || String(b.ultima).localeCompare(String(a.ultima)));
}

/** Incidentes desde `desdeIso` (incluido); sin fecha, todos. */
export function filtrarDesde(incidentes, desdeIso) {
  if (!desdeIso) return incidentes;
  return incidentes.filter((i) => String(i.ts) >= desdeIso);
}
