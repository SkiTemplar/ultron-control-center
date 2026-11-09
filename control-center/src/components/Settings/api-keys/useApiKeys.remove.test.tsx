import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeyFieldRow } from "./KeyFieldRow";
import { useApiKeys } from "./useApiKeys";

const invokeMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../../lib/dialog", () => ({ confirmDialog: confirmMock }));

function backend(remove: () => Promise<void> = async () => undefined) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "get_env_keys_status") return Promise.resolve([]);
    if (cmd === "remove_env_key") return remove();
    return Promise.resolve(undefined);
  });
}

const removals = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "remove_env_key");
const statusReads = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "get_env_keys_status");

describe("useApiKeys: quitar una key", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    confirmMock.mockReset();
  });

  it("sin confirmar no borra nada", async () => {
    backend();
    confirmMock.mockResolvedValue(false);
    const { result } = renderHook(() => useApiKeys());
    await act(() => result.current.handleRemove("GROQ_API_KEY"));
    expect(removals()).toHaveLength(0);
  });

  it("al confirmar la borra y relee el estado para refrescar el badge", async () => {
    backend();
    confirmMock.mockResolvedValue(true);
    const { result } = renderHook(() => useApiKeys());
    await waitFor(() => expect(statusReads()).toHaveLength(1));
    await act(() => result.current.handleRemove("GROQ_API_KEY"));
    expect(removals()).toEqual([["remove_env_key", { key: "GROQ_API_KEY" }]]);
    expect(statusReads()).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it("un fallo se enseña y el estado se relee igualmente", async () => {
    backend(() => Promise.reject(new Error("denegado")));
    confirmMock.mockResolvedValue(true);
    const { result } = renderHook(() => useApiKeys());
    await act(() => result.current.handleRemove("GROQ_API_KEY"));
    expect(result.current.error).toContain("denegado");
    expect(result.current.error).toContain("GROQ_API_KEY");
  });
});

describe("KeyFieldRow: botón Quitar", () => {
  const def = {
    envVar: "GROQ_API_KEY",
    label: "Groq",
    placeholder: "",
    docsUrl: "https://example.invalid",
    tutorial: { steps: [], usedFor: "", withoutIt: "" },
  } as never;
  const state = { value: "", visible: false };
  const status = (configured: boolean) =>
    ({ env_var: "GROQ_API_KEY", configured, active: configured, masked: "gs…1", is_secret: true }) as never;

  function renderRow(configured: boolean) {
    const onRemove = vi.fn();
    render(
      <ul>
        <KeyFieldRow
          def={def}
          state={state}
          status={status(configured)}
          onChange={vi.fn()}
          onToggleVisible={vi.fn()}
          onRemove={onRemove}
        />
      </ul>,
    );
    return onRemove;
  }

  it("una key configurada se puede quitar", () => {
    const onRemove = renderRow(true);
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    expect(onRemove).toHaveBeenCalledWith("GROQ_API_KEY");
  });

  it("sin key no hay nada que quitar", () => {
    renderRow(false);
    expect(screen.queryByRole("button", { name: "Quitar" })).toBeNull();
  });
});
