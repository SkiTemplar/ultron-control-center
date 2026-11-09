// Alta de proveedores personalizados con invoke simulado: validación antes
// de llamar al backend, variable ULTRON_KEY_<SLUG> derivada del id y aviso
// visible si el backend no guarda la key.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CustomProvidersGroup } from "./CustomProvidersGroup";
import { useCustomProviders } from "./useCustomProviders";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function Harness() {
  const custom = useCustomProviders();
  return <CustomProvidersGroup custom={custom} probes={{}} onProbe={() => undefined} />;
}

function backend(saveKeys: () => unknown) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "ai_router_list_providers") {
      return [{ id: "groq", name: "Groq", custom: false, key_env_var: "GROQ_API_KEY" }];
    }
    if (cmd === "ai_router_upsert_custom_provider") return { id: "mi-proxy", name: "Mi proxy" };
    if (cmd === "set_env_vars_keys") return saveKeys();
    return null;
  });
}

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("proveedores personalizados", () => {
  beforeEach(() => invokeMock.mockReset());

  it("un id del seed no llega al backend y se explica", async () => {
    backend(() => ({ saved: [], skipped: [], errors: {} }));
    render(<Harness />);
    await screen.findByText("No hay proveedores personalizados.");
    fill(/^Nombre/, "Groq bis");
    fill(/^Id \(slug\)/, "groq");
    fill(/^base_url/, "https://api.ejemplo.com/v1");
    fireEvent.click(screen.getByRole("button", { name: "Añadir o actualizar" }));
    expect(await screen.findByText(/ya lo usa un proveedor del router/)).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("ai_router_upsert_custom_provider", expect.anything());
  });

  it("guarda el proveedor con ULTRON_KEY_<SLUG> y la key por set_env_vars_keys", async () => {
    backend(() => ({ saved: ["ULTRON_KEY_MI_PROXY"], skipped: [], errors: {} }));
    render(<Harness />);
    await screen.findByText("No hay proveedores personalizados.");
    fill(/^Nombre/, "Mi proxy");
    fill(/^base_url/, "https://api.ejemplo.com/v1/");
    fill(/^Key/, "sk-123");
    fireEvent.click(screen.getByRole("button", { name: "Añadir o actualizar" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("ai_router_upsert_custom_provider", {
        provider: {
          id: "mi-proxy",
          name: "Mi proxy",
          base_url: "https://api.ejemplo.com/v1",
          api_format: "openai_compat",
          key_env_var: "ULTRON_KEY_MI_PROXY",
        },
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith("set_env_vars_keys", { keys: { ULTRON_KEY_MI_PROXY: "sk-123" } });
    expect(await screen.findByText(/Key guardada en ULTRON_KEY_MI_PROXY/)).toBeInTheDocument();
  });

  // Caso negativo del hallazgo: antes mandaba siempre ULTRON_KEY_<ID> y el
  // backend fallaba en cada llamada por falta de esa variable.
  it("un servidor local sin key se guarda sin variable de key", async () => {
    backend(() => ({ saved: [], skipped: [], errors: {} }));
    render(<Harness />);
    await screen.findByText("No hay proveedores personalizados.");
    fill(/^Nombre/, "LM Studio");
    fill(/^base_url/, "http://localhost:1234/v1");
    fireEvent.click(screen.getByRole("button", { name: "Añadir o actualizar" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("ai_router_upsert_custom_provider", {
        provider: {
          id: "lm-studio",
          name: "LM Studio",
          base_url: "http://localhost:1234/v1",
          api_format: "openai_compat",
          key_env_var: "",
        },
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("set_env_vars_keys", expect.anything());
    expect(await screen.findByText(/sin autenticación/)).toBeInTheDocument();
  });

  it("si el backend salta la key lo dice en vez de darla por guardada", async () => {
    backend(() => ({ saved: [], skipped: ["ULTRON_KEY_MI_PROXY"], errors: {} }));
    render(<Harness />);
    await screen.findByText("No hay proveedores personalizados.");
    fill(/^Nombre/, "Mi proxy");
    fill(/^base_url/, "https://api.ejemplo.com/v1");
    fill(/^Key/, "sk-123");
    fireEvent.click(screen.getByRole("button", { name: "Añadir o actualizar" }));
    expect(await screen.findByText(/La key NO se guardó/)).toBeInTheDocument();
  });
});
