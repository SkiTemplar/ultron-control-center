import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyControl } from "./ProxyControl";
import tauriConf from "../../../src-tauri/tauri.conf.json";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function backend(enabled: boolean) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "proxy_state_enabled") return enabled;
    if (cmd === "proxy_health") return { status: "running", message: null, searched_paths: [] };
    return {
      enabled,
      mode: "managed",
      binary_present: true,
      port_8082_up: true,
      base_url: "",
      message: null,
    };
  });
}

describe("ProxyControl", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("la CSP sigue bloqueando el puerto del proxy: si cambia, este panel puede volver a leerlo", () => {
    expect(tauriConf.app.security.csp).not.toMatch(/connect-src[^;]*127\.0\.0\.1/);
  });

  it("no intenta un fetch que la CSP bloquea y dice qué no puede ver", async () => {
    backend(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<ProxyControl />);
    await screen.findByText(/no puede ver qué backend y modelo/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("con el proxy apagado no muestra ese aviso", async () => {
    backend(false);
    render(<ProxyControl />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("proxy_health"));
    expect(screen.queryByText(/no puede ver qué backend y modelo/)).toBeNull();
  });
});
