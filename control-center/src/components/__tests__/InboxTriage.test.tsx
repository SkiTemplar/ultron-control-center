// InboxTriage — tests de comportamiento del componente de bandeja de entrada
//
// Cubre:
//   (1) Al montar invoca list_inbox y renderiza las capturas devueltas
//   (2) Estado vacío cuando list_inbox devuelve []
//   (3) El botón Copiar copia el texto al portapapeles

import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { InboxTriage } from "../InboxTriage";

// ---------------------------------------------------------------------------
// Datos de prueba
// ---------------------------------------------------------------------------

const SAMPLE_ENTRIES = [
  { ts: "2026-05-30T14:32:11Z", text: "Idea sobre el router de IA", source: "hotkey" },
  { ts: "2026-05-30T15:00:00Z", text: "Revisar PR de memory stack", source: "cli" },
];

// ---------------------------------------------------------------------------
// Setup del clipboard mock
// ---------------------------------------------------------------------------

const mockWriteText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mockWriteText },
    writable: true,
    configurable: true,
  });
  mockWriteText.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InboxTriage", () => {
  it("(1) invoca list_inbox al montar y renderiza las capturas devueltas", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(SAMPLE_ENTRIES);

    await act(async () => {
      render(<InboxTriage />);
    });

    // Verifica que invoke fue llamado con el comando correcto
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("list_inbox", { limit: 200 });

    // Ambos textos de captura deben aparecer en el DOM
    expect(screen.getByText("Idea sobre el router de IA")).toBeTruthy();
    expect(screen.getByText("Revisar PR de memory stack")).toBeTruthy();

    // Debe mostrar el contador de capturas en la cabecera
    expect(screen.getByText(/2 capturas/i)).toBeTruthy();
  });

  it("(2) muestra estado vacío cuando list_inbox devuelve []", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);

    await act(async () => {
      render(<InboxTriage />);
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("list_inbox", { limit: 200 });

    // Debe mostrar el mensaje de bandeja vacía
    expect(screen.getByText("La bandeja está vacía.")).toBeTruthy();

    // No deben existir botones Copiar
    const copyButtons = screen.queryAllByText("Copiar");
    expect(copyButtons).toHaveLength(0);
  });

  it("(3) el botón Copiar copia el texto al portapapeles y muestra feedback", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(SAMPLE_ENTRIES);

    await act(async () => {
      render(<InboxTriage />);
    });

    // Localiza el primer botón Copiar
    const copyButtons = screen.getAllByText("Copiar");
    expect(copyButtons.length).toBeGreaterThan(0);

    // Hace clic en el primer botón
    await act(async () => {
      fireEvent.click(copyButtons[0]);
    });

    // navigator.clipboard.writeText debe haber sido llamado con el texto correcto
    expect(mockWriteText).toHaveBeenCalledWith("Idea sobre el router de IA");

    // El botón debe cambiar a "Copiado" como feedback visual
    await waitFor(() => {
      expect(screen.getByText("Copiado")).toBeTruthy();
    });
  });
});
