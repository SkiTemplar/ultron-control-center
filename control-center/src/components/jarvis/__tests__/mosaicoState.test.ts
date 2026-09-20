import { describe, expect, it } from "vitest";
import {
  anadir,
  cargar,
  disposicionPorDefecto,
  fijarColumnas,
  fijarRef,
  guardar,
  MAX_PANELES,
  mover,
  quitar,
  sincronizar,
  type Disposicion,
} from "../mosaicoState";

function disp(...keys: string[]): Disposicion {
  return {
    columnas: 2,
    paneles: keys.map((key) => ({ key, tipo: "chat" as const, ref: "" })),
  };
}

describe("mover", () => {
  it("desplaza el panel a la posición de destino", () => {
    const d = mover(disp("a", "b", "c"), "a", "c");
    expect(d.paneles.map((p) => p.key)).toEqual(["b", "c", "a"]);
  });

  it("mueve hacia atrás sin perder ninguno", () => {
    const d = mover(disp("a", "b", "c"), "c", "a");
    expect(d.paneles.map((p) => p.key)).toEqual(["c", "a", "b"]);
  });

  it("es un movimiento, no un intercambio", () => {
    // Con un intercambio esto daría ["c","b","a"]: arrastrar el primero al
    // final mandaría el último al principio sin que nadie lo pidiera.
    const d = mover(disp("a", "b", "c", "d"), "a", "d");
    expect(d.paneles.map((p) => p.key)).toEqual(["b", "c", "d", "a"]);
  });

  it("no hace nada con claves que no existen o iguales", () => {
    const original = disp("a", "b");
    expect(mover(original, "a", "a")).toBe(original);
    expect(mover(original, "z", "a").paneles.map((p) => p.key)).toEqual(["a", "b"]);
    expect(mover(original, "a", "z").paneles.map((p) => p.key)).toEqual(["a", "b"]);
  });
});

describe("anadir / quitar / fijarRef", () => {
  it("añade con clave nueva y no repite", () => {
    const d = anadir(anadir(disp(), "chat"), "terminal");
    const claves = d.paneles.map((p) => p.key);
    expect(new Set(claves).size).toBe(claves.length);
    expect(d.paneles[d.paneles.length - 1].tipo).toBe("terminal");
  });

  it("no pasa del máximo de paneles", () => {
    // Caso negativo: más de seis paneles en una pantalla no se leen.
    let d = disp();
    for (let i = 0; i < MAX_PANELES + 3; i++) d = anadir(d, "chat");
    expect(d.paneles).toHaveLength(MAX_PANELES);
  });

  it("quita por clave y deja el resto intacto", () => {
    const d = quitar(disp("a", "b", "c"), "b");
    expect(d.paneles.map((p) => p.key)).toEqual(["a", "c"]);
  });

  it("guarda la referencia solo en el panel indicado", () => {
    const d = fijarRef(disp("a", "b"), "b", "hilo-1");
    expect(d.paneles.map((p) => p.ref)).toEqual(["", "hilo-1"]);
  });
});

describe("fijarColumnas", () => {
  it("respeta los límites", () => {
    expect(fijarColumnas(disp(), 3).columnas).toBe(3);
    expect(fijarColumnas(disp(), 99).columnas).toBe(3);
    expect(fijarColumnas(disp(), 0).columnas).toBe(1);
    expect(fijarColumnas(disp(), -5).columnas).toBe(1);
  });
});

describe("cargar / guardar", () => {
  function almacenFalso(valor: string | null) {
    const datos = new Map<string, string>();
    if (valor !== null) datos.set("maria.mosaico.v1", valor);
    return {
      getItem: (k: string) => datos.get(k) ?? null,
      setItem: (k: string, v: string) => void datos.set(k, v),
    };
  }

  it("va y vuelve", () => {
    const a = almacenFalso(null);
    const original = anadir(disposicionPorDefecto(), "terminal");
    guardar(a, original);
    expect(cargar(a).paneles.map((p) => p.tipo)).toEqual(
      original.paneles.map((p) => p.tipo),
    );
  });

  it("un almacén corrupto no deja la pestaña en blanco", () => {
    // Caso negativo: JSON roto, lista vacía y tipos inventados caen a la
    // disposición por defecto en vez de reventar el render.
    for (const malo of ["{{{", "[]", '{"paneles":[]}', '{"paneles":[{"tipo":"virus"}]}']) {
      const d = cargar(almacenFalso(malo));
      expect(d.paneles.length).toBeGreaterThan(0);
    }
    expect(cargar(null).paneles.length).toBeGreaterThan(0);
  });

  it("sin almacenamiento, guardar no lanza", () => {
    expect(() => guardar(null, disposicionPorDefecto())).not.toThrow();
  });
});

describe("sincronizar", () => {
  const vacio: Disposicion = { columnas: 2, paneles: [] };

  it("mete una terminal por cada sesion abierta", () => {
    const d = sincronizar(vacio, "terminal", ["t1", "t2"]);
    expect(d.paneles.map((p) => p.ref)).toEqual(["t1", "t2"]);
    expect(d.paneles.every((p) => p.tipo === "terminal")).toBe(true);
  });

  it("aprovecha los paneles vacios del tipo antes de crear otros", () => {
    // La disposicion de fabrica trae un chat y una terminal sin asignar: la
    // terminal abierta tiene que caer ahi, no en un panel nuevo.
    const d = sincronizar(disposicionPorDefecto(), "terminal", ["t1"]);
    expect(d.paneles).toHaveLength(2);
    expect(d.paneles.find((p) => p.tipo === "terminal")?.ref).toBe("t1");
  });

  it("no duplica lo que ya esta puesto", () => {
    const una = sincronizar(vacio, "terminal", ["t1"]);
    const otra = sincronizar(una, "terminal", ["t1"]);
    expect(otra.paneles).toHaveLength(1);
  });

  it("no pasa del tope de paneles", () => {
    const muchas = Array.from({ length: MAX_PANELES + 4 }, (_, i) => `t${i}`);
    const d = sincronizar(vacio, "terminal", muchas);
    expect(d.paneles.length).toBe(MAX_PANELES);
  });

  it("no toca la disposicion de entrada", () => {
    // Caso negativo: si mutara, React no veria el cambio y el mosaico se
    // quedaria igual en pantalla aunque el estado fuese otro.
    const antes = disposicionPorDefecto();
    const copia = JSON.stringify(antes);
    sincronizar(antes, "terminal", ["t1"]);
    expect(JSON.stringify(antes)).toBe(copia);
  });

  it("sin nada abierto se queda como estaba", () => {
    const antes = disposicionPorDefecto();
    expect(sincronizar(antes, "terminal", [])).toBe(antes);
  });
});
