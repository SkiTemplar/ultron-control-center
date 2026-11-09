// Barreras de error: un fallo de render se queda en el mensaje o el panel que lo
// provoca. Sin ellas, React desmonta toda la ventana y queda en blanco.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { Markdown, MarkdownBlocks } from "../components/chat/Markdown";
import { ApiContext } from "../context";

// El enlace con «boom» simula un componente de Markdown que lanza al pintarse.
vi.mock("../components/chat/md-blocks", async (original) => {
  const real = await original<typeof import("../components/chat/md-blocks")>();
  return {
    ...real,
    MdLink: (props: Parameters<typeof real.MdLink>[0]) => {
      if (props.href?.includes("boom")) throw new Error("fallo de render");
      return real.MdLink(props);
    },
  };
});

const api = { isMock: true } as unknown as SesionesApi;

afterEach(cleanup);

beforeEach(() => {
  // React anuncia en consola cada error capturado: es lo esperado aquí.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

function Bomb({ armed }: { armed: boolean }): React.ReactElement {
  if (armed) throw new Error("revienta");
  return <p>sano</p>;
}

describe("ErrorBoundary", () => {
  it("pinta el aviso con el motivo y no toca a los hermanos", () => {
    render(
      <div>
        <ErrorBoundary scope="este mensaje"><Bomb armed /></ErrorBoundary>
        <p>vecino</p>
      </div>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("este mensaje");
    expect(alert.textContent).toContain("revienta");
    expect(screen.getByText("vecino")).not.toBeNull();
  });

  it("caso negativo: sin error no añade nada al DOM", () => {
    const { container } = render(<ErrorBoundary scope="x"><Bomb armed={false} /></ErrorBoundary>);
    expect(container.innerHTML).toBe("<p>sano</p>");
  });

  it("se recupera sola cuando cambia resetKey", () => {
    const view = render(<ErrorBoundary scope="x" resetKey="a"><Bomb armed /></ErrorBoundary>);
    expect(screen.queryByRole("alert")).not.toBeNull();
    view.rerender(<ErrorBoundary scope="x" resetKey="b"><Bomb armed={false} /></ErrorBoundary>);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("sano")).not.toBeNull();
  });

  it("Reintentar vuelve a pintar el contenido", () => {
    function Host() {
      const [armed, setArmed] = useState(true);
      return (
        <>
          <button onClick={() => setArmed(false)}>desarmar</button>
          <ErrorBoundary scope="x"><Bomb armed={armed} /></ErrorBoundary>
        </>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByText("desarmar"));
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(screen.getByText("sano")).not.toBeNull();
  });
});

describe("Markdown con un componente que lanza", () => {
  const wrap = (children: React.ReactNode) => <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;

  it("el mensaje malo enseña su texto en crudo y el resto de la ventana sigue", () => {
    const { container } = render(wrap(
      <>
        <Markdown text="[a](https://x.com/boom)" />
        <Markdown text="**bien**" />
      </>,
    ));
    expect(container.querySelector("pre.md-raw")?.textContent).toBe("[a](https://x.com/boom)");
    expect(screen.getByRole("alert").textContent).toContain("fallo de render");
    expect(container.querySelector("strong")?.textContent).toBe("bien");
  });

  it("en streaming, el texto siguiente recupera el render", () => {
    const view = render(wrap(<Markdown text="[a](https://x.com/boom)" live />));
    expect(screen.queryByRole("alert")).not.toBeNull();
    view.rerender(wrap(<Markdown text="[a](https://x.com/ok)" live />));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("link", { name: "a" })).not.toBeNull();
  });

  it("MarkdownBlocks aísla el trozo malo", () => {
    const { container } = render(wrap(<MarkdownBlocks blocks={["uno\n\n", "[a](https://x.com/boom)\n\n", "tres\n\n"]} />));
    expect(container.textContent).toContain("uno");
    expect(container.textContent).toContain("tres");
    expect(container.querySelector("pre.md-raw")?.textContent).toContain("boom");
  });
});
