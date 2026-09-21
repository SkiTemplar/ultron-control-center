// Destacados — la lógica pura de la pantalla, fuera del componente para
// poder probarla sin montar React ni tocar Tauri.
//
// 2026-09-22. Lo que se prueba aquí es lo que distinguía la pantalla vieja de
// una útil: "sin red", "cuota agotada", "sin resultados" y "los filtros se lo
// han comido todo" son CUATRO estados distintos. Antes todo caía en el mismo
// banner rojo o en el mismo "No results for this tab".

import type { RepoHit, RespuestaBusqueda } from "../../types";

export type FiltrosDestacados = {
  minStars: number;
  topics: string[];
};

/** Filtro local: no vuelve a preguntar a GitHub, así que no gasta cuota. */
export function filtrarHits(
  hits: RepoHit[],
  texto: string,
  filtros: FiltrosDestacados,
): RepoHit[] {
  const aguja = texto.trim().toLowerCase();
  return hits.filter((h) => {
    if (aguja) {
      const pajar = [
        h.name,
        h.owner,
        h.full_name,
        h.description ?? "",
        h.language ?? "",
        ...h.topics,
      ]
        .join(" ")
        .toLowerCase();
      if (!pajar.includes(aguja)) return false;
    }
    if (filtros.minStars > 0 && h.stars < filtros.minStars) return false;
    if (
      filtros.topics.length > 0 &&
      !filtros.topics.some((t) => h.topics.includes(t))
    ) {
      return false;
    }
    return true;
  });
}

export type EstadoPantalla =
  | "cargando"
  | "error"
  | "cuota"
  | "vacio"
  | "vacio-por-filtros"
  | "lista";

/**
 * Qué se enseña. El orden importa: un fallo de red tapa a la cuota, y la
 * cuota tapa al "no hay resultados" (decir "no hay nada" cuando lo que pasa
 * es que GitHub no contesta es mentirle al usuario).
 */
export function estadoPantalla(args: {
  cargando: boolean;
  error: string | null;
  resp: RespuestaBusqueda | null;
  visibles: number;
}): EstadoPantalla {
  if (args.error) return "error";
  if (args.resp?.cuota.agotada && args.resp.hits.length === 0) return "cuota";
  if (args.cargando && (args.resp?.hits.length ?? 0) === 0) return "cargando";
  if ((args.resp?.hits.length ?? 0) === 0) return "vacio";
  if (args.visibles === 0) return "vacio-por-filtros";
  return "lista";
}

/** "hace 3 d" a partir de un RFC 3339. `null` cuando no hay fecha usable. */
export function desde(iso: string | null, ahora: number = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const dias = Math.floor((ahora - t) / 86_400_000);
  if (dias <= 0) return "hoy";
  if (dias === 1) return "ayer";
  if (dias < 60) return `hace ${dias} d`;
  return `hace ${Math.floor(dias / 30)} m`;
}

/** Segundos que faltan para que la ventana de cuota se reinicie. */
export function segundosHastaReinicio(
  epoch: number | null,
  ahora: number = Date.now(),
): number | null {
  if (epoch === null) return null;
  return Math.max(0, Math.round((epoch * 1000 - ahora) / 1000));
}
