import { describe, expect, it } from "vitest";
import { splitLinks } from "../bubble";

describe("splitLinks", () => {
  it("deja el texto sin enlaces tal cual", () => {
    expect(splitLinks("hola, ¿qué tal?")).toEqual([{ text: "hola, ¿qué tal?" }]);
  });

  it("separa enlaces y les quita la puntuación final de la frase", () => {
    const parts = splitLinks("Mira https://example.com/a?b=1. Y escribe a mailto:x@y.z!");
    expect(parts).toEqual([
      { text: "Mira " },
      { text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { text: ". Y escribe a " },
      { text: "mailto:x@y.z", href: "mailto:x@y.z" },
      { text: "!" },
    ]);
  });

  it("no convierte rutas locales ni esquemas raros en enlaces", () => {
    const parts = splitLinks("abre C:\\Users\\x o file:///C:/x o javascript:alert(1)");
    expect(parts.every((p) => !p.href)).toBe(true);
  });

  it("enlace entre paréntesis", () => {
    const parts = splitLinks("(https://a.b/c)");
    expect(parts.find((p) => p.href)?.href).toBe("https://a.b/c");
  });
});

describe("splitLinks con ficheros locales", () => {
  const fileLinks = (text: string) => splitLinks(text).filter((p) => p.kind === "file");

  it("detecta una ruta de imagen y le quita la puntuación final", () => {
    expect(splitLinks("Guardada en C:\\Users\\x\\foto.png.")).toEqual([
      { text: "Guardada en " },
      { text: "C:\\Users\\x\\foto.png", href: "C:\\Users\\x\\foto.png", kind: "file" },
      { text: "." },
    ]);
  });

  it("acepta barras normales y extensión en mayúsculas", () => {
    expect(fileLinks("vídeo: C:/x/y.MP4, audio D:\\m\\a.flac")).toEqual([
      { text: "C:/x/y.MP4", href: "C:/x/y.MP4", kind: "file" },
      { text: "D:\\m\\a.flac", href: "D:\\m\\a.flac", kind: "file" },
    ]);
  });

  it("no enlaza ejecutables, scripts ni accesos directos", () => {
    const text = "C:\\x\\setup.exe C:\\x\\a.bat C:\\x\\b.ps1 C:\\x\\c.lnk C:\\x\\d.js C:\\x\\e.msi";
    expect(splitLinks(text).every((p) => !p.href)).toBe(true);
  });

  it("no enlaza texto plano ni rutas sin extensión", () => {
    expect(splitLinks("lee C:\\x\\notas.txt y C:\\x\\README").every((p) => !p.href)).toBe(true);
  });

  it("ruta con espacios entre comillas o backticks; las comillas quedan como texto", () => {
    expect(splitLinks('abre "C:\\Mis fotos\\playa 1.jpg" ya')).toEqual([
      { text: 'abre "' },
      { text: "C:\\Mis fotos\\playa 1.jpg", href: "C:\\Mis fotos\\playa 1.jpg", kind: "file" },
      { text: '" ya' },
    ]);
    expect(fileLinks("en `C:\\Mis docs\\informe final.pdf`")[0]?.href).toBe("C:\\Mis docs\\informe final.pdf");
    expect(fileLinks("en “C:\\A B\\c.docx”")[0]?.href).toBe("C:\\A B\\c.docx");
  });

  it("sin comillas, la ruta acaba en el primer espacio", () => {
    expect(fileLinks("C:\\Mis fotos\\playa.jpg")).toEqual([]);
    expect(fileLinks("C:\\fotos\\playa.jpg y más")[0]?.href).toBe("C:\\fotos\\playa.jpg");
  });

  it("detecta URLs file:///", () => {
    expect(fileLinks("ver file:///C:/Users/x/doc%20final.pdf)")).toEqual([
      { text: "file:///C:/Users/x/doc%20final.pdf", href: "file:///C:/Users/x/doc%20final.pdf", kind: "file" },
    ]);
  });

  it("mezcla web y ficheros, y los web siguen sin kind", () => {
    const parts = splitLinks("https://a.b/c.png y C:\\a\\c.png");
    expect(parts.filter((p) => p.href)).toEqual([
      { text: "https://a.b/c.png", href: "https://a.b/c.png" },
      { text: "C:\\a\\c.png", href: "C:\\a\\c.png", kind: "file" },
    ]);
  });

  it("no toma una letra pegada a una palabra como unidad", () => {
    expect(fileLinks("abc:\\x\\a.png")).toEqual([]);
  });
});
