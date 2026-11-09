import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunReview } from "./RunReview";
import type { BatchRunReview } from "./types";

const script = {
  name: "queued-1.ps1",
  path: "C:/batches/queued-1.ps1",
  size_bytes: 13,
  content: "Remove-Item x",
  too_large: false,
};
const base = { name: script.name, queueEntry: null };

function renderReview(review: BatchRunReview) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<RunReview review={review} onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel, runButton: screen.getByRole("button", { name: "Ejecutar" }) };
}

describe("RunReview", () => {
  it("enseña el script y confirma con un clic explícito", () => {
    const { onConfirm, runButton } = renderReview({ ...base, status: "ready", script });
    expect(screen.getByLabelText(`Contenido de ${script.name}`).textContent).toBe("Remove-Item x");
    fireEvent.click(runButton);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it.each<[string, BatchRunReview]>([
    ["leyendo", { ...base, status: "loading" }],
    ["sin poder leerlo", { ...base, status: "error", message: "not found" }],
    ["demasiado grande", { ...base, status: "ready", script: { ...script, content: "", too_large: true } }],
  ])("no deja ejecutar %s", (_caso, review) => {
    const { onConfirm, runButton } = renderReview(review);
    expect(runButton).toHaveProperty("disabled", true);
    fireEvent.click(runButton);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("avisa de que una entrada de la cola viene de una sesión de IA", () => {
    const queueEntry = {
      id: "bq-1",
      name: script.name,
      path: "",
      reason: "rejected" as const,
      kind: "auto" as const,
      description: null,
      created_at: "epoch:1",
      last_error: null,
      attempts: 1,
    };
    renderReview({ ...base, queueEntry, status: "ready", script });
    expect(screen.getByText(/Viene de una sesión de IA/)).toBeTruthy();
  });
});
