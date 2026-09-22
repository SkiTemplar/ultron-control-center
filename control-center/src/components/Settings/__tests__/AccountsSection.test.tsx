// AccountsSection — informe de cuentas/modelos: estados con datos, sin
// sesión, y refresco vía el botón "Actualizar modelos".

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AccountsSection } from "../AccountsSection";

const REPORT_WITH_DATA = {
  accounts: [
    {
      provider: "claude",
      label: "Claude",
      account: "yo@ejemplo.com",
      account_source: "~/.claude/.credentials.json (claudeAiOauth.emailAddress)",
      access: "api_key",
      key_tail: "…9f2a",
      plan: "Claude Max 5x",
      plan_source: "~/.claude/.credentials.json (claudeAiOauth.subscriptionType)",
      warnings: [
        "ANTHROPIC_API_KEY está definida: Claude Code facturará por API en vez de usar la suscripción.",
      ],
    },
    {
      provider: "codex",
      label: "Codex (ChatGPT)",
      account: "yo@ejemplo.com",
      account_source: "~/.codex/auth.json (id_token)",
      access: "subscription",
      key_tail: "",
      plan: "ChatGPT Plus",
      plan_source: "~/.codex/auth.json (id_token: chatgpt_plan_type)",
      warnings: [],
    },
  ],
  models: [
    {
      provider: "claude",
      allowed: ["claude-opus-4-6", "claude-fable-5-1"],
      denied: ["claude-mythos"],
      default_model: "",
      source: "~/.claude.json",
      at: "2026-09-22T10:00:00Z",
    },
    {
      provider: "codex",
      allowed: ["gpt-6-sol", "gpt-6-astra"],
      denied: [],
      default_model: "gpt-6-astra",
      source: "~/.codex/models_cache.json",
      at: "2026-09-22T10:00:00Z",
    },
  ],
  distinct_emails: ["yo@ejemplo.com"],
  warnings: [],
};

const REPORT_NO_SESSION = {
  accounts: [
    {
      provider: "antigravity",
      label: "Antigravity (agy)",
      account: "",
      account_source: "agy no encontrada",
      access: "no_access",
      key_tail: "",
      plan: "",
      plan_source: "",
      warnings: [
        "sin sesión: ejecuta `agy` en una terminal para iniciar sesión.",
      ],
    },
  ],
  models: [
    {
      provider: "antigravity",
      allowed: [],
      denied: [],
      default_model: "",
      source: "sin sondear todavía — pulsa «Actualizar modelos»",
      at: "",
    },
  ],
  distinct_emails: [],
  warnings: [],
};

describe("AccountsSection", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("muestra plan, acceso, aviso y modelos permitidos/vetados de cada cuenta", async () => {
    vi.mocked(invoke).mockResolvedValue(REPORT_WITH_DATA);
    render(<AccountsSection />);

    await waitFor(() => expect(screen.getByText("Claude Max 5x")).toBeTruthy());
    expect(screen.getByText("ChatGPT Plus")).toBeTruthy();
    expect(screen.getAllByText("yo@ejemplo.com").length).toBeGreaterThan(0);
    expect(screen.getByText(/ANTHROPIC_API_KEY está definida/)).toBeTruthy();
    expect(screen.getByText("claude-opus-4-6")).toBeTruthy();
    expect(screen.getByText("claude-mythos")).toBeTruthy();
    expect(screen.getAllByText("gpt-6-astra").length).toBeGreaterThan(0);
  });

  it("estado sin sesión se explica en vez de dejar la sección en blanco", async () => {
    vi.mocked(invoke).mockResolvedValue(REPORT_NO_SESSION);
    render(<AccountsSection />);

    await waitFor(() =>
      expect(screen.getByText(/ejecuta `agy` en una terminal para iniciar sesión/)).toBeTruthy(),
    );
    expect(screen.getByText("Sin acceso")).toBeTruthy();
    expect(screen.getByText("cuenta no expuesta por la CLI")).toBeTruthy();
    expect(screen.getByText("(ninguno detectado)")).toBeTruthy();
  });

  it("un fallo del comando se muestra como error, no como pantalla en blanco", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("boom"));
    render(<AccountsSection />);
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
  });

  it("Actualizar modelos vuelve a pedir el informe y refleja el resultado", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(REPORT_NO_SESSION)
      .mockResolvedValueOnce(REPORT_WITH_DATA);
    render(<AccountsSection />);

    await waitFor(() => expect(screen.getByText("Sin acceso")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Actualizar modelos/ }));

    await waitFor(() => expect(screen.getByText("Claude Max 5x")).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("accounts_refresh_models");
  });
});
