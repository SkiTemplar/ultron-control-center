// Marcadores del hilo (bookmarks.ts): funciones puras, clave por conversación,
// lectura defensiva del almacenamiento y persistencia entre «reinicios».

import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_BOOKMARKS, PREVIEW_CHARS, addBookmark, bookmarksOf, conversationKey, makeBookmark, parseBookmarks,
  previewOf, removeBookmark, sanitizeBookmarks, storageKey, toggleBookmark, updateBookmarks, type Bookmark,
} from "../bookmarks";

const bm = (uuid: string, role: Bookmark["role"] = "user"): Bookmark => ({ uuid, preview: `texto ${uuid}`, role, createdAt: "2026-10-14T10:00:00.000Z" });

beforeEach(() => window.localStorage.clear());

describe("clave de la conversación", () => {
  it("prefiere claudeSessionId y cae al id de la sesión", () => {
    expect(conversationKey({ id: "s1", claudeSessionId: "c1" })).toBe("c1");
    expect(conversationKey({ id: "s1", claudeSessionId: null })).toBe("s1");
    expect(conversationKey({ id: "s1", claudeSessionId: "" })).toBe("s1");
    expect(storageKey("c1")).toBe("ultron.sesiones.marcadores.c1");
  });
});

describe("añadir, quitar y alternar", () => {
  it("añade sin mutar y no duplica", () => {
    const empty: readonly Bookmark[] = [];
    const one = addBookmark(empty, bm("a"));
    expect(empty).toHaveLength(0);
    expect(one.map((b) => b.uuid)).toEqual(["a"]);
    expect(addBookmark(one, bm("a"))).toBe(one);
  });

  it("quitar lo que no está devuelve la misma lista", () => {
    const list = [bm("a"), bm("b")];
    expect(removeBookmark(list, "zzz")).toBe(list);
    expect(removeBookmark(list, "a").map((b) => b.uuid)).toEqual(["b"]);
    expect(list).toHaveLength(2);
  });

  it("alternar fija y desfija", () => {
    const on = toggleBookmark([], bm("a"));
    expect(on).toHaveLength(1);
    expect(toggleBookmark(on, bm("a"))).toHaveLength(0);
  });

  it("respeta el tope por conversación", () => {
    const full = Array.from({ length: MAX_BOOKMARKS }, (_, i) => bm(`m${i}`));
    expect(addBookmark(full, bm("extra"))).toBe(full);
  });
});

describe("entrada desde un mensaje", () => {
  it("recorta el extracto y conserva rol y uuid", () => {
    const long = "x".repeat(200);
    const b = makeBookmark({ uuid: "u", role: "assistant", blocks: [{ kind: "text", text: `  ${long}  ` }] }, new Date("2026-10-14T09:00:00Z"));
    expect(b).toMatchObject({ uuid: "u", role: "assistant", createdAt: "2026-10-14T09:00:00.000Z" });
    expect(b?.preview.length).toBe(PREVIEW_CHARS);
    expect(previewOf("a\n\n  b")).toBe("a b");
  });

  it("caso negativo: un mensaje del sistema no se fija", () => {
    expect(makeBookmark({ uuid: "s", role: "system", blocks: [] })).toBeNull();
  });
});

describe("almacenamiento corrupto", () => {
  it("JSON roto, no-array o entradas inválidas → lista vacía o filtrada, sin lanzar", () => {
    expect(parseBookmarks("{no es json")).toEqual([]);
    expect(parseBookmarks(null)).toEqual([]);
    expect(parseBookmarks('{"uuid":"a"}')).toEqual([]);
    const mixed = [bm("a"), { uuid: 3 }, null, { ...bm("b"), role: "system" }, bm("a"), "x"];
    expect(sanitizeBookmarks(mixed).map((b) => b.uuid)).toEqual(["a"]);
  });

  it("lee del almacenamiento una lista corrupta como vacía", () => {
    window.localStorage.setItem(storageKey("corrupta"), "[[[");
    expect(bookmarksOf("corrupta")).toEqual([]);
  });
});

describe("persistencia", () => {
  it("guarda por conversación y no mezcla conversaciones", () => {
    expect(updateBookmarks("conv-a", (l) => addBookmark(l, bm("a1")))).toBe(true);
    updateBookmarks("conv-b", (l) => addBookmark(l, bm("b1", "assistant")));
    expect(parseBookmarks(window.localStorage.getItem(storageKey("conv-a"))).map((b) => b.uuid)).toEqual(["a1"]);
    expect(parseBookmarks(window.localStorage.getItem(storageKey("conv-b"))).map((b) => b.uuid)).toEqual(["b1"]);
    expect(bookmarksOf("conv-a").map((b) => b.uuid)).toEqual(["a1"]);
  });

  it("al quitar el último se borra la clave", () => {
    updateBookmarks("conv-c", (l) => addBookmark(l, bm("c1")));
    updateBookmarks("conv-c", (l) => removeBookmark(l, "c1"));
    expect(window.localStorage.getItem(storageKey("conv-c"))).toBeNull();
  });

  it("una conversación nueva lee lo que dejó una sesión anterior", () => {
    window.localStorage.setItem(storageKey("conv-previa"), JSON.stringify([bm("p1")]));
    expect(bookmarksOf("conv-previa").map((b) => b.uuid)).toEqual(["p1"]);
  });
});
