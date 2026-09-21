// Red de seguridad del navegador de conversaciones.
//
// Cubre lo que no tenia NINGUN test antes de 2026-09-17: la forma exacta de los
// argumentos con los que se continua una conversacion (`spawn_session` +
// resumeId). Ese contrato vive entre el frontend y un script PowerShell, asi
// que un cambio de nombre de campo no lo detecta ni el compilador ni Rust.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Conversations } from "../../Conversations";
import type { ClaudeSession } from "../../../types/projects";
import type { TranscriptPage } from "../types";

function session(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    project_slug: "C--trabajo-portfolio",
    project_label: "C:/trabajo/portfolio",
    preview: "arregla el login de la web",
    size_bytes: 2048,
    last_activity: new Date().toISOString(),
    line_count: 12,
    ...over,
  };
}

function page(over: Partial<TranscriptPage> = {}): TranscriptPage {
  return {
    session_id: "11111111-2222-3333-4444-555555555555",
    path: "C:/Users/x/.claude/projects/p/s.jsonl",
    total_lines: 2,
    offset: 0,
    returned_lines: 2,
    has_more: false,
    char_capped: false,
    turns: [
      {
        line: 0,
        role: "user",
        timestamp: "2026-09-01T10:00:00Z",
        text: "arregla el login de la web",
        model: null,
        tools: [],
        truncated: false,
      },
      {
        line: 1,
        role: "assistant",
        timestamp: "2026-09-01T10:00:06Z",
        text: "Revisado: faltaba el **token CSRF**.",
        model: "claude-opus-5",
        tools: ["Bash"],
        truncated: false,
      },
    ],
    ...over,
  };
}

/** Enruta cada comando a su respuesta; falla ruidosamente ante uno inesperado. */
function mockBackend(handlers: Record<string, (args: unknown) => unknown>) {
  vi.mocked(invoke).mockImplementation(((cmd: string, args: unknown) => {
    const h = handlers[cmd];
    if (!h) return Promise.reject(new Error(`comando no esperado: ${cmd}`));
    return Promise.resolve(h(args));
  }) as unknown as typeof invoke);
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  localStorage.clear();
});

describe("Conversations", () => {
  it("lista las conversaciones agrupadas y abre la elegida al pulsarla", async () => {
    const s = session();
    mockBackend({
      list_claude_sessions: () => [s],
      read_session_transcript: () => page(),
    });

    render(<Conversations />);

    // La fila aparece con su titulo derivado del preview.
    const row = await screen.findByText("arregla el login de la web");
    // Y el cubo temporal de hoy, con su contador.
    expect(screen.getByText(/Hoy · 1/)).toBeInTheDocument();

    fireEvent.click(row);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("read_session_transcript", {
        sessionId: s.id,
        offset: 0,
        limit: 400,
      });
    });

    // El turno del assistant se pinta con su modelo y su chip de herramienta.
    expect(await screen.findByText(/faltaba el/)).toBeInTheDocument();
    expect(screen.getByText("opus-5")).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
  });

  it("continua la conversacion con los argumentos exactos de spawn_session", async () => {
    const s = session();
    mockBackend({
      list_claude_sessions: () => [s],
      read_session_transcript: () => page(),
      spawn_session: () => ({ launched: true, provider: "claude" }),
    });

    render(<Conversations />);
    fireEvent.click(await screen.findByText("arregla el login de la web"));
    fireEvent.click(await screen.findByRole("button", { name: /Continuar/ }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("spawn_session", {
        provider: "claude",
        prompt: null,
        cwd: "C:/trabajo/portfolio",
        flags: {
          dangerouslySkipPermissions: false,
          effort: null,
          model: null,
          resumeId: s.id,
        },
      });
    });
  });

  it("pagina con 'Cargar mas' desde el offset que devolvio el backend", async () => {
    const s = session({ line_count: 900 });
    const first = page({ total_lines: 900, returned_lines: 400, has_more: true });
    const second = page({
      offset: 400,
      returned_lines: 400,
      total_lines: 900,
      has_more: true,
      turns: [
        {
          line: 400,
          role: "user",
          timestamp: null,
          text: "segunda pagina",
          model: null,
          tools: [],
          truncated: false,
        },
      ],
    });
    let calls = 0;
    mockBackend({
      list_claude_sessions: () => [s],
      read_session_transcript: () => (calls++ === 0 ? first : second),
    });

    render(<Conversations />);
    fireEvent.click(await screen.findByText("arregla el login de la web"));
    fireEvent.click(await screen.findByRole("button", { name: /Cargar más mensajes/ }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("read_session_transcript", {
        sessionId: s.id,
        offset: 400,
        limit: 400,
      });
    });
    // Los turnos se acumulan: el de la pagina 1 sigue pintado. (Se afirma
    // contra el turno del assistant porque el del usuario repite el mismo
    // texto que el titulo de la fila en la lista.)
    expect(await screen.findByText("segunda pagina")).toBeInTheDocument();
    expect(screen.getByText(/faltaba el/)).toBeInTheDocument();
  });

  it("filtra por relevancia y no por coincidencia exacta", async () => {
    const login = session({ id: "aaa", preview: "arregla el login de la web" });
    const shader = session({ id: "bbb", preview: "optimiza el shader del agua" });
    mockBackend({
      list_claude_sessions: () => [login, shader],
      read_session_transcript: () => page(),
    });

    render(<Conversations />);
    await screen.findByText("arregla el login de la web");

    fireEvent.change(screen.getByLabelText("Buscar conversaciones"), {
      target: { value: "shader" },
    });

    await waitFor(() => {
      expect(screen.queryByText("arregla el login de la web")).not.toBeInTheDocument();
    });
    expect(screen.getByText("optimiza el shader del agua")).toBeInTheDocument();
  });

  it("no deja la paginacion en bucle si el backend devuelve una pagina vacia", async () => {
    // Caso negativo: has_more=true pero returned_lines=0. Sin la guarda, el
    // boton seguiria pidiendo el mismo offset para siempre.
    const s = session();
    const first = page({ has_more: true, returned_lines: 2, total_lines: 50 });
    const empty = page({ offset: 2, returned_lines: 0, has_more: true, turns: [] });
    let calls = 0;
    mockBackend({
      list_claude_sessions: () => [s],
      read_session_transcript: () => (calls++ === 0 ? first : empty),
    });

    render(<Conversations />);
    fireEvent.click(await screen.findByText("arregla el login de la web"));
    fireEvent.click(await screen.findByRole("button", { name: /Cargar más mensajes/ }));

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Cargar más mensajes/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("muestra el error del backend sin romper la pestana", async () => {
    const s = session();
    mockBackend({
      list_claude_sessions: () => [s],
      read_session_transcript: () => {
        throw new Error("no encuentro el transcript de la sesion 'aaa'");
      },
    });

    render(<Conversations />);
    fireEvent.click(await screen.findByText("arregla el login de la web"));

    expect(await screen.findByText(/no encuentro el transcript/)).toBeInTheDocument();
    // La cabecera sigue viva: el fallo es del panel, no de la pestana.
    expect(screen.getByRole("button", { name: /Continuar/ })).toBeInTheDocument();
  });
});
