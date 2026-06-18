import { useEffect, useState } from "react";
import type { SessionProvider } from "../../types";
import { PROVIDERS } from "./constants";
import { deriveWorkspaceName } from "./utils";
import type { LauncherModalProps } from "./types";

export function LauncherModal({
  mode,
  workspace,
  busy,
  onClose,
  onLaunch,
}: LauncherModalProps) {
  const [provider, setProvider] = useState<SessionProvider>("claude");
  const [model, setModel] = useState<string>(PROVIDERS.claude.defaultModel);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const headline = workspace.project_name ?? deriveWorkspaceName(workspace.cwd);
  const title =
    mode === "custom" ? "Custom launch" : "Send context to a new session";
  const launchLabel =
    mode === "custom" ? "Launch" : "Launch with context";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex w-full max-w-xl flex-col rounded-lg shadow-xl"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <div
          className="flex items-center justify-between border-b px-4 py-2.5"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">{title}</div>
            <div
              className="mt-0.5 truncate text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
              title={workspace.cwd}
            >
              {headline}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="p-4">
          {mode === "send-context" && (
            <div
              className="mb-3 rounded p-2.5 text-[11.5px] leading-relaxed"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
            >
              Spawns a new session seeded with a reference to{" "}
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--color-text)",
                }}
              >
                {workspace.latest_session_id?.slice(0, 8) ?? "—"}
              </span>
              . The new session will receive a prompt asking it to load and
              continue context from that session.
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 text-[12px]">
              <span style={{ color: "var(--color-text-tertiary)" }}>Provider</span>
              <select
                value={provider}
                onChange={(e) => {
                  const p = e.target.value as SessionProvider;
                  setProvider(p);
                  setModel(PROVIDERS[p].defaultModel);
                }}
                className="rounded px-2 py-1 text-[12px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="gemini">Gemini</option>
              </select>
            </div>
            <div className="flex items-center gap-2 text-[12px]">
              <span style={{ color: "var(--color-text-tertiary)" }}>Model</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="rounded px-2 py-1 text-[12px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                {PROVIDERS[provider].models.map((m) => (
                  <option key={m.id || "default"} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div
          className="flex items-center justify-end gap-2 border-t px-4 py-2.5"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1 text-[11.5px]"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onLaunch({ provider, model })}
            disabled={busy}
            className="rounded px-3 py-1 text-[11.5px] font-medium disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {launchLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
