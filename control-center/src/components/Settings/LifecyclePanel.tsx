import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../../lib/dialog";

// ---------------------------------------------------------------------------
// LifecyclePanel — Rebuild + Close + global hotkey (el arranque con Windows va en ArranqueSection).
// "Check for updates" removed (the user owns the binary).
// "Uninstall" removed (deprecated).
// v2.5.2 (wave 2): merged the "Show/hide Control Center" global hotkey
// editor from the old GeneralSection — it was the only hotkey worth
// keeping (in-app + project hotkeys were retired).
// ---------------------------------------------------------------------------

// HotkeyEditor inlined from the deleted GeneralSection. Single global
// shortcut to show/hide the Control Center.
function HotkeyEditor() {
  const [spec, setSpec] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke<string>("get_global_hotkey")
      .then((s) => {
        setSpec(s);
        setDraft(s);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (capturing) inputRef.current?.focus();
  }, [capturing]);

  async function apply() {
    if (!draft.trim() || draft === spec) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await invoke<string>("set_global_hotkey", { spec: draft.trim() });
      setSpec(r);
      setDraft(r);
      setSuccess(`Registered: ${r}`);
      window.setTimeout(() => setSuccess(null), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function onCapture(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (["Control", "Alt", "Shift", "Meta", "OS"].includes(e.key)) return;
    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    let k = e.key;
    if (k.length === 1) k = k.toUpperCase();
    parts.push(k);
    setDraft(parts.join("+"));
    setCapturing(false);
  }

  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border-strong)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
          Atajo para abrir mar.ia en Ajustes
        </div>
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
        >
          ~/.maria/.tmp/hotkey.txt
        </span>
      </div>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Púlsalo en cualquier programa de Windows y mar.ia se pone delante, abierta en
        Ajustes. Si ya la tenías delante, se esconde. Formato:{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>Ctrl+Alt+M</span>,{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>Ctrl+Shift+F12</span>… Necesita al
        menos un modificador.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onCapture}
          placeholder="Ctrl+Alt+M"
          className="rounded px-3 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text)",
            border: `1px solid ${capturing ? "var(--color-accent)" : "var(--color-border-strong)"}`,
            outline: "none",
            fontFamily: "var(--font-mono)",
            minWidth: 220,
          }}
        />
        <button
          type="button"
          onClick={() => setCapturing(!capturing)}
          className="rounded px-2.5 py-1 text-[11.5px]"
          style={{
            background: capturing ? "var(--color-surface-3)" : "transparent",
            color: capturing ? "var(--color-text)" : "var(--color-text-tertiary)",
            border: `1px solid ${capturing ? "var(--color-border-strong)" : "var(--color-border)"}`,
          }}
        >
          {capturing ? "Cancel capture" : "Capture key"}
        </button>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={busy || !draft.trim() || draft === spec}
          className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {busy ? "Applying…" : "Apply"}
        </button>
        <span className="text-[11.5px]" style={{ color: "var(--color-text-faint)" }}>
          active:{" "}
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>
            {spec || "—"}
          </span>
        </span>
      </div>

      {error && (
        <div
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {success && (
        <div
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {success}
        </div>
      )}
    </div>
  );
}

export function LifecyclePanel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [showCloseAfterRebuild, setShowCloseAfterRebuild] = useState(false);

  // --- restos de arranques viejos ---
  // El interruptor de «arrancar con Windows» vive en Ajustes → General →
  // ArranqueSection, justo debajo (2026-09-23): había dos en la misma página y
  // pulsar uno dejaba el otro desfasado. Aquí queda solo la limpieza de
  // accesos directos que dejaron versiones antiguas en la carpeta Inicio.
  useEffect(() => {
    void invoke("purge_legacy_autostart").catch(() => undefined);
  }, []);

  // --- rebuild helper ---

  async function rebuild() {
    setBusy("update");
    setError(null);
    setStatus(null);
    setShowCloseAfterRebuild(false);
    try {
      await invoke("run_app_lifecycle", { kind: "update" });
      setStatus("Rebuild opened in a new terminal. Takes ~3-5 minutes the first time.");
      setShowCloseAfterRebuild(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function closeControlCenter(reason: "rebuild" | "manual") {
    const msg =
      reason === "rebuild"
        ? "Close mar.ia now?\n\nFrees the file lock on control-center.exe so the rebuild can replace it."
        : "Close mar.ia?\n\nFully exits the app. Global hotkeys stop working until you relaunch.";
    const ok = await confirmDialog(msg, { title: "Close Control Center", kind: "warning" });
    if (!ok) return;
    try {
      await invoke("close_control_center");
    } catch (e) {
      console.error("close_control_center failed", e);
    }
  }

  return (
    <div className="space-y-4">
      {status && (
        <div
          className="rounded p-3 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {status}
        </div>
      )}
      {error && (
        <div
          className="rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Global hotkey (only hotkey kept after v2.5.2 wave 2 — the in-app
          and project hotkey editors were retired). */}
      <HotkeyEditor />

      {/* Rebuild from source */}
      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">Rebuild from source</div>
            <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
              Runs{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>npm run build:local</code>{" "}
              in a new terminal (includes the Finance tab when its local sources
              are present). Relaunch after the build finishes.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void rebuild()}
            disabled={busy !== null}
            className="shrink-0 rounded px-4 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {busy === "update" ? "Opening…" : "Rebuild"}
          </button>
        </div>
        {showCloseAfterRebuild && (
          <div
            className="mt-3 flex items-center justify-between gap-3 rounded p-3 text-[11.5px]"
            style={{
              background: "rgba(210, 153, 34, 0.06)",
              border: "1px solid rgba(210, 153, 34, 0.28)",
              color: "var(--color-text-secondary)",
            }}
          >
            <span>
              Close this window so the new binary can overwrite{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>control-center.exe</code>.
            </span>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => setShowCloseAfterRebuild(false)}
                className="rounded px-2.5 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                Not yet
              </button>
              <button
                type="button"
                onClick={() => void closeControlCenter("rebuild")}
                className="rounded px-2.5 py-1 text-[11.5px] font-medium"
                style={{
                  background: "var(--color-warn)",
                  color: "var(--color-accent-text)",
                }}
              >
                Close now
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Close Control Center */}
      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">Close Control Center</div>
            <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
              Fully exits the process (X button only minimizes to tray).
            </p>
          </div>
          <button
            type="button"
            onClick={() => void closeControlCenter("manual")}
            disabled={busy !== null}
            className="shrink-0 rounded px-4 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-danger)",
              border: "1px solid rgba(248, 81, 73, 0.32)",
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
