// useLoadOlder: la página anterior se pide con un gesto hacia arriba aunque el
// desplazamiento ya esté en el tope (sin evento `scroll`), y nunca sin gesto
// mientras el chat sigue anclado abajo.

import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OLDER_RETRY_BASE_MS, useLoadOlder } from "../components/chat/scroll-hooks";

function Harness({ canLoad, stuck, onLoadOlder, count = 10 }: { canLoad: boolean; stuck: boolean; onLoadOlder: () => void; count?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(stuck);
  useLoadOlder(ref, stuckRef, canLoad, onLoadOlder, count);
  return <div ref={ref} data-testid="sc" tabIndex={0} />;
}

function setup(canLoad: boolean, stuck = true) {
  const onLoadOlder = vi.fn();
  const r = render(<Harness canLoad={canLoad} stuck={stuck} onLoadOlder={onLoadOlder} />);
  const el = r.container.querySelector("[data-testid=sc]") as HTMLDivElement;
  Object.defineProperty(el, "scrollHeight", { value: 5000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 600, configurable: true });
  onLoadOlder.mockClear();
  return { el, onLoadOlder };
}

describe("useLoadOlder", () => {
  it("rueda hacia arriba en el tope pide la página anterior aunque siga anclado", () => {
    const { el, onLoadOlder } = setup(true);
    el.scrollTop = 0;
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("Inicio o RePág en el tope también la piden", () => {
    const { el, onLoadOlder } = setup(true);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it("caso negativo: rueda hacia abajo, lejos del tope o sin más páginas no pide nada", () => {
    const { el, onLoadOlder } = setup(true);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }));
    el.scrollTop = 2000;
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
    expect(onLoadOlder).not.toHaveBeenCalled();
    const sin = setup(false);
    sin.el.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
    expect(sin.onLoadOlder).not.toHaveBeenCalled();
  });

  it("un scroll sin gesto con el chat anclado no carga nada", async () => {
    const { el, onLoadOlder } = setup(true, true);
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  describe("tras un fallo de la página anterior", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Hilo desanclado cerca del tope: la carga automática pide la página al montar. */
    function failing() {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(0);
      const onLoadOlder = vi.fn();
      const r = render(<Harness canLoad stuck={false} onLoadOlder={onLoadOlder} />);
      const el = r.container.querySelector("[data-testid=sc]") as HTMLDivElement;
      expect(onLoadOlder).toHaveBeenCalledTimes(1);
      // `loadOlder` marca `loading` y falla: `canLoad` vuelve a `true` sin mensajes nuevos.
      r.rerender(<Harness canLoad={false} stuck={false} onLoadOlder={onLoadOlder} />);
      r.rerender(<Harness canLoad stuck={false} onLoadOlder={onLoadOlder} />);
      return { el, onLoadOlder, rerender: r.rerender };
    }

    it("caso negativo: no vuelve a pedirla sola en bucle", () => {
      const { onLoadOlder, rerender } = failing();
      expect(onLoadOlder).toHaveBeenCalledTimes(1);
      rerender(<Harness canLoad stuck={false} onLoadOlder={onLoadOlder} />);
      expect(onLoadOlder).toHaveBeenCalledTimes(1);
    });

    it("un gesto la reintenta solo pasada la espera, que crece con cada fallo", () => {
      const { el, onLoadOlder, rerender } = failing();
      const wheelUp = () => el.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
      wheelUp();
      expect(onLoadOlder).toHaveBeenCalledTimes(1);
      vi.setSystemTime(OLDER_RETRY_BASE_MS);
      wheelUp();
      expect(onLoadOlder).toHaveBeenCalledTimes(2);
      // Segundo fallo seguido: la espera se duplica.
      rerender(<Harness canLoad={false} stuck={false} onLoadOlder={onLoadOlder} />);
      rerender(<Harness canLoad stuck={false} onLoadOlder={onLoadOlder} />);
      vi.setSystemTime(OLDER_RETRY_BASE_MS * 2);
      wheelUp();
      expect(onLoadOlder).toHaveBeenCalledTimes(2);
      vi.setSystemTime(OLDER_RETRY_BASE_MS * 3);
      wheelUp();
      expect(onLoadOlder).toHaveBeenCalledTimes(3);
    });

    it("una carga que trae mensajes reanuda la carga automática", () => {
      const { el, onLoadOlder, rerender } = failing();
      vi.setSystemTime(OLDER_RETRY_BASE_MS);
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
      expect(onLoadOlder).toHaveBeenCalledTimes(2);
      rerender(<Harness canLoad={false} stuck={false} onLoadOlder={onLoadOlder} count={10} />);
      rerender(<Harness canLoad stuck={false} onLoadOlder={onLoadOlder} count={60} />);
      expect(onLoadOlder).toHaveBeenCalledTimes(3);
    });
  });
});
