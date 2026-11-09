// Panel → Sistema de memoria: el estado del índice FTS5 de brain.db es visible
// en la tarjeta y la pone en rojo cuando diverge de memory_items (auditoría
// 2026-10-23). Antes `memory_health` devolvía `healthy: true` fijo para SQLite y
// la tarjeta seguía en verde con el índice roto.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MemoryStatusCard, type FtsDetails } from "../MemoryStatusCard";

const STATS = {
  active: 10,
  pending: 0,
  rejected: 0,
  deprecated: 0,
  stale: 0,
  candidates_pending: 0,
};

function mockHealth(fts: FtsDetails) {
  const health = {
    embeddings_real: false,
    stores: {
      qdrant: { healthy: false, message: "off", latency_ms: null },
      sqlite: { healthy: fts.in_sync, message: "brain.db", latency_ms: null, details: fts },
    },
  };
  vi.mocked(invoke).mockImplementation(((cmd: string) =>
    Promise.resolve(cmd === "memory_health" ? health : STATS)) as typeof invoke);
}

/** Color del borde izquierdo de la tarjeta (el acento). */
function accentOf(container: HTMLElement): string {
  return (container.firstElementChild as HTMLElement).style.borderLeft;
}

describe("MemoryStatusCard · índice FTS5", () => {
  afterEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("en sync: enseña las filas y el acento queda en verde", async () => {
    mockHealth({ fts_rows: 10, item_rows: 10, integrity_ok: true, in_sync: true, error: null });
    const { container } = render(<MemoryStatusCard />);
    await waitFor(() => expect(screen.getByTestId("memory-fts-row")).toBeInTheDocument());
    expect(screen.getByTestId("memory-fts-row")).toHaveTextContent("10 filas · en sync");
    expect(accentOf(container)).toContain("var(--color-success)");
  });

  it("desincronizado: enseña las dos cifras y el acento pasa a rojo", async () => {
    mockHealth({
      fts_rows: 12,
      item_rows: 10,
      integrity_ok: false,
      in_sync: false,
      error: "database disk image is malformed",
    });
    const { container } = render(<MemoryStatusCard />);
    await waitFor(() => expect(screen.getByTestId("memory-fts-row")).toBeInTheDocument());
    expect(screen.getByTestId("memory-fts-row")).toHaveTextContent(
      "desincronizado · 12 filas frente a 10 items",
    );
    expect(accentOf(container)).toContain("var(--color-danger)");
  });
});
