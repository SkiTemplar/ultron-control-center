// Marco de la app: boundary por pestaña, ciclo de vida de los toasts y
// navegación de la paleta alineada con la barra lateral.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabErrorBoundary } from "../TabErrorBoundary";
import { CommandPalette } from "../CommandPalette";
import { TAB_LABELS } from "../Sidebar";
import {
  dismissToast,
  pauseToast,
  resumeToast,
  showToast,
  subscribeQueue,
  type Popup,
} from "../../lib/popups";

function Boom(): never {
  throw new Error("kaput");
}

describe("TabErrorBoundary con key por pestaña", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("nombra la pestaña con su etiqueta y no arrastra el error a la siguiente", () => {
    const { rerender } = render(
      <TabErrorBoundary key="ai-router" tab={TAB_LABELS["ai-router"]}>
        <Boom />
      </TabErrorBoundary>,
    );
    expect(screen.getByText(/Error en la pestaña/).textContent).toContain("AI Router");

    rerender(
      <TabErrorBoundary key="usage" tab={TAB_LABELS.usage}>
        <p>usage ok</p>
      </TabErrorBoundary>,
    );
    expect(screen.queryByText(/Error en la pestaña/)).toBeNull();
    expect(screen.getByText("usage ok")).toBeTruthy();
  });

  it("sin cambiar la key el error se mantiene (el reinicio viene de la key)", () => {
    const { rerender } = render(
      <TabErrorBoundary key="lab" tab={TAB_LABELS.lab}>
        <Boom />
      </TabErrorBoundary>,
    );
    rerender(
      <TabErrorBoundary key="lab" tab={TAB_LABELS.lab}>
        <p>lab ok</p>
      </TabErrorBoundary>,
    );
    expect(screen.getByText(/Error en la pestaña/).textContent).toContain("Lab");
  });
});

describe("toasts", () => {
  let items: Popup[] = [];
  let unsub: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    unsub = subscribeQueue((q) => {
      items = q;
    });
    for (const p of items) dismissToast(p.id);
  });
  afterEach(() => {
    unsub();
    vi.useRealTimers();
  });

  it("warn dura 12 s, info 6 s y blocking no caduca", () => {
    showToast({ message: "i", severity: "info" });
    showToast({ message: "w", severity: "warn" });
    const blocking = showToast({ message: "b", severity: "blocking" });
    vi.advanceTimersByTime(6_500);
    expect(items.map((p) => p.message)).toEqual(["w", "b"]);
    vi.advanceTimersByTime(6_000);
    expect(items.map((p) => p.message)).toEqual(["b"]);
    vi.advanceTimersByTime(60_000);
    expect(items.map((p) => p.message)).toEqual(["b"]);
    dismissToast(blocking);
    expect(items).toEqual([]);
  });

  it("la pausa congela la cuenta atrás y la reanudación respeta lo que quedaba", () => {
    const id = showToast({ message: "x", severity: "info" });
    vi.advanceTimersByTime(4_000);
    pauseToast(id);
    vi.advanceTimersByTime(30_000);
    expect(items).toHaveLength(1);
    resumeToast(id);
    vi.advanceTimersByTime(1_900);
    expect(items).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(items).toHaveLength(0);
  });
});

describe("CommandPalette", () => {
  function open(query = "") {
    render(<CommandPalette open onClose={() => {}} onNavigate={() => {}} />);
    if (query) {
      act(() => {
        fireEvent.change(screen.getByPlaceholderText(/Escribe un comando/), {
          target: { value: query },
        });
      });
    }
  }
  const labels = () =>
    screen.getAllByRole("button").map((b) => b.textContent ?? "");

  it("Navegar sigue a la barra lateral: Router de IA, Notas y Laboratorio dentro; Learn y Memory retiradas; Finanzas fuera sin VITE_FINANCE", () => {
    open();
    const all = labels();
    for (const l of ["Ir a AI Router", "Ir a Notes", "Ir a Lab", "Ir a Session Monitor", "Ir a Notifications", "Ir a Settings", "Library · Agentes"]) {
      expect(all).toContain(l);
    }
    expect(all).not.toContain("Ir a Finance");
    expect(all).not.toContain("Ir a Learn");
    expect(all).not.toContain("Ir a Memory");
    expect(all.indexOf("Ir a AI Router")).toBeLessThan(all.indexOf("Ir a System"));
    expect(all.some((l) => l.startsWith("Go to "))).toBe(false);
    expect(screen.queryByText("Navigate (More)")).toBeNull();
  });

  it("una descripción solo casa por subcadena, no por subsecuencia dispersa", () => {
    render(
      <CommandPalette
        open
        onClose={() => {}}
        onNavigate={() => {}}
        extraActions={[
          { id: "a", label: "Purge legacy autostart entries", description: "Remove stale Run-key / Startup shim left by older installs.", group: "System", run: () => {} },
          { id: "b", label: "Reconstruir FTS5", description: "Regenera el índice de memoria", group: "Mantenimiento (Memoria)", run: () => {} },
        ]}
      />,
    );
    act(() => {
      fireEvent.change(screen.getByPlaceholderText(/Escribe un comando/), {
        target: { value: "memo" },
      });
    });
    const all = labels();
    expect(all.some((l) => l.startsWith("Reconstruir FTS5"))).toBe(true);
    expect(all.some((l) => l.startsWith("Purge legacy"))).toBe(false);
  });
});
