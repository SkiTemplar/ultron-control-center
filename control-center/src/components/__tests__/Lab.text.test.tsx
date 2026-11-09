import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Lab } from "../Lab";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

describe("Lab: el texto pegado sobrevive al cambio de pestaña", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ patrones: [] });
    window.sessionStorage.clear();
  });

  it("al desmontar y volver, el texto sigue ahí", async () => {
    const { unmount } = render(<Lab />);
    const box = screen.getAllByRole("textbox")[0] as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "texto pegado" } });
    unmount();

    render(<Lab />);
    expect((screen.getAllByRole("textbox")[0] as HTMLTextAreaElement).value).toBe("texto pegado");
  });

  it("sin nada guardado empieza vacío", () => {
    render(<Lab />);
    expect((screen.getAllByRole("textbox")[0] as HTMLTextAreaElement).value).toBe("");
  });
});
