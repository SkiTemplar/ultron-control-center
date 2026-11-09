// Menú del clic derecho de Pupus: «Ver la última respuesta» solo sale si hay
// una respuesta que volver a enseñar (el bocadillo se cierra solo).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PetMenu } from "../bubble";

afterEach(cleanup);

describe("PetMenu", () => {
  it("con una respuesta anterior ofrece verla y avisa con lastReply", () => {
    const onPick = vi.fn();
    render(<PetMenu onPick={onPick} canReplay />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Ver la última respuesta" }));
    expect(onPick).toHaveBeenCalledWith("lastReply");
  });

  it("caso negativo: sin respuesta anterior no hay botón que no haga nada", () => {
    render(<PetMenu onPick={vi.fn()} />);
    expect(screen.queryByRole("menuitem", { name: "Ver la última respuesta" })).toBeNull();
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
  });
});
