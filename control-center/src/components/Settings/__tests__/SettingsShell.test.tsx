// Settings (index.tsx) — barra de pestañas accesible, «Recargar» solo en las
// pestañas que consumen el snapshot y barra de guardado solo con cambios.
// Más el interruptor común SettingsSwitch.

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { Settings } from "../index";
import { SettingsSwitch } from "../SettingsSwitch";

const SNAPSHOT = {
  path: "C:/Users/demo/.claude/settings.json",
  content: { model: "claude-opus-5-5" },
  content_hash: "huella-de-la-lectura",
  backup_dir: "C:/Users/demo/.claude/backups",
  recent_backups: ["C:/Users/demo/.claude/backups/settings-2026-10-17.json"],
};

function mockBackend(cmd: string): unknown {
  switch (cmd) {
    case "settings_read":
      return SNAPSHOT;
    case "get_global_hotkey":
      return "ctrl+alt+u";
    case "plugin:autostart|is_enabled":
      return false;
    default:
      return null;
  }
}

describe("Settings", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => mockBackend(cmd));
  });

  it("expone las pestañas como tablist con una seleccionada", async () => {
    render(<Settings />);
    const tabs = await screen.findAllByRole("tab");
    expect(tabs).toHaveLength(10);
    const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected.map((t) => t.textContent)).toEqual(["General"]);
  });

  it("solo ofrece «Recargar» en las pestañas que leen settings.json", async () => {
    render(<Settings />);
    await screen.findAllByRole("tab");
    expect(screen.queryByRole("button", { name: "Recargar" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "settings.json" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Recargar" })).toBeTruthy());
  });

  it("muestra la barra de guardado solo con cambios pendientes y marca la pestaña", async () => {
    render(<Settings />);
    fireEvent.click(await screen.findByRole("tab", { name: "settings.json" }));
    const input = await screen.findByDisplayValue("claude-opus-5-5");
    expect(screen.queryByText("Cambios sin guardar")).toBeNull();

    fireEvent.change(input, { target: { value: "claude-sonnet-5-5" } });
    expect(screen.getByText("Cambios sin guardar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeTruthy();

    // Fuera de settings.json no hay guardado, pero la pestaña avisa.
    fireEvent.click(screen.getByRole("tab", { name: /Pupus/ }));
    expect(screen.queryByRole("button", { name: "Guardar cambios" })).toBeNull();
    expect(screen.getByRole("tab", { name: /settings\.json/ }).getAttribute("title")).toBe(
      "Cambios sin guardar",
    );
  });

  // Hallazgo 27 (auditoría 2026-11-08): el guardado manda la huella de la
  // lectura y, si el backend lo rechaza porque el fichero cambió, el error se
  // ve y el borrador no se pierde.
  it("guarda con la huella de la lectura y muestra el rechazo por cambio en disco", async () => {
    const STALE = "settings.json ha cambiado en disco desde que se leyó";
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "settings_save") throw STALE;
      return mockBackend(cmd);
    });
    render(<Settings />);
    fireEvent.click(await screen.findByRole("tab", { name: "settings.json" }));
    const input = await screen.findByDisplayValue("claude-opus-5-5");
    fireEvent.change(input, { target: { value: "claude-sonnet-5-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect(await screen.findByText(STALE)).toBeTruthy();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("settings_save", {
      content: { model: "claude-sonnet-5-5" },
      expectedHash: "huella-de-la-lectura",
    });
    expect(screen.getByDisplayValue("claude-sonnet-5-5")).toBeTruthy();
    expect(screen.getByText("Cambios sin guardar")).toBeTruthy();
  });
});

describe("SettingsSwitch", () => {
  it("es un switch con estado y nombre accesibles que conmuta", () => {
    const onChange = vi.fn();
    render(<SettingsSwitch checked={false} onChange={onChange} label="Iniciar con Windows" />);
    const sw = screen.getByRole("switch", { name: "Iniciar con Windows" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("no conmuta deshabilitado", () => {
    const onChange = vi.fn();
    render(<SettingsSwitch checked onChange={onChange} label="x" disabled />);
    fireEvent.click(screen.getByRole("switch", { name: "x" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
