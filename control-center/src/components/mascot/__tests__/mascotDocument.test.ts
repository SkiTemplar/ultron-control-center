import { afterEach, describe, expect, it } from "vitest";
import { MASCOT_ROOT_CLASS, prepareMascotDocument } from "../mascotDocument";

afterEach(() => document.documentElement.classList.remove(MASCOT_ROOT_CLASS));

describe("prepareMascotDocument", () => {
  it("en /mascot pone el fondo transparente al momento, sin esperar a React", () => {
    expect(prepareMascotDocument("/mascot")).toBe(true);
    expect(document.documentElement.classList.contains(MASCOT_ROOT_CLASS)).toBe(true);
  });

  it("en cualquier otra ventana no toca el documento", () => {
    expect(prepareMascotDocument("/")).toBe(false);
    expect(prepareMascotDocument("/detached/project")).toBe(false);
    expect(document.documentElement.classList.contains(MASCOT_ROOT_CLASS)).toBe(false);
  });
});
