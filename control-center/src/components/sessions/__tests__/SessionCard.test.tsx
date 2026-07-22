// SessionCard — unit tests del resumen AI bajo demanda.
//
// Covers:
//   (1) Por defecto la card muestra el truncado local (last_activity_summary)
//       y NO invoca summarize_session_activity al montar (privacidad + coste).
//   (2) Click en "resumir AI" invoca summarize_session_activity con
//       { sessionId } y el resultado reemplaza el truncado local.
//   (3) Si el invoke falla, se mantiene el truncado local, el error queda
//       expuesto vía title y el botón pasa a "reintentar AI".
//
// Nota: SessionCard cachea resúmenes en un Map a nivel de módulo, así que cada
// test usa un session_id único para no heredar caché de otro test.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SessionCard } from "../SessionCard";
import type { SessionInfo } from "../sessionTypes";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOCAL_SUMMARY = "Editando SessionCard.tsx y corriendo tests";

const BASE_SESSION: SessionInfo = {
  session_id: "sess-base",
  project_path: "C:\\projects\\alpha",
  project_name: "Alpha",
  matched_project_id: null,
  git_branch: "main",
  model: "claude-sonnet-4-5",
  context_tokens: 10_000,
  context_limit: 200_000,
  context_pct: 5,
  cache_read_tokens: 0,
  output_tokens: 500,
  status: "working",
  last_activity: "2026-07-22T10:00:00Z",
  age_seconds: 42,
  last_prompt: "arregla el bug del resumen",
  last_activity_summary: LOCAL_SUMMARY,
  is_subagent: false,
};

function renderCard(overrides: Partial<SessionInfo> = {}) {
  return render(<SessionCard session={{ ...BASE_SESSION, ...overrides }} />);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// (1) Default: truncado local, sin invoke al montar
// ---------------------------------------------------------------------------

describe("SessionCard — resumen AI bajo demanda", () => {
  it("muestra el truncado local por defecto y NO invoca summarize al montar", () => {
    renderCard({ session_id: "sess-mount" });

    expect(screen.getByText(LOCAL_SUMMARY)).toBeTruthy();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      "summarize_session_activity",
      expect.anything(),
    );
    // El affordance del resumen AI está disponible
    expect(screen.getByText("resumir AI")).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // (2) Click → invoke + reemplazo del texto
  // -------------------------------------------------------------------------

  it("click en 'resumir AI' invoca summarize_session_activity y reemplaza el truncado", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("Resumen AI generado por el backend");
    renderCard({ session_id: "sess-click" });

    fireEvent.click(screen.getByText("resumir AI"));

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "summarize_session_activity",
        { sessionId: "sess-click" },
      );
    });
    await waitFor(() => {
      expect(screen.getByText("Resumen AI generado por el backend")).toBeTruthy();
    });

    // El truncado local ya no se muestra y el botón desaparece
    expect(screen.queryByText(LOCAL_SUMMARY)).toBeNull();
    expect(screen.queryByText("resumir AI")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // (3) Error → truncado local + error en title, botón de reintento
  // -------------------------------------------------------------------------

  it("si el invoke falla mantiene el truncado local y expone el error en title", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("modelo no disponible"));
    renderCard({ session_id: "sess-err" });

    fireEvent.click(screen.getByText("resumir AI"));

    await waitFor(() => {
      expect(screen.getByText("reintentar AI")).toBeTruthy();
    });

    // Sigue el truncado local, con el error accesible vía tooltip
    expect(screen.getByText(LOCAL_SUMMARY)).toBeTruthy();
    expect(screen.getAllByTitle(/modelo no disponible/).length).toBeGreaterThan(0);
  });
});
