// Settings/api-keys/GithubTokenCard.tsx — subseccion del token de GitHub,
// persistido aparte via `set_github_token` (~/.ultron/.env), no via
// `set_env_vars_keys` (setx).

import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { handleExternalClick } from "../../../lib/openExternal";
import { EyeIcon } from "./EyeIcon";
import { GITHUB_TOKEN_TUTORIAL } from "./key-catalog";
import { TutorialDisclosure } from "./TutorialDisclosure";
import type { GithubTokenResult } from "./types";

export function GithubTokenCard() {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<GithubTokenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentMasked, setCurrentMasked] = useState<string | null>(null);

  // Check whether a token is already stored (peek at env via a quick invoke).
  // We reuse `get_env_keys_status` — GITHUB_TOKEN is not in that list, so we
  // fall back to a one-shot set_github_token dry-run approach instead.
  // The simplest correct approach: call set_github_token with the placeholder
  // "ULTRON_CHECK" which the backend will reject, giving us the current state
  // indirectly. Instead we just load the .env line directly from a dedicated
  // check. Since no dedicated read command exists we show the masked value
  // returned by a previous save (persisted in state). On mount we call
  // get_env_keys_status and look for a GITHUB_TOKEN-equivalent — it won't be
  // there (not in ALLOWED_KEYS), so we rely on the save result to update the
  // displayed masked value.
  //
  // A future improvement: add a `get_github_token_status` command.

  const handleSave = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("El token no puede estar vacío.");
      return;
    }
    setSaving(true);
    setResult(null);
    setError(null);
    try {
      const r = await invoke<GithubTokenResult>("set_github_token", { token: trimmed });
      setResult(r);
      if (r.ok) {
        setCurrentMasked(r.masked);
        setValue("");
      } else {
        setError(r.message);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [value]);

  return (
    <div>
      {/* Subsection divider */}
      <div
        className="mb-4 mt-8 border-t pt-5"
        style={{ borderColor: "var(--color-border)" }}
      >
        <h3 className="mb-1 text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
          GitHub Token
        </h3>
        <p
          className="mb-3 text-[12px] leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Usado por el AI Router y los workflows que acceden a la GitHub API.
          Se persiste en{" "}
          <code
            className="rounded px-1 py-px text-[11px]"
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border)",
            }}
          >
            ~/.ultron/.env
          </code>{" "}
          y se aplica al proceso actual sin reiniciar.
        </p>
      </div>

      <label
        className="mb-1 flex items-center justify-between text-[12px] font-medium"
        htmlFor="apikey-GITHUB_TOKEN"
      >
        <span className="flex items-center gap-2">
          GitHub Token
          {currentMasked ? (
            <span
              className="rounded px-1.5 py-px text-[10px] font-medium tabular-nums"
              style={{
                fontFamily: "var(--font-mono)",
                background: "rgba(63, 185, 80, 0.10)",
                color: "var(--color-success)",
                border: "1px solid rgba(63,185,80,0.30)",
              }}
            >
              configurado
            </span>
          ) : (
            <span
              className="rounded px-1.5 py-px text-[10px]"
              style={{
                background: "var(--color-surface-1)",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border)",
              }}
            >
              sin configurar
            </span>
          )}
        </span>
        <a
          href="https://github.com/settings/tokens"
          target="_blank"
          onClick={handleExternalClick}
          rel="noopener noreferrer"
          className="text-[10.5px] transition-colors"
          style={{ color: "var(--color-accent)" }}
          tabIndex={-1}
        >
          Obtener token ↗
        </a>
      </label>

      <div className="flex items-center gap-1.5">
        <div className="relative flex-1" style={{ fontFamily: "var(--font-mono)" }}>
          <input
            id="apikey-GITHUB_TOKEN"
            type={visible ? "text" : "password"}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={value}
            onChange={(e) => { setValue(e.target.value); setResult(null); setError(null); }}
            placeholder={
              currentMasked
                ? `ya configurado (${currentMasked}) — escribe para reemplazar`
                : "ghp_… / github_pat_…"
            }
            className="w-full rounded px-2.5 py-1.5 text-[12px] outline-none transition-colors"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text)",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--color-accent)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--color-border-strong)"; }}
          />
        </div>
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          title={visible ? "Ocultar" : "Mostrar"}
          className="flex shrink-0 items-center justify-center rounded p-1.5 transition-colors"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-text-secondary)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--color-text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-text-secondary)"; }}
        >
          <EyeIcon crossed={visible} />
        </button>
        <span
          className="shrink-0 rounded px-1.5 py-px text-[10px] tabular-nums"
          style={{
            fontFamily: "var(--font-mono)",
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          GITHUB_TOKEN
        </span>
      </div>

      <TutorialDisclosure tutorial={GITHUB_TOKEN_TUTORIAL} />

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !value.trim()}
          className="rounded px-4 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {saving ? "Guardando…" : "Save token"}
        </button>
      </div>

      {error && (
        <div
          className="mt-3 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248,81,73,0.06)",
            border: "1px solid rgba(248,81,73,0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {result?.ok && (
        <div
          className="mt-3 rounded p-3 text-[12px]"
          style={{
            background: "rgba(63,185,80,0.06)",
            border: "1px solid rgba(63,185,80,0.22)",
            color: "var(--color-success)",
          }}
        >
          {result.message}
        </div>
      )}
    </div>
  );
}
