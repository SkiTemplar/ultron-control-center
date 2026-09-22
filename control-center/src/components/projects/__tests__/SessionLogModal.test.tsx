// SessionLogModal — unit tests
//
// Covers:
//   (a) Un summary.md con frontmatter renderiza el cuerpo como markdown
//       (`## Temas` como <h2>, un ítem de lista como <li>) y el frontmatter
//       YAML (session_id/rango/modelo/generated_at) no aparece en el DOM.
//   (b) Negativo: un `<script>` embebido en el cuerpo no crea ningún
//       elemento <script> — Markdown nunca hace pasada de HTML.
//   (c) Un cuerpo vacío no revienta el render.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SessionLogModal } from "../SessionLogModal";
import type { SessionLogEntry } from "../../../types";

const BASE_ENTRY: SessionLogEntry = {
  session_id: "sess-1",
  started_at: "2026-09-21T10:00:00",
  duration_min: 30,
  model: "claude-sonnet-5",
  generated_at: "2026-09-21T10:30:00",
  headline: "Bitácora de prueba",
  pending_count: 0,
  sections: ["Temas"],
  file_mtime: 1_758_000_000,
  degraded: false,
};

const FRONTMATTER = [
  "---",
  "session_id: sess-1",
  "rango: 2026-09-21T10:00 .. 2026-09-21T10:30",
  "modelo: claude-sonnet-5",
  "generated_at: 2026-09-21T10:30:00",
  "---",
  "",
].join("\n");

function mockLogAndEntry(entryBody: string) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "project_session_log") return [BASE_ENTRY];
    if (cmd === "project_session_entry") return entryBody;
    return null;
  });
}

async function openEntry() {
  render(
    <SessionLogModal projectId="proj-1" projectName="Alpha" onClose={() => {}} />,
  );
  await waitFor(() => expect(screen.getByText("Bitácora de prueba")).toBeTruthy());
  fireEvent.click(screen.getByText("Bitácora de prueba"));
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("SessionLogModal — cuerpo como markdown", () => {
  it("renderiza ## Temas como encabezado y un ítem como <li>, sin el frontmatter en el DOM", async () => {
    const body = `${FRONTMATTER}## Temas\n\n- Primer tema tratado en la sesión\n`;
    mockLogAndEntry(body);
    await openEntry();

    await waitFor(() => expect(screen.getByText("Temas")).toBeTruthy());
    expect(screen.getByText("Temas").tagName).toBe("H2");
    expect(screen.getByText("Primer tema tratado en la sesión").closest("li")).not.toBeNull();

    // El frontmatter no debe pintarse como texto suelto.
    expect(screen.queryByText(/session_id: sess-1/)).toBeNull();
    expect(screen.queryByText(/generated_at:/)).toBeNull();
  });

  it("no crea ningún elemento <script> a partir de un cuerpo con <script>", async () => {
    const body = `${FRONTMATTER}## Temas\n\n<script>alert(1)</script>\n`;
    mockLogAndEntry(body);
    await openEntry();

    await waitFor(() => expect(screen.getByText("Temas")).toBeTruthy());
    expect(document.querySelectorAll("script").length).toBe(0);
  });

  it("no revienta con un cuerpo vacío", async () => {
    mockLogAndEntry("");
    await openEntry();

    // El toggle no lanza y no queda "Cargando…" colgado.
    await waitFor(() => expect(screen.queryByText("Cargando…")).toBeNull());
  });
});
