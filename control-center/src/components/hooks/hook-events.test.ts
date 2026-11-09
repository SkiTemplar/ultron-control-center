// Catálogo único de eventos de hook: la lista de la interfaz ES el JSON que el
// backend incluye con include_str! (src-tauri/src/hooks_admin/validation.rs).

import { describe, expect, it } from "vitest";
import hookEvents from "./hook-events.json";
import { EVENT_OPTIONS } from "./constants";

describe("catálogo de eventos de hook", () => {
  it("EVENT_OPTIONS es exactamente el JSON compartido con el backend", () => {
    expect([...EVENT_OPTIONS]).toEqual(hookEvents);
  });

  it("tiene 33 eventos (Claude Code 2.1.309), sin duplicados y con nombres PascalCase", () => {
    expect(hookEvents).toHaveLength(33);
    expect(new Set(hookEvents).size).toBe(hookEvents.length);
    for (const e of hookEvents) expect(e).toMatch(/^[A-Z][A-Za-z]+$/);
  });

  it("incluye los eventos que el backend rechazaba antes de unificar", () => {
    for (const e of ["PostToolUseFailure", "StopFailure", "PermissionDenied", "WorktreeCreate", "ElicitationResult"]) {
      expect(EVENT_OPTIONS).toContain(e);
    }
  });
});
