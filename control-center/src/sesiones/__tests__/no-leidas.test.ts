// Respuestas nuevas sin leer: un turno que termina fuera de la vista deja marca y
// mostrarla en un panel la borra. Casos negativos: una sesión a la vista o un turno
// interrumpido no dejan marca.

import { beforeEach, describe, expect, it } from "vitest";
import { clearSeen, markTurnUnread, unreadStore } from "../unread";
import { emptyWorkspace, showInFocused, type Workspace } from "../workspace";

const withA: Workspace = showInFocused(emptyWorkspace, "a");

beforeEach(() => unreadStore.dispatch(() => new Set()));

describe("no leídas", () => {
  it("marca la sesión que no está en ningún panel y la borra al mostrarla", () => {
    markTurnUnread({ id: "b", reason: "answer" }, withA);
    expect(unreadStore.getState().has("b")).toBe(true);
    clearSeen(showInFocused(withA, "b"));
    expect(unreadStore.getState().has("b")).toBe(false);
  });

  it("caso negativo: la sesión a la vista y los turnos interrumpidos no se marcan", () => {
    markTurnUnread({ id: "a", reason: "answer" }, withA);
    markTurnUnread({ id: "b", reason: "aborted" }, withA);
    expect(unreadStore.getState().size).toBe(0);
  });
});
