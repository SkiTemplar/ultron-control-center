import { describe, expect, it } from "vitest";
import { formatAgeMs, formatRelativeTime } from "./relative-time";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const H = 3_600_000;
const D = 24 * H;

describe("formatRelativeTime", () => {
  it("convierte un ISO crudo en antigüedad relativa", () => {
    expect(formatRelativeTime("2026-10-18T09:00:00Z", NOW)).toBe("hace 3 h");
    expect(formatRelativeTime("2026-10-18T11:45:00Z", NOW)).toBe("hace 15 min");
    expect(formatRelativeTime("2026-10-16T12:00:00Z", NOW)).toBe("hace 2 d");
  });

  it("pasa a meses y años en fechas viejas", () => {
    expect(formatRelativeTime("2026-07-20T12:01:00Z", NOW)).toBe("hace 3 meses");
    expect(formatAgeMs(95 * D)).toBe("hace 3 meses");
    expect(formatAgeMs(31 * D)).toBe("hace 1 mes");
    expect(formatAgeMs(400 * D)).toBe("hace 1 año");
    expect(formatAgeMs(800 * D)).toBe("hace 2 años");
  });

  it("acepta fechas sin hora", () => {
    expect(formatRelativeTime("2026-10-15", NOW)).toBe("hace 3 d");
  });

  it("devuelve null sin fecha o con una fecha ilegible", () => {
    expect(formatRelativeTime(null, NOW)).toBeNull();
    expect(formatRelativeTime("", NOW)).toBeNull();
    expect(formatRelativeTime("ayer", NOW)).toBeNull();
  });

  it("no inventa un futuro: fechas posteriores a ahora son «ahora mismo»", () => {
    expect(formatRelativeTime("2026-10-18T13:00:00Z", NOW)).toBe("ahora mismo");
    expect(formatAgeMs(30_000)).toBe("ahora mismo");
  });
});
