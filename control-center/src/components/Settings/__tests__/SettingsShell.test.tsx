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
