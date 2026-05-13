import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SpawnResult, GeminiResult } from "../types";

// ---------------------------------------------------------------------------
// Provider card
// ---------------------------------------------------------------------------

type Provider = "claude" | "gemini" | "codex";

const PROVIDER_META: Record<
  Provider,
  { label: string; tagline: string; accent: string }
> = {
  claude: {
    label: "Claude",
    tagline: "Anthropic CLI · primary coding partner",
    accent: "var(--color-success)",
  },
  gemini: {
    label: "Gemini",
    tagline: "Google CLI · long-context + image",
    accent: "var(--color-warn)",
  },
  codex: {
    label: "Codex",
    tagline: "OpenAI CLI · peer review / second opinion",
    accent: "var(--color-purple, #a875ff)",
  },
};

function SpawnCard({ provider }: { provider: Provider }) {
  const meta = PROVIDER_META[provider];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      await invoke<SpawnResult>("spawn_session", { provider });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline gap-2">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: meta.accent }}
        />
        <h3 className="text-[14px] font-semibold leading-none">{meta.label}</h3>
      </div>
      <p
        className="mt-2 text-[12px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {meta.tagline}
      </p>
      <button
        type="button"
        onClick={open}
        disabled={busy}
        className="mt-3 w-full rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
        style={{
          background: "var(--color-accent)",
          color: "var(--color-accent-text)",
        }}
      >
        {busy ? "Opening…" : "Open session"}
      </button>
      {error && (
        <p
          className="mt-2 text-[11px]"
          style={{ color: "var(--color-danger)" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gemini inline form
// ---------------------------------------------------------------------------

const GEMINI_MODELS = [
  { id: "gemini-3.1-pro-preview", label: "3.1 Pro · best quality" },
  { id: "gemini-3.1-flash-lite", label: "3.1 Flash Lite · fast" },
  { id: "gemini-2.5-pro", label: "2.5 Pro · stable" },
  { id: "gemini-2.5-flash", label: "2.5 Flash · stable fast" },
];

function GeminiInline() {
  const [model, setModel] = useState(GEMINI_MODELS[0].id);
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState<GeminiResult | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    if (!prompt.trim()) return;
    setRunning(true);
    setOutput(null);
    try {
      const r = (await invoke("run_gemini", { model, prompt })) as GeminiResult;
      setOutput(r);
    } catch (e) {
      setOutput({
        success: false,
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
    } finally {
      setRunning(false);
    }
  }

  function clear() {
    setPrompt("");
    setOutput(null);
  }

  return (
    <section
      className="rounded p-5"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[14px] font-semibold">Gemini quick prompt</h2>
        <span className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
          inline · stdout to this panel
        </span>
      </header>

      <div className="flex items-center gap-3">
        <label
          className="text-[11px]"
          style={{ color: "var(--color-text-tertiary)" }}
          htmlFor="gemini-model"
        >
          Model
        </label>
        <select
          id="gemini-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="rounded px-2 py-1 text-[12px]"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {GEMINI_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Type a prompt…  (Ctrl+Enter to send)"
        rows={5}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            run();
          }
        }}
        className="mt-3 w-full rounded px-3 py-2 text-[12.5px] leading-relaxed"
        style={{
          background: "var(--color-surface-1)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border-strong)",
          fontFamily: "var(--font-mono)",
          outline: "none",
          resize: "vertical",
        }}
      />

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={run}
          disabled={running || !prompt.trim()}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {running ? "Running…" : "Run"}
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={clear}
            disabled={running}
            className="rounded px-2 py-1.5 text-[11px] transition-colors"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Clear
          </button>
          {output && output.stdout && (
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(output.stdout)}
              className="rounded px-2 py-1.5 text-[11px] transition-colors"
              style={{
                background: "transparent",
                color: "var(--color-text-secondary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              Copy output
            </button>
          )}
        </div>
      </div>

      {output && (
        <pre
          className="mt-3 max-h-96 overflow-auto rounded p-3 text-[11.5px] leading-relaxed"
          style={{
            background: "var(--color-surface-1)",
            border: `1px solid ${output.success ? "var(--color-border)" : "rgba(248, 81, 73, 0.22)"}`,
            fontFamily: "var(--font-mono)",
            color: output.success
              ? "var(--color-text)"
              : "var(--color-danger)",
            whiteSpace: "pre-wrap",
          }}
        >
          {output.stdout || output.stderr || "(no output)"}
          {output.exit_code !== null && output.exit_code !== 0 && (
            <div className="mt-2" style={{ color: "var(--color-text-tertiary)" }}>
              — exit {output.exit_code}
            </div>
          )}
        </pre>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function Sessions() {
  return (
    <div className="px-10 py-8">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold leading-tight">Sessions</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
          Quick spawn of CLI sessions · inline Gemini for one-shot prompts
        </p>
      </header>

      <div className="grid grid-cols-3 gap-3">
        <SpawnCard provider="claude" />
        <SpawnCard provider="gemini" />
        <SpawnCard provider="codex" />
      </div>

      <div className="mt-6">
        <GeminiInline />
      </div>
    </div>
  );
}
