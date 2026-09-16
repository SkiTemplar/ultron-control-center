import { describe, expect, it } from "vitest";
import {
  buildFimPrompt,
  buildGenerateRequest,
  firstLoadedModelName,
  formatLogTime,
  formatStatusBarLabel,
  formatSuggestionLogLine,
  sanitizeCompletion,
  trimPrefixContext,
  trimSuffixContext,
  truncateForLog,
} from "../src/logic";

describe("buildFimPrompt", () => {
  it("intercala los marcadores FIM alrededor de prefijo y sufijo", () => {
    const prompt = buildFimPrompt("int main() {\n  ", "\n}\n");
    expect(prompt).toBe("<|fim_prefix|>int main() {\n  <|fim_suffix|>\n}\n<|fim_middle|>");
  });
});

describe("trimPrefixContext", () => {
  it("no toca el texto si cabe dentro del limite", () => {
    expect(trimPrefixContext("abc", 10)).toBe("abc");
  });

  it("corta en el limite de linea mas cercano cuando el prefijo excede el limite", () => {
    const prefix = "linea1\nlinea2\nlinea3";
    // limite de 8 cae a mitad de "linea2\nlinea3" (13 chars) -> debe cortar a la siguiente linea completa
    const result = trimPrefixContext(prefix, 8);
    expect(result).toBe("linea3");
    expect(prefix.endsWith(result)).toBe(true);
  });

  it("devuelve el recorte crudo si ni una linea completa cabe en el limite", () => {
    const prefix = "unalineamuylarga";
    const result = trimPrefixContext(prefix, 5);
    expect(result).toBe("larga");
  });

  it("con maxChars <= 0 devuelve cadena vacia", () => {
    expect(trimPrefixContext("algo", 0)).toBe("");
  });
});

describe("trimSuffixContext", () => {
  it("no toca el texto si cabe dentro del limite", () => {
    expect(trimSuffixContext("abc", 10)).toBe("abc");
  });

  it("corta en el limite de linea mas cercano conservando el inicio", () => {
    const suffix = "linea1\nlinea2\nlinea3";
    const result = trimSuffixContext(suffix, 8);
    expect(result).toBe("linea1");
    expect(suffix.startsWith(result)).toBe(true);
  });
});

describe("buildGenerateRequest", () => {
  it("aplica el recorte de ventana antes de construir el prompt", () => {
    const req = buildGenerateRequest({
      model: "qwen2.5-coder:1.5b-base",
      prefix: "a".repeat(20),
      suffix: "b".repeat(20),
      maxPrefixChars: 5,
      maxSuffixChars: 5,
    });
    expect(req.model).toBe("qwen2.5-coder:1.5b-base");
    expect(req.raw).toBe(true);
    expect(req.stream).toBe(false);
    expect(req.options.stop).toEqual(["\n"]);
    expect(req.options.temperature).toBe(0);
    // Sin saltos de linea en el texto de prueba: no hay limite de linea
    // donde cortar, asi que se queda el recorte crudo al tamano pedido.
    expect(req.prompt).toContain("a".repeat(5));
    expect(req.prompt).toContain("b".repeat(5));
  });

  it("usa 48 como num_predict por defecto", () => {
    const req = buildGenerateRequest({
      model: "m",
      prefix: "",
      suffix: "",
      maxPrefixChars: 100,
      maxSuffixChars: 100,
    });
    expect(req.options.num_predict).toBe(48);
  });
});

describe("sanitizeCompletion", () => {
  it("devuelve null si la respuesta esta vacia", () => {
    expect(sanitizeCompletion("", "")).toBeNull();
    expect(sanitizeCompletion(null, "")).toBeNull();
    expect(sanitizeCompletion(undefined, "")).toBeNull();
  });

  it("devuelve null si la respuesta es solo espacios", () => {
    expect(sanitizeCompletion("   ", "")).toBeNull();
    expect(sanitizeCompletion("\t \n resto", "")).toBeNull();
  });

  it("devuelve la primera linea cuando hay contenido util", () => {
    expect(sanitizeCompletion("return 0;", "")).toBe("return 0;");
  });

  it("corta en el primer salto de linea si el stop token no actuo", () => {
    expect(sanitizeCompletion("return 0;\nint otra() {}", "")).toBe("return 0;");
  });

  it("devuelve null si la respuesta repite integramente el texto tras el cursor", () => {
    expect(sanitizeCompletion(");", ");\n")).toBeNull();
  });

  it("recorta el solape cuando la respuesta repite solo el final del texto tras el cursor", () => {
    // el texto tras el cursor ya es ");" y el modelo propone "foo(x);":
    // solo "foo(x" es contenido nuevo, el resto duplica lo que ya hay.
    expect(sanitizeCompletion("foo(x);", ");")).toBe("foo(x");
  });

  it("no toca la respuesta si no hay solape con el texto tras el cursor", () => {
    expect(sanitizeCompletion("printf(\"hi\")", ";")).toBe("printf(\"hi\")");
  });
});

describe("firstLoadedModelName", () => {
  it("lee el nombre del primer modelo cargado (campo name)", () => {
    const body = JSON.stringify({ models: [{ name: "qwen2.5-coder:1.5b-base" }] });
    expect(firstLoadedModelName(body)).toBe("qwen2.5-coder:1.5b-base");
  });

  it("cae al campo model si no hay name", () => {
    const body = JSON.stringify({ models: [{ model: "qwen2.5-coder:7b" }] });
    expect(firstLoadedModelName(body)).toBe("qwen2.5-coder:7b");
  });

  it("devuelve null con lista vacia (ningun modelo cargado)", () => {
    expect(firstLoadedModelName(JSON.stringify({ models: [] }))).toBeNull();
  });

  it("devuelve null sin el campo models", () => {
    expect(firstLoadedModelName("{}")).toBeNull();
  });

  it("devuelve null con JSON invalido en vez de lanzar", () => {
    expect(firstLoadedModelName("esto no es JSON")).toBeNull();
  });
});

describe("formatStatusBarLabel", () => {
  it("incluye el modelo y el contador cuando hay modelo", () => {
    expect(formatStatusBarLabel({ model: "qwen2.5-coder:1.5b-base", suggestionCount: 12 })).toBe(
      "Ollama Tab · qwen2.5-coder:1.5b-base · 12",
    );
  });

  it("omite el separador de modelo cuando aun no se conoce", () => {
    expect(formatStatusBarLabel({ model: null, suggestionCount: 0 })).toBe("Ollama Tab · 0");
  });
});

describe("truncateForLog", () => {
  it("no toca el texto si cabe dentro del limite", () => {
    expect(truncateForLog("return 0;")).toBe("return 0;");
  });

  it("corta a 60 caracteres por defecto y anade elipsis", () => {
    const long = "a".repeat(80);
    const result = truncateForLog(long);
    expect(result).toBe(`${"a".repeat(60)}…`);
    expect(result.length).toBe(61);
  });

  it("acepta un limite personalizado", () => {
    expect(truncateForLog("abcdefgh", 4)).toBe("abcd…");
  });
});

describe("formatLogTime", () => {
  it("formatea hora, minuto y segundo con ceros a la izquierda", () => {
    expect(formatLogTime(new Date(2026, 0, 1, 9, 5, 3))).toBe("09:05:03");
  });
});

describe("formatSuggestionLogLine", () => {
  it("combina hora, lenguaje, latencia y sugerencia truncada", () => {
    const line = formatSuggestionLogLine({
      date: new Date(2026, 0, 1, 14, 30, 0),
      languageId: "typescript",
      elapsedMs: 123,
      suggestion: "return total;",
    });
    expect(line).toBe("[14:30:00] typescript 123ms: return total;");
  });

  it("trunca la sugerencia larga en vez de volcarla entera", () => {
    const long = "x".repeat(100);
    const line = formatSuggestionLogLine({
      date: new Date(2026, 0, 1, 0, 0, 0),
      languageId: "python",
      elapsedMs: 5,
      suggestion: long,
    });
    expect(line).toBe(`[00:00:00] python 5ms: ${"x".repeat(60)}…`);
  });

  it("nunca incluye el prefijo del fichero — solo lo que se le pasa como sugerencia", () => {
    const line = formatSuggestionLogLine({
      date: new Date(2026, 0, 1, 0, 0, 0),
      languageId: "rust",
      elapsedMs: 1,
      suggestion: "ok",
    });
    expect(line).not.toContain("fim_prefix");
  });
});
