// H19: lo borrado o archivado no puede esconder para siempre las repeticiones.
//
// Antes, Delete / Clear all y el botón del ojo metían la huella en un `Set`
// persistido que nadie podaba: una alerta crítica que volvía a dispararse
// después de «Clear all» no se veía nunca más.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { AlertEntry } from "../../types";
import { Notifications } from "../Notifications";
import { loadDismissed } from "../notifications/persistence";
import {
  forget,
  hideAll,
  isHidden,
  parseDismissed,
  restore,
} from "../notifications/dismissed";

vi.mock("../../lib/dialog", () => ({
  confirmDialog: vi.fn().mockResolvedValue(true),
}));

const FP = "doctor::fts desincronizado";

function crit(timestamp: string): AlertEntry {
  return { source: "doctor", message: "fts desincronizado", severity: "critical", timestamp };
}

describe("dismissed — ocultar con fecha", () => {
  it("oculta mientras no haya una repetición posterior", () => {
    const hiddenAt = Date.parse("2026-10-17T10:00:00Z");
    const d = hideAll(new Map(), [FP], hiddenAt);
    expect(isHidden(d, FP, "2026-10-17T09:59:00Z")).toBe(true);
    expect(isHidden(d, FP, "2026-10-17T10:00:00Z")).toBe(true);
    expect(isHidden(d, FP, "2026-10-17T10:00:01Z")).toBe(false);
    expect(isHidden(d, "otra::huella", "2026-10-17T09:00:00Z")).toBe(false);
  });

  it("sin fecha legible manda la ocultación", () => {
    const d = hideAll(new Map(), [FP], 1000);
    expect(isHidden(d, FP, "")).toBe(true);
  });

  it("no muta el mapa de entrada", () => {
    const base = new Map([[FP, 5]]);
    hideAll(base, ["x"], 9);
    forget(base, [FP]);
    expect([...base]).toEqual([[FP, 5]]);
  });

  it("restore devuelve el estado previo de las huellas", () => {
    const before = new Map([[FP, 5]]);
    const masked = hideAll(before, [FP, "nueva"], 9);
    const back = restore(masked, before, [FP, "nueva"]);
    expect([...back]).toEqual([[FP, 5]]);
  });

  it("parseDismissed descarta la lista antigua y los valores no numéricos", () => {
    expect(parseDismissed([FP]).size).toBe(0);
    expect([...parseDismissed({ [FP]: 7, malo: "x" })]).toEqual([[FP, 7]]);
  });

  it("loadDismissed descarta la v1 contaminada con huellas ya borradas", () => {
    localStorage.clear();
    localStorage.setItem("ultron.cc.dismissed_fingerprints.v1", JSON.stringify([FP]));
    expect(loadDismissed().size).toBe(0);
    expect(localStorage.getItem("ultron.cc.dismissed_fingerprints.v1")).toBeNull();
  });
});

describe("Notifications — repeticiones tras borrar u ocultar", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("una crítica que vuelve tras Clear all se ve", async () => {
    const onDeleted = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <Notifications alerts={[crit("2026-10-17T08:00:00Z")]} onDeleted={onDeleted} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Borrar todas/ }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("delete_alert_entries", {
      fingerprints: [FP],
    });

    // El padre relee alerts.jsonl: vacío. Luego la alerta se repite con una
    // fecha anterior al reloj del navegador (desfase de reloj o fichero
    // escrito con retraso): igualmente tiene que verse.
    rerender(<Notifications alerts={[]} onDeleted={onDeleted} />);
    rerender(<Notifications alerts={[crit("2026-10-17T08:05:00Z")]} onDeleted={onDeleted} />);
    await waitFor(() => expect(screen.getByText(/fts desincronizado/)).toBeTruthy());
    expect(screen.queryByText(/\d+ ocultas?/)).toBeNull();
  });

  it("si el borrado falla, las filas vuelven y el error se ve", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("alerts.jsonl bloqueado"));
    render(<Notifications alerts={[crit("2026-10-17T08:00:00Z")]} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Borrar todas/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/bloqueado/));
    expect(screen.getByText(/fts desincronizado/)).toBeTruthy();
  });

  it("si el borrado no encuentra nada en disco, lo dice en vez de no hacer nada", async () => {
    vi.mocked(invoke).mockResolvedValue(0);
    const onDeleted = vi.fn().mockResolvedValue(undefined);
    render(<Notifications alerts={[crit("2026-10-17T08:00:00Z")]} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: /Borrar todas/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/No se ha borrado nada/));
    // La huella sale del conjunto: la fila sigue a la vista.
    expect(screen.getByText(/fts desincronizado/)).toBeTruthy();
  });

  it("si se borró algo, no hay aviso de error", async () => {
    vi.mocked(invoke).mockResolvedValue(1);
    const onDeleted = vi.fn().mockResolvedValue(undefined);
    render(<Notifications alerts={[crit("2026-10-17T08:00:00Z")]} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: /Borrar todas/ }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("el ojo oculta aunque la fecha de la alerta vaya por delante del reloj", () => {
    const ahead = new Date(Date.now() + 5 * 60_000).toISOString();
    render(<Notifications alerts={[crit(ahead)]} />);
    fireEvent.click(screen.getByRole("button", { name: "Ocultar" }));
    expect(screen.queryByText(/fts desincronizado/)).toBeNull();
  });

  it("lo ocultado con el ojo reaparece cuando se repite", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const { rerender } = render(<Notifications alerts={[crit(past)]} />);
    fireEvent.click(screen.getByRole("button", { name: "Ocultar" }));
    expect(screen.queryByText(/fts desincronizado/)).toBeNull();
    expect(screen.getByText(/1 oculta/)).toBeTruthy();

    // Misma ocurrencia: sigue oculta.
    rerender(<Notifications alerts={[crit(past)]} />);
    expect(screen.queryByText(/fts desincronizado/)).toBeNull();

    // Repetición posterior a la ocultación: vuelve a verse.
    rerender(<Notifications alerts={[crit(past), crit(future)]} />);
    expect(screen.getByText(/fts desincronizado/)).toBeTruthy();
  });
});

describe("computeGlobalStatus — mismo criterio que la pestaña", () => {
  beforeEach(() => localStorage.clear());

  it("lo oculto no pone el punto en rojo, pero una repetición posterior sí", async () => {
    const { computeGlobalStatus } = await import("../../lib/status");
    const hiddenAt = Date.parse("2026-10-17T10:00:00Z");
    localStorage.setItem(
      "ultron.cc.dismissed_fingerprints.v2",
      JSON.stringify({ [FP]: hiddenAt }),
    );
    expect(computeGlobalStatus([crit("2026-10-17T09:00:00Z")])).toBe("ok");
    expect(
      computeGlobalStatus([crit("2026-10-17T09:00:00Z"), crit("2026-10-17T11:00:00Z")]),
    ).toBe("down");
  });
});
