// Ratón sobre la mascota (pointerPress.ts): un puntero cancelado no cuenta
// como clic; soltarlo sí.

import { describe, expect, it, vi } from "vitest";
import type { PointerEvent } from "react";
import type { MascotEngine } from "../engine";
import { pressHandlers, type Press } from "../pointerPress";

function setup() {
  const eng = { startDrag: vi.fn(), dragTo: vi.fn(), endDrag: vi.fn(), poke: vi.fn() };
  const onClick = vi.fn();
  const pressRef = { current: null as Press | null };
  const h = pressHandlers({
    pressRef,
    engineRef: { current: eng as unknown as MascotEngine },
    driveRef: { current: false },
    cursorRef: { current: null },
    onClick,
  });
  const ev = (x: number, y: number) =>
    ({
      button: 0,
      pointerId: 1,
      clientX: x,
      clientY: y,
      ctrlKey: false,
      currentTarget: { setPointerCapture: vi.fn() },
    }) as unknown as PointerEvent<HTMLDivElement>;
  return { eng, onClick, pressRef, h, ev };
}

describe("pressHandlers", () => {
  it("pulsar y soltar sin moverse es un clic", () => {
    const t = setup();
    t.h.onPointerDown(t.ev(10, 10));
    t.h.onPointerUp(t.ev(11, 10));
    expect(t.onClick).toHaveBeenCalledTimes(1);
    expect(t.onClick).toHaveBeenCalledWith(t.eng);
    expect(t.pressRef.current).toBeNull();
  });

  it("un puntero cancelado no es un clic: ni abre avisos ni salta (negativo)", () => {
    const t = setup();
    t.h.onPointerDown(t.ev(10, 10));
    t.h.onPointerCancel(t.ev(10, 10));
    expect(t.onClick).not.toHaveBeenCalled();
    expect(t.eng.endDrag).not.toHaveBeenCalled();
    expect(t.pressRef.current).toBeNull();
    // Un pointerup posterior sin pulsación nueva tampoco cuenta.
    t.h.onPointerUp(t.ev(10, 10));
    expect(t.onClick).not.toHaveBeenCalled();
  });

  it("cancelado a mitad de arrastre: lo suelta, sin clic", () => {
    const t = setup();
    t.h.onPointerDown(t.ev(10, 10));
    t.h.onPointerMove(t.ev(40, 10));
    expect(t.eng.startDrag).toHaveBeenCalledTimes(1);
    t.h.onPointerCancel(t.ev(40, 10));
    expect(t.eng.endDrag).toHaveBeenCalledWith(false);
    expect(t.onClick).not.toHaveBeenCalled();
  });

  it("arrastrar y soltar lanza, sin clic", () => {
    const t = setup();
    t.h.onPointerDown(t.ev(10, 10));
    t.h.onPointerMove(t.ev(40, 10));
    t.h.onPointerUp(t.ev(40, 10));
    expect(t.eng.endDrag).toHaveBeenCalledTimes(1);
    expect(t.onClick).not.toHaveBeenCalled();
  });
});
