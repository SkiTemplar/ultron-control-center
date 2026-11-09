import { describe, it, expect } from "vitest";
import { summarizeAutoTag, type AutoTagOutcome } from "../autoTagSummary";

const o = (status: AutoTagOutcome["status"], error?: string): AutoTagOutcome => ({
  session_id: "s",
  status,
  tags: status === "tagged" ? ["rust"] : [],
  error,
});

describe("summarizeAutoTag", () => {
  it("todo bien: no marca fallos", () => {
    const r = summarizeAutoTag([o("tagged"), o("tagged")]);
    expect(r).toEqual({ message: "Etiquetadas 2 de 2 sesiones", hasFailures: false });
  });

  it("cuenta las fallidas y enseña la primera causa", () => {
    const r = summarizeAutoTag([o("tagged"), o("failed", "router: groq 429"), o("failed", "guardar: x"), o("skipped")]);
    expect(r.hasFailures).toBe(true);
    expect(r.message).toBe(
      "Etiquetadas 1 de 4 sesiones; 1 sin primer mensaje; 2 fallidas (la primera: router: groq 429)",
    );
  });

  it("caso negativo: una saltada no cuenta como fallo", () => {
    expect(summarizeAutoTag([o("skipped")]).hasFailures).toBe(false);
  });
});
