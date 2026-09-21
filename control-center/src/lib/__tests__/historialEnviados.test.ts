import { describe, expect, it } from "vitest";
import {
  anadir,
  cargar,
  guardar,
  inicio,
  MAX_HISTORIAL,
  navegar,
} from "../historialEnviados";

// El historial va del MÁS RECIENTE al más antiguo, que es el orden en el que
// lo recorre la flecha arriba.
const H = ["tercero", "segundo", "primero"];

describe("navegar", () => {
  it("la primera flecha arriba trae el último enviado", () => {
    const n = navegar(inicio(), H, 1, "lo que estoy escribiendo");
    expect(n.texto).toBe("tercero");
    expect(n.indice).toBe(0);
  });

  it("subir varias veces recorre hacia atrás sin saltarse ninguno", () => {
    // El off-by-one clásico: saltarse el primero o repetirlo.
    let n = inicio();
    const vistos: string[] = [];
    for (let i = 0; i < 3; i++) {
      n = navegar(n, H, 1, "");
      vistos.push(n.texto);
    }
    expect(vistos).toEqual(["tercero", "segundo", "primero"]);
  });

  it("en el más antiguo, seguir subiendo no da la vuelta", () => {
    // Dar la vuelta parecería que se ha borrado el historial.
    let n = inicio();
    for (let i = 0; i < 6; i++) n = navegar(n, H, 1, "");
    expect(n.texto).toBe("primero");
    expect(n.indice).toBe(H.length - 1);
  });

  it("bajar del todo devuelve el borrador intacto", () => {
    const borrador = "esto lo estaba escribiendo";
    let n = navegar(inicio(), H, 1, borrador);
    n = navegar(n, H, 1, "");
    n = navegar(n, H, -1, "");
    n = navegar(n, H, -1, "");
    expect(n.indice).toBe(-1);
    expect(n.texto).toBe(borrador);
  });

  it("sin historial no hace nada", () => {
    const antes = inicio("hola");
    expect(navegar(antes, [], 1, "hola")).toBe(antes);
  });
});

describe("anadir", () => {
  it("el último enviado queda el primero", () => {
    expect(anadir(["a"], "b")).toEqual(["b", "a"]);
  });

  it("repetir un mensaje no lo duplica, lo sube", () => {
    // Caso negativo: mandar "sí" cinco veces no puede dejar cinco pulsaciones
    // de flecha arriba para llegar al mensaje anterior.
    let h: string[] = [];
    for (let i = 0; i < 5; i++) h = anadir(h, "sí");
    expect(h).toEqual(["sí"]);
    expect(anadir(["a", "b", "a"], "a")).toEqual(["a", "b"]);
  });

  it("lo vacío no se guarda", () => {
    expect(anadir(["a"], "   ")).toEqual(["a"]);
    expect(anadir(["a"], "")).toEqual(["a"]);
  });

  it("no crece sin fin", () => {
    let h: string[] = [];
    for (let i = 0; i < MAX_HISTORIAL + 30; i++) h = anadir(h, `m${i}`);
    expect(h.length).toBe(MAX_HISTORIAL);
    expect(h[0]).toBe(`m${MAX_HISTORIAL + 29}`);
  });
});

describe("persistencia", () => {
  function almacenFalso(): Storage {
    const datos = new Map<string, string>();
    return {
      getItem: (k: string) => datos.get(k) ?? null,
      setItem: (k: string, v: string) => void datos.set(k, v),
      removeItem: (k: string) => void datos.delete(k),
      clear: () => datos.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
  }

  it("guarda y recupera", () => {
    const a = almacenFalso();
    guardar(a, "chat", ["uno", "dos"]);
    expect(cargar(a, "chat")).toEqual(["uno", "dos"]);
  });

  it("cada caja tiene su historial", () => {
    const a = almacenFalso();
    guardar(a, "chat", ["del chat"]);
    expect(cargar(a, "orbe")).toEqual([]);
  });

  it("sin almacenamiento no revienta", () => {
    // Modo privado o almacenamiento bloqueado: el historial es una comodidad,
    // no puede tumbar la pantalla.
    expect(cargar(null, "chat")).toEqual([]);
    expect(() => guardar(null, "chat", ["a"])).not.toThrow();
  });

  it("basura guardada no rompe la carga", () => {
    const a = almacenFalso();
    a.setItem("maria.historial.chat", "{no es json");
    expect(cargar(a, "chat")).toEqual([]);
    a.setItem("maria.historial.chat", '{"no":"una lista"}');
    expect(cargar(a, "chat")).toEqual([]);
  });
});
