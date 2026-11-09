// Relevo por la API de Anthropic (créditos del plan) antes de Codex: destino
// del composer, nombre en el banner y cuota del HUD.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RelayBanner, relayTarget } from "../components/composer/RelayBanner";
import { relayQuotaText } from "../components/hud/hud-data";
import type { RelayState } from "../types";

const relay = (activeEngine: RelayState["activeEngine"]): RelayState =>
  ({ sessionId: "s1", activeEngine, since: "2026-10-28T20:00:00Z", taskIds: [], failedPrompt: "", handoff: "" }) as RelayState;

describe("relevo por la API de Anthropic", () => {
  it("el composer apunta a OpenCode y no a Codex", () => {
    expect(relayTarget("claude", relay("opencode"), false)).toBe("opencode");
    expect(relayTarget("claude", relay("codex"), false)).toBe("codexLocal");
    expect(relayTarget("gemini", relay("opencode"), true)).toBe("gemini");
  });

  it("el banner dice Claude API", () => {
    render(<RelayBanner relay={relay("opencode")} onReturn={() => {}} onGemini={() => {}} />);
    expect(screen.getByText(/Relevo: Claude API sigue el trabajo/)).toBeTruthy();
  });

  it("el HUD no busca cuota de Codex para la API", () => {
    expect(relayQuotaText(null, null, "opencode")).toBe("créditos API");
    expect(relayQuotaText(null, null, "codex")).toBe("consultando uso…");
  });
});
