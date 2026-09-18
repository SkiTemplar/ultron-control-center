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
    hilo({ id: "b", title: "memoria", folder: "ultron" }),
  ];

  it("busca en el título y en la carpeta", () => {
    expect(filtrar(lista, "dns").map((h) => h.id)).toEqual(["a"]);
    expect(filtrar(lista, "ULTRON").map((h) => h.id)).toEqual(["b"]);
    expect(filtrar(lista, "  ").map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("devuelve vacío cuando no hay coincidencia", () => {
    expect(filtrar(lista, "supabase")).toEqual([]);
  });
});
