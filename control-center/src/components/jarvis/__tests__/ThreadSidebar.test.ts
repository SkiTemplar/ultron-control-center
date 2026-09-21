import { describe, expect, it } from "vitest";
import { agrupar, filtrar, type ThreadMeta } from "../ThreadSidebar";

const AHORA = new Date("2026-09-18T12:00:00Z");

function hilo(p: Partial<ThreadMeta> & { id: string }): ThreadMeta {
  return {
    title: p.id,
    folder: "",
    created: "2026-09-18T09:00:00Z",
    updated: "2026-09-18T09:00:00Z",
    pinned: false,
    closed: false,
    turns: 2,
    ...p,
  };
}

describe("agrupar", () => {
  it("pone las fijadas primero, luego carpetas y al final fechas", () => {
    const grupos = agrupar(
      [
        hilo({ id: "suelta-hoy" }),
        hilo({ id: "fijada", pinned: true, updated: "2026-01-01T09:00:00Z" }),
        hilo({ id: "en-carpeta", folder: "trabajo" }),
      ],
      AHORA,
    );
    expect(grupos.map((g) => g.titulo)).toEqual(["fijadas", "📁 trabajo", "hoy"]);
    expect(grupos[0].hilos.map((h) => h.id)).toEqual(["fijada"]);
  });

  it("no repite una conversación en dos grupos", () => {
    // Una fijada DENTRO de una carpeta sale solo en "fijadas": verla dos
    // veces haría imposible saber cuántas conversaciones hay.
    const grupos = agrupar([hilo({ id: "a", pinned: true, folder: "trabajo" })], AHORA);
    const total = grupos.reduce((n, g) => n + g.hilos.length, 0);
    expect(total).toBe(1);
    expect(grupos.map((g) => g.titulo)).toEqual(["fijadas"]);
  });

  it("separa por día de calendario", () => {
    // Las horas van a mediodía UTC a propósito: `bucketFor` corta por el día
    // LOCAL, y una marca a las 23:50 UTC cae en el día siguiente en España.
    const grupos = agrupar(
      [
        hilo({ id: "hoy", updated: "2026-09-18T11:00:00Z" }),
        hilo({ id: "ayer", updated: "2026-09-17T11:00:00Z" }),
        hilo({ id: "viejo", updated: "2025-03-01T10:00:00Z" }),
      ],
      AHORA,
    );
    expect(grupos.map((g) => g.titulo)).toEqual(["hoy", "ayer", "más antiguo"]);
  });

  it("sin conversaciones no inventa grupos vacíos", () => {
    // Caso negativo: cabeceras sin filas debajo ensucian la lista.
    expect(agrupar([], AHORA)).toEqual([]);
  });
});

describe("filtrar", () => {
  const lista = [
    hilo({ id: "a", title: "router y dns" }),
    hilo({ id: "b", title: "memoria", folder: "trabajo" }),
  ];

  it("busca en el título y en la carpeta", () => {
    expect(filtrar(lista, "dns").map((h) => h.id)).toEqual(["a"]);
    expect(filtrar(lista, "TRABAJO").map((h) => h.id)).toEqual(["b"]);
    expect(filtrar(lista, "  ").map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("devuelve vacío cuando no hay coincidencia", () => {
    expect(filtrar(lista, "supabase")).toEqual([]);
  });
});

describe("agrupar — la conversación nueva sale arriba", () => {
  const hilo = (id: string, updated: string, folder = "") =>
    ({
      id,
      title: id,
      folder,
      created: updated,
      updated,
      pinned: false,
      closed: false,
      turns: 1,
    }) as ThreadMeta;

  it("una conversación nueva sin carpeta va antes que una carpeta vieja", () => {
    // El fallo reportado el 2026-09-21: los grupos de carpeta se pintaban
    // siempre antes que los de fecha, así que la recién creada (sin carpeta)
    // caía debajo de todas las carpetas.
    const grupos = agrupar(
      [
        hilo("nueva", "2026-09-21T12:00:00Z"),
        hilo("vieja-en-carpeta", "2026-01-05T09:00:00Z", "proyecto"),
      ],
      new Date("2026-09-21T12:05:00Z"),
    );
    expect(grupos[0].hilos.map((h) => h.id)).toEqual(["nueva"]);
  });

  it("si la carpeta tiene lo más reciente, la carpeta va primera", () => {
    // Caso negativo: no es "fecha antes que carpeta", es "lo más reciente
    // primero". Invertir la regla a ciegas rompería este caso.
    const grupos = agrupar(
      [
        hilo("antiguo", "2026-02-01T10:00:00Z"),
        hilo("recien-en-carpeta", "2026-09-21T12:00:00Z", "proyecto"),
      ],
      new Date("2026-09-21T12:05:00Z"),
    );
    expect(grupos[0].titulo).toContain("proyecto");
  });

  it("las fijadas siguen mandando sobre la recencia", () => {
    const fijada = { ...hilo("fijada", "2026-01-01T00:00:00Z"), pinned: true };
    const grupos = agrupar(
      [fijada, hilo("nueva", "2026-09-21T12:00:00Z")],
      new Date("2026-09-21T12:05:00Z"),
    );
    expect(grupos[0].titulo).toBe("fijadas");
  });
});
