import { describe, expect, it } from "vitest";
import {
  benchmarkBlockReason,
  engineOptions,
  headerState,
  formatExpiry,
  modelSizeLabel,
  sameModel,
  type EditorEngineStatus,
  type OllamaStatus,
} from "./ollamaEngine";

const editor = (engine: string, available = true): EditorEngineStatus => ({
  available,
  engine,
  model_low: "qwen2.5-coder:1.5b-base",
  model_mid: "qwen2.5-coder:3b-base",
  model_high: "qwen2.5-coder:7b-base",
  active_model: null,
  settings_path: null,
  keep_alive_override: null,
});

const ollama = (overrides: Partial<OllamaStatus> = {}): OllamaStatus => ({
  installed: true,
  server_up: true,
  version: "0.12.0",
  configured_model: "qwen2.5-coder:3b-base",
  configured_engine: "mid",
  loaded_models: [],
  downloaded_models: [
    { name: "qwen2.5-coder:3b-base", size: 1, family: null, parameter_size: null, quantization_level: null },
  ],
  ...overrides,
});

const loaded3b = { name: "qwen2.5-coder:3b-base", size_vram: 2_000_000_000, expires_at: null };

describe("modelSizeLabel", () => {
  it("saca el tamaño del tag", () => {
    expect(modelSizeLabel("qwen2.5-coder:1.5b-base")).toBe("1.5b");
    expect(modelSizeLabel("qwen2.5-coder:3b-base")).toBe("3b");
    expect(modelSizeLabel("qwen2.5-coder:7B")).toBe("7b");
    expect(modelSizeLabel("smollm:135m")).toBe("135m");
  });

  it("busca en el nombre base si el tag no lo trae", () => {
    expect(modelSizeLabel("phi3-3.8b:latest")).toBe("3.8b");
  });

  it("sin tamaño reconocible devuelve el tag, no un trozo numérico cualquiera", () => {
    expect(modelSizeLabel("llama3:latest")).toBe("latest");
    expect(modelSizeLabel("deepseek-coder-v2:q4_0")).toBe("q4_0");
    expect(modelSizeLabel("mistral")).toBe("mistral");
    expect(modelSizeLabel("modelo:1.2.3b")).toBe("1.2.3b");
  });
});

describe("formatExpiry", () => {
  const now = Date.parse("2026-10-05T18:32:00");

  it("muestra la hora real de descarga", () => {
    expect(formatExpiry("2026-10-05T18:37:00", now)).toBe("se descarga a las 18:37 si no se usa");
  });

  it("no promete un modelo fijo salvo con keep_alive -1 explícito", () => {
    expect(formatExpiry("2026-10-05T18:37:00", now)).not.toMatch(/fijado|sin caducidad/);
    expect(formatExpiry("2318-01-01T00:00:00Z", now)).toBe("sin caducidad (keep_alive -1)");
  });

  it("marca lo caducado y tolera valores vacíos o inválidos", () => {
    expect(formatExpiry("2026-10-05T18:00:00", now)).toBe("caducado");
    expect(formatExpiry(null, now)).toBeNull();
    expect(formatExpiry("no-es-fecha", now)).toBeNull();
  });
});

describe("sameModel", () => {
  it("trata un nombre sin tag como :latest y distingue tags distintos", () => {
    expect(sameModel("llama3", "llama3:latest")).toBe(true);
    expect(sameModel("qwen2.5-coder:3b-base", "qwen2.5-coder:7b-base")).toBe(false);
  });
});

describe("engineOptions", () => {
  it("rotula cada nivel con su tamaño real y el modelo completo en el tooltip", () => {
    const options = engineOptions(editor("mid"));
    expect(options.map((o) => o.label)).toEqual([
      "1.5b · rápido",
      "3b · equilibrado",
      "7b · potente",
      "Copilot",
      "Apagado",
    ]);
    expect(options[2].title).toBe("qwen2.5-coder:7b-base");
    expect(options.map((o) => o.engine)).toEqual(["low", "mid", "high", "copilot", "off"]);
  });
});

describe("headerState", () => {
  it("marca cargado solo si el modelo del motor está en /api/ps", () => {
    expect(headerState(ollama({ loaded_models: [loaded3b] }), editor("mid"), null, false).label).toBe(
      "cargado",
    );
    // Caso negativo: otro modelo cargado no cuenta como el del motor.
    const other = { ...loaded3b, name: "qwen2.5-coder:1.5b-base" };
    expect(headerState(ollama({ loaded_models: [other] }), editor("mid"), null, false).label).toBe(
      "no cargado",
    );
  });

  it("distingue «no descargado» de «no cargado»", () => {
    const missing = ollama({ downloaded_models: [] });
    expect(headerState(missing, editor("mid"), null, false).label).toBe("no descargado");
    expect(headerState(ollama(), editor("mid"), null, false).label).toBe("no cargado");
    expect(benchmarkBlockReason(missing, editor("mid"))).toMatch(/Descargar modelo/);
  });

  it("distingue Copilot, apagado y servidor parado", () => {
    expect(headerState(ollama(), editor("copilot"), null, false).title).toBe("Copilot");
    expect(headerState(ollama(), editor("off"), null, false).label).toBe("apagado");
    expect(headerState(ollama({ server_up: false }), editor("mid"), null, false).label).toBe(
      "servidor parado",
    );
  });
});

describe("benchmarkBlockReason", () => {
  it("permite medir con motor local y modelo cargado", () => {
    expect(benchmarkBlockReason(ollama({ loaded_models: [loaded3b] }), editor("mid"))).toBeNull();
  });

  it("lo bloquea con Copilot aunque el modelo siga cargado", () => {
    expect(benchmarkBlockReason(ollama({ loaded_models: [loaded3b] }), editor("copilot"))).toMatch(
      /motor local/,
    );
  });

  it("lo bloquea si el modelo del motor no está cargado", () => {
    expect(benchmarkBlockReason(ollama(), editor("mid"))).toMatch(
      /no está cargado/,
    );
  });
});
