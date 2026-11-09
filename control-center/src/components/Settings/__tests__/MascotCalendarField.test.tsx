// MascotCalendarField — la URL del calendario es privada: el campo no se
// precarga, se vacía al guardar y no aparece en el DOM ni en los errores.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MascotCalendarField, statusLine } from "../MascotCalendarField";

const TOKEN = "https://cal.example.invalid/feed/TOKEN-SECRETO-123.ics";
const EMPTY = { configured: false, lastFetch: null, lastError: null, upcoming: 0 };
const SAVED = { configured: true, lastFetch: null, lastError: null, upcoming: 0 };

describe("MascotCalendarField", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("tras guardar, el DOM no contiene la URL tecleada", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === "mascot_calendar_status" ? EMPTY : SAVED));
    const { container } = render(<MascotCalendarField />);
    await waitFor(() => expect(screen.getByText("Sin URL configurada.")).toBeTruthy());
    const field = screen.getByLabelText("URL del calendario (ICS)") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: TOKEN } });
    fireEvent.click(screen.getByText("Guardar"));
    await waitFor(() => expect(screen.getByText(/^Configurada/)).toBeTruthy());
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("mascot_calendar_set_url", { url: TOKEN });
    expect(field.value).toBe("");
    expect(container.innerHTML).not.toContain("TOKEN-SECRETO");
  });

  it("un error que citara la URL se muestra sin ella (negativo)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "mascot_calendar_status") return EMPTY;
      throw new Error(`fallo con ${TOKEN}`);
    });
    const { container } = render(<MascotCalendarField />);
    await waitFor(() => expect(screen.getByText("Sin URL configurada.")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("URL del calendario (ICS)"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByText("Guardar"));
    await waitFor(() => expect(screen.getByText(/fallo con/)).toBeTruthy());
    // El campo conserva lo tecleado para corregirlo, pero el texto visible no.
    const visible = container.innerHTML.replace(/value="[^"]*"/g, "");
    expect(visible).not.toContain("TOKEN-SECRETO");
  });

  it("resume el estado sin la URL", () => {
    expect(statusLine({ configured: true, lastFetch: null, lastError: null, upcoming: 1 })).toBe(
      "Configurada · aún sin descargar · 1 entrega próxima",
    );
    expect(statusLine(EMPTY)).toBe("Sin URL configurada.");
  });
});
