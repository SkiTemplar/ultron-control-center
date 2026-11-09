import { describe, expect, it, vi } from "vitest";
import { PetRectPublisher, THROTTLE_MS, toPhysRect, type PhysRect } from "../petRect";

const env = { origin_x: -2560, origin_y: 291, scale_factor: 1.5 };

describe("toPhysRect", () => {
  it("pasa la caja CSS a px físicos de pantalla con el origen del monitor", () => {
    expect(toPhysRect({ x: 100, y: 200, w: 40, h: 30 }, env)).toEqual([-2410, 591, -2350, 636]);
  });

  it("redondea hacia fuera para no perder el borde", () => {
    expect(toPhysRect({ x: 0.4, y: 0.4, w: 1, h: 1 }, { origin_x: 0, origin_y: 0, scale_factor: 1.25 })).toEqual([0, 0, 2, 2]);
  });
});

describe("PetRectPublisher", () => {
  const ok = () => vi.fn<(r: PhysRect | null) => Promise<unknown>>(() => Promise.resolve());

  it("publica solo los cambios y como mucho cada THROTTLE_MS", () => {
    const send = ok();
    const p = new PetRectPublisher(send);
    p.publish([0, 0, 10, 10], 0);
    p.publish([0, 0, 10, 10], 500);
    expect(send).toHaveBeenCalledTimes(1);
    p.publish([1, 0, 11, 10], 600);
    expect(send).toHaveBeenCalledTimes(2);
    p.publish([2, 0, 12, 10], 650);
    expect(send).toHaveBeenCalledTimes(2);
    p.publish([2, 0, 12, 10], 600 + THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith([2, 0, 12, 10]);
  });

  it("null (no se le puede soltar nada) sale al momento, sin esperar al throttle", () => {
    const send = ok();
    const p = new PetRectPublisher(send);
    p.publish([0, 0, 10, 10], 0);
    p.publish(null, 1);
    expect(send).toHaveBeenLastCalledWith(null);
  });

  it("caso negativo: si el envío falla, el siguiente fotograma lo reintenta", async () => {
    const send = vi.fn<(r: PhysRect | null) => Promise<unknown>>(() => Promise.reject(new Error("sin IPC")));
    const p = new PetRectPublisher(send);
    p.publish(null, 0);
    await Promise.resolve();
    await Promise.resolve();
    p.publish(null, 1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
