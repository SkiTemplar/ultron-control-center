import { describe, expect, it } from "vitest";
import {
  desde,
  estadoPantalla,
  filtrarHits,
  segundosHastaReinicio,
} from "../destacados-helpers";
import type { RepoHit, RespuestaBusqueda } from "../../../types";

function hit(parcial: Partial<RepoHit>): RepoHit {
  return {
    full_name: "a/b",
    owner: "a",
    name: "b",
    description: null,
    stars: 0,
    language: null,
    html_url: null,
    updated_at: null,
    topics: [],
    created_at: null,
    pushed_at: null,
    license: null,
    stars_per_day: null,
    ...parcial,
  };
}

function respuesta(parcial: Partial<RespuestaBusqueda>): RespuestaBusqueda {
  return {
    fuente: "skills",
    hits: [],
    consulta: "topic:agent-skills",
    parcial: false,
    avisos: [],
    cuota: {
      recurso: "search",
      limite: 10,
      restantes: 7,
      reinicio_epoch: null,
      con_token: false,
      agotada: false,
    },
    desde_cache: false,
    ...parcial,
  };
}

describe("filtrarHits", () => {
  const lista = [
    hit({ full_name: "anthropics/skills", name: "skills", stars: 1000, topics: ["agent-skills"] }),
    hit({ full_name: "otro/mcp-cosas", name: "mcp-cosas", stars: 5, topics: ["mcp-server"] }),
  ];

  it("filtra por texto en nombre, owner, descripcion y topics", () => {
    expect(filtrarHits(lista, "anthropics", { minStars: 0, topics: [] })).toHaveLength(1);
    expect(filtrarHits(lista, "mcp-server", { minStars: 0, topics: [] })).toHaveLength(1);
  });

  it("filtra por minimo de estrellas", () => {
    expect(filtrarHits(lista, "", { minStars: 100, topics: [] })).toHaveLength(1);
  });

  it("filtra por topic", () => {
    const r = filtrarHits(lista, "", { minStars: 0, topics: ["mcp-server"] });
    expect(r.map((h) => h.name)).toEqual(["mcp-cosas"]);
  });

  it("sin filtros no quita nada", () => {
    // Caso negativo: un filtro que recorta cuando no debe deja la pantalla
    // vacia sin motivo, que es el sintoma que se quiere evitar.
    expect(filtrarHits(lista, "", { minStars: 0, topics: [] })).toHaveLength(2);
  });
});

describe("estadoPantalla", () => {
  it("un fallo de red tapa a todo lo demas", () => {
    const e = estadoPantalla({
      cargando: false,
      error: "no hay conexion",
      resp: respuesta({ cuota: { ...respuesta({}).cuota, agotada: true } }),
      visibles: 0,
    });
    expect(e).toBe("error");
  });

  it("la cuota agotada NO se ensena como 'sin resultados'", () => {
    const e = estadoPantalla({
      cargando: false,
      error: null,
      resp: respuesta({
        hits: [],
        cuota: { ...respuesta({}).cuota, agotada: true, restantes: 0 },
      }),
      visibles: 0,
    });
    expect(e).toBe("cuota");
  });

  it("con cuota agotada pero datos de cache se ensena la lista", () => {
    const h = [hit({})];
    const e = estadoPantalla({
      cargando: false,
      error: null,
      resp: respuesta({
        hits: h,
        desde_cache: true,
        cuota: { ...respuesta({}).cuota, agotada: true, restantes: 0 },
      }),
      visibles: 1,
    });
    expect(e).toBe("lista");
  });

  it("distingue 'sin resultados' de 'los filtros se lo comieron'", () => {
    expect(
      estadoPantalla({ cargando: false, error: null, resp: respuesta({ hits: [] }), visibles: 0 }),
    ).toBe("vacio");
    expect(
      estadoPantalla({
        cargando: false,
        error: null,
        resp: respuesta({ hits: [hit({})] }),
        visibles: 0,
      }),
    ).toBe("vacio-por-filtros");
  });

  it("cargando sin nada en pantalla es 'cargando'", () => {
    expect(
      estadoPantalla({ cargando: true, error: null, resp: null, visibles: 0 }),
    ).toBe("cargando");
  });
});

describe("desde / segundosHastaReinicio", () => {
  const ahora = Date.parse("2026-09-22T12:00:00Z");

  it("traduce fechas a lenguaje corto", () => {
    expect(desde("2026-09-22T09:00:00Z", ahora)).toBe("hoy");
    expect(desde("2026-09-21T09:00:00Z", ahora)).toBe("ayer");
    expect(desde("2026-09-12T12:00:00Z", ahora)).toBe("hace 10 d");
    expect(desde("2025-09-22T12:00:00Z", ahora)).toBe("hace 12 m");
  });

  it("no inventa una fecha cuando no la hay o esta rota", () => {
    expect(desde(null, ahora)).toBeNull();
    expect(desde("no-es-una-fecha", ahora)).toBeNull();
  });

  it("la espera de cuota nunca es negativa", () => {
    expect(segundosHastaReinicio(ahora / 1000 + 45, ahora)).toBe(45);
    expect(segundosHastaReinicio(ahora / 1000 - 45, ahora)).toBe(0);
    expect(segundosHastaReinicio(null, ahora)).toBeNull();
  });
});
