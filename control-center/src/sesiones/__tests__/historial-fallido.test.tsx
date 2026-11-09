// Historial que no carga: el chat enseña el fallo con «Reintentar» en vez de
// «Sesión lista»; una carga buena posterior lo borra (caso negativo: sin fallo
// no aparece el aviso).

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { loadHistory } from "../bootstrap";
import { HistoryError } from "../components/chat/MessageList";
import { pagingOf } from "../session-state";
import { store } from "../store";

const state = () => store.getState().bySession.s1;

beforeEach(() => {
  store.dispatch({ type: "reset", id: "s1" });
  store.dispatch({ type: "error", message: null as unknown as string });
});
afterEach(cleanup);

describe("historial fallido", () => {
  it("un fallo deja `loadError` y la carga buena siguiente lo borra", async () => {
    const history = vi.fn().mockRejectedValueOnce(new Error("transcript ilegible")).mockResolvedValueOnce({ messages: [], hasMore: false });
    const api = { history } as unknown as SesionesApi;
    await loadHistory(api, "s1", null);
    expect(pagingOf(state(), null).loadError).toContain("transcript ilegible");
    expect(state().historyLoaded).toBe(true);
    await loadHistory(api, "s1", null, true);
    expect(pagingOf(state(), null).loadError).toBeFalsy();
  });

  it("caso negativo: una carga buena no deja aviso", async () => {
    const api = { history: vi.fn().mockResolvedValue({ messages: [], hasMore: true }) } as unknown as SesionesApi;
    await loadHistory(api, "s1", null);
    expect(pagingOf(state(), null).loadError).toBeFalsy();
  });

  it("el aviso enseña el motivo y «Reintentar» llama al reintento", () => {
    const retry = vi.fn();
    render(<HistoryError error="sin acceso" onRetry={retry} />);
    expect(screen.getByRole("alert").textContent).toContain("sin acceso");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
