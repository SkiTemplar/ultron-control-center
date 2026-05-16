// ULTRON Control Center — Codex fallback button.
//
// One-click "switch to Codex with context" affordance. Lives at the top of
// the Sessions tab. The actual context assembly happens in the Rust backend
// (see src-tauri/src/codex_fallback.rs); this component is a thin UI:
//
//   1. Click button         -> calls build_fallback_prompt, opens modal
//   2. Modal previews the prompt
//   3. User can either copy the prompt OR launch a Codex session with it
//
// The handoff goes through the same spawn-session plumbing the rest of the
// Sessions tab uses, so window/PowerShell/wt.exe quoting is owned in ONE
// place (sessions.rs).
//
// We accept a `cwd` prop so the parent Sessions component can pass through
// whatever workspace the user has selected. Default is the empty string,
// which lets the Codex session start wherever the spawn script decides.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Props = {
  cwd?: string;
  onToast?: (msg: string) => void;
};

export function CodexFallbackButton({ cwd, onToast }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [copied, setCopied] = useState(false);
  const [prompt, setPrompt] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  async function openPreview() {
    setError(null);
    setCopied(false);
    setLoading(true);
    setOpen(true);
    try {
      const built = await invoke<string>("build_fallback_prompt");
      setPrompt(built);
    } catch (e) {
      setError(String(e));
      setPrompt("");
    } finally {
      setLoading(false);
    }
  }

  function close() {
    if (launching) return; // don't yank the modal mid-launch
    setOpen(false);
    setPrompt("");
    setError(null);
    setCopied(false);
  }

  async function copyToClipboard() {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      // Reset the visual confirmation after a couple seconds so the user
      // can copy again if they edited the source in the meantime.
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      // navigator.clipboard can fail under sandboxed contexts; we surface
      // the error inline rather than aborting the modal.
      setError(`clipboard: ${e}`);
    }
  }

  async function launch() {
    setError(null);
    setLaunching(true);
    try {
      await invoke<string>("launch_codex_fallback", {
        cwd: cwd && cwd.trim() ? cwd : null,
      });
      if (onToast) onToast("Codex session spawned");
      setOpen(false);
      setPrompt("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLaunching(false);
    }
  }

  return (
    <>
      <section
        className="rounded p-4"
        style={{
          background: "rgba(248, 168, 73, 0.06)",
          border: "1px solid rgba(248, 168, 73, 0.28)",
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div
              className="text-[10px] font-medium uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Fallback
            </div>
            <div
              className="mt-0.5 text-[13px] font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              Claude rate-limited? -&gt; Switch to Codex with context
            </div>
            <div
              className="mt-0.5 text-[11.5px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Empaqueta skill activa, tarea, contexto L0, señales y últimas
              interacciones, y abre una sesión Codex con ese prompt.
            </div>
          </div>
          <button
            type="button"
            onClick={openPreview}
            className="shrink-0 rounded px-3 py-2 text-[12.5px] font-semibold transition-colors"
            style={{
              background: "rgba(248, 168, 73, 0.18)",
              color: "var(--color-text)",
              border: "1px solid rgba(248, 168, 73, 0.45)",
            }}
            title="Preview the prompt before launching Codex"
          >
            Preview & launch
          </button>
        </div>
      </section>

      {open && (
        <div
          // Fullscreen modal backdrop. Click outside the inner card closes it.
          className="fixed inset-0 z-[60] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={close}
        >
          <div
            className="w-[760px] max-w-[92vw] rounded p-5"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border-strong)",
              boxShadow: "0 12px 32px rgba(0,0,0,0.7)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-baseline justify-between">
              <div>
                <h2 className="text-[15px] font-semibold leading-tight">
                  Codex fallback · prompt preview
                </h2>
                <p
                  className="mt-0.5 text-[11.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  Revisa lo que Codex va a recibir. Si todo cuadra, lanza la
                  sesión.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                disabled={launching}
                className="text-[11.5px] transition-colors disabled:opacity-40"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                close
              </button>
            </div>

            {loading && (
              <div
                className="rounded p-6 text-center text-[12.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                Cargando contexto...
              </div>
            )}

            {!loading && error && (
              <div
                className="rounded p-3 text-[11.5px]"
                style={{
                  background: "rgba(248, 81, 73, 0.08)",
                  border: "1px solid rgba(248, 81, 73, 0.32)",
                  color: "var(--color-danger)",
                }}
              >
                {error}
              </div>
            )}

            {!loading && !error && (
              <pre
                className="max-h-96 overflow-auto whitespace-pre-wrap rounded p-3 text-[11.5px] leading-relaxed"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {prompt || "(prompt vacío — no se encontró contexto)"}
              </pre>
            )}

            <div className="mt-3 flex items-center justify-between gap-2">
              <span
                className="text-[10.5px] tabular-nums"
                style={{ color: "var(--color-text-faint)" }}
              >
                {prompt
                  ? `${prompt.length.toLocaleString()} chars`
                  : ""}
                {cwd ? ` · cwd: ${cwd}` : ""}
              </span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={close}
                  disabled={launching}
                  className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40"
                  style={{
                    background: "transparent",
                    color: "var(--color-text-tertiary)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={copyToClipboard}
                  disabled={!prompt || launching}
                  className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                >
                  {copied ? "Copied" : "Copy to clipboard"}
                </button>
                <button
                  type="button"
                  onClick={launch}
                  disabled={!prompt || launching}
                  className="rounded px-3 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-40"
                  style={{
                    background: "var(--color-accent)",
                    color: "var(--color-accent-text)",
                  }}
                >
                  {launching ? "Launching..." : "Launch Codex session"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
